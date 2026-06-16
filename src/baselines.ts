import * as fs from "fs";
import * as path from "path";
import { DocumentObject, DocumentMapper } from "@adeu/core";
import { countTokens } from "./tokenizers.js";
import { scenarios } from "./scenarios.js";

// System prompts for each baseline as defined in the system architecture
export const XML_SYSTEM_PROMPT = `You are an expert contract editor. You are provided with the entire XML document of a Microsoft Word file (Flat OPC format).
Analyze the XML structure and perform the requested edit.
You must output the entire updated XML document, preserving all formatting, styles, relationships, and namespaces exactly as they are. Do not truncate the output, or the document will be corrupted.`;

export const MD_SYSTEM_PROMPT = `You are an expert contract editor. You are provided with the document content in Markdown format.
Perform the requested edits.
If the edit is a minor surgical correction, output only the updated paragraph. If it is a complex edit or insertion, output the full section containing the changes. Use clear markdown formatting.`;

export const ADEU_SYSTEM_PROMPT = `You are an expert contract editor. You are provided with the document in Markdown with track changes represented as CriticMarkup (e.g. {++insert++}, {--delete--}).
Perform the requested edits and output a JSON array of DocumentChange objects representing only the surgical modifications or review actions to be applied.
Supported operations:
- { "type": "modify", "target_text": string, "new_text": string }
- { "type": "accept", "target_id": string }
- { "type": "reject", "target_id": string }
- { "type": "reply", "target_id": string, "text": string }`;

// Blended industry average cost per million tokens
const R_IN = 3.0 / 1000000;
const R_OUT = 15.0 / 1000000;

export interface BaselineResult {
  baselineName: string;
  scenarioId: string;
  scenarioName: string;
  tokenizer: "cl100k_base" | "o200k_base";
  tokensIn: number;
  tokensOut: number;
  totalTokens: number;
  cost: number;
  fidelity: number;
  xmlIntegrity: "PASS" | "FAIL";
}

export function getGoldenDocxPath(): string {
  const candidates = [
    "./golden.docx",
    "../adeu/shared/fixtures/golden.docx",
    "/Users/mkorpela/workspace/adeu/shared/fixtures/golden.docx",
    "./shared/fixtures/golden.docx",
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return path.resolve(c);
    }
  }
  throw new Error("Could not locate golden.docx in any candidate paths");
}

export async function runSimulation(docPath: string): Promise<BaselineResult[]> {
  const buffer = fs.readFileSync(docPath);
  const doc = await DocumentObject.load(buffer);

  // 1. Raw XML (word/document.xml)
  const xmlStr = doc.part.blob;

  // 2. Plain Markdown (clean view of the document)
  const plainMd = new DocumentMapper(doc, true).full_text;

  // 3. CriticMarkup Markdown (unclean view with revision/comment tags)
  const criticMd = new DocumentMapper(doc, false).full_text;

  const tokenizers: ("cl100k_base" | "o200k_base")[] = ["cl100k_base", "o200k_base"];
  const results: BaselineResult[] = [];

  for (const tokenizer of tokenizers) {
    // Count token requirements for prompts & contents
    const tokensXml = countTokens(xmlStr, tokenizer);
    const tokensPlainMd = countTokens(plainMd, tokenizer);
    const tokensCriticMd = countTokens(criticMd, tokenizer);

    const tokensXmlPrompt = countTokens(XML_SYSTEM_PROMPT, tokenizer);
    const tokensMdPrompt = countTokens(MD_SYSTEM_PROMPT, tokenizer);
    const tokensAdeuPrompt = countTokens(ADEU_SYSTEM_PROMPT, tokenizer);

    for (const scenario of scenarios) {
      // -------------------------------------------------------------
      // Baseline 1: Raw XML / Flat OPC
      // -------------------------------------------------------------
      const b1In = tokensXml + tokensXmlPrompt;
      const b1Out = tokensXml; // entire XML must be returned to avoid corruption
      results.push({
        baselineName: "Raw XML / Flat OPC",
        scenarioId: scenario.id,
        scenarioName: scenario.name,
        tokenizer,
        tokensIn: b1In,
        tokensOut: b1Out,
        totalTokens: b1In + b1Out,
        cost: b1In * R_IN + b1Out * R_OUT,
        fidelity: 100,
        xmlIntegrity: "FAIL",
      });

      // -------------------------------------------------------------
      // Baseline 2: Naïve Markdown Round-Trip
      // -------------------------------------------------------------
      const b2In = tokensPlainMd + tokensMdPrompt;
      let b2Out = 0;

      if (scenario.id === "surgical-correction") {
        // Surgical edit: outputs only the modified paragraph
        let pText = "";
        if (plainMd.includes("Seller")) {
          const para = plainMd.split("\n").find((p) => p.includes("Seller")) || "";
          pText = para.replace(/Seller/g, "Vendor");
        } else {
          // If the placeholder document is too short, simulate a realistic paragraph
          pText = "This agreement is by and between the Vendor and the buyer.";
        }
        b2Out = countTokens(pText, tokenizer);
      } else if (scenario.id === "clause-drafting") {
        // Complex edit: outputs the full section containing the newly inserted content
        b2Out = countTokens(scenario.replacementText, tokenizer);
      } else if (scenario.id === "negotiation-cleanup") {
        // Surgical edit (even though track changes cannot natively be run, simulate paragraph emission)
        const resolvedPara =
          "The parties hereby agree to accept and resolve the tracked change Chg:12.";
        b2Out = countTokens(resolvedPara, tokenizer);
      }

      results.push({
        baselineName: "Naïve Markdown Round-Trip",
        scenarioId: scenario.id,
        scenarioName: scenario.name,
        tokenizer,
        tokensIn: b2In,
        tokensOut: b2Out,
        totalTokens: b2In + b2Out,
        cost: b2In * R_IN + b2Out * R_OUT,
        fidelity: 30,
        xmlIntegrity: "PASS",
      });

      // -------------------------------------------------------------
      // Baseline 3: Adeu Virtual DOM
      // -------------------------------------------------------------
      const b3In = tokensCriticMd + tokensAdeuPrompt;
      let b3Out = 0;

      if (scenario.id === "surgical-correction") {
        const changes = [
          {
            type: "modify",
            target_text: scenario.targetText,
            new_text: scenario.replacementText,
          },
        ];
        b3Out = countTokens(JSON.stringify(changes), tokenizer);
      } else if (scenario.id === "clause-drafting") {
        const changes = [
          {
            type: "modify",
            target_text: scenario.targetText,
            new_text: scenario.replacementText,
          },
        ];
        b3Out = countTokens(JSON.stringify(changes), tokenizer);
      } else if (scenario.id === "negotiation-cleanup") {
        const changes = [
          {
            type: "accept",
            target_id: scenario.reviewAction?.targetId || "Chg:12",
          },
        ];
        b3Out = countTokens(JSON.stringify(changes), tokenizer);
      }

      results.push({
        baselineName: "Adeu Virtual DOM",
        scenarioId: scenario.id,
        scenarioName: scenario.name,
        tokenizer,
        tokensIn: b3In,
        tokensOut: b3Out,
        totalTokens: b3In + b3Out,
        cost: b3In * R_IN + b3Out * R_OUT,
        fidelity: 100,
        xmlIntegrity: "PASS",
      });
    }
  }

  return results;
}
