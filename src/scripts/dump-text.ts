import * as fs from "node:fs";
import { DocumentObject, DocumentMapper } from "@adeu/core";
import { getGoldenDocxPath } from "../baselines.js";

async function dump() {
  const docPath = getGoldenDocxPath();
  const buffer = fs.readFileSync(docPath);
  const doc = await DocumentObject.load(buffer);
  console.log("=== GOLDEN.DOCX PLAIN TEXT ===");
  console.log(new DocumentMapper(doc, true).full_text);
  console.log("=== GOLDEN.DOCX CRITICMARKUP TEXT ===");
  console.log(new DocumentMapper(doc, false).full_text);

  const largePath = docPath.replace("golden.docx", "golden_large.docx");
  if (fs.existsSync(largePath)) {
    const largeBuffer = fs.readFileSync(largePath);
    const largeDoc = await DocumentObject.load(largeBuffer);
    console.log("\n=========================================");
    console.log("=== GOLDEN_LARGE.DOCX PLAIN TEXT ===");
    console.log(new DocumentMapper(largeDoc, true).full_text);
    console.log("=== GOLDEN_LARGE.DOCX CRITICMARKUP TEXT ===");
    console.log(new DocumentMapper(largeDoc, false).full_text);
  } else {
    console.log("\ngolden_large.docx not found.");
  }
}
dump();
