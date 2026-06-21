import { DOMParser } from "@xmldom/xmldom";

/**
 * Validates whether the given string is well-formed XML syntax.
 */
export function validateXmlSyntax(rawOutput: string): boolean {
  try {
    const parser = new DOMParser({
      onError: () => {
        throw new Error("XML Parse Error");
      },
    });
    const xmlDoc = parser.parseFromString(rawOutput, "text/xml");
    return xmlDoc.getElementsByTagName("parsererror").length === 0;
  } catch {
    return false;
  }
}

/**
 * Parses and merges XML modifications expressed as SEARCH/REPLACE blocks.
 */
export function applyXmlSearchReplace(originalXml: string, responseText: string): string {
  const blockRegex =
    /<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/g;
  let matches = [...responseText.matchAll(blockRegex)];

  if (matches.length === 0) {
    const lenientRegex = /<<<<<<< SEARCH([\s\S]*?)=======\s*([\s\S]*?)>>>>>>> REPLACE/g;
    matches = [...responseText.matchAll(lenientRegex)];
  }

  if (matches.length === 0) {
    if (responseText.includes("<<<<<<< SEARCH")) {
      throw new Error("Found SEARCH/REPLACE headers but failed to parse them cleanly.");
    }
    return responseText; // Treat entire output as full XML
  }

  let patchedXml = originalXml;
  for (const match of matches) {
    const searchBlock = match[1];
    const replaceBlock = match[2];
    const normalizedSearch = searchBlock.replace(/\r\n/g, "\n").trim();

    if (patchedXml.includes(searchBlock)) {
      patchedXml = patchedXml.replace(searchBlock, replaceBlock);
    } else if (patchedXml.replace(/\r\n/g, "\n").includes(normalizedSearch)) {
      const originalLines = patchedXml.split(/\r?\n/);
      const searchLines = normalizedSearch.split("\n");
      let foundIndex = -1;
      for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
        let matchLines = true;
        for (let j = 0; j < searchLines.length; j++) {
          if (originalLines[i + j].trim() !== searchLines[j].trim()) {
            matchLines = false;
            break;
          }
        }
        if (matchLines) {
          foundIndex = i;
          break;
        }
      }

      if (foundIndex !== -1) {
        originalLines.splice(foundIndex, searchLines.length, replaceBlock);
        patchedXml = originalLines.join("\n");
      } else {
        patchedXml = patchedXml.replace(/\r\n/g, "\n").replace(normalizedSearch, replaceBlock);
      }
    } else {
      const searchTrimmed = searchBlock.trim();
      if (patchedXml.includes(searchTrimmed)) {
        patchedXml = patchedXml.replace(searchTrimmed, replaceBlock.trim());
      } else {
        throw new Error(`Could not find search block in the XML:\n${searchBlock}`);
      }
    }
  }
  return patchedXml;
}

/**
 * Strips formatting backticks from incoming stringified JSON messages.
 */
export function cleanJsonResponse(raw: string): string {
  return raw
    .trim()
    .replace(/^```(json)?/i, "")
    .replace(/```$/, "")
    .trim();
}