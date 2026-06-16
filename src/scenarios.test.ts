import { describe, it, expect } from "vitest";
import { scenarios } from "./scenarios.js";

describe("scenarios", () => {
  it("should have three defined scenarios", () => {
    expect(scenarios).toHaveLength(3);
  });

  it("should have correct properties for each scenario", () => {
    const s1 = scenarios.find((s) => s.id === "surgical-correction");
    expect(s1).toBeDefined();
    expect(s1?.targetText).toBe("Seller");
    expect(s1?.replacementText).toBe("Vendor");

    const s2 = scenarios.find((s) => s.id === "clause-drafting");
    expect(s2).toBeDefined();
    expect(s2?.targetText).toBe("## 8. Governing Law");
    expect(s2?.replacementText).toContain("## 9. Data Protection");

    const s3 = scenarios.find((s) => s.id === "negotiation-cleanup");
    expect(s3).toBeDefined();
    expect(s3?.reviewAction?.type).toBe("accept");
    expect(s3?.reviewAction?.targetId).toBe("Chg:12");
  });
});
