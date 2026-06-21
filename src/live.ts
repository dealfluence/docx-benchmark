/* eslint-disable @typescript-eslint/no-explicit-any */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DOMParser } from "@xmldom/xmldom";
import { performance } from "node:perf_hooks";
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { DocumentObject, DocumentMapper, RedlineEngine } from "@adeu/core";
import { z } from "zod";
import dotenv from "dotenv";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { getGoldenDocxPath, XML_SYSTEM_PROMPT, ADEU_SYSTEM_PROMPT } from "./baselines.js";
import { scenarios } from "./scenarios.js";
import { evaluateFidelity, createStrippedDoc, createXmlReconstructedDoc } from "./fidelity.js";
import { checkScenarioSuccess } from "./success.js";

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

// System prompts for each paradigm
export const MD_LIVE_SYSTEM_PROMPT = `You are an expert contract editor. You are provided with the document content in Markdown format.
Perform the requested edits and return the ENTIRE updated Markdown document. Do not truncate the document, as it must be completely round-tripped back to DOCX.
Ensure your response contains ONLY the Markdown text. Do not wrap it in any explanation.`;

// Timeout configuration (in milliseconds)
export const GEMINI_TIMEOUT_MS = process.env.GEMINI_TIMEOUT_MS
  ? parseInt(process.env.GEMINI_TIMEOUT_MS, 10)
  : 60000;
export const MCP_CONNECT_TIMEOUT_MS = process.env.MCP_CONNECT_TIMEOUT_MS
  ? parseInt(process.env.MCP_CONNECT_TIMEOUT_MS, 10)
  : 30000;
export const MCP_TOOL_TIMEOUT_MS = process.env.MCP_TOOL_TIMEOUT_MS
  ? parseInt(process.env.MCP_TOOL_TIMEOUT_MS, 10)
  : 30000;

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errMsg: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(errMsg)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// Zod schemas for validation
export const DocumentChangeSchema = z.union([
  z.object({
    type: z.literal("modify"),
    target_text: z.string(),
    new_text: z.string(),
  }),
  z.object({
    type: z.literal("accept"),
    target_id: z.string(),
  }),
  z.object({
    type: z.literal("reject"),
    target_id: z.string(),
  }),
  z.object({
    type: z.literal("reply"),
    target_id: z.string(),
    text: z.string(),
  }),
]);

export const AdeuOutputSchema = z.array(DocumentChangeSchema);

// Helper to validate XML syntax
export function validateXmlSyntax(rawOutput: string): boolean {
  try {
    const parser = new DOMParser({
      onError: () => {
        throw new Error("XML Parse Error");
      },
    });
    const xmlDoc = parser.parseFromString(rawOutput, "text/xml");
    return xmlDoc.getElementsByTagName("parsererror").length === 0;
  } catch {
    return false;
  }
}

// XML Search-and-Replace block parser
export function applyXmlSearchReplace(originalXml: string, responseText: string): string {
  const blockRegex =
    /<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/g;
  let matches = [...responseText.matchAll(blockRegex)];

  if (matches.length === 0) {
    const lenientRegex = /<<<<<<< SEARCH([\s\S]*?)=======\s*([\s\S]*?)>>>>>>> REPLACE/g;
    matches = [...responseText.matchAll(lenientRegex)];
  }

  if (matches.length === 0) {
    if (responseText.includes("<<<<<<< SEARCH")) {
      throw new Error("Found SEARCH/REPLACE headers but failed to parse them cleanly.");
    }
    return responseText; // Treat entire output as full XML
  }

  let patchedXml = originalXml;
  for (const match of matches) {
    const searchBlock = match[1];
    const replaceBlock = match[2];
    const normalizedSearch = searchBlock.replace(/\r\n/g, "\n").trim();

    if (patchedXml.includes(searchBlock)) {
      patchedXml = patchedXml.replace(searchBlock, replaceBlock);
    } else if (patchedXml.replace(/\r\n/g, "\n").includes(normalizedSearch)) {
      const originalLines = patchedXml.split(/\r?\n/);
      const searchLines = normalizedSearch.split("\n");
      let foundIndex = -1;
      for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
        let matchLines = true;
        for (let j = 0; j < searchLines.length; j++) {
          if (originalLines[i + j].trim() !== searchLines[j].trim()) {
            matchLines = false;
            break;
          }
        }
        if (matchLines) {
          foundIndex = i;
          break;
        }
      }

      if (foundIndex !== -1) {
        originalLines.splice(foundIndex, searchLines.length, replaceBlock);
        patchedXml = originalLines.join("\n");
      } else {
        patchedXml = patchedXml.replace(/\r\n/g, "\n").replace(normalizedSearch, replaceBlock);
      }
    } else {
      const searchTrimmed = searchBlock.trim();
      if (patchedXml.includes(searchTrimmed)) {
        patchedXml = patchedXml.replace(searchTrimmed, replaceBlock.trim());
      } else {
        throw new Error(`Could not find search block in the XML:\n${searchBlock}`);
      }
    }
  }
  return patchedXml;
}

// Clean up raw JSON response
export function cleanJsonResponse(raw: string): string {
  return raw
    .trim()
    .replace(/^```(json)?/i, "")
    .replace(/```$/, "")
    .trim();
}

type IntegrityStatus = "PASS" | "FAIL";

interface SingleTrialRun {
  repIndex: number;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  xmlIntegrity: IntegrityStatus;
  fidelity: number;
  xmlDelta: number;
  success: boolean;
  roundTrips: number;
  turnsToSuccess: number;
  recoveryRate: number;
  schemaTokens: number;
  historyTokens: number;
  newContentTokens: number;
  error?: string;
}

export interface LiveTrialSummary {
  provider: string;
  model: string;
  scenarioId: string;
  scenarioName: string;
  paradigm: "raw-xml" | "markdown-roundtrip" | "adeu" | "safe-docx";
  docSize: "small" | "large";
  supported: boolean;
  reps: number;
  latencyMeanMs: number;
  latencyMinMs: number;
  latencyMaxMs: number;
  tokensInMean: number;
  tokensInMin: number;
  tokensInMax: number;
  tokensOutMean: number;
  tokensOutMin: number;
  tokensOutMax: number;
  totalTokensMean: number;
  totalTokensMin: number;
  totalTokensMax: number;
  xmlDeltaMean: number;
  xmlDeltaMin: number;
  xmlDeltaMax: number;
  xmlIntegrityRate: string;
  fidelityMean: number;
  fidelityMin: number;
  fidelityMax: number;
  successRate: string;
  roundTripsMean: number;
  turnsToSuccessMean: number;
  recoveryRateMean: number;
  schemaTokensMean?: number;
  schemaTokensMin?: number;
  schemaTokensMax?: number;
  historyTokensMean?: number;
  historyTokensMin?: number;
  historyTokensMax?: number;
  newContentTokensMean?: number;
  newContentTokensMin?: number;
  newContentTokensMax?: number;
}

// Helper to convert lowercase string types to Gemini uppercase SchemaType
function mapSchemaType(type: string): SchemaType {
  return (SchemaType as any)[type.toUpperCase()] || SchemaType.STRING;
}

// Recursively clean and map any JSON Schema to the structure required by Gemini SDK
export function cleanSchema(schema: any): any {
  if (!schema) return undefined;
  const res: any = { ...schema };
  delete res.$schema;
  delete res.additionalProperties;

  const unionList = schema.anyOf || schema.oneOf;
  if (unionList) {
    const consolidatedProperties: any = {};
    const consolidatedRequired: string[] = [];
    let consolidatedType = "object";

    for (const sub of unionList) {
      const cleanedSub = cleanSchema(sub);
      if (cleanedSub.properties) {
        Object.assign(consolidatedProperties, cleanedSub.properties);
      }
      if (cleanedSub.required) {
        consolidatedRequired.push(...cleanedSub.required);
      }
      if (cleanedSub.type) {
        consolidatedType = cleanedSub.type;
      }
    }

    res.type = consolidatedType;
    res.properties = consolidatedProperties;
    const commonRequired = consolidatedRequired.filter((reqField) =>
      unionList.every((sub: any) => sub.required?.includes(reqField)),
    );
    if (commonRequired.length > 0) {
      res.required = commonRequired;
    } else {
      delete res.required;
    }
    delete res.anyOf;
    delete res.oneOf;
  }

  if (typeof res.type === "string") {
    res.type = mapSchemaType(res.type);
  }
  if (schema.properties) {
    res.properties = {};
    for (const key of Object.keys(schema.properties)) {
      res.properties[key] = cleanSchema(schema.properties[key]);
    }
  }
  if (schema.items) {
    res.items = cleanSchema(schema.items);
  }
  return res;
}

function getStats(arr: number[]) {
  const sum = arr.reduce((a, b) => a + b, 0);
  return {
    mean: sum / (arr.length || 1),
    min: Math.min(...arr),
    max: Math.max(...arr),
  };
}

function getFullTaskDescription(scenario: any): string {
  let desc = scenario.description;
  if (scenario.targetText || scenario.replacementText || scenario.reviewAction) {
    desc += `\nInstructions:\n`;
    if (scenario.targetText) desc += `- Find target text: "${scenario.targetText}"\n`;
    if (scenario.replacementText) desc += `- Replace with: "${scenario.replacementText}"\n`;
    if (scenario.reviewAction)
      desc += `- Review Action: ${JSON.stringify(scenario.reviewAction)}\n`;
  }
  return desc;
}

function formatTokenMetric(
  mean: number,
  min: number,
  max: number,
  floorMean?: number,
  floorMin?: number,
  floorMax?: number,
  isSafeDocx = false,
  useLocale = false,
): string {
  const f = (val: number) => {
    const rounded = Math.round(val);
    return useLocale ? rounded.toLocaleString() : String(rounded);
  };
  if (isSafeDocx) {
    return `${f(floorMean || 0)} / ${f(mean)} [${f(floorMin || 0)}–${f(floorMax || 0)} / ${f(min)}–${f(max)}] (floor/total)`;
  }
  return `${f(mean)} [${f(min)}–${f(max)}]`;
}

export async function runLiveBenchmark() {
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
        const paradigms: ("raw-xml" | "markdown-roundtrip" | "adeu" | "safe-docx")[] = [
          "raw-xml",
          "markdown-roundtrip",
          "adeu",
          "safe-docx",
        ];

        for (const paradigm of paradigms) {
          console.log(
            `Running: \x1b[32m${provider}\x1b[0m | \x1b[36m${scenario.id}\x1b[0m | \x1b[35m${paradigm}\x1b[0m | Size: \x1b[33m${docSize}\x1b[0m (${reps} reps)...`,
          );

          const trials: SingleTrialRun[] = [];

          for (let rep = 0; rep < reps; rep++) {
            process.stdout.write(`  Rep ${rep + 1}/${reps}... `);

            const doc = await DocumentObject.load(buffer);
            const originalDoc = await DocumentObject.load(buffer);

            const start = performance.now();
            let tokensIn = 0;
            let tokensOut = 0;
            let xmlIntegrity: IntegrityStatus = "FAIL";
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
                  const finalDoc = await DocumentObject.load(loopRes.finalBuffer);
                  xmlIntegrity = "PASS";
                  const fidReport = evaluateFidelity(originalDoc, finalDoc, scenario.id);
                  fidelity = fidReport.score;
                  xmlDelta = fidReport.xmlDelta;
                }
              } else if (paradigm === "adeu" && scenario.isAgentic) {
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
                  const finalDoc = await DocumentObject.load(loopRes.finalBuffer);
                  xmlIntegrity = "PASS";
                  fidelity = evaluateFidelity(originalDoc, finalDoc, scenario.id).score;
                }
              } else {
                const isRawXml = paradigm === "raw-xml";
                const isMd = paradigm === "markdown-roundtrip";
                const systemPrompt = isRawXml
                  ? XML_SYSTEM_PROMPT
                  : isMd
                    ? MD_LIVE_SYSTEM_PROMPT
                    : ADEU_SYSTEM_PROMPT;
                const documentContent = isRawXml
                  ? doc.part.blob
                  : new DocumentMapper(doc, isMd).full_text;
                const userInstruction =
                  isRawXml || isMd
                    ? `Please update the document text according to these instructions:\nTarget Text to find: "${scenario.targetText}"\nReplacement Text to insert: "${scenario.replacementText}"`
                    : `Generate a JSON array of DocumentChange objects representing the required change.\nTarget Text: "${scenario.targetText}"\nReplacement Text: "${scenario.replacementText}"\nReview Action: ${scenario.reviewAction ? JSON.stringify(scenario.reviewAction) : "none"}`;

                const fullUserMessage = `Here is the document context:\n=== DOCUMENT START ===\n${documentContent}\n=== DOCUMENT END ===\n\nTask:\n${userInstruction}`;

                const modelInstance = (client as GoogleGenerativeAI).getGenerativeModel(
                  {
                    model,
                    generationConfig: { temperature: 0.0 },
                  },
                  { timeout: GEMINI_TIMEOUT_MS },
                );
                const geminiResponse = await withTimeout(
                  modelInstance.generateContent({
                    contents: [
                      {
                        role: "user",
                        parts: [
                          { text: `System Instructions:\n${systemPrompt}\n\n${fullUserMessage}` },
                        ],
                      },
                    ],
                  }),
                  GEMINI_TIMEOUT_MS,
                  `Gemini API call timed out after ${GEMINI_TIMEOUT_MS}ms`,
                );
                const rawOutput = geminiResponse.response.text() || "";
                tokensIn = geminiResponse.response.usageMetadata?.promptTokenCount || 0;
                tokensOut = geminiResponse.response.usageMetadata?.candidatesTokenCount || 0;
                roundTrips = 1;

                let modifiedDoc: DocumentObject | null = null;
                if (paradigm === "raw-xml") {
                  const appliedXml = applyXmlSearchReplace(doc.part.blob, rawOutput);
                  if (validateXmlSyntax(appliedXml)) {
                    modifiedDoc = await createXmlReconstructedDoc(buffer, appliedXml);
                  }
                } else if (paradigm === "markdown-roundtrip") {
                  modifiedDoc = await createStrippedDoc(buffer, rawOutput);
                } else {
                  const cleanJson = cleanJsonResponse(rawOutput);
                  const validated = AdeuOutputSchema.safeParse(JSON.parse(cleanJson));
                  if (!validated.success) {
                    throw new Error(
                      `JSON failed Adeu schema validation: ${validated.error.message}`,
                    );
                  }
                  const engine = new RedlineEngine(doc);
                  engine.process_batch(validated.data);
                  modifiedDoc = doc;
                }

                if (modifiedDoc) {
                  const exported = await modifiedDoc.save();
                  if (exported && exported.length > 0) {
                    xmlIntegrity = "PASS";
                    const fidReport = evaluateFidelity(originalDoc, modifiedDoc, scenario.id);
                    fidelity = fidReport.score;
                    xmlDelta = fidReport.xmlDelta || 0;
                    success = checkScenarioSuccess(scenario.id, originalDoc, modifiedDoc);
                  }
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

          const roundTripsMean = trials.reduce((sum, t) => sum + t.roundTrips, 0) / repCount;
          const turnsToSuccessMean =
            trials.reduce((sum, t) => sum + t.turnsToSuccess, 0) / repCount;
          const recoveryRateMean = trials.reduce((sum, t) => sum + t.recoveryRate, 0) / repCount;

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

            latencyMeanMs: latStats.mean,
            latencyMinMs: latStats.min,
            latencyMaxMs: latStats.max,

            tokensInMean: tokInStats.mean,
            tokensInMin: tokInStats.min,
            tokensInMax: tokInStats.max,

            tokensOutMean: tokOutStats.mean,
            tokensOutMin: tokOutStats.min,
            tokensOutMax: tokOutStats.max,

            totalTokensMean: totTokStats.mean,
            totalTokensMin: totTokStats.min,
            totalTokensMax: totTokStats.max,

            xmlDeltaMean: xmlDeltaStats.mean,
            xmlDeltaMin: xmlDeltaStats.min,
            xmlDeltaMax: xmlDeltaStats.max,

            xmlIntegrityRate,
            fidelityMean: fidStats.mean,
            fidelityMin: fidStats.min,
            fidelityMax: fidStats.max,

            successRate,
            roundTripsMean,
            turnsToSuccessMean,
            recoveryRateMean,

            schemaTokensMean: schStats.mean,
            schemaTokensMin: schStats.min,
            schemaTokensMax: schStats.max,

            historyTokensMean: histStats.mean,
            historyTokensMin: histStats.min,
            historyTokensMax: histStats.max,

            newContentTokensMean: newContStats.mean,
            newContentTokensMin: newContStats.min,
            newContentTokensMax: newContStats.max,
          });
        }
      }
    }
  }

  printLiveConsoleSummary(summaries);
  writeLiveResultsFiles(summaries);
}

// Unified Agentic Multi-turn Message Loop Configuration
export interface UnifiedLoopConfig {
  gemini: GoogleGenerativeAI;
  modelName: string;
  systemPrompt: string;
  maxTurns: number;
  tools: any[];
  executeTool: (
    name: string,
    args: any,
    turn: number,
  ) => Promise<{ result?: any; error?: string; hadError: boolean }>;
  checkSuccess: (turn: number) => Promise<boolean>;
  getFinalBuffer: () => Promise<Buffer>;
  cleanup: () => Promise<void>;
  loopName?: string;
}

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

  const contents: any[] = [
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
      console.log(
        `\x1b[36m${prefix}\x1b[0m Sending prompt content length: ${contents.length} messages.`,
      );

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

      console.log(
        `\x1b[36m${prefix}\x1b[0m Model generated ${parts.length} parts and ${functionCalls.length} function calls.`,
      );
      for (const fc of functionCalls) {
        console.log(
          `\x1b[36m${prefix}\x1b[0m Tool Call Request: \x1b[33m${fc.name}\x1b[0m with args:`,
          JSON.stringify(fc.args),
        );
      }

      if (functionCalls.length === 0) {
        console.log(`\x1b[36m${prefix}\x1b[0m No function calls generated. Breaking loop.`);
        break;
      }

      roundTrips++;
      contents.push({ role: "model", parts });

      const functionResponses: any[] = [];
      let currentTurnHadError = false;

      for (const fc of functionCalls) {
        try {
          const toolResult = await executeTool(fc.name, fc.args, turn);
          if (toolResult.hadError) currentTurnHadError = true;
          functionResponses.push({
            name: fc.name,
            response: toolResult.error ? { error: toolResult.error } : toolResult.result,
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
    await cleanup();
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

async function connectMcpClient(packageName: string, clientName: string) {
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

const mapToGeminiTools = (tools: any[]) =>
  tools.map((t) => ({
    name: t.name,
    description: t.description || "",
    parameters: cleanSchema(t.inputSchema),
  }));

function bindArgsToTempPath(args: any, properties: any, tempFilePath: string): any {
  const cleanArgs = { ...args };
  for (const key of ["file_path", "path", "save_to_local_path"]) {
    if (key in properties) {
      cleanArgs[key] = tempFilePath;
    }
  }
  return cleanArgs;
}

function isMcpToolSuccess(toolResult: any): boolean {
  if (toolResult.isError) return false;
  const textContent = toolResult.content?.[0]?.text || "";
  return !(textContent.includes('"success": false') || textContent.includes('"error"'));
}

export async function runSafeDocxLoop(
  gemini: GoogleGenerativeAI,
  modelName: string,
  docPath: string,
  scenarioId: string,
  taskDescription: string,
): Promise<LoopResult> {
  const MAX_TURNS = 8;
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
    executeTool: async (name, args) => {
      const toolDef = mcpTools.find((t) => t.name === name);
      const cleanArgs = bindArgsToTempPath(
        args,
        (toolDef?.inputSchema as any)?.properties || {},
        tempFilePath,
      );
      if (name === "save") {
        cleanArgs.allow_overwrite = true;
      }

      const toolResult = await withTimeout(
        mcpClient.callTool({
          name,
          arguments: cleanArgs,
        }),
        MCP_TOOL_TIMEOUT_MS,
        `MCP tool call '${name}' timed out after ${MCP_TOOL_TIMEOUT_MS}ms`,
      );

      console.log(
        `[MCP TOOL CALL] Name: ${name}, Arguments: ${JSON.stringify(cleanArgs)}, Result: ${JSON.stringify(toolResult)}`,
      );

      return {
        result: { result: (toolResult as any).content },
        hadError: !isMcpToolSuccess(toolResult),
      };
    },
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

async function runAdeuLoop(
  gemini: GoogleGenerativeAI,
  modelName: string,
  docBuffer: Buffer,
  scenarioId: string,
  taskDescription: string,
): Promise<LoopResult> {
  const MAX_TURNS = 15;
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

Please observe the document first by calling the 'read_document' tool, analyze the content, then perform edits by calling 'apply_patch' with transactional modifications.

You MUST call 'read_document' a second time after applying a patch to verify that your changes were successfully applied and the correct text is present in the updated document.

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
    executeTool: async (name, args) => {
      const toolDef = mcpTools.find((t) => t.name === name);
      const cleanArgs = bindArgsToTempPath(
        args,
        (toolDef?.inputSchema as any)?.properties || {},
        tempFilePath,
      );

      const toolResult = await withTimeout(
        mcpClient.callTool({
          name,
          arguments: cleanArgs,
        }),
        MCP_TOOL_TIMEOUT_MS,
        `Adeu MCP tool call '${name}' timed out after ${MCP_TOOL_TIMEOUT_MS}ms`,
      );

      console.log(
        `[Adeu MCP TOOL CALL] Name: ${name}, Arguments: ${JSON.stringify(cleanArgs)}, Result: ${JSON.stringify(toolResult)}`,
      );

      return {
        result: { result: (toolResult as any).content },
        hadError: !isMcpToolSuccess(toolResult),
      };
    },
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

interface LoopResult {
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

function printLiveConsoleSummary(summaries: LiveTrialSummary[]) {
  console.log(`\n\x1b[1m\x1b[32m=== LIVE BENCHMARK CONSOLE SUMMARY (N=${reps}) ===\x1b[0m`);
  const tableRows = summaries.map((s) => {
    const isSafe = s.paradigm === "safe-docx";
    return {
      Provider: s.provider,
      Scenario: s.scenarioId,
      Paradigm: s.paradigm,
      Size: s.docSize,
      "Succ Rate": s.successRate,
      "XML Delta": `${s.xmlDeltaMean.toFixed(0)} [${s.xmlDeltaMin}–${s.xmlDeltaMax}]`,
      Fidelity: `${s.fidelityMean.toFixed(1)}% [${s.fidelityMin}–${s.fidelityMax}]`,
      "Xml Integrity": s.xmlIntegrityRate,
      Trips: s.roundTripsMean.toFixed(1),
      TurnsSucc: s.turnsToSuccessMean.toFixed(1),
      "Tokens In": formatTokenMetric(
        s.tokensInMean,
        s.tokensInMin,
        s.tokensInMax,
        s.newContentTokensMean,
        s.newContentTokensMin,
        s.newContentTokensMax,
        isSafe,
        false,
      ),
      "Tokens Out": `${Math.round(s.tokensOutMean)} [${Math.round(s.tokensOutMin)}–${Math.round(s.tokensOutMax)}]`,
      "Total Tokens": formatTokenMetric(
        s.totalTokensMean,
        s.totalTokensMin,
        s.totalTokensMax,
        (s.newContentTokensMean || 0) + s.tokensOutMean,
        (s.newContentTokensMin || 0) + s.tokensOutMin,
        (s.newContentTokensMax || 0) + s.tokensOutMax,
        isSafe,
        false,
      ),
      Cost: "UNKNOWN",
      Latency: `${(s.latencyMeanMs / 1000).toFixed(1)}s [${(s.latencyMinMs / 1000).toFixed(1)}–${(s.latencyMaxMs / 1000).toFixed(1)}]`,
    };
  });
  console.table(tableRows);
}

function writeLiveResultsFiles(summaries: LiveTrialSummary[]) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join("./results", `${timestamp}.json`);
  const mdPath = path.join("./results", `${timestamp}.md`);

  fs.mkdirSync("./results", { recursive: true });

  const jsonStr = JSON.stringify(summaries, null, 2);
  fs.writeFileSync(jsonPath, jsonStr, "utf-8");
  fs.writeFileSync("./live_benchmark_results.json", jsonStr, "utf-8");
  console.log(
    `\x1b[32m[JSON Results Written]\x1b[0m Saved to ${jsonPath} and ./live_benchmark_results.json`,
  );

  let md = `# Live Benchmark Report\n\n`;
  md += `**Date:** ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}\n`;
  md += `**Repetitions (N):** ${reps} per trial\n`;
  md += `**Temperature:** 0.0\n\n`;

  md +=
    `## Models Configured\n` +
    Array.from(new Set(summaries.map((s) => `- ${s.provider}: \`${s.model}\``))).join("\n") +
    "\n\n";

  md += `## Comparative Metrics\n\n`;
  md += `> [Spacer alert note showing conditions of token savings]\n`;
  md += `> [!IMPORTANT]\n`;
  md += `> Token savings only matter when **Success Rate** is high. A paradigm that achieves low token counts but consistently fails tasks or corrupts document styling has zero utility.\n\n`;

  const scenariosGrouped = Array.from(new Set(summaries.map((s) => s.scenarioId)));

  for (const sId of scenariosGrouped) {
    const sResults = summaries.filter((s) => s.scenarioId === sId);
    md += `### Scenario: ${sResults[0]?.scenarioName} (\`${sId}\`)\n\n`;
    md += `| Paradigm | Doc Size | Success Rate | XML Delta (Surgicality) | Fidelity Score (Avg [Min–Max]) | XML Integrity | Round Trips (Avg) | Turns to Success (Avg) | Recovery Rate (Avg) | Input Tokens (Avg [Min–Max]) | Output Tokens (Avg [Min–Max]) | Total Tokens (Avg [Min–Max]) | Cost (Avg [Min–Max]) | Latency (Avg [Min–Max]) |\n`;
    md += `| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |\n`;

    for (const s of sResults) {
      const isSafe = s.paradigm === "safe-docx";
      md +=
        `| **${s.paradigm}** | ${s.docSize} | ${s.successRate} | ${s.xmlDeltaMean.toFixed(0)} [${s.xmlDeltaMin}–${s.xmlDeltaMax}] | ${s.fidelityMean.toFixed(1)}% [${s.fidelityMin}–${s.fidelityMax}] | ${s.xmlIntegrityRate} | ${s.roundTripsMean.toFixed(1)} | ${s.turnsToSuccessMean.toFixed(1)} | ${(s.recoveryRateMean * 100).toFixed(1)}% | ` +
        `${formatTokenMetric(s.tokensInMean, s.tokensInMin, s.tokensInMax, s.newContentTokensMean, s.newContentTokensMin, s.newContentTokensMax, isSafe, true)} | ` +
        `${Math.round(s.tokensOutMean).toLocaleString()} [${Math.round(s.tokensOutMin).toLocaleString()}–${Math.round(s.tokensOutMax).toLocaleString()}] | ` +
        `${formatTokenMetric(s.totalTokensMean, s.totalTokensMin, s.totalTokensMax, (s.newContentTokensMean || 0) + s.tokensOutMean, (s.newContentTokensMin || 0) + s.tokensOutMin, (s.newContentTokensMax || 0) + s.tokensOutMax, isSafe, true)} | ` +
        `UNKNOWN | ${(s.latencyMeanMs / 1000).toFixed(1)}s [${(s.latencyMinMs / 1000).toFixed(1)}–${(s.latencyMaxMs / 1000).toFixed(1)}] |\n`;
    }
    md += `\n`;
  }

  fs.writeFileSync(mdPath, md, "utf-8");
  fs.writeFileSync("./live_benchmark_results.md", md, "utf-8");
  console.log(
    `\x1b[32m[Markdown Results Written]\x1b[0m Saved to ${mdPath} and ./live_benchmark_results.md`,
  );
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
