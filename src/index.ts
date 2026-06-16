import { fileURLToPath } from "node:url";
import { runSimulation, getGoldenDocxPath } from "./baselines.js";

export async function main() {
  try {
    const docPath = getGoldenDocxPath();
    console.log(
      `\n\x1b[1m\x1b[34m[Adeu Benchmark Suite]\x1b[0m Running offline simulation using document:`,
    );
    console.log(`  -> ${docPath}\n`);

    const results = await runSimulation(docPath);

    // 1. Color-coded console.table output
    console.log(`\x1b[1m\x1b[32m=== CONSOLE SUMMARY ===\x1b[0m`);
    const consoleRows = results.map((r) => ({
      Scenario: r.scenarioId,
      "Baseline Model": r.baselineName,
      Tokenizer: r.tokenizer.split("_")[0],
      "Tokens In": r.tokensIn,
      "Tokens Out": r.tokensOut,
      Total: r.totalTokens,
      "Cost ($)": `$${r.cost.toFixed(6)}`,
      Fidelity: `${r.fidelity}%`,
      "XML Integrity": r.xmlIntegrity === "PASS" ? "🟢 PASS" : "🔴 FAIL",
    }));
    console.table(consoleRows);

    // 2. Markdown tables for README.md grouped by Scenario
    console.log(`\n\x1b[1m\x1b[32m=== MARKDOWN REPORT FOR README.MD ===\x1b[0m\n`);

    // Group scenarios
    const scenarioIds = Array.from(new Set(results.map((r) => r.scenarioId)));

    for (const sId of scenarioIds) {
      const sResults = results.filter((r) => r.scenarioId === sId);
      const sName = sResults[0]?.scenarioName;

      console.log(`### ${sName}`);
      console.log(
        `| Baseline Paradigm | Tokenizer | Input Tokens | Output Tokens | Total Tokens | Estimated Cost | Fidelity Score | XML Schema Integrity |`,
      );
      console.log(`| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |`);

      for (const r of sResults) {
        const integrityEmoji = r.xmlIntegrity === "PASS" ? "✅ PASS" : "❌ FAIL";
        console.log(
          `| **${r.baselineName}** | \`${r.tokenizer}\` | ${r.tokensIn.toLocaleString()} | ${r.tokensOut.toLocaleString()} | ${r.totalTokens.toLocaleString()} | $${r.cost.toFixed(6)} | ${r.fidelity}% | ${integrityEmoji} |`,
        );
      }
      console.log(`\n`);
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`\x1b[31m[Error running benchmark]: ${msg}\x1b[0m`);
    process.exit(1);
  }
}

// Only invoke main automatically if we are the entrypoint
const nodePath = process.argv[1];
if (nodePath) {
  const currentFilePath = fileURLToPath(import.meta.url);
  // Match both .ts and .js endings due to compilation / tsx execution
  if (
    currentFilePath.endsWith(nodePath) ||
    currentFilePath.replace(/\.ts$/, ".js").endsWith(nodePath) ||
    nodePath.endsWith("src/index.ts") ||
    nodePath.endsWith("dist/index.js")
  ) {
    main();
  }
}
