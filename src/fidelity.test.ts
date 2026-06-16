import * as fs from "node:fs";
import { describe, it, expect } from "vitest";
import { DocumentObject } from "@adeu/core";
import { getGoldenDocxPath } from "./baselines.js";
import {
  evaluateFidelity,
  getPartContent,
  extractStyleIds,
  hasHeaderOrFooter,
} from "./fidelity.js";

describe("fidelity checks", () => {
  it("should extract styles, headers, and comments from golden.docx", async () => {
    const docPath = getGoldenDocxPath();
    const buffer = fs.readFileSync(docPath);
    const doc = await DocumentObject.load(buffer);

    expect(doc).toBeDefined();

    // Check style extracting
    const stylesXml = getPartContent(doc, "word/styles.xml");
    expect(stylesXml).toBeTruthy();
    const styleIds = extractStyleIds(stylesXml);
    expect(styleIds.length).toBeGreaterThan(0);

    // Check headers/footers
    const hasHdFt = hasHeaderOrFooter(doc);
    expect(hasHdFt).toBe(false);
  });

  it("should return 100% fidelity score when comparing golden.docx to itself", async () => {
    const docPath = getGoldenDocxPath();
    const buffer = fs.readFileSync(docPath);
    const origDoc = await DocumentObject.load(buffer);
    const modDoc = await DocumentObject.load(buffer);

    const report = evaluateFidelity(origDoc, modDoc, "surgical-correction");
    expect(report.stylesPreserved).toBe(true);
    expect(report.headersPreserved).toBe(true);
    expect(report.commentsPreserved).toBe(true);
    expect(report.trackChangesPreserved).toBe(true);
    expect(report.score).toBe(100);
  });
});
