import * as fs from "node:fs";
import * as path from "node:path";
import { DocumentObject } from "@adeu/core";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { getGoldenDocxPath } from "../baselines.js";

async function main() {
  const docPath = getGoldenDocxPath();
  const buffer = fs.readFileSync(docPath);
  const doc = await DocumentObject.load(buffer);

  const parser = new DOMParser();
  const serializer = new XMLSerializer();
  
  const docXml = doc.part.blob;
  const xmlDoc = parser.parseFromString(docXml, "text/xml");
  const body = xmlDoc.getElementsByTagName("w:body")[0];
  if (!body) throw new Error("Could not find w:body in document XML");

  // Get all paragraphs/tables in the body except the final section properties
  const nodes: Node[] = [];
  let sectPr: Node | null = null;
  
  for (let i = 0; i < body.childNodes.length; i++) {
    const node = body.childNodes[i];
    if (node.nodeName === "w:sectPr") {
      sectPr = node;
    } else {
      nodes.push(node);
    }
  }

  // Duplicate the existing legal clauses 15 times to expand the document to ~10-15 pages
  // while retaining styles, headers, footers, and margins
  for (let step = 1; step <= 15; step++) {
    for (const node of nodes) {
      const cloned = node.cloneNode(true);
      const clonedStr = serializer.serializeToString(cloned);
      
      // Clean up tracked changes or comments inside cloned nodes to avoid structural duplications
      if (clonedStr.includes("w:ins") || clonedStr.includes("w:del") || clonedStr.includes("w:comment")) {
        const cleanXml = clonedStr
          .replace(/<w:ins[^>]*>/g, "")
          .replace(/<\/w:ins>/g, "")
          .replace(/<w:del[^>]*>[\s\S]*?<\/w:del>/g, "")
          .replace(/<w:commentRangeStart[^>]*\/>/g, "")
          .replace(/<w:commentRangeEnd[^>]*\/>/g, "")
          .replace(/<w:commentReference[^>]*\/>/g, "");
        
        try {
          const cleanedNode = parser.parseFromString(cleanXml, "text/xml").documentElement;
          if (cleanedNode) body.appendChild(cleanedNode);
        } catch {
          body.appendChild(cloned);
        }
      } else {
        body.appendChild(cloned);
      }
    }
  }

  // Re-append section properties at the very end
  if (sectPr) {
    body.appendChild(sectPr);
  }

  const updatedXml = serializer.serializeToString(xmlDoc);
  doc.part.blob = updatedXml;
  doc.part._element = xmlDoc.documentElement as unknown as Element;

  const largePath = path.resolve(path.dirname(docPath), "golden_large.docx");
  const savedBuffer = await doc.save();
  fs.writeFileSync(largePath, savedBuffer);
  console.log(`Created large document at: ${largePath} (size: ${savedBuffer.length} bytes)`);
}

main().catch(console.error);
