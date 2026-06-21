import * as fs from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { GoogleGenerativeAI, Content, FunctionDeclaration, Part } from "@google/generative-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DocumentObject } from "@adeu/core";
import { checkScenarioSuccess } from "./success.js";
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
      const modelNoTools = gemini.getGenerativeModel({ model: modelName });
      const modelWithTools = gemini.getGenerativeModel({
        model: modelName,
        tools: [{ functionDeclarations: tools }],
      });
      const testContent = [{ role: "user", parts: [{ text: "hello" }] }];
      const countNoTools = await modelNoTools.countTokens({ contents: testContent });
      const countWithTools = await modelWithTools.countTokens({ contents: testContent });
      schemaTokensPerTurn = Math.max(0, countWithTools.totalTokens - countNoTools.totalTokens);
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
          `\x1b[36m${prefix}\x1b[0m Sending prompt content length: ${contents.length} messages.`,
        );
      }

      const geminiResponse = await withTimeout(
        modelInstance.generateContent({ contents }),
        GEMINI_TIMEOUT_MS,
        `Gemini API call timed out after ${GEMINI_TIMEOUT_MS}ms`,
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
          `\x1b[36m${prefix}\x1b[0m Model generated ${parts.length} parts and ${functionCalls.length} function calls.`,
        );
      }

      if (functionCalls.length === 0) {
        if (isVerbose) {
          console.log(`\x1b[36m${prefix}\x1b[0m No function calls generated. Breaking loop.`);
        }
        break;
      }

      roundTrips++;
      contents.push({ role: "model", parts });

      const functionResponses: Array<{ name: string; response: Record<string, unknown> }> = [];
      let currentTurnHadError = false;
      const turnStart = performance.now();

      for (const fc of functionCalls) {
        try {
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
          console.error(`\x1b[31m${prefix} ERROR in Tool Response for ${fc.name}:\x1b[0m`, errMsg);
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
        const isSuccessNow = await checkSuccess(turn);
        if (isSuccessNow && !success) {
          success = true;
          turnsToSuccess = turn;
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
  const toolsResponse = await withTimeout(
    mcpClient.listTools(),
    MCP_TOOL_TIMEOUT_MS,
    `${clientName} listTools timed out after ${MCP_TOOL_TIMEOUT_MS}ms`,
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
  for (const key of ["file_path", "path", "save_to_local_path", "original_docx_path", "output_path"]) {
    if (key in properties) {
      cleanArgs[key] = tempFilePath;
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
    const toolResult = await mcpClient.callTool({ name, arguments: cleanArgs });
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
  const tempFilePath = path.resolve(`./temp_safe_docx_rep_${performance.now()}.docx`);
  fs.copyFileSync(docPath, tempFilePath);

  const { mcpClient, tools: mcpTools } = await connectMcpClient(
    "@usejunior/safe-docx",
    "benchmark-client",
  );
  const geminiTools = mapToGeminiTools(mcpTools);

  const systemPrompt = `You are an expert contract editor editing a Microsoft Word document (.docx) using the provided Safe Docx MCP tools.
The document is currently located at path: "${tempFilePath}".
Your task is: ${taskDescription}

You must be highly efficient and minimize the number of tool calls and conversation turns.
Follow this precise strategy:
1. Locate the content to change by calling 'grep' with a specific pattern. Do NOT read the entire document if not needed.
2. Edit the document content using 'replace_text' or 'batch_edit' (if multiple edits are needed). Ensure your edits are precise. If multiple edits are required, perform them in batch or in a single turn if possible.
   CRITICAL: If you use 'batch_edit', every object inside the 'steps' array MUST contain a unique, non-empty string 'step_id' (e.g. "step_1", "step_2").
3. Save the document by calling 'save' immediately after editing.
4. Stop calling tools once saved.

Do not re-read the entire document after editing unless strictly necessary. Do not wander or take unnecessary turns. Your goal is to finish the task in 2-3 turns.`;

  const originalDoc = await DocumentObject.load(fs.readFileSync(docPath));

  return runUnifiedAgenticLoop({
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
      return checkScenarioSuccess(scenarioId, originalDoc, currentDoc);
    },
    getFinalBuffer: async () => {
      return fs.existsSync(tempFilePath) ? fs.readFileSync(tempFilePath) : fs.readFileSync(docPath);
    },
    cleanup: async () => {
      await mcpClient.close();
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
    },
  });
}

export async function runAdeuLoop(
  gemini: GoogleGenerativeAI,
  modelName: string,
  docBuffer: Buffer,
  scenarioId: string,
  taskDescription: string,
): Promise<LoopResult> {
  const tempFilePath = path.resolve(`./temp_adeu_rep_${performance.now()}.docx`);
  fs.writeFileSync(tempFilePath, docBuffer);

  const { mcpClient, tools: mcpTools } = await connectMcpClient(
    "@adeu/mcp-server",
    "adeu-benchmark-client",
  );
  const geminiTools = mapToGeminiTools(mcpTools);

  const systemPrompt = `You are an expert contract editor editing a Microsoft Word document (.docx) using Adeu Virtual DOM.
The document is currently located at path: "${tempFilePath}".
Your task is: ${taskDescription}

Please observe the document first by calling the 'read_docx' tool, analyze the content, then perform edits by calling 'process_document_batch' with transactional modifications.

CRITICAL PARAMETER FORMAT RULES:
1. The 'changes' parameter in 'process_document_batch' is a native JSON array of objects. Do NOT double-serialize or pass JSON string strings inside the array.
   Correct format:
   "changes": [
     { "type": "modify", "target_text": "old text", "new_text": "new text" }
   ]
   Incorrect format:
   "changes": [
     "{\"type\": \"modify\", \"target_text\": \"old text\"}"
   ]

CRITICAL INSTRUCTIONS FOR STOPPING:
1. Once you have verified that the text of your edits is present in the document, you MUST stop calling tools immediately. DO NOT call any more tools (do not call 'read_document' or 'apply_patch' again).
2. The CriticMarkup tags (such as '{++' and '++}' for inserted text, or '{--' and '--}' for deleted text) represent the track changes of your edits. These are normal, expected, and correct.
3. Even if the 'read_document' output shows complex tracked changes (such as headings or paragraph breaks marked as deleted, split, or inserted), DO NOT attempt to "clean up", "fix", accept, or reject these tracked changes. DO NOT make any further edits to improve formatting or structure.
4. As long as your text is in the document, simply output a final message in plain text confirming that the task is complete. This will end your turn.`;

  const originalDoc = await DocumentObject.load(docBuffer);

  return runUnifiedAgenticLoop({
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
      return checkScenarioSuccess(scenarioId, originalDoc, currentDoc);
    },
    getFinalBuffer: async () => {
      return fs.existsSync(tempFilePath) ? fs.readFileSync(tempFilePath) : docBuffer;
    },
    cleanup: async () => {
      await mcpClient.close();
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
    },
  });
}
