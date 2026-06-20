import { describe, it, expect } from "vitest";
import { scenarios } from "./scenarios.js";

describe("scenarios", () => {
  it("should have ten defined scenarios", () => {
    expect(scenarios).toHaveLength(10);
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

    const s4 = scenarios.find((s) => s.id === "bulk-rewrite");
    expect(s4).toBeDefined();
    expect(s4?.targetText).toBe("Typing some. Typing some text");
    expect(s4?.replacementText).toBe("This agreement is drafted to establish the terms of service.");

    const s5 = scenarios.find((s) => s.id === "whole-document-restyle");
    expect(s5).toBeDefined();
    expect(s5?.targetText).toBe("Governing Law");
    expect(s5?.replacementText).toBe("GOVERNING LAW");

    const s6 = scenarios.find((s) => s.id === "no-op");
    expect(s6).toBeDefined();
    expect(s6?.targetText).toBe("NonExistentWord");
    expect(s6?.replacementText).toBe("ShouldNotBeInserted");

    const s7 = scenarios.find((s) => s.id === "conditional-edit");
    expect(s7).toBeDefined();
    expect(s7?.isAgentic).toBe(true);

    const s8 = scenarios.find((s) => s.id === "dependent-multi-target");
    expect(s8).toBeDefined();
    expect(s8?.isAgentic).toBe(true);

    const s9 = scenarios.find((s) => s.id === "selective-verify-and-repair");
    expect(s9).toBeDefined();
    expect(s9?.isAgentic).toBe(true);

    const s10 = scenarios.find((s) => s.id === "search-then-compute");
    expect(s10).toBeDefined();
    expect(s10?.isAgentic).toBe(true);
  });
});
