import * as fs from "node:fs";
import * as path from "node:path";
import { DocumentObject, DocumentMapper } from "@adeu/core";

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Please provide file path");
    process.exit(1);
  }
  const resolved = path.resolve(filePath);
  const buffer = fs.readFileSync(resolved);
  const doc = await DocumentObject.load(buffer);
  const mapper = new DocumentMapper(doc, true);
  const text = mapper.full_text;
  
  console.log(`=== FULL TEXT FOR ${path.basename(resolved)} ===`);
  const regex = /\[([^\]]+)\]/g;
  let match;
  console.log("Found bracketed placeholders:");
  while ((match = regex.exec(text)) !== null) {
    console.log(`- ${match[0]} at index ${match.index}`);
  }
  console.log("\nFirst 3000 chars:");
  console.log(text.substring(0, 3000));
  console.log("=== END OF TEXT ===");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
