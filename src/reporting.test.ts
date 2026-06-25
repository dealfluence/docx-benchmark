import { describe, it, expect } from "vitest";
import { buildCsv, LiveTrialSummary, Stats } from "./reporting.js";

const stat = (n: number): Stats => ({ mean: n, min: n, max: n });

function makeSummary(overrides: Partial<LiveTrialSummary> = {}): LiveTrialSummary {
  return {
    provider: "Gemini",
    model: "gemini-3.5-flash",
    scenarioId: "form-fill",
    scenarioName: "Form Fill, with comma",
    tool: "adeu",
    docSize: "small",
    supported: true,
    reps: 3,
    latency: stat(12345),
    tokensIn: stat(1000),
    tokensOut: stat(200),
    totalTokens: stat(1200),
    xmlDelta: stat(42),
    xmlIntegrityRate: "3/3",
    fidelity: stat(100),
    successRate: "2/3",
    roundTrips: stat(5),
    turnsToSuccess: stat(5),
    recoveryRate: stat(0.5),
    completeTaskCalls: stat(1),
    schemaTokens: stat(500),
    historyTokens: stat(300),
    newContentTokens: stat(200),
    ...overrides,
  };
}

describe("buildCsv", () => {
  it("emits a header row with the expected columns", () => {
    const csv = buildCsv([]);
    const header = csv.trim().split("\n")[0];
    expect(header).toBe(
      "tool,scenario,scenarioName,provider,model,reps,successes,successRatePct,fidelityMeanPct,xmlIntegrityPass,xmlDeltaMean,roundTripsMean,turnsToSuccessMean,taskSubmitsMean,recoveryRatePct,tokensInMean,tokensOutMean,totalTokensMean,newContentTokensMean,latencyMeanSec",
    );
  });

  it("expands rates into numeric columns and quotes fields containing commas", () => {
    const csv = buildCsv([makeSummary()]);
    const lines = csv.trim().split("\n");
    expect(lines.length).toBe(2);
    const row = lines[1];

    // scenarioName has a comma, so it must be quoted.
    expect(row).toContain('"Form Fill, with comma"');
    // successRate "2/3" -> successes=2, successRatePct=66.7
    expect(row).toContain(",2,66.7,");
    // xmlIntegrityRate "3/3" -> xmlIntegrityPass=3
    // recoveryRate 0.5 -> 50.0; latency 12345ms -> 12.3s
    expect(row).toContain("50.0");
    expect(row.endsWith("12.3")).toBe(true);
  });

  it("leaves newContentTokensMean blank when the breakdown is absent", () => {
    const csv = buildCsv([makeSummary({ newContentTokens: undefined })]);
    const row = csv.trim().split("\n")[1];
    // trailing columns: ...,totalTokensMean,newContentTokensMean,latencyMeanSec
    // newContentTokensMean blank -> two consecutive commas before the latency value
    expect(row).toContain(",,12.3");
  });
});
