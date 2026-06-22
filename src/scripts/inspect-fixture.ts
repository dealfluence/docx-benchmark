import * as fs from "node:fs";
import * as path from "node:path";
import { DocumentObject, DocumentMapper } from "@adeu/core";
import { getPartContent, extractStyleIds, hasHeaderOrFooter } from "../fidelity.js";

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Error: Please provide a path to a .docx fixture file.");
    console.error("Usage: npm run inspect-fixture -- <path_to_docx>");
    process.exit(1);
  }

  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    console.error(`Error: File not found at ${resolvedPath}`);
    process.exit(1);
  }

  console.log(`\n=== INSPECTING FIXTURE: ${path.basename(resolvedPath)} ===`);
  console.log(`Path: ${resolvedPath}`);

  try {
    const buffer = fs.readFileSync(resolvedPath);
    const doc = await DocumentObject.load(buffer);

    // 1. Plain Text Stats
    const mapperPlain = new DocumentMapper(doc, true);
    const plainText = mapperPlain.full_text;
    const wordCount = plainText.split(/\s+/).filter(Boolean).length;
    console.log(`- Word Count (plain text): ${wordCount}`);
    console.log(`- Paragraphs detected: ${plainText.split("\n\n").length}`);
    console.log(
      `- Text Preview:\n--------------------------------------------------\n${plainText.substring(0, 1000)}\n--------------------------------------------------`,
    );

    // 2. CriticMarkup Stats
    const mapperCritic = new DocumentMapper(doc, false);
    const criticText = mapperCritic.full_text;
    const hasCriticTags =
      criticText.includes("{++") || criticText.includes("{--") || criticText.includes("{>>");
    console.log(`- CriticMarkup / Track Changes tags present: ${hasCriticTags ? "YES" : "NO"}`);

    // 3. Styles Check
    const stylesXml = getPartContent(doc, "word/styles.xml");
    const styleIds = extractStyleIds(stylesXml);
    console.log(`- Custom Styles Extracted: ${styleIds.length} style ID(s) found.`);
    if (styleIds.length > 0) {
      console.log(
        `  -> IDs: ${styleIds.slice(0, 10).join(", ")}${styleIds.length > 10 ? "..." : ""}`,
      );
    }

    // 4. Headers & Footers
    const hasHdFt = hasHeaderOrFooter(doc);
    console.log(`- Running Headers / Footers: ${hasHdFt ? "PRESENT" : "ABSENT"}`);

    // 5. Margin Comments
    const hasComments = doc.pkg.parts.some((p) => p.partname.includes("comments"));
    console.log(`- Margin Comments: ${hasComments ? "PRESENT" : "ABSENT"}`);
    if (hasComments) {
      const commentsPart = doc.pkg.parts.find((p) => p.partname.includes("comments"));
      if (commentsPart) {
        const commentIds: string[] = [];
        const idRegex = /w:id="([^"]+)"/g;
        let match;
        while ((match = idRegex.exec(commentsPart.blob)) !== null) {
          commentIds.push(match[1]);
        }
        console.log(`  -> Unique Comment IDs: ${Array.from(new Set(commentIds)).join(", ")}`);
      }
    }

    // 6. Native OOXML Tracked Revisions (Insertions / Deletions)
    const docXml = doc.part.blob;
    const insCount = (docXml.match(/<w:ins\s/g) || []).length;
    const delCount = (docXml.match(/<w:del\s/g) || []).length;
    console.log(
      `- Native OOXML Tracked Changes: Insertions (${insCount}), Deletions (${delCount})`,
    );

    console.log("=== INSPECTION COMPLETE ===\n");
  } catch (error) {
    console.error("Error parsing or loading the document package:", error);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal exception during execution:", err);
  process.exit(1);
});
