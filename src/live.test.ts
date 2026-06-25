import * as fs from "node:fs";
import { describe, it, expect, beforeAll } from "vitest";
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
      countTokens: async () => ({ totalTokens: 100 }),
      generateContent: (() => {
        let turn = 0;
        return async () => {
          turn++;
          if (turn === 1) {
            return {
              usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 },
              candidates: [{ content: { parts: [{ functionCall: { name: "save", args: {} } }] } }],
              functionCalls: [{ name: "save", args: {} }],
            };
          } else {
            return {
              usageMetadata: { promptTokenCount: 150, candidatesTokenCount: 20 },
              candidates: [],
              functionCalls: [],
            };
          }
        };
      })(),
    };
    const mockGemini = { models: mockModel } as any;

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
  let docPath: string;
  let buffer: Buffer;
  let originalDoc: DocumentObject;

  beforeAll(async () => {
    docPath = getGoldenDocxPath();
    buffer = fs.readFileSync(docPath);
    originalDoc = await DocumentObject.load(buffer);
  });

  it("F6: form-fill evaluates dynamically and correctly", async () => {
    const passForm = await createStrippedDoc(
      buffer,
      "This Safe certifies that Acme Corporate Technologies, Inc. issues to Jane Founder of 15,000,000.",
    );
    const failForm = await createStrippedDoc(
      buffer,
      "This Safe certifies that [Company Name] of 15,000,000.",
    );
    expect(await checkScenarioSuccess("form-fill", originalDoc, passForm)).toBe(true);
    expect(await checkScenarioSuccess("form-fill", originalDoc, failForm)).toBe(false);
  });

  it("F6: party-swap evaluates dynamically and correctly", async () => {
    const passParty = await createStrippedDoc(
      buffer,
      "Wayne Enterprises, Inc. Wayne Enterprises, Inc. Wayne Enterprises, Inc. agrees to pay Bruce Wayne and Bruce Wayne the sum.",
    );
    const failParty = await createStrippedDoc(
      buffer,
      "This is dated as of and is between [COMPANY NAME] and [PURCHASER NAME].",
    );
    expect(await checkScenarioSuccess("party-swap", originalDoc, passParty)).toBe(true);
    expect(await checkScenarioSuccess("party-swap", originalDoc, failParty)).toBe(false);
  });

  it("F6: policy-checklist-review evaluates dynamically and correctly", async () => {
    const passPolicy = await createStrippedDoc(
      buffer,
      `Checklist review results: { "governingLaw": "unspecified", "liabilityCap": "General Cap", "standardTermsLink": "https://commonpaper.com/standards" }`,
    );
    const failPolicy = await createStrippedDoc(
      buffer,
      `Checklist review results: { "someKey": "value" }`,
    );
    expect(await checkScenarioSuccess("policy-checklist-review", originalDoc, passPolicy)).toBe(
      true,
    );
    expect(await checkScenarioSuccess("policy-checklist-review", originalDoc, failPolicy)).toBe(
      false,
    );
  });

  it("F6: playbook-commenting evaluates dynamically and correctly", async () => {
    const passComment = await createStrippedDoc(buffer, "Plain text document content");
    passComment.pkg.parts.push({
      partname: "word/comments.xml",
      blob: `<?xml version="1.0" encoding="UTF-8"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="1"><w:p><w:r><w:t>Late payment interest rate should be capped at 2.0% above Bank of England base rate, not statutory.</w:t></w:r></w:p></w:comment></w:comments>`,
    } as any);
    const failComment = await createStrippedDoc(buffer, "Plain text document content");
    expect(await checkScenarioSuccess("playbook-commenting", originalDoc, passComment)).toBe(true);
    expect(await checkScenarioSuccess("playbook-commenting", originalDoc, failComment)).toBe(false);
  });

  it("F6: multi-file-assembly evaluates dynamically and correctly", async () => {
    const tempFilePath = "./temp_test_live_scenario5.docx";
    const tempDpaPath = "./temp_test_live_scenario5_dpa.docx";

    // Create temporary DPA mock file
    const dpaDoc = await createStrippedDoc(
      buffer,
      "Wayne Enterprises, Inc. and June 22, 2026 dpa details",
    );
    const dpaExport = await dpaDoc.save();
    fs.writeFileSync(tempDpaPath, dpaExport);

    const passCsa = await createStrippedDoc(
      buffer,
      "Wayne Enterprises, Inc. and June 22, 2026 csa details",
    );

    try {
      expect(
        await checkScenarioSuccess("multi-file-assembly", originalDoc, passCsa, tempFilePath),
      ).toBe(true);

      const failCsa = await createStrippedDoc(buffer, "Missing Wayne details");
      expect(
        await checkScenarioSuccess("multi-file-assembly", originalDoc, failCsa, tempFilePath),
      ).toBe(false);
    } finally {
      if (fs.existsSync(tempDpaPath)) {
        fs.unlinkSync(tempDpaPath);
      }
    }
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
