import { describe, it, expect } from "vitest";
import { getGoldenDocxPath, runSimulation } from "./baselines.js";

describe("baselines simulation", () => {
  it("should run simulation on golden.docx and return 18 results", async () => {
    const docPath = getGoldenDocxPath();
    const results = await runSimulation(docPath);

    // 3 baselines * 3 scenarios * 2 tokenizers = 18 results
    expect(results).toHaveLength(18);

    // Check specific keys are present
    const first = results[0];
    expect(first).toHaveProperty("baselineName");
    expect(first).toHaveProperty("scenarioId");
    expect(first).toHaveProperty("tokenizer");
    expect(first).toHaveProperty("tokensIn");
    expect(first).toHaveProperty("tokensOut");
    expect(first).toHaveProperty("totalTokens");
    expect(first).toHaveProperty("fidelity");
    expect(first).toHaveProperty("xmlIntegrity");

    // Check values make sense
    for (const r of results) {
      expect(r.tokensIn).toBeGreaterThan(0);
      expect(r.tokensOut).toBeGreaterThan(0);
      expect(r.totalTokens).toBe(r.tokensIn + r.tokensOut);
      expect(r.fidelity).toBeGreaterThanOrEqual(0);
      expect(r.fidelity).toBeLessThanOrEqual(100);
      expect(["PASS", "FAIL"]).toContain(r.xmlIntegrity);
    }
  });
});
