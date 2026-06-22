import * as fs from "node:fs";
import * as path from "node:path";
import { DocumentObject, DocumentMapper } from "@adeu/core";

async function main() {
  const resolved = path.resolve("fixtures/bonterms/cloud-terms.docx");
  const buffer = fs.readFileSync(resolved);
  const doc = await DocumentObject.load(buffer);
  const mapper = new DocumentMapper(doc, true);
  const text = mapper.full_text;

  const lines = text.split("\n");
  console.log("=== SEARCHING IN BONTERMS CLOUD-TERMS ===");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (
      line.toLowerCase().includes("interest") ||
      line.toLowerCase().includes("late") ||
      line.toLowerCase().includes("payment")
    ) {
      console.log(`Line ${i}: ${line}`);
    }
  }
}

main().catch((err) => console.error(err));
