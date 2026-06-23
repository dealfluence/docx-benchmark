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

export interface UnifiedLoopConfig {
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
  checkSuccess: (turn: number) => Promise<boolean>;
  getFinalBuffer: () => Promise<Buffer>;
  cleanup?: () => Promise<void>;
  loopName?: string;
}

const getLoopTimestamp = () => `[${new Date().toISOString()}]`;

export const MAX_TURNS = 20;

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
      console.log(
        `${getLoopTimestamp()} [INFO] Cleaned stale session directories under: ${tempDir}`,
      );
    } else {
      fs.mkdirSync(tempDir, { recursive: true });
    }
  } catch (err) {
    console.warn(`${getLoopTimestamp()} [WARNING] Failed to clean temp dir: ${err}`);
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

      console.warn(
        `[${new Date().toISOString()}] [WARNING] generateContent call failed on attempt ${attempt}/${maxRetries} (Error: ${errorMessage}). Retrying in ${delay}ms...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
  throw new Error("generateContent failed after maximum retries");
}

export async function runAgenticLoop(config: UnifiedLoopConfig): Promise<LoopResult> {
  const {
    gemini,
    modelName,
    systemPrompt,
    maxTurns,
    tools,
    executeTool,
    checkSuccess,
    getFinalBuffer,
    cleanup,
    loopName,
  } = config;

  console.log(
    `${getLoopTimestamp()} [INFO] [${loopName || "Loop"}] Initializing model client: ${modelName}`,
  );

  const contents: Content[] = [
    {
      role: "user",
      parts: [{ text: "Please analyze the loaded document and proceed with the specified task." }],
    },
  ];

  let tokensIn = 0;
  let tokensOut = 0;
  let roundTrips = 0;
  let turnsToSuccess = 0;
  let errorTurns = 0;
  let recoveryTurns = 0;
  let completeTaskCalls = 0;
  let previousTurnHadError = false;
  let success = false;

  const schemaTokensPerTurn: number =
    tools.length > 0 ? await estimateSchemaTokensPerTurn(loopName, gemini, modelName, tools) : 0;

  let schemaTokens = 0;
  let historyTokens = 0;
  let newContentTokens = 0;
  let historyAccumulated = 0;
  let finalBuffer: Buffer | null = null;

  try {
    for (let turn = 1; turn <= maxTurns; turn++) {
      const prefix = loopName ? `[${loopName} Turn ${turn}]` : `[Loop Turn ${turn}]`;
      const isVerbose = process.argv.includes("--verbose");
      if (isVerbose) {
        console.log(
          `${getLoopTimestamp()} \x1b[36m${prefix}\x1b[0m Sending prompt content length: ${contents.length} messages.`,
        );
      }

      console.log(
        `${getLoopTimestamp()} [INFO] ${prefix} Dispatching API call (timeout: ${GEMINI_TIMEOUT_MS}ms)...`,
      );
      const geminiResponse = await generateContentWithRetry(
        gemini,
        modelName,
        contents,
        systemPrompt,
        tools,
      ).catch((err) => {
        console.error(
          `${getLoopTimestamp()} \x1b[31m[ERROR] ${prefix} generateContent failed or was aborted!\x1b[0m`,
        );
        throw err;
      });

      console.log(
        `${getLoopTimestamp()} [INFO] ${prefix} generateContent call returned successfully.`,
      );

      const promptTokensThisTurn = geminiResponse.usageMetadata?.promptTokenCount || 0;
      const candidatesTokensThisTurn = geminiResponse.usageMetadata?.candidatesTokenCount || 0;

      tokensIn += promptTokensThisTurn;
      tokensOut += candidatesTokensThisTurn;

      const sTokens = Math.min(schemaTokensPerTurn, promptTokensThisTurn);
      const hTokens = Math.min(historyAccumulated, promptTokensThisTurn - sTokens);
      const nTokens = promptTokensThisTurn - sTokens - hTokens;

      schemaTokens += sTokens;
      historyTokens += hTokens;
      newContentTokens += nTokens;
      historyAccumulated = hTokens + nTokens + candidatesTokensThisTurn;

      console.log(
        `${getLoopTimestamp()} [INFO] ${prefix} Turn Metrics: [Tokens In: ${promptTokensThisTurn} (Schema: ${sTokens}, History: ${hTokens}, New Content: ${nTokens}) | Tokens Out: ${candidatesTokensThisTurn}]`,
      );
      console.log(
        `${getLoopTimestamp()} [INFO] ${prefix} Cumulative Totals: [Tokens In: ${tokensIn} | Tokens Out: ${tokensOut} | Total: ${tokensIn + tokensOut}]`,
      );

      const parts = geminiResponse.candidates?.[0]?.content?.parts || [];
      const functionCalls = geminiResponse.functionCalls || [];

      if (isVerbose) {
        console.log(
          `${getLoopTimestamp()} \x1b[36m${prefix}\x1b[0m Model generated ${parts.length} parts and ${functionCalls.length} function calls.`,
        );
      }

      if (functionCalls.length === 0) {
        console.log(
          `${getLoopTimestamp()} [INFO] ${prefix} No function calls generated. Breaking loop (Task is finalized).`,
        );
        break;
      }

      roundTrips++;
      contents.push({ role: "model", parts });

      const functionResponses: Array<{ name: string; response: Record<string, unknown> }> = [];
      let currentTurnHadError = false;
      const turnStart = performance.now();
      let shouldExitSucceeded = false;

      ({ completeTaskCalls, success, turnsToSuccess, shouldExitSucceeded, currentTurnHadError } =
        await handleFunctionCalls(
          functionCalls,
          prefix,
          completeTaskCalls,
          checkSuccess,
          turn,
          success,
          turnsToSuccess,
          shouldExitSucceeded,
          functionResponses,
          currentTurnHadError,
          executeTool,
          turnStart,
          parts,
          loopName,
        ));

      contents.push({
        role: "user",
        parts: functionResponses.map((fr) => ({ functionResponse: fr })),
      });

      if (currentTurnHadError) {
        errorTurns++;
      } else if (previousTurnHadError) {
        recoveryTurns++;
      }
      previousTurnHadError = currentTurnHadError;

      if (shouldExitSucceeded) {
        break;
      }
    }
  } finally {
    try {
      finalBuffer = await getFinalBuffer();
    } catch {
      // ignore
    }
    if (cleanup) await cleanup();
  }

  const recoveryRate = errorTurns > 0 ? recoveryTurns / errorTurns : 0;

  return {
    tokensIn,
    tokensOut,
    roundTrips,
    turnsToSuccess: success ? turnsToSuccess : maxTurns,
    recoveryRate,
    finalBuffer: finalBuffer || Buffer.alloc(0),
    success,
    schemaTokens,
    historyTokens,
    newContentTokens,
    completeTaskCalls,
  };
}

async function handleFunctionCalls(
  functionCalls: FunctionCall[],
  prefix: string,
  completeTaskCalls: number,
  checkSuccess: (turn: number) => Promise<boolean>,
  turn: number,
  success: boolean,
  turnsToSuccess: number,
  shouldExitSucceeded: boolean,
  functionResponses: { name: string; response: Record<string, unknown> }[],
  currentTurnHadError: boolean,
  executeTool: (
    name: string,
    args: Record<string, unknown>,
    turn: number,
  ) => Promise<{ result?: unknown; error?: string; hadError: boolean }>,
  turnStart: number,
  parts: Part[],
  loopName: string | undefined,
) {
  for (const fc of functionCalls) {
    if (!fc.name) {
      console.warn(
        `${getLoopTimestamp()} [WARNING] ${prefix} Skipping anonymous or invalid function call.`,
      );
      continue;
    }
    const toolName = fc.name;
    try {
      if (toolName === "complete_task") {
        completeTaskCalls++;
        ({ success, turnsToSuccess, shouldExitSucceeded, currentTurnHadError } =
          await handleCompleteTaskCall(
            prefix,
            checkSuccess,
            turn,
            success,
            turnsToSuccess,
            shouldExitSucceeded,
            functionResponses,
            toolName,
            currentTurnHadError,
          ));
      } else {
        console.log(
          `${getLoopTimestamp()} [INFO] ${prefix} Initiating Tool Call: '${fc.name}' with args: ${JSON.stringify(fc.args)}...`,
        );
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
      console.error(
        `${getLoopTimestamp()} \x1b[31m[ERROR] ${prefix} Exception occurred inside tool '${fc.name}':\x1b[0m`,
        errMsg,
      );
      if (err instanceof Error && err.stack) {
        console.error(`Stack trace:\n${err.stack}`);
      }
      functionResponses.push({
        name: fc.name,
        response: { error: errMsg },
      });
    }

    const elapsedMs = Math.round(performance.now() - turnStart);
    const resObj = functionResponses[functionResponses.length - 1]?.response;
    const resStr = JSON.stringify(resObj);

    // Truncate the raw stringified tool response for safe logging
    const truncatedResult =
      resStr && resStr.length > 350 ? resStr.substring(0, 350) + "..." : resStr;

    // Extract any reasoning text from the current turn response parts
    const reasoningText = parts
      .filter((p: Part) => p.text)
      .map((p: Part) => p.text!.trim())
      .join("\n");

    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        turn,
        paradigm: loopName,
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
  return { completeTaskCalls, success, turnsToSuccess, shouldExitSucceeded, currentTurnHadError };
}

async function handleCompleteTaskCall(
  prefix: string,
  checkSuccess: (turn: number) => Promise<boolean>,
  turn: number,
  success: boolean,
  turnsToSuccess: number,
  shouldExitSucceeded: boolean,
  functionResponses: { name: string; response: Record<string, unknown> }[],
  toolName: string,
  currentTurnHadError: boolean,
) {
  console.log(
    `${getLoopTimestamp()} [INFO] ${prefix} [complete_task] Intercepting task submission. Checking validation gate...`,
  );
  const isSuccessNow = await checkSuccess(turn);
  if (isSuccessNow) {
    console.log(
      `${getLoopTimestamp()} [INFO] ${prefix} [complete_task] Validation gate PASSED! Recording success.`,
    );
    success = true;
    turnsToSuccess = turn;
    shouldExitSucceeded = true;
    functionResponses.push({
      name: toolName,
      response: {
        success: true,
        message: "Submission accepted. All validation checks passed.",
      },
    });
  } else {
    console.log(
      `${getLoopTimestamp()} [INFO] ${prefix} [complete_task] Validation gate FAILED. Rejecting submission with linter feedback.`,
    );
    currentTurnHadError = true;
    functionResponses.push({
      name: toolName,
      response: {
        success: false,
        error:
          "Submission Rejected: The validation gate failed. Your document does not yet satisfy all task criteria. Please ensure all requested edits are correctly applied, saved to disk, and no placeholders remain before re-submitting.",
      },
    });
  }
  return { success, turnsToSuccess, shouldExitSucceeded, currentTurnHadError };
}

async function estimateSchemaTokensPerTurn(
  loopName: string | undefined,
  gemini: GoogleGenAI,
  modelName: string,
  tools: FunctionDeclaration[],
) {
  console.log(
    `${getLoopTimestamp()} [INFO] [${loopName || "Loop"}] Estimating tool schema token footprint using modern client...`,
  );
  const testContent = [{ role: "user", parts: [{ text: "hello" }] }];
  const countNoTools = await gemini.models.countTokens({
    model: modelName,
    contents: testContent,
  });
  const countWithTools = await gemini.models.countTokens({
    model: modelName,
    contents: testContent,
    config: { tools: [{ functionDeclarations: tools }] },
  });
  const schemaTokensPerTurn = Math.max(
    0,
    (countWithTools.totalTokens || 0) - (countNoTools.totalTokens || 0),
  );
  console.log(
    `${getLoopTimestamp()} [INFO] [${loopName || "Loop"}] Estimated Schema Tokens per Turn: ${schemaTokensPerTurn}`,
  );
  return schemaTokensPerTurn;
}

export async function connectMcpClient(
  packageName: string,
  clientName: string,
  extraArgs: string[] = [],
) {
  console.log(
    `${getLoopTimestamp()} [INFO] Connecting to MCP Server package '${packageName}' (client: '${clientName}')...`,
  );
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", packageName, ...extraArgs],
  });
  const mcpClient = new Client({ name: clientName, version: "1.0.0" }, { capabilities: {} });
  await withTimeout(
    mcpClient.connect(transport),
    MCP_CONNECT_TIMEOUT_MS,
    `${clientName} connection timed out after ${MCP_CONNECT_TIMEOUT_MS}ms`,
  );
  console.log(
    `${getLoopTimestamp()} [INFO] Connection handshake completed with MCP Server '${clientName}'.`,
  );

  console.log(
    `${getLoopTimestamp()} [INFO] Retrieving tool registrations from MCP Server '${clientName}'...`,
  );
  const toolsResponse = await withTimeout(
    mcpClient.listTools(),
    MCP_TOOL_TIMEOUT_MS,
    `${clientName} listTools timed out after ${MCP_TOOL_TIMEOUT_MS}ms`,
  );
  console.log(
    `${getLoopTimestamp()} [INFO] Successfully listed ${toolsResponse.tools.length} tool(s) from MCP Server '${clientName}'.`,
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
  options: { forceSaveOverwrite?: boolean; clientName: string },
) {
  return async (name: string, args: Record<string, unknown>) => {
    const cleanArgs = resolveArgsToSessionDir(args, sessionDir);
    if (options.forceSaveOverwrite && name === "save") {
      cleanArgs.allow_overwrite = true;
    }
    console.log(
      `${getLoopTimestamp()} [INFO] [${options.clientName}] Dispatching tool call '${name}' with args: ${JSON.stringify(cleanArgs)}...`,
    );
    const toolResult = await withTimeout(
      mcpClient.callTool({ name, arguments: cleanArgs }),
      MCP_TOOL_TIMEOUT_MS,
      `MCP tool call to '${name}' on client '${options.clientName}' timed out after ${MCP_TOOL_TIMEOUT_MS}ms`,
    );
    console.log(
      `${getLoopTimestamp()} [INFO] [${options.clientName}] Tool call '${name}' returned with status.`,
    );
    return {
      result: { result: (toolResult as McpToolResult).content },
      hadError: !isMcpToolSuccess(toolResult as McpToolResult),
    };
  };
}

export async function runSafeDocxLoop(
  gemini: GoogleGenAI,
  modelName: string,
  docPath: string,
  scenarioId: string,
  taskDescription: string,
): Promise<LoopResult> {
  console.log(
    `${getLoopTimestamp()} [INFO] [Safe Docx Loop] Initializing loop session for scenario '${scenarioId}'...`,
  );

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

  let tempDpaPath: string | undefined = undefined;
  if (scenarioId === "multi-file-assembly") {
    const dpaSourcePath = path.resolve(path.dirname(docPath), "dpa-module.docx");
    if (fs.existsSync(dpaSourcePath)) {
      tempDpaPath = path.join(sessionDir, "dpa-module.docx").replace(/\\/g, "/");
      fs.copyFileSync(dpaSourcePath, tempDpaPath);
    }
  }

  const { mcpClient, tools: mcpTools } = await connectMcpClient(
    "@usejunior/safe-docx",
    "benchmark-client",
  );
  const geminiTools = [...mapToGeminiTools(mcpTools), COMPLETE_TASK_TOOL];

  const systemPrompt = `You are an expert contract editor editing Microsoft Word documents (.docx) using the provided Safe Docx MCP tools.

Documents involved in this task:
- Primary Document: "${docFileName}"
${tempDpaPath ? `- Companion DPA Document: "dpa-module.docx"` : ""}

Your task is: ${taskDescription}

You must be highly efficient and minimize the number of tool calls and conversation turns.
Verify your changes are saved to the correct paths using the 'save' tool before stopping.
If the task requires adding review feedback or comments, use the appropriate comment tools to anchor your observations to the relevant nodes.

CRITICAL INSTRUCTIONS FOR SUBMISSION:
1. You MUST explicitly call the 'complete_task' tool to submit your work and finalize the task. Simply writing a final message in plain text will NOT complete the task.
2. If your submission fails the validation gate, you will receive structured linter feedback. Analyze the feedback, correct the document, and call 'complete_task' again once ready.`;

  const originalDoc = await DocumentObject.load(fs.readFileSync(docPath));

  const result = await runAgenticLoop({
    gemini,
    modelName,
    systemPrompt,
    maxTurns: MAX_TURNS,
    tools: geminiTools,
    loopName: "Safe Docx Loop",
    executeTool: makeMcpToolExecutor(mcpClient, sessionDir, {
      forceSaveOverwrite: true,
      clientName: "Safe-Docx",
    }),
    checkSuccess: async () => {
      const currentBuffer = fs.readFileSync(tempFilePath);
      const currentDoc = await DocumentObject.load(currentBuffer);
      return checkScenarioSuccess(scenarioId, originalDoc, currentDoc, tempFilePath);
    },
    getFinalBuffer: async () => {
      return fs.existsSync(tempFilePath) ? fs.readFileSync(tempFilePath) : fs.readFileSync(docPath);
    },
    cleanup: async () => {
      await mcpClient.close();
    },
  });

  return { ...result, tempFilePath };
}

export async function runAdeuLoop(
  gemini: GoogleGenAI,
  modelName: string,
  docPath: string,
  scenarioId: string,
  taskDescription: string,
): Promise<LoopResult> {
  console.log(
    `${getLoopTimestamp()} [INFO] [Adeu Loop] Initializing loop session for scenario '${scenarioId}'...`,
  );

  cleanTempDirOnStartup();

  const tempDir = getTempDirPath();
  const sessionDir = path.join(
    tempDir,
    `session_${performance.now()}_${Math.random().toString(36).substring(2, 8)}`,
  );
  fs.mkdirSync(sessionDir, { recursive: true });

  const docBuffer = fs.readFileSync(docPath);
  const docFileName = path.basename(docPath);
  const tempFilePath = path.join(sessionDir, docFileName).replace(/\\/g, "/");
  fs.writeFileSync(tempFilePath, docBuffer);

  let tempDpaPath: string | undefined = undefined;
  if (scenarioId === "multi-file-assembly") {
    const dpaSourcePath = path.resolve(path.dirname(docPath), "dpa-module.docx");
    if (fs.existsSync(dpaSourcePath)) {
      tempDpaPath = path.join(sessionDir, "dpa-module.docx").replace(/\\/g, "/");
      fs.copyFileSync(dpaSourcePath, tempDpaPath);
    }
  }

  const { mcpClient, tools: mcpTools } = await connectMcpClient(
    "@adeu/mcp-server",
    "adeu-benchmark-client",
    ["--scope", "docx"],
  );
  const geminiTools = [...mapToGeminiTools(mcpTools), COMPLETE_TASK_TOOL];

  const systemPrompt = `You are an expert contract editor editing Microsoft Word documents (.docx) using Adeu Virtual DOM.

Documents involved in this task:
- Primary Document: "${docFileName}"
${tempDpaPath ? `- Companion DPA Document: "dpa-module.docx"` : ""}

Your task is: ${taskDescription}

Please observe the documents first, analyze the content, then perform modifications using your batch processing capabilities.
If the task requires adding review feedback or comments, attach comments to the appropriate targets.

CRITICAL INSTRUCTIONS FOR SUBMISSION:
1. Once you have verified that the text of your edits is present in the document, you MUST explicitly call the 'complete_task' tool to submit your work and finalize the task. Simply writing a final message in plain text will NOT complete the task.
2. The CriticMarkup tags (such as '{++' and '++}' for inserted text, or '{--' and '--}' for deleted text) represent the track changes of your edits. These are normal, expected, and correct.
3. Even if the 'read_document' output shows complex tracked changes (such as headings or paragraph breaks marked as deleted, split, or inserted), DO NOT attempt to "clean up", "fix", accept, or reject these tracked changes. DO NOT make any further edits to improve formatting or structure.
4. If your submission fails the validation gate, you will receive structured linter feedback. Analyze the feedback, correct the document, and call 'complete_task' again once ready.`;

  const originalDoc = await DocumentObject.load(docBuffer);

  const result = await runAgenticLoop({
    gemini,
    modelName,
    systemPrompt,
    maxTurns: MAX_TURNS,
    tools: geminiTools,
    loopName: "Adeu Loop",
    executeTool: makeMcpToolExecutor(mcpClient, sessionDir, {
      forceSaveOverwrite: false,
      clientName: "Adeu-MCP",
    }),
    checkSuccess: async () => {
      const currentBuffer = fs.readFileSync(tempFilePath);
      const currentDoc = await DocumentObject.load(currentBuffer);
      return checkScenarioSuccess(scenarioId, originalDoc, currentDoc, tempFilePath);
    },
    getFinalBuffer: async () => {
      return fs.existsSync(tempFilePath) ? fs.readFileSync(tempFilePath) : docBuffer;
    },
    cleanup: async () => {
      await mcpClient.close();
    },
  });

  return { ...result, tempFilePath };
}
