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
    const defaultStyles = [
      "Normal",
      "Heading1",
      "Heading2",
      "Heading3",
      "Title",
      "Subtitle",
      "DefaultParagraphFont",
      "NormalTable",
    ];
    const customStyles = styleIds.filter(
      (id) => !defaultStyles.some((d) => d.toLowerCase() === id.toLowerCase()),
    );
    console.log(`- Styles: Found ${styleIds.length} styles.`);
    console.log(`  -> Custom Styles (${customStyles.length}): ${customStyles.length > 0 ? customStyles.join(", ") : "None"}`);
    if (customStyles.length === 0) {
      console.warn("  [WARNING] No custom styles found. Styles fidelity sub-score will be vacuous!");
    }

    // 2. Headers/Footers
    const hasHdFt = hasHeaderOrFooter(doc);
    console.log(`- Headers/Footers: ${hasHdFt ? "PRESENT" : "ABSENT"}`);
    if (!hasHdFt) {
      console.warn("  [WARNING] No headers or footers found. Headers/footers fidelity sub-score will be vacuous!");
    }

    // 3. Comments
    const hasComments = doc.pkg.parts.some((p) => p.partname.includes("comments"));
    console.log(`- Margin Comments: ${hasComments ? "PRESENT" : "ABSENT"}`);
    if (!hasComments) {
      console.warn("  [WARNING] No margin comment threads found. Comments fidelity sub-score will be vacuous!");
    }

    // 4. Tracked Revisions
    const docXml = doc.part.blob;
    const insCount = (docXml.match(/<w:ins\s/g) || []).length;
    const delCount = (docXml.match(/<w:del\s/g) || []).length;
    console.log(`- Tracked Revisions: Insertions (${insCount}), Deletions (${delCount})`);
    if (insCount === 0 && delCount === 0) {
      console.warn("  [WARNING] No tracked changes found. Tracked revisions fidelity sub-score will be vacuous!");
    }

    console.log("\n=== END OF INSPECTION ===\n");
  } catch (error) {
    console.error("Error inspecting golden.docx:", error);
    process.exit(1);
  }
}

inspectGolden();
