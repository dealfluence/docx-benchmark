import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { DocumentObject } from "@adeu/core";
import dotenv from "dotenv";

import { getGoldenDocxPath, clearTempDirectory } from "./utils/paths.js";
import { scenarios } from "./scenarios.js";
import { evaluateTrial, TrialEvaluation } from "./fidelity.js";

export const ADEU_SYSTEM_PROMPT = `You are an expert contract editor. You are provided with the document in Markdown with track changes represented as CriticMarkup (e.g. {++insert++}, {--delete--}).
Perform the requested edits and output a JSON array of DocumentChange objects representing only the surgical modifications or review actions to be applied.
Supported operations:
- { "type": "modify", "target_text": string, "new_text": string }
- { "type": "accept", "target_id": string }
- { "type": "reject", "target_id": string }
- { "type": "reply", "target_id": string, "text": string }`;

import { runSafeDocxLoop, runAdeuLoop } from "./loops.js";
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

// Model names config
const geminiModel = process.env.GEMINI_MODEL || "gemini-3.5-flash";

export {
  withTimeout,
  GEMINI_TIMEOUT_MS,
  MCP_CONNECT_TIMEOUT_MS,
  MCP_TOOL_TIMEOUT_MS,
} from "./utils/gemini.js";
export { runUnifiedAgenticLoop, runSafeDocxLoop, runAdeuLoop } from "./loops.js";
export { printLiveConsoleSummary, writeLiveResultsFiles } from "./reporting.js";

export async function runLiveBenchmark() {
  clearTempDirectory();
  const docPath = getGoldenDocxPath();
  const dirPath = path.dirname(docPath);
  const largeDocPath = path.resolve(dirPath, "golden_large.docx");

  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    console.log(
      `\n\x1b[1m\x1b[31m[API Key Missing]\x1b[0m GEMINI_API_KEY environment variable is required.`,
    );
    console.log(`Gracefully exiting live run...`);
    return;
  }

  const clients = [
    {
      provider: "Gemini",
      client: new GoogleGenerativeAI(geminiKey),
      model: geminiModel,
    },
  ];

  console.log(`\n\x1b[1m\x1b[34m[Adeu Live Provider Benchmark (Real-world Measurement)]\x1b[0m`);
  console.log(
    `Configured Providers: ${clients.map((c) => c.provider + " (" + c.model + ")").join(", ")}`,
  );
  console.log(`Repetitions (N): ${reps}\n`);

  const summaries: LiveTrialSummary[] = [];
  const docSizes: ("small" | "large")[] = isQuick ? ["small"] : ["small", "large"];

  for (const docSize of docSizes) {
    const currentDocPath = docSize === "small" ? docPath : largeDocPath;
    if (!fs.existsSync(currentDocPath)) {
      console.warn(`[WARNING] Document not found: ${currentDocPath}, skipping ${docSize} size.`);
      continue;
    }
    const buffer = fs.readFileSync(currentDocPath);

    for (const clientWrapper of clients) {
      const { provider, client, model } = clientWrapper;
      const activeScenarios = isQuick
        ? [scenarios[0], scenarios.find((s) => s.isAgentic) || scenarios[0]]
        : scenarios;

      for (const scenario of activeScenarios) {
        const paradigms: ("adeu" | "safe-docx")[] = ["adeu", "safe-docx"];

        for (const paradigm of paradigms) {
          console.log(
            `Running: \x1b[32m${provider}\x1b[0m | \x1b[36m${scenario.id}\x1b[0m | \x1b[35m${paradigm}\x1b[0m | Size: \x1b[33m${docSize}\x1b[0m (${reps} reps)...`,
          );

          const trials: SingleTrialRun[] = [];

          for (let rep = 0; rep < reps; rep++) {
            process.stdout.write(`  Rep ${rep + 1}/${reps}... `);

            const originalDoc = await DocumentObject.load(buffer);

            const start = performance.now();
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

            let finalDoc: DocumentObject | null = null;
            try {
              if (paradigm === "safe-docx") {
                const fullTaskDescription = getFullTaskDescription(scenario);
                const loopRes = await runSafeDocxLoop(
                  client as GoogleGenerativeAI,
                  model,
                  currentDocPath,
                  scenario.id,
                  fullTaskDescription,
                );
                tokensIn = loopRes.tokensIn;
                tokensOut = loopRes.tokensOut;
                roundTrips = loopRes.roundTrips;
                turnsToSuccess = loopRes.turnsToSuccess;
                recoveryRate = loopRes.recoveryRate;
                success = loopRes.success;
                schemaTokensVal = loopRes.schemaTokens || 0;
                historyTokensVal = loopRes.historyTokens || 0;
                newContentTokensVal = loopRes.newContentTokens || 0;

                if (loopRes.finalBuffer) {
                  finalDoc = await DocumentObject.load(loopRes.finalBuffer);
                }
              } else if (paradigm === "adeu") {
                const fullTaskDescription = getFullTaskDescription(scenario);
                const loopRes = await runAdeuLoop(
                  client as GoogleGenerativeAI,
                  model,
                  buffer,
                  scenario.id,
                  fullTaskDescription,
                );
                tokensIn = loopRes.tokensIn;
                tokensOut = loopRes.tokensOut;
                roundTrips = loopRes.roundTrips;
                turnsToSuccess = loopRes.turnsToSuccess;
                recoveryRate = loopRes.recoveryRate;
                success = loopRes.success;
                schemaTokensVal = loopRes.schemaTokens || 0;
                historyTokensVal = loopRes.historyTokens || 0;
                newContentTokensVal = loopRes.newContentTokens || 0;

                if (loopRes.finalBuffer) {
                  finalDoc = await DocumentObject.load(loopRes.finalBuffer);
                }
              }

              if (finalDoc) {
                const exported = await finalDoc.save();
                if (exported && exported.length > 0) {
                  const evalResult = evaluateTrial(originalDoc, finalDoc, scenario.id);
                  success = evalResult.success;
                  fidelity = evalResult.fidelity;
                  xmlDelta = evalResult.xmlDelta;
                  xmlIntegrity = evalResult.xmlIntegrity;
                }
              }
            } catch (e: unknown) {
              apiError = e instanceof Error ? e.message : String(e);
            }

            const latencyMs = performance.now() - start;

            if (apiError) {
              const apiFailVal: "PASS" | "FAIL" = "FAIL";
              trials.push({
                repIndex: rep,
                latencyMs,
                tokensIn: 0,
                tokensOut: 0,
                xmlIntegrity: apiFailVal,
                fidelity: 0,
                xmlDelta: 0,
                success: false,
                roundTrips: 0,
                turnsToSuccess: 0,
                recoveryRate: 0,
                schemaTokens: 0,
                historyTokens: 0,
                newContentTokens: 0,
                error: apiError,
              });
              console.log(`\x1b[31m[API ERROR]\x1b[0m ${apiError}`);
              continue;
            }

            trials.push({
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
            });

            console.log(
              `Latency: ${(latencyMs / 1000).toFixed(2)}s | Tokens: ${tokensIn} in, ${tokensOut} out | Trips: ${roundTrips} | Integrity: ${xmlIntegrity} | Fidelity: ${fidelity}% | Success: ${success ? "🟢 YES" : "🔴 NO"}`,
            );
          }

          const repCount = trials.length;
          const latStats = getStats(trials.map((t) => t.latencyMs));
          const tokInStats = getStats(trials.map((t) => t.tokensIn));
          const tokOutStats = getStats(trials.map((t) => t.tokensOut));
          const totTokStats = getStats(trials.map((t) => t.tokensIn + t.tokensOut));
          const fidStats = getStats(trials.map((t) => t.fidelity));
          const xmlDeltaStats = getStats(trials.map((t) => t.xmlDelta));
          const schStats = getStats(trials.map((t) => t.schemaTokens));
          const histStats = getStats(trials.map((t) => t.historyTokens));
          const newContStats = getStats(trials.map((t) => t.newContentTokens));

          const roundTripsStats = getStats(trials.map((t) => t.roundTrips));
          const turnsToSuccessStats = getStats(trials.map((t) => t.turnsToSuccess));
          const recoveryRateStats = getStats(trials.map((t) => t.recoveryRate));

          const xmlIntegrityRate = `${trials.filter((t) => t.xmlIntegrity === "PASS").length}/${repCount}`;
          const successRate = `${trials.filter((t) => t.success).length}/${repCount}`;

          summaries.push({
            provider,
            model,
            scenarioId: scenario.id,
            scenarioName: scenario.name,
            paradigm,
            docSize,
            supported: true,
            reps: repCount,

            latency: latStats,
            tokensIn: tokInStats,
            tokensOut: tokOutStats,
            totalTokens: totTokStats,
            xmlDelta: xmlDeltaStats,
            xmlIntegrityRate,
            fidelity: fidStats,
            successRate,
            roundTrips: roundTripsStats,
            turnsToSuccess: turnsToSuccessStats,
            recoveryRate: recoveryRateStats,

            schemaTokens: schStats,
            historyTokens: histStats,
            newContentTokens: newContStats,
          });
        }
      }
    }
  }

  printLiveConsoleSummary(summaries, reps);
  writeLiveResultsFiles(summaries, reps);
}

// Automatically execute main if file is run directly
const nodePath = process.argv[1];
if (nodePath) {
  const currentFilePath = fileURLToPath(import.meta.url);
  const isDirectRun =
    currentFilePath.endsWith(nodePath) ||
    currentFilePath.replace(/\.ts$/, ".js").endsWith(nodePath) ||
    nodePath.endsWith("src/live.ts") ||
    nodePath.endsWith("dist/live.js");

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
