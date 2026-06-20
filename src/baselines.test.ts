import { describe, it, expect } from "vitest";
import { getGoldenDocxPath, runSimulation } from "./baselines.js";

describe("baselines simulation", () => {
  it("should run simulation on golden.docx and return 36 results", async () => {
    const docPath = getGoldenDocxPath();
    const results = await runSimulation(docPath);

    // 3 baselines * 10 scenarios * 2 tokenizers = 60 results
    expect(results).toHaveLength(60);

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
    expect(first).toHaveProperty("cost");

    // Check values make sense
    for (const r of results) {
      expect(r.tokensIn).toBeGreaterThan(0);
      expect(r.tokensOut).toBe("n/a (requires live run)");
      expect(r.totalTokens).toBe("n/a (requires live run)");
      expect(r.cost).toBe("n/a (requires live run)");
      expect(r.fidelity).toBe("n/a (requires live run)");
      expect(r.xmlIntegrity).toBe("n/a (requires live run)");
    }
  });
});
