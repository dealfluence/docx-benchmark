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
  paradigm: "adeu" | "safe-docx";
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
  isSafeDocx = false,
  useLocale = false,
): string {
  const f = (val: number) => {
    const rounded = Math.round(val);
    return useLocale ? rounded.toLocaleString("en-US") : String(rounded);
  };
  if (isSafeDocx && floorMetric) {
    return `${f(floorMetric.mean)} / ${f(metric.mean)} [${f(floorMetric.min)}-${f(floorMetric.max)} / ${f(metric.min)}-${f(metric.max)}] (floor/total)`;
  }
  return `${f(metric.mean)} [${f(metric.min)}-${f(metric.max)}]`;
}

export function printLiveConsoleSummary(summaries: LiveTrialSummary[], reps: number) {
  console.log(`\n\x1b[1m\x1b[32m=== LIVE BENCHMARK CONSOLE SUMMARY (N=${reps}) ===\x1b[0m`);
  const tableRows = summaries.map((s) => {
    const isSafe = s.paradigm === "safe-docx";
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
      Paradigm: s.paradigm,
      Size: s.docSize,
      "Succ Rate": s.successRate,
      "XML Delta": `${s.xmlDelta.mean.toFixed(0)} [${s.xmlDelta.min}-${s.xmlDelta.max}]`,
      Fidelity: `${s.fidelity.mean.toFixed(1)}% [${s.fidelity.min}-${s.fidelity.max}]`,
      "Xml Integrity": s.xmlIntegrityRate,
      Trips: `${s.roundTrips.mean.toFixed(1)} [${s.roundTrips.min}-${s.roundTrips.max}]`,
      TurnsSucc: `${s.turnsToSuccess.mean.toFixed(1)} [${s.turnsToSuccess.min}-${s.turnsToSuccess.max}]`,
      "Tokens In": formatTokenMetric(s.tokensIn, s.newContentTokens, isSafe, false),
      "Tokens Out": `${Math.round(s.tokensOut.mean)} [${Math.round(s.tokensOut.min)}-${Math.round(s.tokensOut.max)}]`,
      "Total Tokens": formatTokenMetric(s.totalTokens, totalFloorStats, isSafe, false),
      Latency: `${(s.latency.mean / 1000).toFixed(1)}s [${(s.latency.min / 1000).toFixed(1)}-${(s.latency.max / 1000).toFixed(1)}]`,
    };
  });
  console.table(tableRows);
}

export function writeLiveResultsFiles(summaries: LiveTrialSummary[], reps: number) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join("./results", `${timestamp}.json`);
  const mdPath = path.join("./results", `${timestamp}.md`);

  fs.mkdirSync("./results", { recursive: true });

  const jsonStr = JSON.stringify(summaries, null, 2);
  fs.writeFileSync(jsonPath, jsonStr, "utf-8");
  fs.writeFileSync("./live_benchmark_results.json", jsonStr, "utf-8");
  console.log(
    `\x1b[32m[JSON Results Written]\x1b[0m Saved to ${jsonPath} and ./live_benchmark_results.json`,
  );

  let md = `# Live Benchmark Report\n\n`;
  md += `**Date:** ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}\n`;
  md += `**Repetitions (N):** ${reps} per trial\n`;
  md += `**Temperature:** 0.0\n\n`;

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
    md += `| Paradigm | Doc Size | Success Rate | XML Delta (Surgicality) | Fidelity Score (Avg [Min-Max]) | XML Integrity | Round Trips (Avg) | Turns to Success (Avg) | Recovery Rate (Avg) | Input Tokens (Avg [Min-Max]) | Output Tokens (Avg [Min-Max]) | Total Tokens (Avg [Min-Max]) | Latency (Avg [Min-Max]) |\n`;
    md += `| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |\n`;

    for (const s of sResults) {
      const isSafe = s.paradigm === "safe-docx";
      const totalFloorStats: Stats | undefined = s.newContentTokens
        ? {
            mean: s.newContentTokens.mean + s.tokensOut.mean,
            min: s.newContentTokens.min + s.tokensOut.min,
            max: s.newContentTokens.max + s.tokensOut.max,
          }
        : undefined;

      md +=
        `| **${s.paradigm}** | ${s.docSize} | ${s.successRate} | ${s.xmlDelta.mean.toFixed(0)} [${s.xmlDelta.min}-${s.xmlDelta.max}] | ${s.fidelity.mean.toFixed(1)}% [${s.fidelity.min}-${s.fidelity.max}] | ${s.xmlIntegrityRate} | ${s.roundTrips.mean.toFixed(1)} [${s.roundTrips.min}-${s.roundTrips.max}] | ${s.turnsToSuccess.mean.toFixed(1)} [${s.turnsToSuccess.min}-${s.turnsToSuccess.max}] | ${(s.recoveryRate.mean * 100).toFixed(1)}% [${(s.recoveryRate.min * 100).toFixed(1)}%-${(s.recoveryRate.max * 100).toFixed(1)}%] | ` +
        `${formatTokenMetric(s.tokensIn, s.newContentTokens, isSafe, true)} | ` +
        `${Math.round(s.tokensOut.mean).toLocaleString()} [${Math.round(s.tokensOut.min).toLocaleString()}-${Math.round(s.tokensOut.max).toLocaleString()}] | ` +
        `${formatTokenMetric(s.totalTokens, totalFloorStats, isSafe, true)} | ` +
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
