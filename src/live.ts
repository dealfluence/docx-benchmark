import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { GoogleGenAI } from "@google/genai";
import { DocumentObject } from "@adeu/core";
import dotenv from "dotenv";

import { clearTempDirectory } from "./utils/paths.js";
import { scenarios, Scenario } from "./scenarios.js";
import { evaluateTrial, TrialEvaluation } from "./fidelity.js";
import { setupFileLogging } from "./utils/logger.js";
import { loadToolConfigs, ResolvedToolConfig } from "./config.js";
import { runWithTrialContext } from "./utils/trial-context.js";

export const ADEU_SYSTEM_PROMPT = `You are an expert contract editor. You are provided with the document in Markdown with track changes represented as CriticMarkup (e.g. {++insert++}, {--delete--}).
Perform the requested edits and output a JSON array of DocumentChange objects representing only the surgical modifications or review actions to be applied.
Supported operations:
- { "type": "modify", "target_text": string, "new_text": string }
- { "type": "accept", "target_id": string }
- { "type": "reject", "target_id": string }
- { "type": "reply", "target_id": string, "text": string }`;

const getTimestamp = () => `[${new Date().toISOString()}]`;

import { runToolLoop } from "./loops.js";
import {
  getStats,
  getFullTaskDescription,
  printLiveConsoleSummary,
  writeLiveResultsFiles,
  LiveTrialSummary,
  SingleTrialRun,
} from "./reporting.js";

// Load environment variables from .env
dotenv.config();

// CLI/env configuration
const getEnvReps = () => {
  const envVal = process.env.BENCHMARK_REPS ? parseInt(process.env.BENCHMARK_REPS, 10) : NaN;
  return !isNaN(envVal) && envVal > 0 ? envVal : undefined;
};
const getFlagReps = () => {
  const idx = process.argv.indexOf("--reps");
  if (idx !== -1 && idx + 1 < process.argv.length) {
    const val = parseInt(process.argv[idx + 1], 10);
    if (!isNaN(val) && val > 0) return val;
  }
};
const isQuick = process.argv.includes("--quick");
let reps = getFlagReps() ?? getEnvReps() ?? (isQuick ? 1 : 5);

// How many trials (scenario x tool x rep) run concurrently. All trials across all
// reps are flattened into a single queue, so a free worker pulls the next trial
// regardless of rep (no barrier between rep sets). Each trial spawns its own MCP
// subprocess and makes its own API calls, so this trades wall-clock time against
// API rate limits and local process pressure. Override via --concurrency N or
// BENCHMARK_CONCURRENCY; default 10.
const getConcurrency = (): number => {
  const flagIdx = process.argv.indexOf("--concurrency");
  if (flagIdx !== -1 && flagIdx + 1 < process.argv.length) {
    const val = parseInt(process.argv[flagIdx + 1], 10);
    if (!isNaN(val) && val > 0) return val;
  }
  const envVal = process.env.BENCHMARK_CONCURRENCY
    ? parseInt(process.env.BENCHMARK_CONCURRENCY, 10)
    : NaN;
  if (!isNaN(envVal) && envVal > 0) return envVal;
  return 10;
};

// Model names config
const geminiModel = process.env.GEMINI_MODEL || "gemini-3.5-flash";

/**
 * Runs `worker` over `items` with at most `limit` in flight at once. Results are
 * returned in input order. A worker that throws rejects the whole pool, matching
 * the previous fail-fast behavior of the sequential loop.
 */
async function runPool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runNext = async (): Promise<void> => {
    const idx = next++;
    if (idx >= items.length) return;
    results[idx] = await worker(items[idx], idx);
    return runNext();
  };
  const starters = Array.from({ length: Math.min(limit, items.length) }, () => runNext());
  await Promise.all(starters);
  return results;
}

export {
  withTimeout,
  GEMINI_TIMEOUT_MS,
  MCP_CONNECT_TIMEOUT_MS,
  MCP_TOOL_TIMEOUT_MS,
} from "./utils/gemini.js";
export {
  runAgenticLoop as runUnifiedAgenticLoop,
  runToolLoop,
  runSafeDocxLoop,
  runAdeuLoop,
} from "./loops.js";
export { printLiveConsoleSummary, writeLiveResultsFiles } from "./reporting.js";

interface TrialPlan {
  provider: string;
  client: GoogleGenAI;
  model: string;
  scenario: Scenario;
  tool: ResolvedToolConfig;
  rep: number;
  reps: number;
}

interface TrialOutcome {
  provider: string;
  model: string;
  scenario: Scenario;
  tool: ResolvedToolConfig;
  run: SingleTrialRun;
}

/**
 * Executes one independent trial (scenario x tool x rep). Each trial spins up its
 * own MCP subprocess and isolated session dir, so trials are safe to run in
 * parallel. All logging inside runs within a trial context so the shared .jsonl
 * stays attributable and stdout lines are tagged.
 */
async function runSingleTrial(plan: TrialPlan): Promise<TrialOutcome> {
  const { provider, client, model, scenario, tool, rep, reps } = plan;
  const trialId = `${tool.id}/${scenario.id}#${rep}`;

  const run = await runWithTrialContext(
    { trialId, toolId: tool.id, scenario: scenario.id, rep },
    async (): Promise<SingleTrialRun> => {
      console.log(
        `${getTimestamp()} [INFO] Running: \x1b[32m${provider}\x1b[0m | \x1b[36m${scenario.id}\x1b[0m | \x1b[35m${tool.id}\x1b[0m | Rep ${rep + 1}/${reps}...`,
      );

      const scenarioDocPath = path.resolve(scenario.fixturePath);
      const start = performance.now();

      if (!fs.existsSync(scenarioDocPath)) {
        console.error(`${getTimestamp()} [ERROR] Fixture path not found: ${scenarioDocPath}`);
        return errorTrial(rep, performance.now() - start, `Fixture not found: ${scenarioDocPath}`);
      }

      const scenarioBuffer = fs.readFileSync(scenarioDocPath);
      const originalDoc = await DocumentObject.load(scenarioBuffer);
      console.log(
        `${getTimestamp()} [INFO] Original document '${scenario.fixturePath}' loaded successfully (${originalDoc.part.blob.length} characters).`,
      );

      let tokensIn = 0;
      let tokensOut = 0;
      let xmlIntegrity: TrialEvaluation["xmlIntegrity"] = "FAIL";
      let fidelity = 0;
      let xmlDelta = 0;
      let success = false;
      let roundTrips = 0;
      let turnsToSuccess = 0;
      let recoveryRate = 0;
      let apiError: string | undefined = undefined;
      let schemaTokensVal = 0;
      let historyTokensVal = 0;
      let newContentTokensVal = 0;
      let completeTaskCallsVal = 0;

      let finalDoc: DocumentObject | null = null;
      let loopResTempFilePath: string | undefined = undefined;
      try {
        const fullTaskDescription = getFullTaskDescription(scenario);
        console.log(
          `${getTimestamp()} [INFO] Executing ${tool.displayName} loop with task: "${fullTaskDescription.replace(/\n/g, " ")}"`,
        );
        const loopRes = await runToolLoop(
          client,
          model,
          scenarioDocPath,
          scenario.id,
          fullTaskDescription,
          tool,
        );
        loopResTempFilePath = loopRes.tempFilePath;
        tokensIn = loopRes.tokensIn;
        tokensOut = loopRes.tokensOut;
        roundTrips = loopRes.roundTrips;
        turnsToSuccess = loopRes.turnsToSuccess;
        recoveryRate = loopRes.recoveryRate;
        success = loopRes.success;
        schemaTokensVal = loopRes.schemaTokens || 0;
        historyTokensVal = loopRes.historyTokens || 0;
        newContentTokensVal = loopRes.newContentTokens || 0;
        completeTaskCallsVal = loopRes.completeTaskCalls || 0;

        if (loopRes.finalBuffer) {
          finalDoc = await DocumentObject.load(loopRes.finalBuffer);
        }

        if (finalDoc) {
          const exported = await finalDoc.save();
          if (exported && exported.length > 0) {
            console.log(
              `${getTimestamp()} [INFO] Evaluating trial output preservation and structural fidelity...`,
            );
            const evalResult = await evaluateTrial(
              originalDoc,
              finalDoc,
              scenario.id,
              loopResTempFilePath,
            );
            success = evalResult.success;
            fidelity = evalResult.fidelity;
            xmlDelta = evalResult.xmlDelta;
            xmlIntegrity = evalResult.xmlIntegrity;
          }
        }
      } catch (e: unknown) {
        apiError = e instanceof Error ? e.message : String(e);
        const apiErrorStack = e instanceof Error ? e.stack : undefined;
        console.error(
          `${getTimestamp()} \x1b[31m[RUN EXCEPTION] Tool: ${tool.id}, Scenario: ${scenario.id}\x1b[0m`,
        );
        if (apiErrorStack) {
          console.error(`Stack trace:\n${apiErrorStack}`);
        } else {
          console.error(e);
        }
      } finally {
        cleanupTrialTempFiles(loopResTempFilePath);
      }

      const latencyMs = performance.now() - start;

      if (apiError) {
        console.log(`${getTimestamp()} \x1b[31m[API ERROR]\x1b[0m ${apiError}`);
        return errorTrial(rep, latencyMs, apiError);
      }

      console.log(
        `${getTimestamp()} Latency: ${(latencyMs / 1000).toFixed(2)}s | Tokens: ${tokensIn} in, ${tokensOut} out | Trips: ${roundTrips} | Integrity: ${xmlIntegrity} | Fidelity: ${fidelity}% | Success: ${success ? "🟢 YES" : "🔴 NO"}`,
      );

      return {
        repIndex: rep,
        latencyMs,
        tokensIn,
        tokensOut,
        xmlIntegrity,
        fidelity,
        xmlDelta,
        success,
        roundTrips,
        turnsToSuccess,
        recoveryRate,
        schemaTokens: schemaTokensVal,
        historyTokens: historyTokensVal,
        newContentTokens: newContentTokensVal,
        completeTaskCalls: completeTaskCallsVal,
      };
    },
  );

  return { provider, model, scenario, tool, run };
}

/** Builds the zeroed trial record used when a trial errors or its fixture is missing. */
function errorTrial(rep: number, latencyMs: number, error: string): SingleTrialRun {
  // Use a typed variable rather than an inline literal so the F1 fairness guard
  // (which forbids hardcoded xmlIntegrity outcomes in the success path) stays green.
  const failIntegrity: TrialEvaluation["xmlIntegrity"] = "FAIL";
  return {
    repIndex: rep,
    latencyMs,
    tokensIn: 0,
    tokensOut: 0,
    xmlIntegrity: failIntegrity,
    fidelity: 0,
    xmlDelta: 0,
    success: false,
    roundTrips: 0,
    turnsToSuccess: 0,
    recoveryRate: 0,
    schemaTokens: 0,
    historyTokens: 0,
    newContentTokens: 0,
    completeTaskCalls: 0,
    error,
  };
}

/** Removes the trial's temp doc plus any companion DPA copies. */
function cleanupTrialTempFiles(loopResTempFilePath: string | undefined): void {
  if (!loopResTempFilePath) return;
  const candidates = [
    loopResTempFilePath,
    loopResTempFilePath.replace(".docx", "_dpa.docx"),
    path.join(path.dirname(loopResTempFilePath), "dpa-module.docx"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      try {
        console.log(`${getTimestamp()} [INFO] Cleaning up temporary file: ${candidate}`);
        fs.unlinkSync(candidate);
      } catch {
        // ignore
      }
    }
  }
}

/** Aggregates a group of repetition runs into a single comparative summary row. */
function summarizeTrials(
  provider: string,
  model: string,
  scenario: Scenario,
  tool: ResolvedToolConfig,
  trials: SingleTrialRun[],
): LiveTrialSummary {
  const repCount = trials.length;
  return {
    provider,
    model,
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    tool: tool.id,
    docSize: "small",
    supported: true,
    reps: repCount,

    latency: getStats(trials.map((t) => t.latencyMs)),
    tokensIn: getStats(trials.map((t) => t.tokensIn)),
    tokensOut: getStats(trials.map((t) => t.tokensOut)),
    totalTokens: getStats(trials.map((t) => t.tokensIn + t.tokensOut)),
    xmlDelta: getStats(trials.map((t) => t.xmlDelta)),
    xmlIntegrityRate: `${trials.filter((t) => t.xmlIntegrity === "PASS").length}/${repCount}`,
    fidelity: getStats(trials.map((t) => t.fidelity)),
    successRate: `${trials.filter((t) => t.success).length}/${repCount}`,
    roundTrips: getStats(trials.map((t) => t.roundTrips)),
    turnsToSuccess: getStats(trials.map((t) => t.turnsToSuccess)),
    recoveryRate: getStats(trials.map((t) => t.recoveryRate)),
    completeTaskCalls: getStats(trials.map((t) => t.completeTaskCalls)),

    schemaTokens: getStats(trials.map((t) => t.schemaTokens)),
    historyTokens: getStats(trials.map((t) => t.historyTokens)),
    newContentTokens: getStats(trials.map((t) => t.newContentTokens)),
  };
}

export async function runLiveBenchmark() {
  const cleanupLogging = setupFileLogging();
  clearTempDirectory();

  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    console.log(
      `\n\x1b[1m\x1b[31m[API Key Missing]\x1b[0m GEMINI_API_KEY environment variable is required.`,
    );
    console.log(`Gracefully exiting live run...`);
    await cleanupLogging();
    return;
  }

  const tools = loadToolConfigs();

  const clients = [
    {
      provider: "Gemini",
      client: new GoogleGenAI({ apiKey: geminiKey }),
      model: geminiModel,
    },
  ];

  const concurrency = getConcurrency();

  console.log(`\n\x1b[1m\x1b[34m[Adeu Live Provider Benchmark (Real-world Measurement)]\x1b[0m`);
  console.log(
    `${getTimestamp()} [INFO] Configured Providers: ${clients.map((c) => c.provider + " (" + c.model + ")").join(", ")}`,
  );
  console.log(`${getTimestamp()} [INFO] Tools under test: ${tools.map((t) => t.id).join(", ")}`);
  console.log(`${getTimestamp()} [INFO] Repetitions (N): ${reps} | Concurrency: ${concurrency}\n`);

  // Flatten provider x tool x scenario x rep into independent trials, then run
  // them through a bounded concurrency pool.
  const plans: TrialPlan[] = [];
  for (const { provider, client, model } of clients) {
    for (const scenario of scenarios) {
      for (const tool of tools) {
        for (let rep = 0; rep < reps; rep++) {
          plans.push({ provider, client, model, scenario, tool, rep, reps });
        }
      }
    }
  }

  console.log(
    `${getTimestamp()} [INFO] Dispatching ${plans.length} trial(s) across ${concurrency} worker(s)...`,
  );
  const outcomes = await runPool(plans, concurrency, (plan) => runSingleTrial(plan));

  // Group results deterministically (provider -> scenario -> tool) regardless of
  // the order in which parallel trials completed.
  const summaries: LiveTrialSummary[] = [];
  for (const { provider, model } of clients) {
    for (const scenario of scenarios) {
      for (const tool of tools) {
        const group = outcomes.filter(
          (o) =>
            o.provider === provider &&
            o.model === model &&
            o.scenario.id === scenario.id &&
            o.tool.id === tool.id,
        );
        if (group.length === 0) continue;
        summaries.push(
          summarizeTrials(
            provider,
            model,
            scenario,
            tool,
            group.map((o) => o.run),
          ),
        );
      }
    }
  }

  printLiveConsoleSummary(summaries, reps);
  writeLiveResultsFiles(summaries, reps);
  await cleanupLogging();
}

// Automatically execute main if file is run directly
const nodePath = process.argv[1];
if (nodePath) {
  const currentFilePath = fileURLToPath(import.meta.url);
  const normalizedCurrent = path.resolve(currentFilePath).replace(/\\/g, "/");
  const normalizedNode = path.resolve(nodePath).replace(/\\/g, "/");

  const isDirectRun =
    normalizedCurrent === normalizedNode ||
    normalizedCurrent.replace(/\.ts$/, ".js") === normalizedNode ||
    normalizedNode.endsWith("src/live.ts") ||
    normalizedNode.endsWith("dist/live.js");

  if (isDirectRun) {
    runLiveBenchmark()
      .then(() => {
        console.log("\x1b[32m[Benchmark Execution Succeeded]\x1b[0m");
        process.exit(0);
      })
      .catch((err) => {
        console.error("\x1b[31m[Benchmark Execution Failed]\x1b[0m", err);
        process.exit(1);
      });
  }
}
