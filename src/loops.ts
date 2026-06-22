import * as fs from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { GoogleGenerativeAI, Content, FunctionDeclaration, Part } from "@google/generative-ai";
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
}

export interface UnifiedLoopConfig {
  gemini: GoogleGenerativeAI;
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

export const MAX_TURNS = 10;

export async function runUnifiedAgenticLoop(config: UnifiedLoopConfig): Promise<LoopResult> {
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
    `${getLoopTimestamp()} [INFO] [${loopName || "Loop"}] Configuring model client: ${modelName}`,
  );
  const modelInstance = gemini.getGenerativeModel(
    {
      model: modelName,
      generationConfig: { temperature: 0.0 },
      tools: tools.length > 0 ? [{ functionDeclarations: tools }] : undefined,
    },
    { timeout: GEMINI_TIMEOUT_MS },
  );

  const contents: Content[] = [
    {
      role: "user",
      parts: [{ text: systemPrompt }],
    },
  ];

  let tokensIn = 0;
  let tokensOut = 0;
  let roundTrips = 0;
  let turnsToSuccess = 0;
  let errorTurns = 0;
  let recoveryTurns = 0;
  let previousTurnHadError = false;
  let success = false;

  let schemaTokensPerTurn = 0;
  if (tools.length > 0) {
    try {
      console.log(
        `${getLoopTimestamp()} [INFO] [${loopName || "Loop"}] Estimating tool schema token footprint...`,
      );
      const modelNoTools = gemini.getGenerativeModel({ model: modelName });
      const modelWithTools = gemini.getGenerativeModel({
        model: modelName,
        tools: [{ functionDeclarations: tools }],
      });
      const testContent = [{ role: "user", parts: [{ text: "hello" }] }];
      const countNoTools = await modelNoTools.countTokens({ contents: testContent });
      const countWithTools = await modelWithTools.countTokens({ contents: testContent });
      schemaTokensPerTurn = Math.max(0, countWithTools.totalTokens - countNoTools.totalTokens);
      console.log(
        `${getLoopTimestamp()} [INFO] [${loopName || "Loop"}] Estimated Schema Tokens per Turn: ${schemaTokensPerTurn}`,
      );
    } catch {
      schemaTokensPerTurn = 2500;
    }
  }

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
        `${getLoopTimestamp()} [INFO] ${prefix} Calling generateContent... (Timeout configured: ${GEMINI_TIMEOUT_MS}ms)`,
      );
      const geminiResponse = await withTimeout(
        modelInstance.generateContent({ contents }),
        GEMINI_TIMEOUT_MS,
        `Gemini API call timed out after ${GEMINI_TIMEOUT_MS}ms`,
      ).catch((err) => {
        console.error(
          `${getLoopTimestamp()} \x1b[31m[ERROR] ${prefix} generateContent failed or was aborted!\x1b[0m`,
        );
        throw err;
      });

      console.log(
        `${getLoopTimestamp()} [INFO] ${prefix} generateContent call returned successfully.`,
      );

      const promptTokensThisTurn = geminiResponse.response.usageMetadata?.promptTokenCount || 0;
      const candidatesTokensThisTurn =
        geminiResponse.response.usageMetadata?.candidatesTokenCount || 0;

      tokensIn += promptTokensThisTurn;
      tokensOut += candidatesTokensThisTurn;

      const sTokens = Math.min(schemaTokensPerTurn, promptTokensThisTurn);
      const hTokens = Math.min(historyAccumulated, promptTokensThisTurn - sTokens);
      const nTokens = promptTokensThisTurn - sTokens - hTokens;

      schemaTokens += sTokens;
      historyTokens += hTokens;
      newContentTokens += nTokens;
      historyAccumulated = hTokens + nTokens + candidatesTokensThisTurn;

      const parts = geminiResponse.response.candidates?.[0]?.content?.parts || [];
      const functionCalls = geminiResponse.response.functionCalls() || [];

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

      for (const fc of functionCalls) {
        try {
          console.log(
            `${getLoopTimestamp()} [INFO] ${prefix} Initiating Tool Call: '${fc.name}'...`,
          );
          const toolResult = await executeTool(fc.name, fc.args as Record<string, unknown>, turn);
          if (toolResult.hadError) currentTurnHadError = true;
          functionResponses.push({
            name: fc.name,
            response: toolResult.error
              ? { error: toolResult.error }
              : (toolResult.result as Record<string, unknown>),
          });
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
          resStr && resStr.length > 250 ? resStr.substring(0, 250) + "..." : resStr;

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

      try {
        console.log(
          `${getLoopTimestamp()} [INFO] ${prefix} Evaluating success criteria at turn boundary...`,
        );
        const isSuccessNow = await checkSuccess(turn);
        if (isSuccessNow && !success) {
          console.log(
            `${getLoopTimestamp()} [INFO] ${prefix} Success criteria achieved at Turn ${turn}!`,
          );
          success = true;
          turnsToSuccess = turn;
        } else {
          console.log(
            `${getLoopTimestamp()} [INFO] ${prefix} Success criteria evaluation: ${isSuccessNow ? "ACHIEVED" : "NOT YET ACHIEVED"}`,
          );
        }
      } catch {
        // ignore
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
  };
}

export async function connectMcpClient(packageName: string, clientName: string) {
  console.log(
    `${getLoopTimestamp()} [INFO] Connecting to MCP Server package '${packageName}' (client: '${clientName}')...`,
  );
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", packageName],
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

export function bindArgsToTempPath(
  args: Record<string, unknown>,
  properties: Record<string, unknown>,
  tempFilePath: string,
): Record<string, unknown> {
  const cleanArgs = { ...args };
  for (const key of [
    "file_path",
    "path",
    "save_to_local_path",
    "original_docx_path",
    "output_path",
    "docx_path",
    "original_path",
    "modified_path",
  ]) {
    if (key in properties) {
      const origValue = String(args[key] || "");
      if (origValue.toLowerCase().includes("dpa")) {
        cleanArgs[key] = tempFilePath.replace(".docx", "_dpa.docx");
      } else {
        cleanArgs[key] = tempFilePath;
      }
    }
  }
  return cleanArgs;
}

export function isMcpToolSuccess(toolResult: McpToolResult): boolean {
  if (toolResult.isError) return false;
  const textContent = toolResult.content?.[0]?.text || "";
  return !(textContent.includes('"success": false') || textContent.includes('"error"'));
}

export function makeMcpToolExecutor(
  mcpClient: Client,
  mcpTools: McpTool[],
  tempFilePath: string,
  options: { forceSaveOverwrite?: boolean; clientName: string },
) {
  return async (name: string, args: Record<string, unknown>) => {
    const toolDef = mcpTools.find((t) => t.name === name);
    const cleanArgs = bindArgsToTempPath(
      args,
      (toolDef?.inputSchema?.properties as Record<string, unknown>) || {},
      tempFilePath,
    );
    if (options.forceSaveOverwrite && name === "save") {
      cleanArgs.allow_overwrite = true;
    }
    console.log(
      `${getLoopTimestamp()} [INFO] [${options.clientName}] Dispatching tool call '${name}'...`,
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
  gemini: GoogleGenerativeAI,
  modelName: string,
  docPath: string,
  scenarioId: string,
  taskDescription: string,
): Promise<LoopResult> {
  console.log(
    `${getLoopTimestamp()} [INFO] [Safe Docx Loop] Initializing loop session for scenario '${scenarioId}'...`,
  );

  const tempDir = getTempDirPath();
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  const tempFilePath = path.join(tempDir, `temp_safe_docx_rep_${performance.now()}.docx`);
  fs.copyFileSync(docPath, tempFilePath);

  let tempDpaPath: string | undefined = undefined;
  if (scenarioId === "multi-file-assembly") {
    tempDpaPath = tempFilePath.replace(".docx", "_dpa.docx");
    const dpaSourcePath = path.resolve(path.dirname(docPath), "dpa-module.docx");
    if (fs.existsSync(dpaSourcePath)) {
      fs.copyFileSync(dpaSourcePath, tempDpaPath);
    }
  }

  const { mcpClient, tools: mcpTools } = await connectMcpClient(
    "@usejunior/safe-docx",
    "benchmark-client",
  );
  const geminiTools = mapToGeminiTools(mcpTools);

  const systemPrompt = `You are an expert contract editor editing Microsoft Word documents (.docx) using the provided Safe Docx MCP tools.

Documents involved in this task:
- Primary Document: "${tempFilePath}"
${tempDpaPath ? `- Companion DPA Document: "${tempDpaPath}"` : ""}

Your task is: ${taskDescription}

You must be highly efficient and minimize the number of tool calls and conversation turns.
Verify your changes are saved to the correct paths using the 'save' tool before stopping.
If the task requires adding review feedback or comments, use the appropriate comment tools to anchor your observations to the relevant nodes.`;

  const originalDoc = await DocumentObject.load(fs.readFileSync(docPath));

  const result = await runUnifiedAgenticLoop({
    gemini,
    modelName,
    systemPrompt,
    maxTurns: MAX_TURNS,
    tools: geminiTools,
    loopName: "Safe Docx Loop",
    executeTool: makeMcpToolExecutor(mcpClient, mcpTools, tempFilePath, {
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
  gemini: GoogleGenerativeAI,
  modelName: string,
  docPath: string,
  scenarioId: string,
  taskDescription: string,
): Promise<LoopResult> {
  console.log(
    `${getLoopTimestamp()} [INFO] [Adeu Loop] Initializing loop session for scenario '${scenarioId}'...`,
  );

  const tempDir = getTempDirPath();
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  const tempFilePath = path.join(tempDir, `temp_adeu_rep_${performance.now()}.docx`);
  const docBuffer = fs.readFileSync(docPath);
  fs.writeFileSync(tempFilePath, docBuffer);

  let tempDpaPath: string | undefined = undefined;
  if (scenarioId === "multi-file-assembly") {
    tempDpaPath = tempFilePath.replace(".docx", "_dpa.docx");
    const dpaSourcePath = path.resolve(path.dirname(docPath), "dpa-module.docx");
    if (fs.existsSync(dpaSourcePath)) {
      fs.copyFileSync(dpaSourcePath, tempDpaPath);
    }
  }

  const { mcpClient, tools: mcpTools } = await connectMcpClient(
    "@adeu/mcp-server",
    "adeu-benchmark-client",
  );
  const geminiTools = mapToGeminiTools(mcpTools);

  const systemPrompt = `You are an expert contract editor editing Microsoft Word documents (.docx) using Adeu Virtual DOM.

Documents involved in this task:
- Primary Document: "${tempFilePath}"
${tempDpaPath ? `- Companion DPA Document: "${tempDpaPath}"` : ""}

Your task is: ${taskDescription}

Please observe the documents first, analyze the content, then perform modifications using your batch processing capabilities.
If the task requires adding review feedback or comments, attach comments to the appropriate targets.

CRITICAL INSTRUCTIONS FOR STOPPING:
1. Once you have verified that the text of your edits is present in the document, you MUST stop calling tools immediately. DO NOT call any more tools (do not call 'read_document' or 'apply_patch' again).
2. The CriticMarkup tags (such as '{++' and '++}' for inserted text, or '{--' and '--}' for deleted text) represent the track changes of your edits. These are normal, expected, and correct.
3. Even if the 'read_document' output shows complex tracked changes (such as headings or paragraph breaks marked as deleted, split, or inserted), DO NOT attempt to "clean up", "fix", accept, or reject these tracked changes. DO NOT make any further edits to improve formatting or structure.
4. As long as your text is in the document, simply output a final message in plain text confirming that the task is complete. This will end your turn.`;

  const originalDoc = await DocumentObject.load(docBuffer);

  const result = await runUnifiedAgenticLoop({
    gemini,
    modelName,
    systemPrompt,
    maxTurns: MAX_TURNS,
    tools: geminiTools,
    loopName: "Adeu Loop",
    executeTool: makeMcpToolExecutor(mcpClient, mcpTools, tempFilePath, {
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
