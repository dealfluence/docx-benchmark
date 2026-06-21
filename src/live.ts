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

// CLI configuration
let reps = 5;
if (process.env.BENCHMARK_REPS) {
  const parsed = parseInt(process.env.BENCHMARK_REPS, 10);
  if (!isNaN(parsed) && parsed > 0) {
    reps = parsed;
  }
}
const repsFlagIndex = process.argv.indexOf("--reps");
if (repsFlagIndex !== -1 && repsFlagIndex + 1 < process.argv.length) {
  const parsed = parseInt(process.argv[repsFlagIndex + 1], 10);
  if (!isNaN(parsed) && parsed > 0) {
    reps = parsed;
  }
}

// Is --quick mode active?
const isQuick = process.argv.includes("--quick");
if (isQuick) {
  // If --reps is explicitly provided, respect it, otherwise default to 1 for quick mode
  const hasRepsFlag = repsFlagIndex !== -1;
  const hasRepsEnv = !!process.env.BENCHMARK_REPS;
  if (!hasRepsFlag && !hasRepsEnv) {
    reps = 1;
  }
}

// Model names config
const geminiModel = process.env.GEMINI_MODEL || "gemini-3.5-flash";

// System prompts for each paradigm
export const MD_LIVE_SYSTEM_PROMPT = `You are an expert contract editor. You are provided with the document content in Markdown format.
Perform the requested edits and return the ENTIRE updated Markdown document. Do not truncate the document, as it must be completely round-tripped back to DOCX.
Ensure your response contains ONLY the Markdown text. Do not wrap it in any explanation.`;

// Timeout configuration (in milliseconds)
export const GEMINI_TIMEOUT_MS = process.env.GEMINI_TIMEOUT_MS ? parseInt(process.env.GEMINI_TIMEOUT_MS, 10) : 60000;
export const MCP_CONNECT_TIMEOUT_MS = process.env.MCP_CONNECT_TIMEOUT_MS ? parseInt(process.env.MCP_CONNECT_TIMEOUT_MS, 10) : 30000;
export const MCP_TOOL_TIMEOUT_MS = process.env.MCP_TOOL_TIMEOUT_MS ? parseInt(process.env.MCP_TOOL_TIMEOUT_MS, 10) : 30000;

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string
): Promise<T> {
  let timeoutId: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(errorMessage));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
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
  const blockRegex = /<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/g;
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
  let clean = raw.trim();
  if (clean.startsWith("```json")) {
    clean = clean.slice(7);
  } else if (clean.startsWith("```")) {
    clean = clean.slice(3);
  }
  if (clean.endsWith("```")) {
    clean = clean.slice(0, -3);
  }
  return clean.trim();
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

  // Agentic metrics
  roundTripsMean: number;
  turnsToSuccessMean: number;
  recoveryRateMean: number;

  // Token breakdown metrics (for safe-docx)
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
  const upper = type.toUpperCase();
  if (upper === "OBJECT") return SchemaType.OBJECT;
  if (upper === "STRING") return SchemaType.STRING;
  if (upper === "ARRAY") return SchemaType.ARRAY;
  if (upper === "BOOLEAN") return SchemaType.BOOLEAN;
  if (upper === "INTEGER") return SchemaType.INTEGER;
  if (upper === "NUMBER") return SchemaType.NUMBER;
  return SchemaType.STRING;
}

// Recursively clean and map any JSON Schema to the structure required by Gemini SDK
export function cleanSchema(schema: any): any {
  if (!schema) return undefined;
  const res: any = { ...schema };
  delete res.$schema;
  delete res.additionalProperties;

  // Generically flatten union schemas (anyOf / oneOf) to satisfy Gemini's strict array constraints
  if (schema.anyOf || schema.oneOf) {
    const unionList = schema.anyOf || schema.oneOf;
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
    const commonRequired = consolidatedRequired.filter(reqField =>
      unionList.every((sub: any) => sub.required && sub.required.includes(reqField))
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

export async function runLiveBenchmark() {
  const docPath = getGoldenDocxPath();
  const dirPath = path.dirname(docPath);
  const largeDocPath = path.resolve(dirPath, "golden_large.docx");

  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    console.log(`\n\x1b[1m\x1b[31m[API Key Missing]\x1b[0m GEMINI_API_KEY environment variable is required.`);
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
  console.log(`Configured Providers: ${clients.map((c) => c.provider + " (" + c.model + ")").join(", ")}`);
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

      // Filter scenarios for --quick mode: 1 simple + 1 agentic
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
          console.log(`Running: \x1b[32m${provider}\x1b[0m | \x1b[36m${scenario.id}\x1b[0m | \x1b[35m${paradigm}\x1b[0m | Size: \x1b[33m${docSize}\x1b[0m (${reps} reps)...`);
          
          const trials: SingleTrialRun[] = [];

          for (let rep = 0; rep < reps; rep++) {
            process.stdout.write(`  Rep ${rep + 1}/${reps}... `);

            // Fresh document loads
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
                // Execute real Safe Docx MCP multi-turn loop
                let fullTaskDescription = scenario.description;
                if (scenario.targetText || scenario.replacementText || scenario.reviewAction) {
                  fullTaskDescription += `\nInstructions:\n`;
                  if (scenario.targetText) {
                    fullTaskDescription += `- Find target text: "${scenario.targetText}"\n`;
                  }
                  if (scenario.replacementText) {
                    fullTaskDescription += `- Replace with: "${scenario.replacementText}"\n`;
                  }
                  if (scenario.reviewAction) {
                    fullTaskDescription += `- Review Action: ${JSON.stringify(scenario.reviewAction)}\n`;
                  }
                }

                const loopRes = await runSafeDocxLoop(
                  client as GoogleGenerativeAI,
                  model,
                  currentDocPath,
                  scenario.id,
                  fullTaskDescription
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
                // Execute Adeu multi-turn loop for agentic scenarios
                let fullTaskDescription = scenario.description;
                if (scenario.targetText || scenario.replacementText || scenario.reviewAction) {
                  fullTaskDescription += `\nInstructions:\n`;
                  if (scenario.targetText) {
                    fullTaskDescription += `- Find target text: "${scenario.targetText}"\n`;
                  }
                  if (scenario.replacementText) {
                    fullTaskDescription += `- Replace with: "${scenario.replacementText}"\n`;
                  }
                  if (scenario.reviewAction) {
                    fullTaskDescription += `- Review Action: ${JSON.stringify(scenario.reviewAction)}\n`;
                  }
                }

                const loopRes = await runAdeuLoop(
                  client as GoogleGenerativeAI,
                  model,
                  buffer,
                  scenario.id,
                  fullTaskDescription
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
                // One-shot path for simple scenarios (or traditional paradigms)
                let systemPrompt = "";
                let documentContent = "";
                let userInstruction = "";

                if (paradigm === "raw-xml") {
                  systemPrompt = XML_SYSTEM_PROMPT;
                  documentContent = doc.part.blob;
                  userInstruction = `Please update the document text according to these instructions:
Target Text to find: "${scenario.targetText}"
Replacement Text to insert: "${scenario.replacementText}"`;
                } else if (paradigm === "markdown-roundtrip") {
                  systemPrompt = MD_LIVE_SYSTEM_PROMPT;
                  documentContent = new DocumentMapper(doc, true).full_text;
                  userInstruction = `Please update the document text according to these instructions:
Target Text to find: "${scenario.targetText}"
Replacement Text to insert: "${scenario.replacementText}"`;
                } else {
                  // adeu (simple)
                  systemPrompt = ADEU_SYSTEM_PROMPT;
                  documentContent = new DocumentMapper(doc, false).full_text;
                  userInstruction = `Generate a JSON array of DocumentChange objects representing the required change.
Target Text: "${scenario.targetText}"
Replacement Text: "${scenario.replacementText}"
Review Action: ${scenario.reviewAction ? JSON.stringify(scenario.reviewAction) : "none"}`;
                }

                const fullUserMessage = `Here is the document context:\n=== DOCUMENT START ===\n${documentContent}\n=== DOCUMENT END ===\n\nTask:\n${userInstruction}`;

                const modelInstance = (client as GoogleGenerativeAI).getGenerativeModel(
                  {
                    model,
                    generationConfig: { temperature: 0.0 },
                  },
                  { timeout: GEMINI_TIMEOUT_MS }
                );
                const geminiResponse = await withTimeout(
                   modelInstance.generateContent({
                     contents: [
                       {
                         role: "user",
                         parts: [{ text: `System Instructions:\n${systemPrompt}\n\n${fullUserMessage}` }],
                       },
                     ],
                   }),
                   GEMINI_TIMEOUT_MS,
                   `Gemini API call timed out after ${GEMINI_TIMEOUT_MS}ms`
                 );
                const rawOutput = geminiResponse.response.text() || "";
                tokensIn = geminiResponse.response.usageMetadata?.promptTokenCount || 0;
                tokensOut = geminiResponse.response.usageMetadata?.candidatesTokenCount || 0;
                roundTrips = 1;

                // Evaluate outcome
                let modifiedDoc: DocumentObject | null = null;
                if (paradigm === "raw-xml") {
                  const appliedXml = applyXmlSearchReplace(doc.part.blob, rawOutput);
                  if (validateXmlSyntax(appliedXml)) {
                    modifiedDoc = await createXmlReconstructedDoc(buffer, appliedXml);
                    const exported = await modifiedDoc.save();
                    if (exported && exported.length > 0) {
                      xmlIntegrity = "PASS";
                      fidelity = evaluateFidelity(originalDoc, modifiedDoc, scenario.id).score;
                      success = checkScenarioSuccess(scenario.id, originalDoc, modifiedDoc);
                    }
                  }
                } else if (paradigm === "markdown-roundtrip") {
                  modifiedDoc = await createStrippedDoc(buffer, rawOutput);
                  const exported = await modifiedDoc.save();
                  if (exported && exported.length > 0) {
                    xmlIntegrity = "PASS";
                    const fidReport = evaluateFidelity(originalDoc, modifiedDoc, scenario.id);
                    fidelity = fidReport.score;
                    xmlDelta = fidReport.xmlDelta;
                    success = checkScenarioSuccess(scenario.id, originalDoc, modifiedDoc);
                  }
                } else {
                  // adeu (simple)
                  const cleanJson = cleanJsonResponse(rawOutput);
                  const parsedJSON = JSON.parse(cleanJson);
                  const validated = AdeuOutputSchema.safeParse(parsedJSON);

                  if (validated.success) {
                    const engine = new RedlineEngine(doc);
                    engine.process_batch(validated.data);
                    const exported = await doc.save();
                    if (exported && exported.length > 0) {
                      xmlIntegrity = "PASS";
                      const fidReport = evaluateFidelity(originalDoc, doc, scenario.id);
                      fidelity = fidReport.score;
                      success = checkScenarioSuccess(scenario.id, originalDoc, doc);
                    }
                  } else {
                    throw new Error(`JSON failed Adeu schema validation: ${validated.error.message}`);
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

            console.log(`Latency: ${(latencyMs / 1000).toFixed(2)}s | Tokens: ${tokensIn} in, ${tokensOut} out | Trips: ${roundTrips} | Integrity: ${xmlIntegrity} | Fidelity: ${fidelity}% | Success: ${success ? "🟢 YES" : "🔴 NO"}`);
          }

          // Aggregate N trials
          const repCount = trials.length;
          
          const latencies = trials.map((t) => t.latencyMs);
          const tokensIns = trials.map((t) => t.tokensIn);
          const tokensOuts = trials.map((t) => t.tokensOut);
          const totalToks = trials.map((t) => t.tokensIn + t.tokensOut);
          const fidelities = trials.map((t) => t.fidelity);
          const xmlDeltas = trials.map((t) => t.xmlDelta || 0);
          const roundTripsList = trials.map((t) => t.roundTrips);
          const turnsToSuccessList = trials.map((t) => t.turnsToSuccess);
          const recoveryRatesList = trials.map((t) => t.recoveryRate);
          const schemaTokensList = trials.map((t) => t.schemaTokens || 0);
          const historyTokensList = trials.map((t) => t.historyTokens || 0);
          const newContentTokensList = trials.map((t) => t.newContentTokens || 0);
          
          const latencyMeanMs = latencies.reduce((a, b) => a + b, 0) / repCount;
          const latencyMinMs = Math.min(...latencies);
          const latencyMaxMs = Math.max(...latencies);

          const tokensInMean = tokensIns.reduce((a, b) => a + b, 0) / repCount;
          const tokensInMin = Math.min(...tokensIns);
          const tokensInMax = Math.max(...tokensIns);

          const tokensOutMean = tokensOuts.reduce((a, b) => a + b, 0) / repCount;
          const tokensOutMin = Math.min(...tokensOuts);
          const tokensOutMax = Math.max(...tokensOuts);

          const totalTokensMean = totalToks.reduce((a, b) => a + b, 0) / repCount;
          const totalTokensMin = Math.min(...totalToks);
          const totalTokensMax = Math.max(...totalToks);

          const fidelityMean = fidelities.reduce((a, b) => a + b, 0) / repCount;
          const fidelityMin = Math.min(...fidelities);
          const fidelityMax = Math.max(...fidelities);

          const xmlDeltaMean = xmlDeltas.reduce((a, b) => a + b, 0) / repCount;
          const xmlDeltaMin = Math.min(...xmlDeltas);
          const xmlDeltaMax = Math.max(...xmlDeltas);

          const roundTripsMean = roundTripsList.reduce((a, b) => a + b, 0) / repCount;
          const turnsToSuccessMean = turnsToSuccessList.reduce((a, b) => a + b, 0) / repCount;
          const recoveryRateMean = recoveryRatesList.reduce((a, b) => a + b, 0) / repCount;

          const schemaTokensMean = schemaTokensList.reduce((a, b) => a + b, 0) / repCount;
          const schemaTokensMin = Math.min(...schemaTokensList);
          const schemaTokensMax = Math.max(...schemaTokensList);

          const historyTokensMean = historyTokensList.reduce((a, b) => a + b, 0) / repCount;
          const historyTokensMin = Math.min(...historyTokensList);
          const historyTokensMax = Math.max(...historyTokensList);

          const newContentTokensMean = newContentTokensList.reduce((a, b) => a + b, 0) / repCount;
          const newContentTokensMin = Math.min(...newContentTokensList);
          const newContentTokensMax = Math.max(...newContentTokensList);

          const passCount = trials.filter((t) => t.xmlIntegrity === "PASS").length;
          const xmlIntegrityRate = `${passCount}/${repCount}`;

          const successCount = trials.filter((t) => t.success).length;
          const successRate = `${successCount}/${repCount}`;

          summaries.push({
            provider,
            model,
            scenarioId: scenario.id,
            scenarioName: scenario.name,
            paradigm,
            docSize,
            supported: true,
            reps: repCount,
            latencyMeanMs,
            latencyMinMs,
            latencyMaxMs,
            tokensInMean,
            tokensInMin,
            tokensInMax,
            tokensOutMean,
            tokensOutMin,
            tokensOutMax,
            totalTokensMean,
            totalTokensMin,
            totalTokensMax,
            xmlIntegrityRate,
            xmlDeltaMean,
            xmlDeltaMin,
            xmlDeltaMax,
            fidelityMean,
            fidelityMin,
            fidelityMax,
            successRate,
            roundTripsMean,
            turnsToSuccessMean,
            recoveryRateMean,
            schemaTokensMean,
            schemaTokensMin,
            schemaTokensMax,
            historyTokensMean,
            historyTokensMin,
            historyTokensMax,
            newContentTokensMean,
            newContentTokensMin,
            newContentTokensMax,
          });
        }
      }
    }
  }

  // Print summaries
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
  executeTool: (name: string, args: any, turn: number) => Promise<{ result?: any; error?: string; hadError: boolean }>;
  checkSuccess: (turn: number) => Promise<boolean>;
  getFinalBuffer: () => Promise<Buffer>;
  cleanup: () => Promise<void>;
  loopName?: string;
}

// Single core message loop that powers all multi-turn setups to prevent drift and ensure fairness
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
    { timeout: GEMINI_TIMEOUT_MS }
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

  // Measure tool schema tokens using countTokens API
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
      // Fallback if offline/mocked or if API call fails
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
      console.log(`\x1b[36m${prefix}\x1b[0m Sending prompt content length: ${contents.length} messages.`);

      const geminiResponse = await withTimeout(
        modelInstance.generateContent({ contents }),
        GEMINI_TIMEOUT_MS,
        `Gemini API call timed out after ${GEMINI_TIMEOUT_MS}ms`
      );

      const promptTokensThisTurn = geminiResponse.response.usageMetadata?.promptTokenCount || 0;
      const candidatesTokensThisTurn = geminiResponse.response.usageMetadata?.candidatesTokenCount || 0;

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

      console.log(`\x1b[36m${prefix}\x1b[0m Model generated ${parts.length} parts and ${functionCalls.length} function calls.`);
      for (const fc of functionCalls) {
        console.log(`\x1b[36m${prefix}\x1b[0m Tool Call Request: \x1b[33m${fc.name}\x1b[0m with args:`, JSON.stringify(fc.args));
      }

      if (functionCalls.length === 0) {
        console.log(`\x1b[36m${prefix}\x1b[0m No function calls generated. Breaking loop.`);
        break;
      }

      roundTrips++;

      // Save model's function calls in history
      contents.push({
        role: "model",
        parts,
      });

      const functionResponses: any[] = [];
      let currentTurnHadError = false;

      for (const fc of functionCalls) {
        try {
          const toolResult = await executeTool(fc.name, fc.args, turn);
          if (toolResult.hadError) {
            currentTurnHadError = true;
          }
          if (toolResult.error) {
            functionResponses.push({
              name: fc.name,
              response: { error: toolResult.error },
            });
          } else {
            functionResponses.push({
              name: fc.name,
              response: toolResult.result,
            });
          }
        } catch (err) {
          currentTurnHadError = true;
          console.error(`\x1b[31m${prefix} ERROR in Tool Response for ${fc.name}:\x1b[0m`, err instanceof Error ? err.message : err);
          functionResponses.push({
            name: fc.name,
            response: { error: err instanceof Error ? err.message : String(err) },
          });
        }
      }

      // Save responses in history
      contents.push({
        role: "user",
        parts: functionResponses.map((fr) => ({ functionResponse: fr })),
      });

      // Check if previous turn had error and this one recovered
      if (currentTurnHadError) {
        errorTurns++;
      } else if (previousTurnHadError) {
        recoveryTurns++;
      }
      previousTurnHadError = currentTurnHadError;

      // Check success criterion at each turn
      try {
        const isSuccessNow = await checkSuccess(turn);
        if (isSuccessNow && !success) {
          success = true;
          turnsToSuccess = turn;
        }
      } catch {
        // ignore parsing/checking errors at intermediate step
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

// Multi-turn runner for Safe Docx using real MCP server subprocess
export async function runSafeDocxLoop(
  gemini: GoogleGenerativeAI,
  modelName: string,
  docPath: string,
  scenarioId: string,
  taskDescription: string
): Promise<LoopResult> {
  const MAX_TURNS = 8;
  const tempFilePath = path.resolve(`./temp_safe_docx_rep_${performance.now()}.docx`);
  
  // Create a copy of the target file to prevent corrupting fixture
  fs.copyFileSync(docPath, tempFilePath);

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "@usejunior/safe-docx"],
  });

  const mcpClient = new Client(
    { name: "benchmark-client", version: "1.0.0" },
    { capabilities: {} }
  );

  await withTimeout(
    mcpClient.connect(transport),
    MCP_CONNECT_TIMEOUT_MS,
    `MCP connection timed out after ${MCP_CONNECT_TIMEOUT_MS}ms`
  );
  const toolsResponse = await withTimeout(
    mcpClient.listTools(),
    MCP_TOOL_TIMEOUT_MS,
    `MCP listTools timed out after ${MCP_TOOL_TIMEOUT_MS}ms`
  );
  const mcpTools = toolsResponse.tools;

  // Convert MCP tool schemas to Gemini function declarations with upper-case type properties
  const geminiTools = mcpTools.map((t) => {
    const cleaned = cleanSchema(t.inputSchema);
    return {
      name: t.name,
      description: t.description || "",
      parameters: cleaned,
    };
  });

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
      // Force file_path/path/save_to_local_path to be our temporary file path to prevent hallucinations/missing args
      const cleanArgs = { ...args } as any;
      const toolDef = mcpTools.find((t) => t.name === name);
      const properties = (toolDef?.inputSchema as any)?.properties || {};

      if ("file_path" in properties) {
        cleanArgs.file_path = tempFilePath;
      }
      if ("path" in properties) {
        cleanArgs.path = tempFilePath;
      }
      if ("save_to_local_path" in properties) {
        cleanArgs.save_to_local_path = tempFilePath;
      }
      if (name === "save") {
        cleanArgs.allow_overwrite = true;
      }

      const toolResult = await withTimeout(
        mcpClient.callTool({
          name,
          arguments: cleanArgs,
        }),
        MCP_TOOL_TIMEOUT_MS,
        `MCP tool call '${name}' timed out after ${MCP_TOOL_TIMEOUT_MS}ms`
      );

      console.log(`[MCP TOOL CALL] Name: ${name}, Arguments: ${JSON.stringify(cleanArgs)}, Result: ${JSON.stringify(toolResult)}`);

      // Parse result to check success
      let isSuccessResponse = true;
      if ((toolResult as any).isError) {
        isSuccessResponse = false;
      } else {
        const textContent = (toolResult as any).content?.[0]?.text || "";
        if (textContent.includes('"success": false') || textContent.includes('"error"')) {
          isSuccessResponse = false;
        }
      }

      return {
        result: { result: (toolResult as any).content },
        hadError: !isSuccessResponse,
      };
    },
    checkSuccess: async () => {
      const currentBuffer = fs.readFileSync(tempFilePath);
      const currentDoc = await DocumentObject.load(currentBuffer);
      return checkScenarioSuccess(scenarioId, originalDoc, currentDoc);
    },
    getFinalBuffer: async () => {
      if (fs.existsSync(tempFilePath)) {
        return fs.readFileSync(tempFilePath);
      }
      return fs.readFileSync(docPath);
    },
    cleanup: async () => {
      await mcpClient.close();
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
    },
  });
}

// Multi-turn runner for Adeu's loop on agentic scenarios using the real standard @adeu/mcp-server
async function runAdeuLoop(
  gemini: GoogleGenerativeAI,
  modelName: string,
  docBuffer: Buffer,
  scenarioId: string,
  taskDescription: string
): Promise<LoopResult> {
  const MAX_TURNS = 15;
  const tempFilePath = path.resolve(`./temp_adeu_rep_${performance.now()}.docx`);
  
  // Write the initial doc buffer to temporary file for stateful child-process edits
  fs.writeFileSync(tempFilePath, docBuffer);

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "@adeu/mcp-server"],
  });

  const mcpClient = new Client(
    { name: "adeu-benchmark-client", version: "1.0.0" },
    { capabilities: {} }
  );

  await withTimeout(
    mcpClient.connect(transport),
    MCP_CONNECT_TIMEOUT_MS,
    `Adeu MCP connection timed out after ${MCP_CONNECT_TIMEOUT_MS}ms`
  );

  const toolsResponse = await withTimeout(
    mcpClient.listTools(),
    MCP_TOOL_TIMEOUT_MS,
    `Adeu MCP listTools timed out after ${MCP_TOOL_TIMEOUT_MS}ms`
  );
  const mcpTools = toolsResponse.tools;

  // Convert MCP tool schemas to Gemini function declarations with upper-case type properties
  const geminiTools = mcpTools.map((t) => {
    const cleaned = cleanSchema(t.inputSchema);
    return {
      name: t.name,
      description: t.description || "",
      parameters: cleaned,
    };
  });

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
    executeTool: async (name, args, _turn) => {
      // Force file_path or path parameter mapping to temp file
      const cleanArgs = { ...args } as any;
      const toolDef = mcpTools.find((t) => t.name === name);
      const properties = (toolDef?.inputSchema as any)?.properties || {};

      if ("file_path" in properties) {
        cleanArgs.file_path = tempFilePath;
      }
      if ("path" in properties) {
        cleanArgs.path = tempFilePath;
      }

      const toolResult = await withTimeout(
        mcpClient.callTool({
          name,
          arguments: cleanArgs,
        }),
        MCP_TOOL_TIMEOUT_MS,
        `Adeu MCP tool call '${name}' timed out after ${MCP_TOOL_TIMEOUT_MS}ms`
      );

      console.log(`[Adeu MCP TOOL CALL] Name: ${name}, Arguments: ${JSON.stringify(cleanArgs)}, Result: ${JSON.stringify(toolResult)}`);

      let isSuccessResponse = true;
      if ((toolResult as any).isError) {
        isSuccessResponse = false;
      } else {
        const textContent = (toolResult as any).content?.[0]?.text || "";
        if (textContent.includes('"success": false') || textContent.includes('"error"')) {
          isSuccessResponse = false;
        }
      }

      return {
        result: { result: (toolResult as any).content },
        hadError: !isSuccessResponse,
      };
    },
    checkSuccess: async () => {
      const currentBuffer = fs.readFileSync(tempFilePath);
      const currentDoc = await DocumentObject.load(currentBuffer);
      return checkScenarioSuccess(scenarioId, originalDoc, currentDoc);
    },
    getFinalBuffer: async () => {
      if (fs.existsSync(tempFilePath)) {
        return fs.readFileSync(tempFilePath);
      }
      return docBuffer;
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
    const latencyMean = s.latencyMeanMs / 1000;
    const latencyMin = s.latencyMinMs / 1000;
    const latencyMax = s.latencyMaxMs / 1000;
    const latencyStr = `${latencyMean.toFixed(1)}s [${latencyMin.toFixed(1)}–${latencyMax.toFixed(1)}]`;

    const fidelityStr = `${s.fidelityMean.toFixed(1)}% [${s.fidelityMin}–${s.fidelityMax}]`;

    const xmlDeltaStr = `${s.xmlDeltaMean.toFixed(0)} [${s.xmlDeltaMin}–${s.xmlDeltaMax}]`;

    let inputTokensStr = "";
    let totalTokensStr = "";

    if (s.paradigm === "safe-docx") {
      const floorMean = s.newContentTokensMean || 0;
      const floorMin = s.newContentTokensMin || 0;
      const floorMax = s.newContentTokensMax || 0;
      inputTokensStr = `${Math.round(floorMean)} / ${Math.round(s.tokensInMean)} [${Math.round(floorMin)}–${Math.round(floorMax)} / ${Math.round(s.tokensInMin)}–${Math.round(s.tokensInMax)}] (floor/total)`;

      const totFloorMean = floorMean + s.tokensOutMean;
      const totFloorMin = floorMin + s.tokensOutMin;
      const totFloorMax = floorMax + s.tokensOutMax;
      totalTokensStr = `${Math.round(totFloorMean)} / ${Math.round(s.totalTokensMean)} [${Math.round(totFloorMin)}–${Math.round(totFloorMax)} / ${Math.round(s.totalTokensMin)}–${Math.round(s.totalTokensMax)}] (floor/total)`;
    } else {
      inputTokensStr = `${Math.round(s.tokensInMean)} [${Math.round(s.tokensInMin)}–${Math.round(s.tokensInMax)}]`;
      totalTokensStr = `${Math.round(s.totalTokensMean)} [${Math.round(s.totalTokensMin)}–${Math.round(s.totalTokensMax)}]`;
    }

    const outputTokensStr = `${Math.round(s.tokensOutMean)} [${Math.round(s.tokensOutMin)}–${Math.round(s.tokensOutMax)}]`;

    return {
      Provider: s.provider,
      Scenario: s.scenarioId,
      Paradigm: s.paradigm,
      Size: s.docSize,
      "Succ Rate": s.successRate,
      "XML Delta": xmlDeltaStr,
      "Fidelity": fidelityStr,
      "Xml Integrity": s.xmlIntegrityRate,
      "Trips": s.roundTripsMean.toFixed(1),
      "TurnsSucc": s.turnsToSuccessMean.toFixed(1),
      "Tokens In": inputTokensStr,
      "Tokens Out": outputTokensStr,
      "Total Tokens": totalTokensStr,
      "Cost": "UNKNOWN",
      "Latency": latencyStr,
    };
  });
  console.table(tableRows);
}

function writeLiveResultsFiles(summaries: LiveTrialSummary[]) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const resultsDir = "./results";

  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }

  const jsonPath = path.join(resultsDir, `${timestamp}.json`);
  const mdPath = path.join(resultsDir, `${timestamp}.md`);

  // Write JSON
  fs.writeFileSync(jsonPath, JSON.stringify(summaries, null, 2), "utf-8");
  console.log(`\x1b[32m[JSON Results Written]\x1b[0m Saved to ${jsonPath}`);
  
  // Also write to active live_benchmark_results.json
  fs.writeFileSync("./live_benchmark_results.json", JSON.stringify(summaries, null, 2), "utf-8");
  console.log(`\x1b[32m[JSON Results Written]\x1b[0m Saved to ./live_benchmark_results.json`);

  // Build Markdown Report
  let md = `# Live Benchmark Report\n\n`;
  md += `**Date:** ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}\n`;
  md += `**Repetitions (N):** ${reps} per trial\n`;
  md += `**Temperature:** 0.0\n\n`;

  md += `## Models Configured\n`;
  const modelsMap = Array.from(new Set(summaries.map((s) => `${s.provider}: \`${s.model}\``)));
  for (const item of modelsMap) {
    md += `- ${item}\n`;
  }
  md += `\n`;

  md += `## Comparative Metrics\n\n`;
  md += `> [Spacer alert note showing conditions of token savings]\n`;
  md += `> [!IMPORTANT]\n`;
  md += `> Token savings only matter when **Success Rate** is high. A paradigm that achieves low token counts but consistently fails tasks or corrupts document styling has zero utility.\n\n`;

  const scenariosGrouped = Array.from(new Set(summaries.map((s) => s.scenarioId)));

  for (const sId of scenariosGrouped) {
    const sResults = summaries.filter((s) => s.scenarioId === sId);
    const sName = sResults[0]?.scenarioName;

    md += `### Scenario: ${sName} (\`${sId}\`)\n\n`;
    md += `| Paradigm | Doc Size | Success Rate | XML Delta (Surgicality) | Fidelity Score (Avg [Min–Max]) | XML Integrity | Round Trips (Avg) | Turns to Success (Avg) | Recovery Rate (Avg) | Input Tokens (Avg [Min–Max]) | Output Tokens (Avg [Min–Max]) | Total Tokens (Avg [Min–Max]) | Cost (Avg [Min–Max]) | Latency (Avg [Min–Max]) |\n`;
    md += `| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |\n`;

    for (const s of sResults) {
      const latencyMean = s.latencyMeanMs / 1000;
      const latencyMin = s.latencyMinMs / 1000;
      const latencyMax = s.latencyMaxMs / 1000;
      const latencyStr = `${latencyMean.toFixed(1)}s [${latencyMin.toFixed(1)}–${latencyMax.toFixed(1)}]`;

      const fidelityStr = `${s.fidelityMean.toFixed(1)}% [${s.fidelityMin}–${s.fidelityMax}]`;
      const xmlDeltaStr = `${s.xmlDeltaMean.toFixed(0)} [${s.xmlDeltaMin}–${s.xmlDeltaMax}]`;
      
      let inputTokensStr = "";
      let totalTokensStr = "";

      if (s.paradigm === "safe-docx") {
        const floorMean = s.newContentTokensMean || 0;
        const floorMin = s.newContentTokensMin || 0;
        const floorMax = s.newContentTokensMax || 0;
        inputTokensStr = `${Math.round(floorMean).toLocaleString()} / ${Math.round(s.tokensInMean).toLocaleString()} [${Math.round(floorMin).toLocaleString()}–${Math.round(floorMax).toLocaleString()} / ${Math.round(s.tokensInMin).toLocaleString()}–${Math.round(s.tokensInMax).toLocaleString()}] (floor/total)`;

        const totFloorMean = floorMean + s.tokensOutMean;
        const totFloorMin = floorMin + s.tokensOutMin;
        const totFloorMax = floorMax + s.tokensOutMax;
        totalTokensStr = `${Math.round(totFloorMean).toLocaleString()} / ${Math.round(s.totalTokensMean).toLocaleString()} [${Math.round(totFloorMin).toLocaleString()}–${Math.round(totFloorMax).toLocaleString()} / ${Math.round(s.totalTokensMin).toLocaleString()}–${Math.round(s.totalTokensMax).toLocaleString()}] (floor/total)`;
      } else {
        inputTokensStr = `${Math.round(s.tokensInMean).toLocaleString()} [${Math.round(s.tokensInMin).toLocaleString()}–${Math.round(s.tokensInMax).toLocaleString()}]`;
        totalTokensStr = `${Math.round(s.totalTokensMean).toLocaleString()} [${Math.round(s.totalTokensMin).toLocaleString()}–${Math.round(s.totalTokensMax).toLocaleString()}]`;
      }

      const outputTokensStr = `${Math.round(s.tokensOutMean).toLocaleString()} [${Math.round(s.tokensOutMin).toLocaleString()}–${Math.round(s.tokensOutMax).toLocaleString()}]`;

      md += `| **${s.paradigm}** | ${s.docSize} | ${s.successRate} | ${xmlDeltaStr} | ${fidelityStr} | ${s.xmlIntegrityRate} | ${s.roundTripsMean.toFixed(1)} | ${s.turnsToSuccessMean.toFixed(1)} | ${(s.recoveryRateMean * 100).toFixed(1)}% | ${inputTokensStr} | ${outputTokensStr} | ${totalTokensStr} | UNKNOWN | ${latencyStr} |\n`;
    }
    md += `\n`;
  }

  fs.writeFileSync(mdPath, md, "utf-8");
  console.log(`\x1b[32m[Markdown Results Written]\x1b[0m Saved to ${mdPath}`);

  // Also write to active live_benchmark_results.md
  fs.writeFileSync("./live_benchmark_results.md", md, "utf-8");
}

// Automatically execute main if file is run directly
const nodePath = process.argv[1];
if (nodePath) {
  const currentFilePath = fileURLToPath(import.meta.url);
  if (
    currentFilePath.endsWith(nodePath) ||
    currentFilePath.replace(/\.ts$/, ".js").endsWith(nodePath) ||
    nodePath.endsWith("src/live.ts") ||
    nodePath.endsWith("dist/live.js")
  ) {
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
