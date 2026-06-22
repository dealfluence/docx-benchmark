import * as fs from "node:fs";
import * as path from "node:path";
import { DocumentObject, DocumentMapper } from "@adeu/core";

async function main() {
  const resolved = path.resolve("fixtures/common-paper/cloud-service-agreement.docx");
  const buffer = fs.readFileSync(resolved);
  const doc = await DocumentObject.load(buffer);
  const mapper = new DocumentMapper(doc, true);
  const text = mapper.full_text;

  const lines = text.split("\n");
  console.log("=== CSA LINES 360 to 400 ===");
  for (let i = 360; i < 400; i++) {
    if (lines[i] !== undefined) {
      console.log(`Line ${i}: ${lines[i]}`);
    }
  }
}

main().catch((err) => console.error(err));
