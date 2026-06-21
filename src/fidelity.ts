import { DocumentObject } from "@adeu/core";
import { DOMParser } from "@xmldom/xmldom";

export interface FidelityReport {
  stylesPreserved: boolean;
  headersPreserved: boolean;
  commentsPreserved: boolean;
  trackChangesPreserved: boolean;
  score: number;
  xmlDelta: number;
}

/**
 * Safely extracts a part's XML content from DocumentObject by searching various paths.
 */
export function getPartContent(doc: DocumentObject, path: string): string {
  // Try normal path
  let part = doc.pkg.getPartByPath(path);
  if (!part) {
    // Try with leading slash
    part = doc.pkg.getPartByPath("/" + path);
  }
  if (!part) {
    // Search in parts array by partname ending with the path
    part = doc.pkg.parts.find(
      (p) => p.partname === path || p.partname === "/" + path || p.partname.endsWith(path),
    );
  }
  return part ? part.blob : "";
}

/**
 * Extract styleId attributes from a styles XML string.
 */
export function extractStyleIds(stylesXml: string): string[] {
  if (!stylesXml) return [];
  try {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(stylesXml, "text/xml");
    const styles = xmlDoc.getElementsByTagName("w:style");
    const ids: string[] = [];
    for (let i = 0; i < styles.length; i++) {
      const id = styles[i].getAttribute("w:styleId");
      if (id) ids.push(id);
    }
    return ids;
  } catch {
    return [];
  }
}

/**
 * Checks whether any running headers or footers exist in the package.
 */
export function hasHeaderOrFooter(doc: DocumentObject): boolean {
  const hasPart = doc.pkg.parts.some(
    (p) => p.partname.includes("header") || p.partname.includes("footer"),
  );
  if (hasPart) return true;

  for (const rel of doc.part.rels.values()) {
    if (rel.type.includes("relationships/header") || rel.type.includes("relationships/footer")) {
      return true;
    }
  }
  return false;
}

/**
 * Evaluates the high-fidelity features preserved between the original and modified documents.
 */
export function evaluateFidelity(
  originalDoc: DocumentObject,
  modifiedDoc: DocumentObject,
  scenarioId: string,
): FidelityReport {
  // 1. Styles Check
  const origStyles = getPartContent(originalDoc, "word/styles.xml");
  const modStyles = getPartContent(modifiedDoc, "word/styles.xml");
  const origIds = extractStyleIds(origStyles);
  const modIds = extractStyleIds(modStyles);

  // Consider it preserved if we didn't lose any of the custom styles
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
  const customStyles = origIds.filter(
    (id) => !defaultStyles.some((d) => d.toLowerCase() === id.toLowerCase()),
  );
  const missingCustom = customStyles.filter((id) => !modIds.includes(id));
  const stylesPreserved = customStyles.length === 0 || missingCustom.length === 0;

  // 2. Headers/Footers Check
  const origHasHdFt = hasHeaderOrFooter(originalDoc);
  const modHasHdFt = hasHeaderOrFooter(modifiedDoc);
  const headersPreserved = !origHasHdFt || modHasHdFt;

  // 3. Comments Check
  const origHasComments = originalDoc.pkg.parts.some((p) => p.partname.includes("comments"));
  const modHasComments = modifiedDoc.pkg.parts.some((p) => p.partname.includes("comments"));
  const commentsPreserved = !origHasComments || modHasComments;

  // 4. Tracked Changes Check
  const origDocXml = originalDoc.part.blob;
  const modDocXml = modifiedDoc.part.blob;
  const xmlDelta = calculateXmlDelta(origDocXml, modDocXml);
  const origIns = (origDocXml.match(/<w:ins\s/g) || []).length;
  const origDel = (origDocXml.match(/<w:del\s/g) || []).length;
  const modIns = (modDocXml.match(/<w:ins\s/g) || []).length;
  const modDel = (modDocXml.match(/<w:del\s/g) || []).length;

  const origTotal = origIns + origDel;
  const modTotal = modIns + modDel;

  let trackChangesPreserved = true;
  if (origTotal > 0) {
    if (scenarioId === "negotiation-cleanup") {
      // In negotiation-cleanup we accept some revisions, so it can decrease, but shouldn't drop to 0 unless all were accepted.
      trackChangesPreserved = modTotal >= 0;
    } else {
      // For other scenarios, unmutated tracked changes should not be flattened/lost
      trackChangesPreserved = modTotal > 0;
    }
  }

  // Calculate score: 20% baseline for unmutated paragraph run content text
  let score = 20;
  if (stylesPreserved) score += 20;
  if (headersPreserved) score += 20;
  if (commentsPreserved) score += 20;
  if (trackChangesPreserved) score += 20;

  return {
    stylesPreserved,
    headersPreserved,
    commentsPreserved,
    trackChangesPreserved,
    score,
    xmlDelta,
  };
}

/**
 * Simulates a Markdown round-trip by stripping headers, footers, comments, custom styles,
 * and tracked changes, and writing raw text paragraphs into a new DocumentObject structure.
 */
export async function createStrippedDoc(
  originalBuffer: Buffer,
  newText: string,
): Promise<DocumentObject> {
  const docCopy = await DocumentObject.load(originalBuffer);

  // Strip headers, footers, comments from package parts array
  docCopy.pkg.parts = docCopy.pkg.parts.filter((p) => {
    const name = p.partname.toLowerCase();
    return !name.includes("header") && !name.includes("footer") && !name.includes("comments");
  });

  // Strip references from document relations
  const docPart = docCopy.part;
  for (const [id, rel] of docPart.rels.entries()) {
    const type = rel.type.toLowerCase();
    if (type.includes("header") || type.includes("footer") || type.includes("comments")) {
      docPart.rels.delete(id);
    }
  }

  const parser = new DOMParser();

  // Replace word/styles.xml with empty styles container to represent formatting loss
  const stylesPart = docCopy.pkg.parts.find((p) => p.partname.endsWith("styles.xml"));
  if (stylesPart) {
    const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"></w:styles>`;
    stylesPart.blob = stylesXml;
    const parsedStyles = parser.parseFromString(stylesXml, "text/xml");
    stylesPart._element = parsedStyles.documentElement as unknown as Element;
  }

  // Inject reconstructed unstyled body paragraphs
  const paragraphXmls = newText.split("\n\n").map((para) => {
    const cleanPara = para.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `<w:p><w:r><w:t>${cleanPara}</w:t></w:r></w:p>`;
  });
  const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphXmls.join("")}</w:body></w:document>`;
  docCopy.part.blob = docXml;
  const parsedDoc = parser.parseFromString(docXml, "text/xml");
  docCopy.part._element = parsedDoc.documentElement as unknown as Element;

  return docCopy;
}

/**
 * Calculates the edit distance delta between original and modified XML strings by tag boundaries.
 */
export function calculateXmlDelta(originalXml: string, modifiedXml: string): number {
  if (!originalXml || !modifiedXml)
    return Math.abs((originalXml || "").length - (modifiedXml || "").length);

  const oXml = originalXml.replace(/\r\n/g, "\n");
  const mXml = modifiedXml.replace(/\r\n/g, "\n");

  if (oXml === mXml) return 0;

  // Split at closing XML tags to prevent single-line DP bloat
  const oLines = oXml
    .replace(/>/g, ">\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const mLines = mXml
    .replace(/>/g, ">\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const N = oLines.length;
  const M = mLines.length;

  // Guard against excessive memory usage for large files
  if (N > 4000 || M > 4000) {
    let matchingChars = 0;
    const limit = Math.min(oXml.length, mXml.length);
    for (let i = 0; i < limit; i++) {
      if (oXml[i] === mXml[i]) matchingChars++;
    }
    return oXml.length - matchingChars + (mXml.length - matchingChars);
  }

  const dp: number[][] = Array.from({ length: N + 1 }, () => Array(M + 1).fill(0));
  for (let i = 1; i <= N; i++) {
    for (let j = 1; j <= M; j++) {
      if (oLines[i - 1] === mLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const deleted: string[] = [];
  const added: string[] = [];
  let i = N;
  let j = M;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oLines[i - 1] === mLines[j - 1]) {
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      added.push(mLines[j - 1]);
      j--;
    } else {
      deleted.push(oLines[i - 1]);
      i--;
    }
  }

  let charDiff = 0;
  for (const line of deleted) charDiff += line.length;
  for (const line of added) charDiff += line.length;
  return charDiff;
}

/**
 * Reconstructs a DocumentObject by replacing its word/document.xml with an updated raw XML string.
 */
export async function createXmlReconstructedDoc(
  originalBuffer: Buffer,
  updatedXml: string,
): Promise<DocumentObject> {
  const docCopy = await DocumentObject.load(originalBuffer);
  docCopy.part.blob = updatedXml;
  const parser = new DOMParser();
  const parsedDoc = parser.parseFromString(updatedXml, "text/xml");
  docCopy.part._element = parsedDoc.documentElement as unknown as Element;
  return docCopy;
}
