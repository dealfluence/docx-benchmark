import * as fs from "node:fs";
import { DocumentObject, DocumentMapper } from "@adeu/core";
import { getGoldenDocxPath } from "../baselines.js";

async function dump() {
  const docPath = getGoldenDocxPath();
  const buffer = fs.readFileSync(docPath);
  const doc = await DocumentObject.load(buffer);
  console.log("=== PLAIN TEXT ===");
  console.log(new DocumentMapper(doc, true).full_text);
  console.log("=== CRITICMARKUP TEXT ===");
  console.log(new DocumentMapper(doc, false).full_text);
}
dump();
