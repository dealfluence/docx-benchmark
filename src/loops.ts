import * as fs from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import {
  GoogleGenAI,
  Content,
  FunctionDeclaration,
  Part,
  Type,
  GenerateContentResponse,
  ThinkingLevel,
  FunctionCall,
} from "@google/genai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DocumentObject } from "@adeu/core";
import { checkScenarioSuccess } from "./success.js";
import { ResolvedToolConfig } from "./config.js";
import { getTempDirPath } from "./utils/paths.js";
import {
  withTimeout,
  cleanSchema,
  Schema,
  GEMINI_TIMEOUT_MS,
  MCP_CONNECT_TIMEOUT_MS,
  MCP_TOOL_TIMEOUT_MS,
} from "./utils/gemini.js";

export interface LoopResult {
  tokensIn: number;
  tokensOut: number;
  roundTrips: number;
  turnsToSuccess: number;
  recoveryRate: number;
  finalBuffer: Buffer;
  success: boolean;
  schemaTokens?: number;
  historyTokens?: number;
  newContentTokens?: number;
  tempFilePath?: string;
  completeTaskCalls?: number;
}

export interface LoopStats {
  tokensIn: number;
  tokensOut: number;
  schemaTokens: number;
  historyTokens: number;
  newContentTokens: number;
  /** Fixed system + tool-schema overhead re-sent every turn, learned on turn 1. */
  schemaTokensPerTurn: number;
  historyAccumulated: number;
  roundTrips: number;
  turnsToSuccess: number;
  errorTurns: number;
  recoveryTurns: number;
  completeTaskCalls: number;
  previousTurnHadError: boolean;
  success: boolean;
}

export interface LoopConfig {
  gemini: GoogleGenAI;
  modelName: string;
  systemPrompt: string;
  maxTurns: number;
  tools: FunctionDeclaration[];
  executeTool: (
    name: string,
    args: Record<string, unknown>,
    turn: number,
  ) => Promise<{ result?: unknown; error?: string; hadError: boolean }>;
  checkSuccess: (turn: number, finalFilenames?: string[]) => Promise<boolean>;
  getFinalBuffer: () => Promise<Buffer>;
  cleanup?: () => Promise<void>;
  loopName?: string;
  /**
   * When true, a tools-disabled "think aloud" planning step is inserted before
   * every action step: the model must state its next action without taking it,
   * then the following step lets it act. Doubles the step count, so pair with a
   * larger maxTurns.
   */
  thinkAloud?: boolean;
}

export function middleTruncate(str: string, maxLength = 500): string {
  if (str.length <= maxLength) return str;
  const reserve = 30; // space for the middle notice message
  if (maxLength <= reserve) {
    return str.substring(0, maxLength) + "...";
  }
  const half = Math.floor((maxLength - reserve) / 2);
  return `${str.substring(0, half)} ... [truncated ${str.length - half * 2} chars] ... ${str.substring(str.length - half)}`;
}

export function logInfo(prefix: string, message: string) {
  const ts = `[${new Date().toISOString()}]`;
  const p = prefix ? ` [${prefix}]` : "";
  console.log(`${ts} [INFO]${p} ${message}`);
}

export function logWarn(prefix: string, message: string) {
  const ts = `[${new Date().toISOString()}]`;
  const p = prefix ? ` [${prefix}]` : "";
  console.warn(`${ts} [WARNING]${p} ${message}`);
}

export function logError(prefix: string, message: string, err?: unknown) {
  const ts = `[${new Date().toISOString()}]`;
  const p = prefix ? ` [${prefix}]` : "";
  console.error(`${ts} [ERROR]${p} ${message}`);
  if (err) {
    console.error(err);
  }
}

export const MAX_TURNS = 80;

/**
 * Appended to the system prompt during a think-aloud planning step. The model has
 * NO tools in this step, so it cannot act — it must articulate its next move.
 */
export const THINK_ALOUD_SUFFIX = `PLANNING STEP — DO NOT CALL ANY TOOL IN THIS STEP.
The tools are listed for your reference so you can name them precisely, but you MUST NOT invoke any tool here — output text only. Think aloud and state, in a few concise sentences, the single next action you will take and why: name the exact tool you will call next and the specific target/arguments you will use. Your VERY NEXT step will be the tool call in which you carry out exactly this planned action. (Any tool call you attempt in this planning step is ignored and not executed.)`;

/**
 * Builds the neutral, paradigm-symmetric system prompt. Both loops receive an
 * identical skeleton differing only in the tool name and the document list, so
 * neither paradigm gets tool-specific survival coaching. This measures true
 * unguided capability and is defensible for a vendor-published benchmark.
 */
export function buildSystemPrompt(opts: {
  toolDisplayName: string;
  docFileName: string;
  editableCompanions?: string[];
  inputDocs?: string[];
  taskDescription: string;
}): string {
  const {
    toolDisplayName,
    docFileName,
    editableCompanions = [],
    inputDocs = [],
    taskDescription,
  } = opts;
  const docLines = [`- Primary document (edit this): "${docFileName}"`];
  for (const c of editableCompanions) docLines.push(`- Additional document to edit: "${c}"`);
  for (const i of inputDocs)
    docLines.push(`- Input data document (read for values, do NOT edit): "${i}"`);
  return `You are an expert contract editor editing Microsoft Word documents (.docx) using the provided ${toolDisplayName} tools.

Documents involved in this task:
${docLines.join("\n")}

Your task is: ${taskDescription}

Work through the task using the available tools. Inspect the document(s) before editing, apply the requested edits, and verify that the text of your edits is present and saved before finishing.

CRITICAL INSTRUCTIONS FOR SUBMISSION:
1. You MUST explicitly call the 'complete_task' tool to submit your work and finalize the task. If you saved your work to a different filename than the original (e.g., a "_processed.docx" variant), pass that filename in the 'final_filenames' parameter. Writing a final message in plain text will NOT complete the task.
2. If your submission fails the validation gate, you will receive structured linter feedback. Analyze the feedback, correct the document, and call 'complete_task' again once ready.`;
}

let tempDirCleaned = false;

/**
 * Cleans the temporary directory on startup, deleting only stale session folders
 * older than 10 seconds to prevent race conditions during parallel test runs.
 */
export function cleanTempDirOnStartup() {
  if (tempDirCleaned) return;
  tempDirCleaned = true;
  const tempDir = getTempDirPath();
  try {
    if (fs.existsSync(tempDir)) {
      const entries = fs.readdirSync(tempDir);
      const now = Date.now();
      for (const entry of entries) {
        const fullPath = path.join(tempDir, entry);
        const stats = fs.statSync(fullPath);
        if (now - stats.mtimeMs > 10000) {
          fs.rmSync(fullPath, { recursive: true, force: true });
        }
      }
      logInfo("", `Cleaned stale session directories under: ${tempDir}`);
    } else {
      fs.mkdirSync(tempDir, { recursive: true });
    }
  } catch (err) {
    logWarn("", `Failed to clean temp dir: ${err}`);
  }
}

export function appendAndLog(prefix: string, contents: Content[], msg: Content) {
  contents.push(msg);
  logInfo(prefix, `--> Appending Conversation Turn | Role: ${msg.role}`);
  for (const part of msg.parts || []) {
    if (part.text) {
      logInfo(prefix, `    Text: "${part.text.trim()}"`);
    } else if (part.functionCall) {
      logInfo(
        prefix,
        `    Function Call: ${part.functionCall.name} with args ${JSON.stringify(part.functionCall.args)}`,
      );
    } else if (part.functionResponse) {
      const respStr = JSON.stringify(part.functionResponse.response);
      logInfo(
        prefix,
        `    Function Response [${part.functionResponse.name}]: ${middleTruncate(respStr, 500)}`,
      );
    } else {
      logInfo(prefix, `    Part: ${JSON.stringify(part)}`);
    }
  }
}

export const COMPLETE_TASK_TOOL: FunctionDeclaration = {
  name: "complete_task",
  description:
    "Call this tool to finalize your draft, verify modifications, and submit the document for review once you are certain all edits are completed, verified, and successfully saved.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      summary: {
        type: Type.STRING,
        description:
          "A brief, 1-sentence summary of the exact modifications applied to complete the task.",
      },
      final_filenames: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description:
          "The filename(s) or relative path(s) of the final, saved document(s) containing your completed edits (e.g., ['cloud-service-agreement_processed.docx', 'dpa-module_processed.docx'] or ['post-money-safe_processed.docx']). If not specified, defaults to the primary document filename.",
      },
    },
    required: ["summary"],
  },
};

async function generateContentWithRetry(
  gemini: GoogleGenAI,
  modelName: string,
  contents: Content[],
  systemPrompt: string,
  tools: FunctionDeclaration[],
  maxRetries = 3,
): Promise<GenerateContentResponse> {
  let attempt = 0;
  let delay = 2000;

  while (attempt < maxRetries) {
    try {
      const response = await withTimeout(
        gemini.models.generateContent({
          model: modelName,
          contents,
          config: {
            systemInstruction: systemPrompt,
            tools: tools.length > 0 ? [{ functionDeclarations: tools }] : undefined,
            thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
          },
        }),
        GEMINI_TIMEOUT_MS,
        `Gemini API call timed out after ${GEMINI_TIMEOUT_MS}ms`,
      );
      return response;
    } catch (err: unknown) {
      attempt++;
      const errorObj = err as Record<string, unknown> | null;
      const errorMessage = err instanceof Error ? err.message : String(err);
      const isAbort =
        err instanceof Error &&
        (err.name === "AbortError" ||
          errorMessage.includes("aborted") ||
          errorMessage.includes("timed out"));
      const isRateLimit = errorObj?.status === 429 || errorMessage.includes("429");
      const isServerError =
        (typeof errorObj?.status === "number" && errorObj.status >= 500) ||
        errorMessage.includes("500");

      if (attempt >= maxRetries || (!isAbort && !isRateLimit && !isServerError)) {
        throw err;
      }

      logWarn(
        "",
        `generateContent call failed on attempt ${attempt}/${maxRetries} (Error: ${errorMessage}). Retrying in ${delay}ms...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
  throw new Error("generateContent failed after maximum retries");
}

export function initLoopStats(config: LoopConfig): LoopStats {
  return {
    tokensIn: 0,
    tokensOut: 0,
    schemaTokens: 0,
    historyTokens: 0,
    newContentTokens: 0,
    schemaTokensPerTurn: 0,
    historyAccumulated: 0,
    roundTrips: 0,
    turnsToSuccess: config.maxTurns,
    errorTurns: 0,
    recoveryTurns: 0,
    completeTaskCalls: 0,
    previousTurnHadError: false,
    success: false,
  };
}

/**
 * A tools-disabled "think aloud" planning step. The model is called with NO tools
 * and a planning-only system prompt, so it must state its next action as text
 * rather than act. Its plan is appended to the conversation, followed by a short
 * user nudge to act — keeping strict user/model alternation and cueing the
 * following (tool-enabled) step. Tokens count toward the totals; no tool round-trip
 * is recorded (this step makes no tool call).
 */
export async function executeThinkStep(
  step: number,
  config: LoopConfig,
  contents: Content[],
  stats: LoopStats,
): Promise<void> {
  const prefix = `Plan ${step}`;
  logInfo(prefix, `Dispatching think-aloud planning call...`);
  // Tools ARE registered here so the model plans with accurate tool names, but the
  // system prompt forbids calling them and any tool call it emits is discarded
  // below (never executed) — so the step is action-free either way.
  const response = await generateContentWithRetry(
    config.gemini,
    config.modelName,
    contents,
    `${config.systemPrompt}\n\n${THINK_ALOUD_SUFFIX}`,
    config.tools,
  ).catch((err) => {
    logError(prefix, `think-aloud generateContent failed or was aborted!`, err);
    throw err;
  });

  const promptTokens = response.usageMetadata?.promptTokenCount || 0;
  const candidateTokens = response.usageMetadata?.candidatesTokenCount || 0;
  stats.tokensIn += promptTokens;
  stats.tokensOut += candidateTokens;
  // No tool schemas are sent in a planning step, so attribute the prompt to
  // re-sent history plus genuinely new content (keeps the breakdown summing to
  // tokensIn without inflating the schema floor).
  const hTokens = Math.min(stats.historyAccumulated, promptTokens);
  const nTokens = promptTokens - hTokens;
  stats.historyTokens += hTokens;
  stats.newContentTokens += nTokens;
  stats.historyAccumulated = hTokens + nTokens + candidateTokens;

  const parts = response.candidates?.[0]?.content?.parts || [];
  let planText = parts
    .filter((p: Part) => p.text)
    .map((p: Part) => p.text!.trim())
    .filter(Boolean)
    .join("\n");

  // Defensive: if the model ignored the instruction and emitted tool calls during
  // planning, do NOT execute or append them (appending function-call parts without
  // matching responses would also corrupt the conversation). Capture their intent
  // as plan text instead so the signal isn't lost.
  const attemptedCalls = response.functionCalls || [];
  if (attemptedCalls.length > 0) {
    logWarn(
      prefix,
      `Model attempted ${attemptedCalls.length} tool call(s) during planning; ignored (not executed).`,
    );
    if (!planText) {
      planText =
        "Planned next action: " +
        attemptedCalls.map((fc) => `${fc.name}(${JSON.stringify(fc.args)})`).join("; ");
    }
  }

  // Append ONLY the plan text (never the function-call parts) to keep the
  // conversation well-formed and tool-call-free during planning.
  appendAndLog(prefix, contents, {
    role: "model",
    parts: [{ text: planText || "(no plan articulated)" }],
  });
  appendAndLog(prefix, contents, {
    role: "user",
    parts: [{ text: "Now carry out exactly that next action using the appropriate tool." }],
  });

  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      step,
      kind: "plan",
      plan: middleTruncate(planText, 600) || undefined,
    }),
  );
}

export async function executeTurn(
  turn: number,
  config: LoopConfig,
  contents: Content[],
  stats: LoopStats,
): Promise<{ shouldBreak: boolean }> {
  // The tool identity is carried by the trial tag (stdout) and the toolId field
  // (jsonl), so the per-turn prefix only needs the turn number.
  const prefix = `Turn ${turn}`;
  const isVerbose = process.argv.includes("--verbose");

  if (isVerbose) {
    logInfo(prefix, `Sending prompt content length: ${contents.length} messages.`);
  }

  logInfo(prefix, `Dispatching API call (timeout: ${GEMINI_TIMEOUT_MS}ms)...`);
  const geminiResponse = await generateContentWithRetry(
    config.gemini,
    config.modelName,
    contents,
    config.systemPrompt,
    config.tools,
  ).catch((err) => {
    logError(prefix, `generateContent failed or was aborted!`, err);
    throw err;
  });

  logInfo(prefix, `generateContent call returned successfully.`);

  const promptTokensThisTurn = geminiResponse.usageMetadata?.promptTokenCount || 0;
  const candidatesTokensThisTurn = geminiResponse.usageMetadata?.candidatesTokenCount || 0;

  stats.tokensIn += promptTokensThisTurn;
  stats.tokensOut += candidatesTokensThisTurn;

  // The first turn's prompt is essentially the fixed overhead — system prompt +
  // tool schemas + a tiny seed message — that is re-transmitted every turn. We
  // learn it once and treat it as the per-turn schema cost. Each subsequent turn
  // then splits into schema (fixed) / history (re-sent conversation) / new content
  // (genuinely new input this turn), so newContent + output is the irreducible
  // "floor" of real document work, distinct from platform re-transmission.
  if (stats.schemaTokensPerTurn === 0) {
    stats.schemaTokensPerTurn = promptTokensThisTurn;
  }
  const sTokens = Math.min(stats.schemaTokensPerTurn, promptTokensThisTurn);
  const hTokens = Math.min(stats.historyAccumulated, Math.max(0, promptTokensThisTurn - sTokens));
  const nTokens = promptTokensThisTurn - sTokens - hTokens;

  stats.schemaTokens += sTokens;
  stats.historyTokens += hTokens;
  stats.newContentTokens += nTokens;
  stats.historyAccumulated = hTokens + nTokens + candidatesTokensThisTurn;

  logInfo(
    prefix,
    `Turn Metrics: [Tokens In: ${promptTokensThisTurn} (Schema: ${sTokens}, History: ${hTokens}, New Content: ${nTokens}) | Tokens Out: ${candidatesTokensThisTurn}]`,
  );
  logInfo(
    prefix,
    `Cum. Totals: [Tokens In: ${stats.tokensIn} | Tokens Out: ${stats.tokensOut} | Total: ${stats.tokensIn + stats.tokensOut}]`,
  );

  const parts = geminiResponse.candidates?.[0]?.content?.parts || [];
  const functionCalls = geminiResponse.functionCalls || [];

  if (isVerbose) {
    logInfo(
      prefix,
      `Model generated ${parts.length} parts and ${functionCalls.length} function calls.`,
    );
  }

  if (functionCalls.length === 0) {
    logInfo(prefix, `No function calls generated. Breaking loop (Task is finalized).`);
    return { shouldBreak: true };
  }

  stats.roundTrips++;
  appendAndLog(prefix, contents, { role: "model", parts });

  const functionResponses: Array<{ name: string; response: Record<string, unknown> }> = [];
  const turnStart = performance.now();

  const { shouldExitSucceeded, currentTurnHadError } = await handleFunctionCalls(
    functionCalls,
    prefix,
    stats,
    config.checkSuccess,
    turn,
    functionResponses,
    config.executeTool,
    turnStart,
    parts,
  );

  appendAndLog(prefix, contents, {
    role: "user",
    parts: functionResponses.map((fr) => ({ functionResponse: fr })),
  });

  if (currentTurnHadError) {
    stats.errorTurns++;
  } else if (stats.previousTurnHadError) {
    stats.recoveryTurns++;
  }
  stats.previousTurnHadError = currentTurnHadError;

  return { shouldBreak: shouldExitSucceeded };
}

export async function runAgenticLoop(config: LoopConfig): Promise<LoopResult> {
  const loopLabel = config.loopName || "Loop";
  logInfo(loopLabel, `Initializing model client: ${config.modelName}`);

  const contents: Content[] = [];
  appendAndLog(loopLabel, contents, {
    role: "user",
    parts: [{ text: "Please analyze the loaded document and proceed with the specified task." }],
  });

  const stats = initLoopStats(config);

  let finalBuffer: Buffer | null = null;

  try {
    let step = 0;
    while (step < config.maxTurns) {
      // Optional tools-disabled planning step: force the model to articulate its
      // next action before it is allowed to take one.
      if (config.thinkAloud) {
        step++;
        await executeThinkStep(step, config, contents, stats);
        if (step >= config.maxTurns) break;
      }
      step++;
      if ((await executeTurn(step, config, contents, stats)).shouldBreak) {
        break;
      }
    }
  } finally {
    try {
      finalBuffer = await config.getFinalBuffer();
    } catch {
      // ignore
    }
    if (config.cleanup) await config.cleanup();
  }

  const recoveryRate = stats.errorTurns > 0 ? stats.recoveryTurns / stats.errorTurns : 0;

  return {
    recoveryRate,
    finalBuffer: finalBuffer || Buffer.alloc(0),
    ...stats,
  };
}

async function handleFunctionCalls(
  functionCalls: FunctionCall[],
  prefix: string,
  stats: LoopStats,
  checkSuccess: (turn: number, finalFilenames?: string[]) => Promise<boolean>,
  turn: number,
  functionResponses: { name: string; response: Record<string, unknown> }[],
  executeTool: (
    name: string,
    args: Record<string, unknown>,
    turn: number,
  ) => Promise<{ result?: unknown; error?: string; hadError: boolean }>,
  turnStart: number,
  parts: Part[],
): Promise<{ shouldExitSucceeded: boolean; currentTurnHadError: boolean }> {
  let currentTurnHadError = false;
  let shouldExitSucceeded = false;

  for (const fc of functionCalls) {
    if (!fc.name) {
      logWarn(prefix, `Skipping anonymous or invalid function call.`);
      continue;
    }
    const toolName = fc.name;
    try {
      if (toolName === "complete_task") {
        stats.completeTaskCalls++;
        const res = await handleCompleteTaskCall(
          prefix,
          checkSuccess,
          turn,
          stats,
          toolName,
          fc.args as Record<string, unknown>,
        );
        shouldExitSucceeded = res.shouldExitSucceeded;
        if (res.currentTurnHadError) {
          currentTurnHadError = true;
        }
        functionResponses.push(res.functionResponse);
      } else {
        const toolResult = await executeTool(fc.name, fc.args as Record<string, unknown>, turn);
        if (toolResult.hadError) currentTurnHadError = true;
        functionResponses.push({
          name: fc.name,
          response: toolResult.error
            ? { error: toolResult.error }
            : (toolResult.result as Record<string, unknown>),
        });
      }
    } catch (err) {
      currentTurnHadError = true;
      const errMsg = err instanceof Error ? err.message : String(err);
      logError(prefix, `Exception occurred inside tool '${fc.name}':`, err);
      functionResponses.push({
        name: fc.name,
        response: { error: errMsg },
      });
    }

    const elapsedMs = Math.round(performance.now() - turnStart);
    const resObj = functionResponses[functionResponses.length - 1]?.response;
    const resStr = JSON.stringify(resObj);

    // Truncate the raw stringified tool response for safe logging
    const truncatedResult = resStr ? middleTruncate(resStr, 350) : undefined;

    // Extract any reasoning text from the current turn response parts
    const reasoningText = parts
      .filter((p: Part) => p.text)
      .map((p: Part) => p.text!.trim())
      .join("\n");

    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        turn,
        reasoning: reasoningText || undefined,
        tool: fc.name,
        args: fc.args,
        ok: !currentTurnHadError,
        resultBytes: resStr ? resStr.length : 0,
        result: truncatedResult || undefined,
        elapsedMs,
      }),
    );
  }
  return { shouldExitSucceeded, currentTurnHadError };
}

async function handleCompleteTaskCall(
  prefix: string,
  checkSuccess: (turn: number, finalFilenames?: string[]) => Promise<boolean>,
  turn: number,
  stats: LoopStats,
  toolName: string,
  args?: Record<string, unknown>,
): Promise<{
  shouldExitSucceeded: boolean;
  currentTurnHadError: boolean;
  functionResponse: { name: string; response: Record<string, unknown> };
}> {
  logInfo(prefix, `[complete_task] Intercepting task submission. Checking validation gate...`);

  let finalFilenames: string[] | undefined = undefined;
  if (args?.final_filenames) {
    if (Array.isArray(args.final_filenames)) {
      finalFilenames = args.final_filenames.map(String);
    } else if (typeof args.final_filenames === "string") {
      finalFilenames = [args.final_filenames];
    }
  } else if (args?.final_filename) {
    finalFilenames = [String(args.final_filename)];
  }

  const isSuccessNow = await checkSuccess(turn, finalFilenames);
  let shouldExitSucceeded = false;
  let currentTurnHadError = false;
  let functionResponse: { name: string; response: Record<string, unknown> };

  if (isSuccessNow) {
    logInfo(prefix, `[complete_task] Validation gate PASSED! Recording success.`);
    stats.success = true;
    stats.turnsToSuccess = turn;
    shouldExitSucceeded = true;
    functionResponse = {
      name: toolName,
      response: {
        success: true,
        message: "Submission accepted. All validation checks passed.",
      },
    };
  } else {
    logInfo(
      prefix,
      `[complete_task] Validation gate FAILED. Rejecting submission with linter feedback.`,
    );
    currentTurnHadError = true;
    functionResponse = {
      name: toolName,
      response: {
        success: false,
        error:
          "Submission Rejected: The validation gate failed. Your document does not yet satisfy all task criteria. Please ensure all requested edits are correctly applied, saved to disk, and no placeholders remain before re-submitting.",
      },
    };
  }
  return { shouldExitSucceeded, currentTurnHadError, functionResponse };
}

export interface McpLaunchSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Merge custom env onto the inherited process env, dropping undefined values. */
function buildMcpEnv(extra?: Record<string, string>): Record<string, string> | undefined {
  if (!extra) return undefined;
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") merged[k] = v;
  }
  return { ...merged, ...extra };
}

export async function connectMcpClient(spec: McpLaunchSpec, clientName: string) {
  const launchDesc = [spec.command, ...(spec.args ?? [])].join(" ");
  logInfo("", `Connecting to MCP Server '${launchDesc}' (client: '${clientName}')...`);
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args ?? [],
    env: buildMcpEnv(spec.env),
  });
  const mcpClient = new Client({ name: clientName, version: "1.0.0" }, { capabilities: {} });
  await withTimeout(
    mcpClient.connect(transport),
    MCP_CONNECT_TIMEOUT_MS,
    `${clientName} connection timed out after ${MCP_CONNECT_TIMEOUT_MS}ms`,
  );
  logInfo("", `Connection handshake completed with MCP Server '${clientName}'.`);

  const clientObj = mcpClient as unknown as Record<string, unknown>;
  let serverName = "unknown";
  let serverVersion = "unknown";

  const rawVersion =
    clientObj._serverVersion ||
    clientObj.serverInfo ||
    (typeof clientObj.getServerVersion === "function"
      ? (clientObj.getServerVersion as () => unknown)()
      : undefined);

  if (rawVersion && typeof rawVersion === "object") {
    const typedVersion = rawVersion as { name?: string; version?: string };
    serverName = typedVersion.name || "unknown";
    serverVersion = typedVersion.version || "unknown";
  } else if (typeof rawVersion === "string") {
    serverVersion = rawVersion;
  }

  logInfo("", `MCP Server reported info: name="${serverName}", version="${serverVersion}"`);
  logInfo("", `Retrieving tool registrations from MCP Server '${clientName}'...`);
  const toolsResponse = await withTimeout(
    mcpClient.listTools(),
    MCP_TOOL_TIMEOUT_MS,
    `${clientName} listTools timed out after ${MCP_TOOL_TIMEOUT_MS}ms`,
  );
  logInfo(
    "",
    `Successfully listed ${toolsResponse.tools.length} tool(s) from MCP Server '${clientName}'.`,
  );
  return { mcpClient, tools: toolsResponse.tools };
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Schema;
}

interface McpToolResult {
  isError?: boolean;
  content?: Array<{
    type?: string;
    text?: string;
  }>;
}

export const mapToGeminiTools = (tools: McpTool[]): FunctionDeclaration[] =>
  tools.map((t) => ({
    name: t.name,
    description: t.description || "",
    parameters: cleanSchema(t.inputSchema) as FunctionDeclaration["parameters"],
  }));

/**
 * Universal Path Isolation Guard: Automatically translates any file path or relative
 * filename argument pointing to a .docx file so that it resolves within our isolated session folder,
 * guaranteeing complete safety for the master baseline fixtures.
 */
export function resolveArgsToSessionDir(
  args: Record<string, unknown>,
  sessionDir: string,
): Record<string, unknown> {
  const resolvedArgs = { ...args };
  for (const key of Object.keys(resolvedArgs)) {
    const val = resolvedArgs[key];
    if (typeof val === "string") {
      if (val.toLowerCase().endsWith(".docx")) {
        const baseName = path.basename(val);
        resolvedArgs[key] = path.join(sessionDir, baseName).replace(/\\/g, "/");
      }
    }
  }
  return resolvedArgs;
}

export function isMcpToolSuccess(toolResult: McpToolResult): boolean {
  if (toolResult.isError) return false;
  const textContent = toolResult.content?.[0]?.text || "";
  return !(textContent.includes('"success": false') || textContent.includes('"error"'));
}

export function makeMcpToolExecutor(
  mcpClient: Client,
  sessionDir: string,
  options: {
    argDefaults?: Record<string, Record<string, unknown>>;
    clientName: string;
  },
) {
  return async (name: string, args: Record<string, unknown>) => {
    const cleanArgs = resolveArgsToSessionDir(args, sessionDir);
    // Apply per-tool argument defaults from config (e.g. forcing allow_overwrite
    // on a tool's `save`). Config-declared defaults win over model-supplied args,
    // matching the prior hardcoded forceSaveOverwrite behavior.
    const defaults = options.argDefaults?.[name];
    if (defaults) {
      Object.assign(cleanArgs, defaults);
    }
    const toolResult = await withTimeout(
      mcpClient.callTool({ name, arguments: cleanArgs }),
      MCP_TOOL_TIMEOUT_MS,
      `MCP tool call to '${name}' on client '${options.clientName}' timed out after ${MCP_TOOL_TIMEOUT_MS}ms`,
    );
    return {
      result: { result: (toolResult as McpToolResult).content },
      hadError: !isMcpToolSuccess(toolResult as McpToolResult),
    };
  };
}

/**
 * Unified, config-driven agentic loop. Every competitor — whether the bundled
 * adeu/safe-docx pair or a third party's own MCP server — runs through this one
 * function. Tool-specific behavior is supplied entirely by `tool` (launch spec,
 * display name, per-tool argument defaults), so adding a competitor requires no
 * code changes, only an entry in benchmark.tools.json.
 */
export async function runToolLoop(
  gemini: GoogleGenAI,
  modelName: string,
  docPath: string,
  scenarioId: string,
  taskDescription: string,
  tool: ResolvedToolConfig,
  companionFiles: string[] = [],
  inputFiles: string[] = [],
  thinkAloud = false,
): Promise<LoopResult> {
  logInfo(tool.displayName, `Initializing loop session for scenario '${scenarioId}'...`);

  cleanTempDirOnStartup();

  const tempDir = getTempDirPath();
  const sessionDir = path.join(
    tempDir,
    `session_${performance.now()}_${Math.random().toString(36).substring(2, 8)}`,
  );
  fs.mkdirSync(sessionDir, { recursive: true });

  const docFileName = path.basename(docPath);
  const tempFilePath = path.join(sessionDir, docFileName).replace(/\\/g, "/");
  fs.copyFileSync(docPath, tempFilePath);

  // Copy every companion (editable) and input (read-only) doc into the isolated
  // session so the model can read/edit them by basename. The path-isolation guard
  // rewrites .docx args to this session dir, so basenames resolve here.
  const copyCompanion = (sourcePath: string): string | undefined => {
    const resolvedSource = path.resolve(sourcePath);
    if (!fs.existsSync(resolvedSource)) {
      logWarn(tool.displayName, `Companion/input file not found, skipping: ${resolvedSource}`);
      return undefined;
    }
    const base = path.basename(resolvedSource);
    const dest = path.join(sessionDir, base).replace(/\\/g, "/");
    fs.copyFileSync(resolvedSource, dest);
    return base;
  };
  const editableCompanions = companionFiles.map(copyCompanion).filter((b): b is string => !!b);
  const inputDocs = inputFiles.map(copyCompanion).filter((b): b is string => !!b);

  const { mcpClient, tools: mcpTools } = await connectMcpClient(
    { command: tool.command, args: tool.args, env: tool.env },
    `${tool.id}-benchmark-client`,
  );

  const systemPrompt = buildSystemPrompt({
    toolDisplayName: tool.displayName,
    docFileName,
    editableCompanions,
    inputDocs,
    taskDescription,
  });
  const originalDoc = await DocumentObject.load(fs.readFileSync(docPath));
  let resolvedFinalFilePath = tempFilePath;

  const result = await runAgenticLoop({
    gemini,
    modelName,
    systemPrompt,
    maxTurns: MAX_TURNS,
    thinkAloud,
    tools: [...mapToGeminiTools(mcpTools), COMPLETE_TASK_TOOL],
    loopName: tool.displayName,
    executeTool: makeMcpToolExecutor(mcpClient, sessionDir, {
      argDefaults: tool.argDefaults,
      clientName: tool.id,
    }),
    checkSuccess: async (turn, finalFilenames) => {
      let primaryPath = tempFilePath;
      if (finalFilenames && finalFilenames.length > 0) {
        for (const filename of finalFilenames) {
          const base = path.basename(filename);
          const resolvedPath = path.join(sessionDir, base).replace(/\\/g, "/");
          if (!fs.existsSync(resolvedPath)) {
            continue;
          }
          if (base.toLowerCase().includes("dpa") && base !== "dpa-module.docx") {
            const stdDpaPath = path.join(sessionDir, "dpa-module.docx").replace(/\\/g, "/");
            fs.copyFileSync(resolvedPath, stdDpaPath);
          } else {
            primaryPath = resolvedPath;
          }
        }
      }
      resolvedFinalFilePath = primaryPath;
      if (!fs.existsSync(primaryPath)) {
        logWarn(
          tool.displayName,
          `[complete_task] Primary final file does not exist: ${primaryPath}`,
        );
        return false;
      }
      const currentBuffer = fs.readFileSync(primaryPath);
      const currentDoc = await DocumentObject.load(currentBuffer);
      return checkScenarioSuccess(scenarioId, originalDoc, currentDoc, primaryPath);
    },
    getFinalBuffer: async () => {
      return fs.existsSync(resolvedFinalFilePath)
        ? fs.readFileSync(resolvedFinalFilePath)
        : fs.existsSync(tempFilePath)
          ? fs.readFileSync(tempFilePath)
          : fs.readFileSync(docPath);
    },
    cleanup: async () => {
      await mcpClient.close();
    },
  });

  return { ...result, tempFilePath };
}

/**
 * Backward-compatible wrappers around {@link runToolLoop} for the two bundled
 * paradigms. Kept so existing tests and call sites continue to work unchanged.
 */
export async function runSafeDocxLoop(
  gemini: GoogleGenAI,
  modelName: string,
  docPath: string,
  scenarioId: string,
  taskDescription: string,
): Promise<LoopResult> {
  return runToolLoop(gemini, modelName, docPath, scenarioId, taskDescription, {
    id: "safe-docx",
    displayName: "Safe Docx MCP",
    command: "npx",
    args: ["-y", "@usejunior/safe-docx"],
    argDefaults: { save: { allow_overwrite: true } },
  });
}

export async function runAdeuLoop(
  gemini: GoogleGenAI,
  modelName: string,
  docPath: string,
  scenarioId: string,
  taskDescription: string,
): Promise<LoopResult> {
  return runToolLoop(gemini, modelName, docPath, scenarioId, taskDescription, {
    id: "adeu",
    displayName: "Adeu MCP",
    command: "npx",
    args: ["-y", "@adeu/mcp-server", "--scope", "docx"],
  });
}
