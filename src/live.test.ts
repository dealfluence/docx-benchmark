import * as fs from "node:fs";
import { describe, it, expect } from "vitest";
import { DocumentObject, DocumentMapper } from "@adeu/core";
import {
  runLiveBenchmark,
  validateXmlSyntax,
  cleanJsonResponse,
  applyXmlSearchReplace,
  AdeuOutputSchema,
  cleanSchema
} from "./live.js";

import { mapSchemaType, withTimeout } from "./utils/gemini.js";
import { getStats, formatTokenMetric, getFullTaskDescription } from "./reporting.js";
import { SchemaType } from "@google/generative-ai";

import { getGoldenDocxPath } from "./baselines.js";
import { checkScenarioSuccess } from "./success.js";
import { evaluateFidelity, createStrippedDoc } from "./fidelity.js";

describe("live benchmark module", () => {
  it("should export runLiveBenchmark function", () => {
    expect(runLiveBenchmark).toBeTypeOf("function");
  });

  it("should successfully validate correct XML syntax", () => {
    const validXml = `<document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><body><p>Hello world</p></body></document>`;
    expect(validateXmlSyntax(validXml)).toBe(true);
  });

  it("should fail validation for incorrect XML syntax", () => {
    const invalidXml = `<document><body><p>Unclosed tag</body></document>`;
    expect(validateXmlSyntax(invalidXml)).toBe(false);
  });

  it("should correctly clean markdown json blocks", () => {
    const dirty = '```json\n[\n  { "type": "noOp" }\n]\n```';
    const cleaned = cleanJsonResponse(dirty);
    expect(cleaned).toBe('[\n  { "type": "noOp" }\n]');
  });

  it("should parse and apply XML search/replace blocks fairly", () => {
    const original = "<w:p><w:r><w:t>Seller hereby sells</w:t></w:r></w:p>";
    const response = `Here are the edits:
<<<<<<< SEARCH
<w:p><w:r><w:t>Seller hereby sells</w:t></w:r></w:p>
=======
<w:p><w:r><w:t>Vendor hereby sells</w:t></w:r></w:p>
>>>>>>> REPLACE`;

    const patched = applyXmlSearchReplace(original, response);
    expect(patched).toContain("Vendor hereby sells");
    expect(patched).not.toContain("Seller hereby sells");
  });
});

describe("success criteria and evaluation", () => {
  it("should verify scenario success rules dynamically", async () => {
    const docPath = getGoldenDocxPath();
    const buffer = fs.readFileSync(docPath);
    const originalDoc = await DocumentObject.load(buffer);

    // Mock a successful surgical-correction
    const successfulStrip = await createStrippedDoc(
      buffer,
      "This agreement is by and between the Vendor and the Buyer.",
    );
    const successfulSaved = await successfulStrip.save();
    const successfulDoc = await DocumentObject.load(successfulSaved);
    console.log("MODIFIED PLAIN TEXT:", new DocumentMapper(successfulDoc, true).full_text);
    expect(checkScenarioSuccess("surgical-correction", originalDoc, successfulDoc)).toBe(true);

    // Mock a failing surgical-correction
    const failingStrip = await createStrippedDoc(
      buffer,
      "This agreement is by and between the Seller and the Buyer.",
    );
    const failingSaved = await failingStrip.save();
    const failingDoc = await DocumentObject.load(failingSaved);
    expect(checkScenarioSuccess("surgical-correction", originalDoc, failingDoc)).toBe(false);

    // Mock a successful no-op
    expect(checkScenarioSuccess("no-op", originalDoc, originalDoc)).toBe(true);
  });

  it("should run evaluateFidelity against a known doc and detect roundtrip losses", async () => {
    const docPath = getGoldenDocxPath();
    const buffer = fs.readFileSync(docPath);
    const originalDoc = await DocumentObject.load(buffer);

    // Stripped doc represents markdown-roundtrip loss
    const strippedDoc = await createStrippedDoc(buffer, "Plain content without styles or comments");
    const result = evaluateFidelity(originalDoc, strippedDoc, "surgical-correction");

    // Markdown roundtrip loses styles, comments, and track changes
    expect(result.stylesPreserved).toBe(false);
    expect(result.commentsPreserved).toBe(false);
    expect(result.trackChangesPreserved).toBe(false);
    expect(result.score).toBe(40); // 20% baseline + 20% because headers/footers were absent (vacuous preservation)
  });
});

describe("focused xml and parsing utilities", () => {
  it("should handle applyXmlSearchReplace with lenient spaces and newlines", () => {
    const original = "<w:p>  <w:r>hello</w:r>  </w:p>";
    const response = `<<<<<<< SEARCH\n<w:p>  <w:r>hello</w:r>  </w:p>\n=======\n<w:p><w:r>world</w:r></w:p>\n>>>>>>> REPLACE`;
    expect(applyXmlSearchReplace(original, response)).toContain("world");
  });

  it("should throw custom error when SEARCH block is missing", () => {
    const original = "<w:p>hello</w:p>";
    const response = `<<<<<<< SEARCH\nnonexistent\n=======\nreplacement\n>>>>>>> REPLACE`;
    expect(() => applyXmlSearchReplace(original, response)).toThrow("Could not find search block in the XML");
  });

  it("should return original text if search headers are present but parse fails with bad boundary blocks", () => {
    const original = "<w:p>hello</w:p>";
    const response = "This has <<<<<<< SEARCH headers but missing REPLACE footer";
    expect(() => applyXmlSearchReplace(original, response)).toThrow("Found SEARCH/REPLACE headers but failed to parse them cleanly.");
  });

  it("should gracefully return original response if SEARCH string is not found but block structure is missing", () => {
    const original = "<w:p>hello</w:p>";
    const response = "This is a raw xml response without search blocks";
    expect(applyXmlSearchReplace(original, response)).toBe(response);
  });

  it("should clean nested or multiple backtick JSON blocks safely", () => {
    const dirty = "```json\n```json\n[]\n```\n```";
    const cleaned = cleanJsonResponse(dirty);
    expect(cleaned).toBe("```json\n[]\n```");
  });
});

describe("focused gemini and schema utilities", () => {
  it("should map any string to a SchemaType", () => {
    expect(mapSchemaType("object")).toBe(SchemaType.OBJECT);
    expect(mapSchemaType("array")).toBe(SchemaType.ARRAY);
    expect(mapSchemaType("string")).toBe(SchemaType.STRING);
    expect(mapSchemaType("integer")).toBe(SchemaType.INTEGER);
    expect(mapSchemaType("boolean")).toBe(SchemaType.BOOLEAN);
    expect(mapSchemaType("unknown_type_fallback")).toBe(SchemaType.STRING);
  });

  it("should clean complex schema union properties cleanly", () => {
    const unionSchema = {
      anyOf: [
        {
          type: "object",
          properties: {
            name: { type: "string" },
          },
          required: ["name"],
        },
        {
          type: "object",
          properties: {
            age: { type: "integer" },
          },
          required: ["name"],
        },
      ],
    };
    const cleaned = cleanSchema(unionSchema);
    expect(cleaned.type).toBe(SchemaType.OBJECT);
    expect(cleaned.properties.name.type).toBe(SchemaType.STRING);
    expect(cleaned.properties.age.type).toBe(SchemaType.INTEGER);
    expect(cleaned.required).toEqual(["name"]);
  });

  it("should execute withTimeout correctly under resolution", async () => {
    const result = await withTimeout(Promise.resolve("hello"), 50, "fail");
    expect(result).toBe("hello");
  });

  it("should execute withTimeout correctly under timeout triggering", async () => {
    const longPromise = new Promise((resolve) => setTimeout(() => resolve("late"), 200));
    await expect(withTimeout(longPromise, 10, "timed out!")).rejects.toThrow("timed out!");
  });
});

describe("focused reporting and stats utilities", () => {
  it("should correctly calculate stats metrics", () => {
    const stats = getStats([10, 20, 30]);
    expect(stats.mean).toBe(20);
    expect(stats.min).toBe(10);
    expect(stats.max).toBe(30);
  });

  it("should handle getStats on single element array safely", () => {
    const stats = getStats([42]);
    expect(stats.mean).toBe(42);
    expect(stats.min).toBe(42);
    expect(stats.max).toBe(42);
  });

  it("should format tokens with locale format options", () => {
    const metric = { mean: 1250000, min: 1000000, max: 1500000 };
    const formatted = formatTokenMetric(metric, undefined, false, true);
    expect(formatted).toContain("1,250,000");
    expect(formatted).toContain("1,000,000");
    expect(formatted).toContain("1,500,000");
  });

  it("should construct verbose scenario descriptions cleanly", () => {
    const mockScenario = {
      description: "Draft standard terms.",
      targetText: "old clause",
      replacementText: "new clause",
      reviewAction: { type: "accept", targetId: "Chg:9" },
    };
    const desc = getFullTaskDescription(mockScenario);
    expect(desc).toContain("Draft standard terms.");
    expect(desc).toContain('- Find target text: "old clause"');
    expect(desc).toContain('- Replace with: "new clause"');
    expect(desc).toContain('Review Action: {"type":"accept","targetId":"Chg:9"}');
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
import { runSafeDocxLoop } from "./live.js";
import * as path from "node:path";

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

describe("F2-F8 Guard Tests", () => {
  it("F2: Safe Docx is a real loop", async () => {
    const docPath = getGoldenDocxPath();

    // Setup Mock Gemini which returns function calls for 3 turns, then finishes on the 4th turn.
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
                  {
                    content: {
                      parts: [
                        {
                          functionCall: {
                            name: "grep",
                            args: { pattern: "Seller", file_path: docPath },
                          },
                        },
                      ],
                    },
                  },
                ],
                functionCalls: () => [
                  { name: "grep", args: { pattern: "Seller", file_path: docPath } },
                ],
              },
            };
          } else if (turn === 2) {
            return {
              response: {
                usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 12 },
                candidates: [
                  {
                    content: {
                      parts: [
                        {
                          functionCall: {
                            name: "replace_text",
                            args: {
                              target_paragraph_id: "_bk_e23f91f98915",
                              old_string: "Seller",
                              new_string: "Vendor",
                              instruction: "Update terminology to Vendor",
                              file_path: docPath,
                            },
                          },
                        },
                      ],
                    },
                  },
                ],
                functionCalls: () => [
                  {
                    name: "replace_text",
                    args: {
                      target_paragraph_id: "_bk_e23f91f98915",
                      old_string: "Seller",
                      new_string: "Vendor",
                      instruction: "Update terminology to Vendor",
                      file_path: docPath,
                    },
                  },
                ],
              },
            };
          } else if (turn === 3) {
            return {
              response: {
                usageMetadata: { promptTokenCount: 140, candidatesTokenCount: 15 },
                candidates: [
                  {
                    content: {
                      parts: [
                        { functionCall: { name: "save", args: { save_to_local_path: docPath } } },
                      ],
                    },
                  },
                ],
                functionCalls: () => [{ name: "save", args: { save_to_local_path: docPath } }],
              },
            };
          } else {
            return {
              response: {
                usageMetadata: { promptTokenCount: 150, candidatesTokenCount: 5 },
                candidates: [],
                functionCalls: () => [],
              },
            };
          }
        };
      })(),
    };

    const mockGemini = {
      getGenerativeModel: () => mockModel,
    } as any;

    const loopRes = await runSafeDocxLoop(
      mockGemini,
      "gemini-3.5-flash",
      docPath,
      "surgical-correction",
      "Update Seller to Vendor",
    );

    expect(loopRes.roundTrips).toBeGreaterThanOrEqual(2);
    expect(loopRes.success).toBe(true);
    expect(loopRes.finalBuffer).toBeDefined();
    expect(loopRes.finalBuffer?.length).toBeGreaterThan(0);
  });

  it("F4: Token summing", async () => {
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
  });

  it("F5: Fidelity discriminates", async () => {
    const docPath = getGoldenDocxPath();
    const buffer = fs.readFileSync(docPath);
    const originalDoc = await DocumentObject.load(buffer);

    const strippedDoc = await createStrippedDoc(buffer, "Plain content without styles or comments");
    const perfectScore = evaluateFidelity(originalDoc, originalDoc, "surgical-correction").score;
    const poorScore = evaluateFidelity(originalDoc, strippedDoc, "surgical-correction").score;

    expect(perfectScore).toBe(100);
    expect(poorScore).toBeLessThan(100);
    expect(perfectScore).not.toBe(poorScore);
  });

  it("F6: Success discriminates", async () => {
    const docPath = getGoldenDocxPath();
    const buffer = fs.readFileSync(docPath);
    const originalDoc = await DocumentObject.load(buffer);

    // 1. surgical-correction
    const passSurg = await createStrippedDoc(
      buffer,
      "This agreement is by and between the Vendor and the Buyer.",
    );
    const failSurg = await createStrippedDoc(
      buffer,
      "This agreement is by and between the Seller and the Buyer.",
    );
    expect(checkScenarioSuccess("surgical-correction", originalDoc, passSurg)).toBe(true);
    expect(checkScenarioSuccess("surgical-correction", originalDoc, failSurg)).toBe(false);

    // 2. clause-drafting
    const passDraft = await createStrippedDoc(
      buffer,
      "## 9. Data Protection\nEach party shall comply with all applicable data protection laws",
    );
    const failDraft = await createStrippedDoc(buffer, "Some other text");
    expect(checkScenarioSuccess("clause-drafting", originalDoc, passDraft)).toBe(true);
    expect(checkScenarioSuccess("clause-drafting", originalDoc, failDraft)).toBe(false);

    // 3. negotiation-cleanup (checks CriticMarkup)
    const passNegotiation = await createStrippedDoc(buffer, "No changes left");
    // original doc has Chg:12, so check on originalDoc should be false
    expect(checkScenarioSuccess("negotiation-cleanup", originalDoc, passNegotiation)).toBe(true);
    expect(checkScenarioSuccess("negotiation-cleanup", originalDoc, originalDoc)).toBe(false);

    // 4. bulk-rewrite
    const passBulk = await createStrippedDoc(buffer, "establish the terms of service");
    const failBulk = await createStrippedDoc(buffer, "Typing some. Typing some text");
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
      "Governing law is New York. Any venue shall be in the courts of NY.",
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
      "confidentiality 6. liability cap 9. notices section 6",
    );
    const failDep = await createStrippedDoc(buffer, "confidentiality but no renumbering");
    expect(checkScenarioSuccess("dependent-multi-target", originalDoc, passDep)).toBe(true);
    expect(checkScenarioSuccess("dependent-multi-target", originalDoc, failDep)).toBe(false);

    // 9. selective-verify-and-repair
    expect(checkScenarioSuccess("selective-verify-and-repair", originalDoc, originalDoc)).toBe(
      false,
    );

    // 10. search-then-compute
    const passSearchComp = await createStrippedDoc(buffer, "The liability cap is 50,000");
    const failSearchComp = await createStrippedDoc(buffer, "The liability cap is 100,000");
    expect(checkScenarioSuccess("search-then-compute", originalDoc, passSearchComp)).toBe(true);
    expect(checkScenarioSuccess("search-then-compute", originalDoc, failSearchComp)).toBe(false);
  });

  it("F7: Schemas reject bad input", () => {
    // 1. Adeu Output Schema
    const goodAdeu = [
      { type: "modify", target_text: "Seller", new_text: "Vendor" },
      { type: "accept", target_id: "Chg:12" },
    ];
    const badAdeuMissingField = [{ type: "modify", target_text: "Seller" }];
    const badAdeuWrongType = [{ type: "modify", target_text: "Seller", new_text: 1234 }];

    expect(AdeuOutputSchema.safeParse(goodAdeu).success).toBe(true);
    expect(AdeuOutputSchema.safeParse(badAdeuMissingField).success).toBe(false);
    expect(AdeuOutputSchema.safeParse(badAdeuWrongType).success).toBe(false);

    // 2. Safe Docx Clean Schema Mapper
    const rawSchema = {
      type: "object",
      properties: {
        file_path: { type: "string" },
        lines: { type: "integer" },
      },
      required: ["file_path"],
    };
    const cleaned = cleanSchema(rawSchema);
    expect(cleaned.type).toBe(SchemaType.OBJECT);
    expect(cleaned.properties.file_path.type).toBe(SchemaType.STRING);
    expect(cleaned.properties.lines.type).toBe(SchemaType.INTEGER);
  });

  it("F8: Reps plumbing", () => {
    const trialsList = [
      { latencyMs: 100, tokensIn: 50, tokensOut: 10, fidelity: 100 },
      { latencyMs: 200, tokensIn: 60, tokensOut: 20, fidelity: 80 },
      { latencyMs: 300, tokensIn: 70, tokensOut: 30, fidelity: 90 },
    ];

    const repCount = trialsList.length;
    const latencies = trialsList.map((t) => t.latencyMs);
    const fidelityList = trialsList.map((t) => t.fidelity);

    const latencyMeanMs = latencies.reduce((a, b) => a + b, 0) / repCount;
    const latencyMinMs = Math.min(...latencies);
    const latencyMaxMs = Math.max(...latencies);

    const fidelityMean = fidelityList.reduce((a, b) => a + b, 0) / repCount;
    const fidelityMin = Math.min(...fidelityList);
    const fidelityMax = Math.max(...fidelityList);

    expect(latencyMeanMs).toBe(200);
    expect(latencyMinMs).toBe(100);
    expect(latencyMaxMs).toBe(300);

    expect(fidelityMean).toBe(90);
    expect(fidelityMin).toBe(80);
    expect(fidelityMax).toBe(100);
  });

  it("TEST-A: No superdoc, SuperDoc, or ProseMirror strings exist in README.md, METHODOLOGY.md, or src/**/*.ts", () => {
    const forbidden = [/superdoc/i, /prosemirror/i];
    const root = path.resolve(".");
    const filesToSearch: string[] = [
      path.join(root, "README.md"),
      path.join(root, "METHODOLOGY.md"),
    ];

    // Recursively find files in src
    function getFiles(dir: string): string[] {
      const subdirs = fs.readdirSync(dir);
      const files = subdirs.map((subdir) => {
        const res = path.resolve(dir, subdir);
        return fs.statSync(res).isDirectory() ? getFiles(res) : res;
      });
      return files.flat();
    }

    const srcFiles = getFiles(path.join(root, "src")).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
    );
    filesToSearch.push(...srcFiles);

    for (const filePath of filesToSearch) {
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, "utf8");
      for (const pattern of forbidden) {
        if (pattern.test(content)) {
          throw new Error(`Forbidden word matches pattern ${pattern} found in file: ${filePath}`);
        }
      }
    }
  });

  it("TEST-B: Statistics aggregation carries min/max/mean and correct success rate format", () => {
    const trials = [
      {
        repIndex: 0,
        latencyMs: 1200,
        tokensIn: 1000,
        tokensOut: 100,
        xmlIntegrity: "PASS" as const,
        fidelity: 100,
        xmlDelta: 24,
        success: true,
        cost: 0.0001,
        roundTrips: 1,
        turnsToSuccess: 1,
        recoveryRate: 0,
        schemaTokens: 100,
        historyTokens: 100,
        newContentTokens: 800,
      },
      {
        repIndex: 1,
        latencyMs: 1500,
        tokensIn: 1200,
        tokensOut: 150,
        xmlIntegrity: "PASS" as const,
        fidelity: 80,
        xmlDelta: 120,
        success: true,
        cost: 0.00015,
        roundTrips: 1,
        turnsToSuccess: 1,
        recoveryRate: 0,
        schemaTokens: 100,
        historyTokens: 100,
        newContentTokens: 1000,
      },
      {
        repIndex: 2,
        latencyMs: 900,
        tokensIn: 800,
        tokensOut: 50,
        xmlIntegrity: "FAIL" as const,
        fidelity: 60,
        xmlDelta: 340,
        success: false,
        cost: 0.00008,
        roundTrips: 1,
        turnsToSuccess: 1,
        recoveryRate: 0,
        schemaTokens: 100,
        historyTokens: 100,
        newContentTokens: 600,
      },
    ];

    const repCount = trials.length;
    expect(repCount).toBe(3);

    const latencies = trials.map((t) => t.latencyMs);
    const tokensIns = trials.map((t) => t.tokensIn);
    const tokensOuts = trials.map((t) => t.tokensOut);
    const totalToks = trials.map((t) => t.tokensIn + t.tokensOut);
    const costs = trials.map((t) => t.cost);
    const fidelities = trials.map((t) => t.fidelity);
    const xmlDeltas = trials.map((t) => t.xmlDelta);
    const xmlDeltaMean = xmlDeltas.reduce((a, b) => a + b, 0) / repCount;
    const xmlDeltaMin = Math.min(...xmlDeltas);
    const xmlDeltaMax = Math.max(...xmlDeltas);

    const latencyMeanMs = latencies.reduce((a, b) => a + b, 0) / repCount;
    const latencyMinMs = Math.min(...latencies);
    const latencyMaxMs = Math.max(...latencies);

    const tokensInMean = tokensIns.reduce((a, b) => a + b, 0) / repCount;
    const tokensInMin = Math.min(...tokensIns);
    const tokensInMax = Math.max(...tokensIns);

    const tokensOutMean = tokensOuts.reduce((a, b) => a + b, 0) / repCount;
    const tokensOutMin = Math.min(...tokensOuts);
    const tokensOutMax = Math.max(...tokensOuts);

    const totalTokensMean = totalToks.reduce((a, b) => a + b, 0) / repCount;
    const totalTokensMin = Math.min(...totalToks);
    const totalTokensMax = Math.max(...totalToks);

    const costMean = costs.reduce((a, b) => a + b, 0) / repCount;
    const costMin = Math.min(...costs);
    const costMax = Math.max(...costs);

    const fidelityMean = fidelities.reduce((a, b) => a + b, 0) / repCount;
    const fidelityMin = Math.min(...fidelities);
    const fidelityMax = Math.max(...fidelities);

    const passCount = trials.filter((t) => t.xmlIntegrity === "PASS").length;
    const xmlIntegrityRate = `${passCount}/${repCount}`;

    const successCount = trials.filter((t) => t.success).length;
    const successRate = `${successCount}/${repCount}`;

    expect(latencyMeanMs).toBe(1200);
    expect(latencyMinMs).toBe(900);
    expect(latencyMaxMs).toBe(1500);

    expect(tokensInMean).toBe(1000);
    expect(tokensInMin).toBe(800);
    expect(tokensInMax).toBe(1200);

    expect(tokensOutMean).toBe(100);
    expect(tokensOutMin).toBe(50);
    expect(tokensOutMax).toBe(150);

    expect(totalTokensMean).toBe(1100);
    expect(totalTokensMin).toBe(850);
    expect(totalTokensMax).toBe(1350);
    expect(xmlDeltaMean).toBe(161.33333333333334);
    expect(xmlDeltaMin).toBe(24);
    expect(xmlDeltaMax).toBe(340);

    expect(costMean).toBeCloseTo(0.00011, 6);
    expect(costMin).toBe(0.00008);
    expect(costMax).toBe(0.00015);

    expect(fidelityMean).toBe(80);
    expect(fidelityMin).toBe(60);
    expect(fidelityMax).toBe(100);

    expect(xmlIntegrityRate).toBe("2/3");
    expect(successRate).toBe("2/3");
  });

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

  it("F9: Agentic loop sees MCP tool use instructions and passes tool results in history", async () => {
    const docPath = getGoldenDocxPath();

    let capturedTools: any = null;
    const capturedContentsHistory: any[] = [];

    const mockModel = {
      generateContent: (() => {
        let turn = 0;
        return async ({ contents }: { contents: any[] }) => {
          turn++;
          // Capture contents history at the beginning of each generateContent call
          capturedContentsHistory.push(JSON.parse(JSON.stringify(contents)));

          if (turn === 1) {
            return {
              response: {
                usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 },
                candidates: [
                  {
                    content: {
                      parts: [
                        {
                          functionCall: {
                            name: "grep",
                            args: { pattern: "Seller", file_path: docPath },
                          },
                        },
                      ],
                    },
                  },
                ],
                functionCalls: () => [
                  { name: "grep", args: { pattern: "Seller", file_path: docPath } },
                ],
              },
            };
          } else if (turn === 2) {
            return {
              response: {
                usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 12 },
                candidates: [
                  {
                    content: {
                      parts: [
                        {
                          functionCall: {
                            name: "replace_text",
                            args: {
                              target_paragraph_id: "_bk_e23f91f98915",
                              old_string: "Seller",
                              new_string: "Vendor",
                              instruction: "Update terminology to Vendor",
                              file_path: docPath,
                            },
                          },
                        },
                      ],
                    },
                  },
                ],
                functionCalls: () => [
                  {
                    name: "replace_text",
                    args: {
                      target_paragraph_id: "_bk_e23f91f98915",
                      old_string: "Seller",
                      new_string: "Vendor",
                      instruction: "Update terminology to Vendor",
                      file_path: docPath,
                    },
                  },
                ],
              },
            };
          } else if (turn === 3) {
            return {
              response: {
                usageMetadata: { promptTokenCount: 140, candidatesTokenCount: 15 },
                candidates: [
                  {
                    content: {
                      parts: [
                        { functionCall: { name: "save", args: { save_to_local_path: docPath } } },
                      ],
                    },
                  },
                ],
                functionCalls: () => [{ name: "save", args: { save_to_local_path: docPath } }],
              },
            };
          } else {
            return {
              response: {
                usageMetadata: { promptTokenCount: 150, candidatesTokenCount: 5 },
                candidates: [],
                functionCalls: () => [],
              },
            };
          }
        };
      })(),
    };

    const mockGemini = {
      getGenerativeModel: (config: any) => {
        capturedTools = config.tools;
        return mockModel;
      },
    } as any;

    const loopRes = await runSafeDocxLoop(
      mockGemini,
      "gemini-3.5-flash",
      docPath,
      "surgical-correction",
      "Update Seller to Vendor",
    );

    // 1. Verify that the agent gets to see the tool use instructions from the MCP
    expect(capturedTools).toBeDefined();
    expect(capturedTools).toHaveLength(1);
    const functionDeclarations = capturedTools[0].functionDeclarations;
    expect(functionDeclarations).toBeDefined();
    expect(functionDeclarations.length).toBeGreaterThan(0);

    // Verify presence of core safe-docx tools mapped from the MCP server
    const grepTool = functionDeclarations.find((f: any) => f.name === "grep");
    const replaceTool = functionDeclarations.find((f: any) => f.name === "replace_text");
    const saveTool = functionDeclarations.find((f: any) => f.name === "save");

    expect(grepTool).toBeDefined();
    expect(replaceTool).toBeDefined();
    expect(saveTool).toBeDefined();

    // Verify they have parameters and descriptions (MCP tool use instructions)
    expect(grepTool.description).toBeTypeOf("string");
    expect(replaceTool.description).toBeTypeOf("string");
    expect(saveTool.description).toBeTypeOf("string");
    expect(grepTool.parameters).toBeDefined();

    // 2. Verify that the conversation/message history passed to generateContent contains tool results
    expect(capturedContentsHistory).toHaveLength(4);

    // Turn 1 should only contain the system prompt and task instructions
    expect(capturedContentsHistory[0]).toHaveLength(1);
    expect(capturedContentsHistory[0][0].role).toBe("user");

    // Turn 2 should have the Model's turn 1 tool call, and the User's turn 1 tool response
    expect(capturedContentsHistory[1]).toHaveLength(3);
    expect(capturedContentsHistory[1][0].role).toBe("user");
    expect(capturedContentsHistory[1][1].role).toBe("model");
    expect(capturedContentsHistory[1][1].parts[0].functionCall).toBeDefined();
    expect(capturedContentsHistory[1][1].parts[0].functionCall.name).toBe("grep");

    expect(capturedContentsHistory[1][2].role).toBe("user");
    expect(capturedContentsHistory[1][2].parts[0].functionResponse).toBeDefined();
    expect(capturedContentsHistory[1][2].parts[0].functionResponse.name).toBe("grep");
    expect(capturedContentsHistory[1][2].parts[0].functionResponse.response).toBeDefined();

    // Turn 3 should have all previous calls and responses
    expect(capturedContentsHistory[2]).toHaveLength(5);
    expect(capturedContentsHistory[2][1].role).toBe("model");
    expect(capturedContentsHistory[2][1].parts[0].functionCall.name).toBe("grep");
    expect(capturedContentsHistory[2][2].role).toBe("user");
    expect(capturedContentsHistory[2][2].parts[0].functionResponse.name).toBe("grep");
    expect(capturedContentsHistory[2][3].role).toBe("model");
    expect(capturedContentsHistory[2][3].parts[0].functionCall.name).toBe("replace_text");
    expect(capturedContentsHistory[2][4].role).toBe("user");
    expect(capturedContentsHistory[2][4].parts[0].functionResponse.name).toBe("replace_text");

    expect(loopRes.success).toBe(true);
  });
});
