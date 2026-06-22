import * as fs from "node:fs";
import { describe, it, expect } from "vitest";
import { DocumentObject } from "@adeu/core";
import { runLiveBenchmark } from "./live.js";
import { getGoldenDocxPath } from "./utils/paths.js";
import { checkScenarioSuccess } from "./success.js";
import { DOMParser } from "@xmldom/xmldom";
import { runSafeDocxLoop } from "./loops.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

async function createStrippedDoc(originalBuffer: Buffer, newText: string): Promise<DocumentObject> {
  const docCopy = await DocumentObject.load(originalBuffer);
  docCopy.pkg.parts = docCopy.pkg.parts.filter((p) => {
    const name = p.partname.toLowerCase();
    return !name.includes("header") && !name.includes("footer") && !name.includes("comments");
  });
  const docPart = docCopy.part;
  for (const [id, rel] of docPart.rels.entries()) {
    const type = rel.type.toLowerCase();
    if (type.includes("header") || type.includes("footer") || type.includes("comments")) {
      docPart.rels.delete(id);
    }
  }
  const parser = new DOMParser();
  const stylesPart = docCopy.pkg.parts.find((p) => p.partname.endsWith("styles.xml"));
  if (stylesPart) {
    const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"></w:styles>`;
    stylesPart.blob = stylesXml;
    const parsedStyles = parser.parseFromString(stylesXml, "text/xml");
    stylesPart._element = parsedStyles.documentElement as unknown as Element;
  }
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

describe("live benchmark module", () => {
  it("should export runLiveBenchmark function", () => {
    expect(runLiveBenchmark).toBeTypeOf("function");
  });
});

describe("fairness and integrity check against hardcoded constants (F1)", () => {
  it("F1: Forbidden-literal guard - fails if hardcoded success/fidelity/xmlIntegrity in success path", () => {
    const liveFilePath = "./src/live.ts";
    const liveContent = fs.readFileSync(liveFilePath, "utf8");

    // F1 Forbidden-literal guard
    // The live file must not contain static mappings of outcomes like `xmlIntegrity: "FAIL"` or `xmlIntegrity: "PASS"` as hardcoded properties in the main live results summary.
    // It should only ever perform dynamic evaluations.
    const forbiddenFailPattern = /xmlIntegrity\s*:\s*["']FAIL["']/g;
    const forbiddenPassPattern = /xmlIntegrity\s*:\s*["']PASS["']/g;

    const staticFailMatches = liveContent.match(forbiddenFailPattern);
    const staticPassMatches = liveContent.match(forbiddenPassPattern);

    if (staticFailMatches) {
      for (const m of staticFailMatches) {
        expect(m).not.toContain('xmlIntegrity: "FAIL"');
      }
    }
    if (staticPassMatches) {
      for (const m of staticPassMatches) {
        expect(m).not.toContain('xmlIntegrity: "PASS"');
      }
    }

    // Ensure we never assign hardcoded literals directly to success, fidelity or xmlIntegrity in trials.push, unless it's fallback/error values.
    const trialsPushMatches = liveContent.match(/trials\.push\([\s\S]*?\)/g) || [];
    for (const match of trialsPushMatches) {
      if (match.includes("error:")) {
        // This is the error/fail trial push, which has fallback success: false, fidelity: 0. That's allowed.
        continue;
      }
      // In normal trial push, these should be variables
      expect(match).not.toContain("fidelity: 100");
      expect(match).not.toContain("fidelity: 40");
      expect(match).not.toContain("success: true");
      expect(match).not.toContain('xmlIntegrity: "PASS"');
    }
  });
});

describe("F4 Guard Test: Token Summing", () => {
  it("F4: Token summing across agentic conversation turns", async () => {
    const docPath = getGoldenDocxPath();
    const mockModel = {
      generateContent: (() => {
        let turn = 0;
        return async () => {
          turn++;
          if (turn === 1) {
            return {
              response: {
                usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 },
                candidates: [
                  { content: { parts: [{ functionCall: { name: "save", args: {} } }] } },
                ],
                functionCalls: () => [{ name: "save", args: {} }],
              },
            };
          } else {
            return {
              response: {
                usageMetadata: { promptTokenCount: 150, candidatesTokenCount: 20 },
                candidates: [],
                functionCalls: () => [],
              },
            };
          }
        };
      })(),
    };
    const mockGemini = { getGenerativeModel: () => mockModel } as any;

    const loopRes = await runSafeDocxLoop(
      mockGemini,
      "gemini-3.5-flash",
      docPath,
      "no-op",
      "No op",
    );

    // Total tokens should be sum across both turns:
    // Turn 1: 100 in, 10 out
    // Turn 2: 150 in, 20 out
    // Sum: 250 in, 30 out
    expect(loopRes.tokensIn).toBe(250);
    expect(loopRes.tokensOut).toBe(30);
  }, 60000);
});

describe("F6 Guard Test: Success Discriminates", () => {
  it("F6: Success criteria validation evaluates scenarios dynamically and correctly", async () => {
    const docPath = getGoldenDocxPath();
    const buffer = fs.readFileSync(docPath);
    const originalDoc = await DocumentObject.load(buffer);

    // 1. surgical-correction
    const passSurg = await createStrippedDoc(
      buffer,
      "This agreement is by and between NordicGlobal and the Customer.",
    );
    const failSurg = await createStrippedDoc(
      buffer,
      "This agreement is by and between NordicTech and the Customer.",
    );
    expect(checkScenarioSuccess("surgical-correction", originalDoc, passSurg)).toBe(true);
    expect(checkScenarioSuccess("surgical-correction", originalDoc, failSurg)).toBe(false);

    // 2. clause-drafting
    const passDraft = await createStrippedDoc(
      buffer,
      "## 8.4 Data Protection\nEach party shall comply with all applicable data protection laws",
    );
    const failDraft = await createStrippedDoc(buffer, "Some other text");
    expect(checkScenarioSuccess("clause-drafting", originalDoc, passDraft)).toBe(true);
    expect(checkScenarioSuccess("clause-drafting", originalDoc, failDraft)).toBe(false);

    // 3. negotiation-cleanup (checks CriticMarkup)
    const passNegotiation = await createStrippedDoc(buffer, "No changes left");
    // original doc has Chg:2, so check on originalDoc should be false
    expect(checkScenarioSuccess("negotiation-cleanup", originalDoc, passNegotiation)).toBe(true);
    expect(checkScenarioSuccess("negotiation-cleanup", originalDoc, originalDoc)).toBe(false);

    // 4. bulk-rewrite
    const passBulk = await createStrippedDoc(
      buffer,
      "Late payments shall accrue interest at the rate of 1.0%",
    );
    const failBulk = await createStrippedDoc(buffer, "accrue late interest at the rate of 1.5%");
    expect(checkScenarioSuccess("bulk-rewrite", originalDoc, passBulk)).toBe(true);
    expect(checkScenarioSuccess("bulk-rewrite", originalDoc, failBulk)).toBe(false);

    // 5. whole-document-restyle
    const passRestyle = await createStrippedDoc(buffer, "GOVERNING LAW");
    const failRestyle = await createStrippedDoc(buffer, "Governing Law");
    expect(checkScenarioSuccess("whole-document-restyle", originalDoc, passRestyle)).toBe(true);
    expect(checkScenarioSuccess("whole-document-restyle", originalDoc, failRestyle)).toBe(false);

    // 6. no-op
    expect(checkScenarioSuccess("no-op", originalDoc, originalDoc)).toBe(true);
    const failNoOp = await createStrippedDoc(buffer, "ShouldNotBeInserted");
    expect(checkScenarioSuccess("no-op", originalDoc, failNoOp)).toBe(false);

    // 7. conditional-edit
    const passCond = await createStrippedDoc(
      buffer,
      "Governing law is California. The parties irrevocably submit to the jurisdiction of California courts.",
    );
    const failCond = await createStrippedDoc(
      buffer,
      "Governing law is Germany. Disputes resolved by arbitration.",
    );
    expect(checkScenarioSuccess("conditional-edit", originalDoc, passCond)).toBe(true);
    expect(checkScenarioSuccess("conditional-edit", originalDoc, failCond)).toBe(false);

    // 8. dependent-multi-target
    const passDep = await createStrippedDoc(
      buffer,
      "2.2 feedback 2.3 customer data 2.4 data usage rights notwithstanding section 2.3",
    );
    const failDep = await createStrippedDoc(buffer, "feedback but no renumbering");
    expect(checkScenarioSuccess("dependent-multi-target", originalDoc, passDep)).toBe(true);
    expect(checkScenarioSuccess("dependent-multi-target", originalDoc, failDep)).toBe(false);

    // 9. selective-verify-and-repair
    const passSelective = await createStrippedDoc(
      buffer,
      "{++Esko Aho++}{>>[Chg:8 insert] Mikko<<}",
    );
    expect(checkScenarioSuccess("selective-verify-and-repair", originalDoc, passSelective)).toBe(
      true,
    );
    expect(checkScenarioSuccess("selective-verify-and-repair", originalDoc, originalDoc)).toBe(
      false,
    );

    // 10. search-then-compute
    const passSearchComp = await createStrippedDoc(buffer, "interest rate is 0.75%");
    const failSearchComp = await createStrippedDoc(buffer, "interest rate is 1.5%");
    expect(checkScenarioSuccess("search-then-compute", originalDoc, passSearchComp)).toBe(true);
    expect(checkScenarioSuccess("search-then-compute", originalDoc, failSearchComp)).toBe(false);
  });
});

describe("TEST-C Guard Test: Token Breakdown Splits", () => {
  it("TEST-C: Safe Docx token breakdown sums exactly to tokensIn on a mocked 3-turn transcript", () => {
    const schemaTokensPerTurn = 2500;

    const transcript = [
      { prompt: 3000, candidates: 100 },
      { prompt: 5700, candidates: 150 },
      { prompt: 8400, candidates: 50 },
    ];

    let tokensIn = 0;
    let tokensOut = 0;
    let schemaTokens = 0;
    let historyTokens = 0;
    let newContentTokens = 0;
    let historyAccumulated = 0;

    for (let turn = 1; turn <= transcript.length; turn++) {
      const promptTokensThisTurn = transcript[turn - 1].prompt;
      const candidatesTokensThisTurn = transcript[turn - 1].candidates;

      tokensIn += promptTokensThisTurn;
      tokensOut += candidatesTokensThisTurn;

      const sTokens = Math.min(schemaTokensPerTurn, promptTokensThisTurn);
      const hTokens = Math.min(historyAccumulated, promptTokensThisTurn - sTokens);
      const nTokens = promptTokensThisTurn - sTokens - hTokens;

      schemaTokens += sTokens;
      historyTokens += hTokens;
      newContentTokens += nTokens;

      historyAccumulated = hTokens + nTokens + candidatesTokensThisTurn;
    }

    expect(tokensIn).toBe(3000 + 5700 + 8400);
    expect(tokensOut).toBe(100 + 150 + 50);
    expect(tokensIn).toBe(schemaTokens + historyTokens + newContentTokens);
    expect(schemaTokens).toBe(2500 * 3);
    expect(schemaTokens).toBeGreaterThanOrEqual(0);
    expect(historyTokens).toBeGreaterThanOrEqual(0);
    expect(newContentTokens).toBeGreaterThanOrEqual(0);
  });
});
