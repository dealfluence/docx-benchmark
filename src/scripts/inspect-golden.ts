import * as fs from "node:fs";
import { DocumentObject } from "@adeu/core";
import { getGoldenDocxPath } from "../baselines.js";
import { getPartContent, extractStyleIds, hasHeaderOrFooter } from "../fidelity.js";

async function inspectGolden() {
  try {
    const docPath = getGoldenDocxPath();
    console.log(`Loading golden document from: ${docPath}`);
    const buffer = fs.readFileSync(docPath);
    const doc = await DocumentObject.load(buffer);

    console.log("\n=== GOLDEN DOCUMENT FIDELITY DIMENSIONS ===\n");

    // 1. Styles Check
    const stylesXml = getPartContent(doc, "word/styles.xml");
    const styleIds = extractStyleIds(stylesXml);
    console.log(`- Styles: Found ${styleIds.length} styles.`);

    // 2. Headers/Footers
    const hasHdFt = hasHeaderOrFooter(doc);
    console.log(`- Headers/Footers: ${hasHdFt ? "PRESENT" : "ABSENT"}`);

    // 3. Comments
    const hasComments = doc.pkg.parts.some((p) => p.partname.includes("comments"));
    console.log(`- Margin Comments: ${hasComments ? "PRESENT" : "ABSENT"}`);

    // 4. Tracked Revisions
    const docXml = doc.part.blob;
    const insCount = (docXml.match(/<w:ins\s/g) || []).length;
    const delCount = (docXml.match(/<w:del\s/g) || []).length;
    console.log(`- Tracked Revisions: Insertions (${insCount}), Deletions (${delCount})`);

    // List some comment metadata elements if comments are present
    const commentsPart = doc.pkg.parts.find((p) => p.partname.includes("comments"));
    if (commentsPart) {
      const commentIds: string[] = [];
      const idRegex = /w:id="([^"]+)"/g;
      let match;
      while ((match = idRegex.exec(commentsPart.blob)) !== null) {
        commentIds.push(match[1]);
      }
      console.log(`  -> Found Comment IDs in XML: ${Array.from(new Set(commentIds)).join(", ")}`);
    }

    console.log("\n=== END OF INSPECTION ===\n");
  } catch (error) {
    console.error("Error inspecting golden.docx:", error);
    process.exit(1);
  }
}

inspectGolden();
