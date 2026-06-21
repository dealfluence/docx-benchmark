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
 * Uses a robust line-based state machine to bypass regex line-ending limitations.
 */
export function applyXmlSearchReplace(originalXml: string, responseText: string): string {
  const lines = responseText.split(/\r?\n/);
  const blocks: Array<{ search: string; replace: string }> = [];

  let inSearch = false;
  let inReplace = false;
  let searchLines: string[] = [];
  let replaceLines: string[] = [];
  let hasHeaders = false;

  for (const line of lines) {
    if (line.includes("<<<<<<< SEARCH")) {
      inSearch = true;
      inReplace = false;
      searchLines = [];
      replaceLines = [];
      hasHeaders = true;
      continue;
    }
    if (line.includes("=======") && inSearch) {
      inSearch = false;
      inReplace = true;
      continue;
    }
    if (line.includes(">>>>>>> REPLACE") && inReplace) {
      inSearch = false;
      inReplace = false;
      blocks.push({
        search: searchLines.join("\n"),
        replace: replaceLines.join("\n"),
      });
      continue;
    }

    if (inSearch) {
      searchLines.push(line);
    } else if (inReplace) {
      replaceLines.push(line);
    }
  }

  if (blocks.length === 0) {
    if (hasHeaders || responseText.includes("<<<<<<< SEARCH")) {
      throw new Error("Found SEARCH/REPLACE headers but failed to parse them cleanly.");
    }
    return responseText; // Treat entire output as full XML
  }

  let patchedXml = originalXml;
  for (const block of blocks) {
    const searchBlock = block.search;
    const replaceBlock = block.replace;
    const normalizedSearch = searchBlock.trim();

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
