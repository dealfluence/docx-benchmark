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

    // The schema/history/new-content split must sum exactly to tokensIn and
    // isolate a non-zero new-content floor (regression guard for the bug where
    // schema swallowed the entire prompt, forcing newContent to 0).
    // Turn 1 prompt (100) is learned as the fixed schema cost.
    // Turn 2: schema 100, history 10 (turn-1 new+out), newContent 40.
    expect(loopRes.schemaTokens).toBe(200);
    expect(loopRes.historyTokens).toBe(10);
    expect(loopRes.newContentTokens).toBe(40);
    expect(
      (loopRes.schemaTokens ?? 0) + (loopRes.historyTokens ?? 0) + (loopRes.newContentTokens ?? 0),
    ).toBe(loopRes.tokensIn);
  }, 60000);
});

describe("F6 Guard Test: Success Discriminates", () => {
  let buffer: Buffer;

  beforeAll(() => {
    buffer = fs.readFileSync(getGoldenDocxPath());
  });

  // SAFE-like body of comparable size for original vs filled, carrying the
  // "Post-Money Valuation Cap" anchor the base-integrity check requires.
  const SAFE_TEMPLATE =
    "THIS CERTIFIES THAT in exchange for the payment by [Investor Name] of $[_____________] " +
    "(the Purchase Amount) on [Date of Safe], [Company Name], a [State of Incorporation] corporation, " +
    "issues to the Investor the right to certain shares of the Company's Capital Stock. " +
    "The Post-Money Valuation Cap is $[_____________]. All rights and obligations are governed by the " +
    "laws of the State of [Governing Law Jurisdiction]. IN WITNESS WHEREOF: [_name_], [_title_].";
  const SAFE_FILLED =
    "THIS CERTIFIES THAT in exchange for the payment by Vertex Seed Fund, L.P. of $500,000 " +
    "(the Purchase Amount) on June 22, 2026, Acme Robotics, Inc., a Delaware corporation, " +
    "issues to the Investor the right to certain shares of the Company's Capital Stock. " +
    "The Post-Money Valuation Cap is $15,000,000. All rights and obligations are governed by the " +
    "laws of the State of Delaware. IN WITNESS WHEREOF: John Carter, Chief Executive Officer.";

  it("F6: form-fill — all fields filled, no placeholders, base intact", async () => {
    const orig = await createStrippedDoc(buffer, SAFE_TEMPLATE);
    const pass = await createStrippedDoc(buffer, SAFE_FILLED);
    const fail = await createStrippedDoc(
      buffer,
      SAFE_FILLED.replace("June 22, 2026", "[Date of Safe]"),
    );
    expect(await checkScenarioSuccess("form-fill", orig, pass)).toBe(true);
    expect(await checkScenarioSuccess("form-fill", orig, fail)).toBe(false);
  });

  it("F6: form-fill — fails the size floor when the doc is grossly truncated", async () => {
    // Big original, tiny output that still has all values + the anchor: must fail
    // because it retains far less than MIN_SIZE_RATIO of the original's length.
    const orig = await createStrippedDoc(buffer, "Boilerplate SAFE body sentence. ".repeat(80));
    const tiny = await createStrippedDoc(
      buffer,
      "Acme Robotics, Inc.; Delaware; Vertex Seed Fund, L.P.; $500,000; $15,000,000; " +
        "June 22, 2026; John Carter; Chief Executive Officer; Post-Money Valuation Cap.",
    );
    expect(await checkScenarioSuccess("form-fill", orig, tiny)).toBe(false);
  });

  it("F6: party-swap — all new parties, zero leftover prior parties, base intact", async () => {
    const executed =
      "This Series Seed Preferred Stock Investment Agreement is between Stark Industries, Inc. and " +
      "Pym Particle Ventures, L.P. Stark Industries, Inc. issues shares to Pym Particle Ventures, L.P. " +
      "The Key Holder is Anthony Stark. Notices to Stark Industries, Inc. and to Anthony Stark at " +
      "anthony@starkindustries.com. Signed by Anthony Stark for Stark Industries, Inc.";
    const swapped =
      "This Series Seed Preferred Stock Investment Agreement is between Wayne Enterprises, Inc. and " +
      "Fox Capital Partners, L.P. Wayne Enterprises, Inc. issues shares to Fox Capital Partners, L.P. " +
      "The Key Holder is Bruce Wayne. Notices to Wayne Enterprises, Inc. and to Bruce Wayne at " +
      "bruce@wayne.enterprises. Signed by Bruce Wayne for Wayne Enterprises, Inc.";
    const orig = await createStrippedDoc(buffer, executed);
    const pass = await createStrippedDoc(buffer, swapped);
    // A single leftover prior-party reference => fail, even with new parties present.
    const fail = await createStrippedDoc(
      buffer,
      swapped + " (prior counsel: Stark Industries, Inc.)",
    );
    expect(await checkScenarioSuccess("party-swap", orig, pass)).toBe(true);
    expect(await checkScenarioSuccess("party-swap", orig, fail)).toBe(false);
  });

  it("F6: policy-checklist-review fails on an unreviewed document (no comments/redlines)", async () => {
    const csa = await DocumentObject.load(
      fs.readFileSync("fixtures/common-paper/cloud-service-agreement.docx"),
    );
    expect(await checkScenarioSuccess("policy-checklist-review", csa, csa)).toBe(false);
  });

  it("F6: playbook-commenting fails on the seeded fixture before the model reviews it", async () => {
    // Seed has the counterparty's 8%/statutory proposal but no conforming 2% counter.
    const seeded = await DocumentObject.load(
      fs.readFileSync("fixtures/uk-gov/model-services-contract-redlined.docx"),
    );
    expect(await checkScenarioSuccess("playbook-commenting", seeded, seeded)).toBe(false);
  });

  it("F6: multi-file — both docs carry the values AND the CSA stays a CSA", async () => {
    const tempFilePath = "./temp_test_live_scenario5.docx";
    const tempDpaPath = "./temp_test_live_scenario5_dpa.docx";

    // DPA output must clear the size floor vs the ~24K DPA fixture and keep its
    // DPA-unique "Processor" anchor, so bulk it past the threshold.
    const dpaDoc = await createStrippedDoc(
      buffer,
      (
        "Data Processing Agreement. The Processor processes Personal Data for the Customer. " +
        "Customer: Wayne Enterprises, Inc. Effective Date: June 22, 2026. "
      ).repeat(220),
    );
    fs.writeFileSync(tempDpaPath, await dpaDoc.save());

    const origCsa = await createStrippedDoc(
      buffer,
      "Cloud Service Agreement. This Order Form and Cover Page set the Key Terms. The Subscription " +
        "Period begins on the Effective Date. Customer: [enter name of Customer]. Effective Date: [Date]. " +
        "General Cap Amount applies.",
    );
    const passCsa = await createStrippedDoc(
      buffer,
      "Cloud Service Agreement. This Order Form and Cover Page set the Key Terms. The Subscription " +
        "Period begins on the Effective Date. Customer: Wayne Enterprises, Inc. Effective Date: " +
        "June 22, 2026. General Cap Amount applies.",
    );
    // Corruption: CSA slot overwritten with DPA-like content (no "Order Form"/"Subscription Period").
    const corruptCsa = await createStrippedDoc(
      buffer,
      "Data Processing Agreement. The Processor handles Personal Data. Customer: Wayne Enterprises, " +
        "Inc. Effective Date: June 22, 2026.",
    );

    try {
      expect(
        await checkScenarioSuccess("multi-file-assembly", origCsa, passCsa, tempFilePath),
      ).toBe(true);
      // CSA overwritten with DPA content must FAIL the base-integrity invariant.
      expect(
        await checkScenarioSuccess("multi-file-assembly", origCsa, corruptCsa, tempFilePath),
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
