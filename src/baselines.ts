import * as fs from "node:fs";
import * as path from "node:path";
import { DocumentObject, DocumentMapper } from "@adeu/core";
import { countTokens } from "./tokenizers.js";
import { scenarios } from "./scenarios.js";

// System prompts for each baseline as defined in the system architecture
export const XML_SYSTEM_PROMPT = `You are an expert contract editor. You are provided with the XML content of the main document part of a Microsoft Word file.
Analyze the XML structure and perform the requested edit.

To perform the edit, you can use either of these two formats:

1. SEARCH/REPLACE BLOCK FORMAT (Highly Recommended for surgical edits):
Output one or more search/replace blocks specifying exactly which lines of XML to modify. This preserves unmodified XML perfectly.
Format:
<<<<<<< SEARCH
[Exact XML lines from the original document to find]
=======
[New XML lines to replace the search block]
>>>>>>> REPLACE

2. FULL XML FORMAT:
If the change is extremely complex or touches almost every part, output the entire updated XML document.

Ensure you maintain valid XML syntax, well-formed tags, and preserve existing namespaces and styles.`;

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

export interface BaselineResult {
  baselineName: string;
  scenarioId: string;
  scenarioName: string;
  tokenizer: "cl100k_base" | "o200k_base";
  tokensIn: number;
  tokensOut: "n/a (requires live run)";
  totalTokens: "n/a (requires live run)";
  cost: "n/a (requires live run)";
  fidelity: "n/a (requires live run)";
  xmlIntegrity: "n/a (requires live run)";
}

export function getGoldenDocxPath(): string {
  const candidates = [
    "./golden.docx",
    "../adeu/shared/fixtures/golden.docx",
    "/Users/mkorpela/workspace/adeu-benchmark/golden.docx",
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
      // Baseline 1: Raw XML / Flat OPC
      const b1In = tokensXml + tokensXmlPrompt;
      results.push({
        baselineName: "Raw XML / Flat OPC",
        scenarioId: scenario.id,
        scenarioName: scenario.name,
        tokenizer,
        tokensIn: b1In,
        tokensOut: "n/a (requires live run)",
        totalTokens: "n/a (requires live run)",
        cost: "n/a (requires live run)",
        fidelity: "n/a (requires live run)",
        xmlIntegrity: "n/a (requires live run)",
      });

      // Baseline 2: Naïve Markdown Round-Trip
      const b2In = tokensPlainMd + tokensMdPrompt;
      results.push({
        baselineName: "Naïve Markdown Round-Trip",
        scenarioId: scenario.id,
        scenarioName: scenario.name,
        tokenizer,
        tokensIn: b2In,
        tokensOut: "n/a (requires live run)",
        totalTokens: "n/a (requires live run)",
        cost: "n/a (requires live run)",
        fidelity: "n/a (requires live run)",
        xmlIntegrity: "n/a (requires live run)",
      });

      // Baseline 3: Adeu Virtual DOM
      const b3In = tokensCriticMd + tokensAdeuPrompt;
      results.push({
        baselineName: "Adeu Virtual DOM",
        scenarioId: scenario.id,
        scenarioName: scenario.name,
        tokenizer,
        tokensIn: b3In,
        tokensOut: "n/a (requires live run)",
        totalTokens: "n/a (requires live run)",
        cost: "n/a (requires live run)",
        fidelity: "n/a (requires live run)",
        xmlIntegrity: "n/a (requires live run)",
      });
    }
  }

  return results;
}
