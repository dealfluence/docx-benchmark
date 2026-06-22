import * as fs from "node:fs";
import * as path from "node:path";
import { DocumentObject, DocumentMapper } from "@adeu/core";

const fixtures = [
  "fixtures/ycombinator/post-money-safe.docx",
  "fixtures/common-paper/statement-of-work.docx",
  "fixtures/common-paper/cloud-service-agreement.docx",
  "fixtures/common-paper/dpa-module.docx",
  "fixtures/common-paper/professional-services-agreement.docx",
  "fixtures/common-paper/order-form.docx",
  "fixtures/series-seed/investment-agreement.docx",
  "fixtures/bonterms/cloud-terms.docx",
  "fixtures/uk-gov/model-services-contract.docx",
  "fixtures/eu-scc/standard-contractual-clauses.docx",
];

async function main() {
  for (const f of fixtures) {
    const p = path.resolve(f);
    if (!fs.existsSync(p)) continue;
    const buffer = fs.readFileSync(p);
    const doc = await DocumentObject.load(buffer);
    const mapper = new DocumentMapper(doc, true);
    const text = mapper.full_text;

    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (
        line.includes("1.5%") ||
        line.includes("late interest") ||
        (line.toLowerCase().includes("interest") && line.toLowerCase().includes("late"))
      ) {
        console.log(`[${f}] Line ${i}: ${line}`);
      }
    }
  }
}

main().catch((err) => console.error(err));
