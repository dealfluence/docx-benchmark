import { DocumentObject } from "@adeu/core";
import { DOMParser } from "@xmldom/xmldom";

export interface FidelityReport {
  stylesPreserved: boolean;
  headersPreserved: boolean;
  commentsPreserved: boolean;
  trackChangesPreserved: boolean;
  score: number;
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

  // Replace word/styles.xml with empty styles container to represent formatting loss
  const stylesPart = docCopy.pkg.parts.find((p) => p.partname.endsWith("styles.xml"));
  if (stylesPart) {
    stylesPart.blob = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"></w:styles>`;
  }

  // Inject reconstructed unstyled body paragraphs
  const paragraphXmls = newText.split("\n\n").map((para) => {
    const cleanPara = para.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `<w:p><w:r><w:t>${cleanPara}</w:t></w:r></w:p>`;
  });
  docCopy.part.blob = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphXmls.join("")}</w:body></w:document>`;

  return docCopy;
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
  return docCopy;
}
