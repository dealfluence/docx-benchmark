import * as fs from "node:fs";
import * as path from "node:path";
import { Scenario } from "./scenarios.js";

export type IntegrityStatus = "PASS" | "FAIL";

export interface SingleTrialRun {
  repIndex: number;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  xmlIntegrity: IntegrityStatus;
  fidelity: number;
  xmlDelta: number;
  success: boolean;
  roundTrips: number;
  turnsToSuccess: number;
  recoveryRate: number;
  schemaTokens: number;
  historyTokens: number;
  newContentTokens: number;
  completeTaskCalls: number;
  error?: string;
}

export interface Stats {
  mean: number;
  min: number;
  max: number;
}

export interface LiveTrialSummary {
  provider: string;
  model: string;
  scenarioId: string;
  scenarioName: string;
  tool: string;
  docSize: "small" | "large";
  supported: boolean;
  reps: number;
  latency: Stats;
  tokensIn: Stats;
  tokensOut: Stats;
  totalTokens: Stats;
  xmlDelta: Stats;
  xmlIntegrityRate: string;
  fidelity: Stats;
  successRate: string;
  roundTrips: Stats;
  turnsToSuccess: Stats;
  recoveryRate: Stats;
  completeTaskCalls: Stats;
  schemaTokens?: Stats;
  historyTokens?: Stats;
  newContentTokens?: Stats;
}

export function getStats(arr: number[]): Stats {
  const sum = arr.reduce((a, b) => a + b, 0);
  return {
    mean: sum / (arr.length || 1),
    min: Math.min(...arr),
    max: Math.max(...arr),
  };
}

export function getFullTaskDescription(
  scenario: Partial<Scenario> & { description: string },
): string {
  let desc = scenario.description;
  if (scenario.targetText || scenario.replacementText || scenario.reviewAction) {
    desc += `\nInstructions:\n`;
    if (scenario.targetText) desc += `- Find target text: "${scenario.targetText}"\n`;
    if (scenario.replacementText) desc += `- Replace with: "${scenario.replacementText}"\n`;
    if (scenario.reviewAction)
      desc += `- Review Action: ${JSON.stringify(scenario.reviewAction)}\n`;
  }
  return desc;
}

export function formatTokenMetric(
  metric: Stats,
  floorMetric?: Stats,
  showFloor = false,
  useLocale = false,
): string {
  const f = (val: number) => {
    const rounded = Math.round(val);
    return useLocale ? rounded.toLocaleString("en-US") : String(rounded);
  };
  if (showFloor && floorMetric) {
    return `${f(floorMetric.mean)} / ${f(metric.mean)} [${f(floorMetric.min)}-${f(floorMetric.max)} / ${f(metric.min)}-${f(metric.max)}] (floor/total)`;
  }
  return `${f(metric.mean)} [${f(metric.min)}-${f(metric.max)}]`;
}

export function printLiveConsoleSummary(summaries: LiveTrialSummary[], reps: number) {
  console.log(`\n\x1b[1m\x1b[32m=== LIVE BENCHMARK CONSOLE SUMMARY (N=${reps}) ===\x1b[0m`);
  const tableRows = summaries.map((s) => {
    const showFloor = !!s.newContentTokens;
    const totalFloorStats: Stats | undefined = s.newContentTokens
      ? {
          mean: s.newContentTokens.mean + s.tokensOut.mean,
          min: s.newContentTokens.min + s.tokensOut.min,
          max: s.newContentTokens.max + s.tokensOut.max,
        }
      : undefined;

    return {
      Provider: s.provider,
      Scenario: s.scenarioId,
      Tool: s.tool,
      Size: s.docSize,
      "Succ Rate": s.successRate,
      "XML Delta": `${s.xmlDelta.mean.toFixed(0)} [${s.xmlDelta.min}-${s.xmlDelta.max}]`,
      Fidelity: `${s.fidelity.mean.toFixed(1)}% [${s.fidelity.min}-${s.fidelity.max}]`,
      "Xml Integrity": s.xmlIntegrityRate,
      Trips: `${s.roundTrips.mean.toFixed(1)} [${s.roundTrips.min}-${s.roundTrips.max}]`,
      TurnsSucc: `${s.turnsToSuccess.mean.toFixed(1)} [${s.turnsToSuccess.min}-${s.turnsToSuccess.max}]`,
      Submits: `${s.completeTaskCalls.mean.toFixed(1)} [${s.completeTaskCalls.min}-${s.completeTaskCalls.max}]`,
      "Tokens In": formatTokenMetric(s.tokensIn, s.newContentTokens, showFloor, false),
      "Tokens Out": `${Math.round(s.tokensOut.mean)} [${Math.round(s.tokensOut.min)}-${Math.round(s.tokensOut.max)}]`,
      "Total Tokens": formatTokenMetric(s.totalTokens, totalFloorStats, showFloor, false),
      Latency: `${(s.latency.mean / 1000).toFixed(1)}s [${(s.latency.min / 1000).toFixed(1)}-${(s.latency.max / 1000).toFixed(1)}]`,
    };
  });
  console.table(tableRows);
}

/** Quote a CSV cell only when it contains a comma, quote, or newline. */
function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Parse an "X/Y" rate string into its numerator and denominator. */
function parseRate(rate: string): { num: number; den: number } {
  const [a, b] = rate.split("/");
  const num = parseInt(a, 10);
  const den = parseInt(b, 10);
  return { num: isNaN(num) ? 0 : num, den: isNaN(den) ? 0 : den };
}

/**
 * Flat, spreadsheet-friendly results: one row per scenario x tool, mean values
 * only, with rates expanded into numeric columns. This is the headline
 * easy-to-reason-about artifact; the .md/.json keep full min-max detail.
 */
export function buildCsv(summaries: LiveTrialSummary[]): string {
  const headers = [
    "tool",
    "scenario",
    "scenarioName",
    "provider",
    "model",
    "reps",
    "successes",
    "successRatePct",
    "fidelityMeanPct",
    "xmlIntegrityPass",
    "xmlDeltaMean",
    "roundTripsMean",
    "turnsToSuccessMean",
    "taskSubmitsMean",
    "recoveryRatePct",
    "tokensInMean",
    "tokensOutMean",
    "totalTokensMean",
    "newContentTokensMean",
    "latencyMeanSec",
  ];

  const rows = summaries.map((s) => {
    const succ = parseRate(s.successRate);
    const integ = parseRate(s.xmlIntegrityRate);
    const successPct = succ.den ? (succ.num / succ.den) * 100 : 0;
    return [
      s.tool,
      s.scenarioId,
      s.scenarioName,
      s.provider,
      s.model,
      s.reps,
      succ.num,
      successPct.toFixed(1),
      s.fidelity.mean.toFixed(1),
      integ.num,
      Math.round(s.xmlDelta.mean),
      s.roundTrips.mean.toFixed(1),
      s.turnsToSuccess.mean.toFixed(1),
      s.completeTaskCalls.mean.toFixed(1),
      (s.recoveryRate.mean * 100).toFixed(1),
      Math.round(s.tokensIn.mean),
      Math.round(s.tokensOut.mean),
      Math.round(s.totalTokens.mean),
      s.newContentTokens ? Math.round(s.newContentTokens.mean) : "",
      (s.latency.mean / 1000).toFixed(1),
    ]
      .map(csvCell)
      .join(",");
  });

  return [headers.map(csvCell).join(","), ...rows].join("\n") + "\n";
}

export function writeLiveResultsFiles(summaries: LiveTrialSummary[], reps: number) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join("./results", `${timestamp}.json`);
  const mdPath = path.join("./results", `${timestamp}.md`);
  const csvPath = path.join("./results", `${timestamp}.csv`);

  fs.mkdirSync("./results", { recursive: true });

  const jsonStr = JSON.stringify(summaries, null, 2);
  fs.writeFileSync(jsonPath, jsonStr, "utf-8");
  fs.writeFileSync("./live_benchmark_results.json", jsonStr, "utf-8");
  console.log(
    `\x1b[32m[JSON Results Written]\x1b[0m Saved to ${jsonPath} and ./live_benchmark_results.json`,
  );

  const csvStr = buildCsv(summaries);
  fs.writeFileSync(csvPath, csvStr, "utf-8");
  fs.writeFileSync("./live_benchmark_results.csv", csvStr, "utf-8");
  console.log(
    `\x1b[32m[CSV Results Written]\x1b[0m Saved to ${csvPath} and ./live_benchmark_results.csv`,
  );

  let md = `# Live Benchmark Report\n\n`;
  md += `**Date:** ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}\n`;
  md += `**Repetitions (N):** ${reps} per trial\n\n`;

  md +=
    `## Models Configured\n` +
    Array.from(new Set(summaries.map((s) => `- ${s.provider}: \`${s.model}\``))).join("\n") +
    "\n\n";

  md += `## Comparative Metrics\n\n`;
  md += `> [!NOTE]\n`;
  md += `> This benchmark contains **no one-shot** workflows. It exclusively measures multi-turn, agentic round-trip workflows.\n\n`;
  md += `> [!IMPORTANT]\n`;
  md += `> Token savings only matter when **Success Rate** is high. A paradigm that achieves low token counts but consistently fails tasks or corrupts document styling has zero utility.\n\n`;

  const scenariosGrouped = Array.from(new Set(summaries.map((s) => s.scenarioId)));

  for (const sId of scenariosGrouped) {
    const sResults = summaries.filter((s) => s.scenarioId === sId);
    md += `### Scenario: ${sResults[0]?.scenarioName} (\`${sId}\`)\n\n`;
    md += `| Paradigm | Doc Size | Success Rate | XML Delta (Surgicality) | Fidelity Score (Avg [Min-Max]) | XML Integrity | Round Trips (Avg) | Turns to Success (Avg) | Task Submits (Avg [Min-Max]) | Recovery Rate (Avg) | Input Tokens (Avg [Min-Max]) | Output Tokens (Avg [Min-Max]) | Total Tokens (Avg [Min-Max]) | Latency (Avg [Min-Max]) |\n`;
    md += `| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |\n`;

    for (const s of sResults) {
      const showFloor = !!s.newContentTokens;
      const totalFloorStats: Stats | undefined = s.newContentTokens
        ? {
            mean: s.newContentTokens.mean + s.tokensOut.mean,
            min: s.newContentTokens.min + s.tokensOut.min,
            max: s.newContentTokens.max + s.tokensOut.max,
          }
        : undefined;

      md +=
        `| **${s.tool}** | ${s.docSize} | ${s.successRate} | ${s.xmlDelta.mean.toFixed(0)} [${s.xmlDelta.min}-${s.xmlDelta.max}] | ${s.fidelity.mean.toFixed(1)}% [${s.fidelity.min}-${s.fidelity.max}] | ${s.xmlIntegrityRate} | ${s.roundTrips.mean.toFixed(1)} [${s.roundTrips.min}-${s.roundTrips.max}] | ${s.turnsToSuccess.mean.toFixed(1)} [${s.turnsToSuccess.min}-${s.turnsToSuccess.max}] | ${s.completeTaskCalls.mean.toFixed(1)} [${s.completeTaskCalls.min}-${s.completeTaskCalls.max}] | ${(s.recoveryRate.mean * 100).toFixed(1)}% [${(s.recoveryRate.min * 100).toFixed(1)}%-${(s.recoveryRate.max * 100).toFixed(1)}%] | ` +
        `${formatTokenMetric(s.tokensIn, s.newContentTokens, showFloor, true)} | ` +
        `${Math.round(s.tokensOut.mean).toLocaleString()} [${Math.round(s.tokensOut.min).toLocaleString()}-${Math.round(s.tokensOut.max).toLocaleString()}] | ` +
        `${formatTokenMetric(s.totalTokens, totalFloorStats, showFloor, true)} | ` +
        `${(s.latency.mean / 1000).toFixed(1)}s [${(s.latency.min / 1000).toFixed(1)}-${(s.latency.max / 1000).toFixed(1)}] |\n`;
    }
    md += `\n`;
  }

  fs.writeFileSync(mdPath, md, "utf-8");
  fs.writeFileSync("./live_benchmark_results.md", md, "utf-8");
  console.log(
    `\x1b[32m[Markdown Results Written]\x1b[0m Saved to ${mdPath} and ./live_benchmark_results.md`,
  );
}
