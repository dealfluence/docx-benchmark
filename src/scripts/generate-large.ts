import * as fs from "node:fs";
import * as path from "node:path";
import { DocumentObject } from "@adeu/core";
import { DOMParser } from "@xmldom/xmldom";
import { getGoldenDocxPath } from "../baselines.js";

async function main() {
  const docPath = getGoldenDocxPath();
  const buffer = fs.readFileSync(docPath);
  const doc = await DocumentObject.load(buffer);

  const sections = [
    { title: "1. Terminology", text: "The Seller agrees to sell goods to the Buyer." },
    { title: "2. Payment", text: "Buyer shall pay the Seller within 30 days." },
    { title: "3. Delivery", text: "Seller shall deliver the goods to the Buyer's facility." },
    { title: "4. Warranties", text: "The Seller warrants that the goods are free of defects." },
    { title: "5. Liability Cap", text: "The Seller's maximum liability under this agreement shall be capped at $100,000." },
    {
      title: "6. Indemnity",
      text: "The Seller shall indemnify the Buyer against all claims.",
      withTrackChanges: true,
    },
    { title: "7. Governing Law", text: "This agreement is governed by the laws of New York." },
    { title: "8. Notices", text: "All notices shall be sent to the parties' respective addresses as set forth in §5." },
  ];

  const parser = new DOMParser();
  const paragraphXmls: string[] = [];

  // Add initial paragraph from golden.docx to preserve any tracked changes or comments
  paragraphXmls.push(
    `<w:p><w:r><w:t>Typing some. Typing some text</w:t></w:r></w:p>`
  );

  // Add §1 to §8 sections
  for (const sec of sections) {
    paragraphXmls.push(
      `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>## ${sec.title}</w:t></w:r></w:p>`
    );
    if (sec.withTrackChanges) {
      // Indemnity section has tracked changes
      paragraphXmls.push(
        `<w:p><w:r><w:t>The </w:t></w:r><w:ins w:id="Chg:12" w:author="Mikko Korpela" w:date="2026-04-18T21:02:00Z"><w:r><w:t>Seller</w:t></w:r></w:ins><w:del w:id="Chg:13" w:author="Mikko Korpela" w:date="2026-04-18T21:02:00Z"><w:r><w:t>Vendor</w:t></w:r></w:del><w:r><w:t> shall indemnify the Buyer against all claims.</w:t></w:r></w:p>`
      );
    } else {
      paragraphXmls.push(
        `<w:p><w:r><w:t>${sec.text}</w:t></w:r></w:p>`
      );
    }
  }

  // Add 100 paragraphs of boilerplate to make it clearly larger
  for (let i = 1; i <= 100; i++) {
    paragraphXmls.push(
      `<w:p><w:pPr><w:pStyle w:val="Heading3"/></w:pPr><w:r><w:t>## Section Boilerplate ${i}</w:t></w:r></w:p>`
    );
    paragraphXmls.push(
      `<w:p><w:r><w:t>This is boilerplate paragraph ${i} designed to inflate the size of the document for testing crossover behavior. The Safe Docx baseline should perform much better here when applying small edits, as it only needs to read and write small chunks instead of projecting the whole document like Adeu.</w:t></w:r></w:p>`
    );
  }

  const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphXmls.join("")}</w:body></w:document>`;
  doc.part.blob = docXml;
  doc.part._element = parser.parseFromString(docXml, "text/xml").documentElement as unknown as Element;

  const largePath = path.resolve(path.dirname(docPath), "golden_large.docx");
  const savedBuffer = await doc.save();
  fs.writeFileSync(largePath, savedBuffer);
  console.log(`Created large document at: ${largePath} (size: ${savedBuffer.length} bytes)`);
}

main().catch(console.error);
