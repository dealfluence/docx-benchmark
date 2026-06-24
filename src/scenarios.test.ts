import { describe, it, expect } from "vitest";
import { scenarios } from "./scenarios.js";

describe("scenarios v2", () => {
  it("should have 5 defined scenarios", () => {
    expect(scenarios).toHaveLength(5);
  });

  it("should have correct properties for each scenario", () => {
    const s1 = scenarios.find((s) => s.id === "form-fill");
    expect(s1).toBeDefined();
    expect(s1?.isAgentic).toBe(true);
    expect(s1?.fixturePath).toBe("fixtures/ycombinator/post-money-safe.docx");

    const s2 = scenarios.find((s) => s.id === "party-swap");
    expect(s2).toBeDefined();
    expect(s2?.isAgentic).toBe(true);
    expect(s2?.fixturePath).toBe("fixtures/series-seed/investment-agreement.docx");

    const s3 = scenarios.find((s) => s.id === "policy-checklist-review");
    expect(s3).toBeDefined();
    expect(s3?.isAgentic).toBe(true);
    expect(s3?.fixturePath).toBe("fixtures/common-paper/cloud-service-agreement.docx");

    const s4 = scenarios.find((s) => s.id === "playbook-commenting");
    expect(s4).toBeDefined();
    expect(s4?.isAgentic).toBe(true);
    expect(s4?.fixturePath).toBe("fixtures/uk-gov/model-services-contract.docx");

    const s5 = scenarios.find((s) => s.id === "multi-file-assembly");
    expect(s5).toBeDefined();
    expect(s5?.isAgentic).toBe(true);
    expect(s5?.fixturePath).toBe("fixtures/common-paper/cloud-service-agreement.docx");
  });
});
