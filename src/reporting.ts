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
  rateLimitCount?: number;
}

export interface Stats {
  mean: number;
  min: number;
  max: number;
  median?: number;
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
  rateLimitCount?: number;
  passingSteps?: Stats;
  passingTokensIn?: Stats;
  passingTokensOut?: Stats;
  passingTokensTotal?: Stats;
}

export function getMedian(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function getStats(arr: number[]): Stats {
  const sum = arr.reduce((a, b) => a + b, 0);
  return {
    mean: sum / (arr.length || 1),
    min: arr.length ? Math.min(...arr) : 0,
    max: arr.length ? Math.max(...arr) : 0,
    median: getMedian(arr),
  };
}

export function getFullTaskDescription(
  scenario: Partial<Scenario> & { description: string },
): string {
  // The scenario description is now the complete, self-contained task instruction.
  return scenario.description;
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

  console.log(`\n\x1b[1m\x1b[36m=== PASSING RUNS PERFORMANCE STATS ===\x1b[0m`);
  const passingRows = summaries.map((s) => {
    return {
      Tool: s.tool,
      Scenario: s.scenarioId,
      "Succ Rate": s.successRate,
      "Steps Avg": s.passingSteps ? s.passingSteps.mean.toFixed(1) : "-",
      "Steps Med": s.passingSteps ? s.passingSteps.median?.toFixed(1) : "-",
      "Tokens In (Avg)": s.passingTokensIn
        ? Math.round(s.passingTokensIn.mean).toLocaleString()
        : "-",
      "Tokens Out (Avg)": s.passingTokensOut
        ? Math.round(s.passingTokensOut.mean).toLocaleString()
        : "-",
      "Tokens Tot (Avg)": s.passingTokensTotal
        ? Math.round(s.passingTokensTotal.mean).toLocaleString()
        : "-",
      "Tokens Tot (Med)": s.passingTokensTotal
        ? Math.round(s.passingTokensTotal.median || 0).toLocaleString()
        : "-",
    };
  });
  console.table(passingRows);

  const totalRateLimits = summaries.reduce((acc, s) => acc + (s.rateLimitCount || 0), 0);
  if (totalRateLimits > 0) {
    console.log(
      `\n\x1b[1m\x1b[31m🚨 WARNING: Encountered ${totalRateLimits} API rate limit (429) events during the run! Check the logs for details. 🚨\x1b[0m`,
    );
  }
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

export function buildHtml(summaries: LiveTrialSummary[], reps: number): string {
  const jsonData = JSON.stringify(summaries, null, 2);
  const totalRateLimits = summaries.reduce((acc, s) => acc + (s.rateLimitCount || 0), 0);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Adeu Benchmark Results</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
    body { font-family: 'Inter', sans-serif; }
  </style>
</head>
<body class="bg-gray-50 text-gray-800 min-h-screen">
  <header class="bg-slate-900 text-white shadow-md">
    <div class="max-w-7xl mx-auto px-4 py-6 sm:px-6 lg:px-8 flex justify-between items-center">
      <div>
        <h1 class="text-3xl font-bold tracking-tight">Adeu Benchmark</h1>
        <p class="text-slate-400 mt-1">Multi-Turn Agentic Document Editing Performance Report</p>
      </div>
      <div class="text-right">
        <p class="text-sm text-slate-300">Generated on</p>
        <p class="text-lg font-medium">${new Date().toLocaleString()}</p>
        <span class="inline-flex items-center rounded-md bg-slate-800 px-2 py-1 text-xs font-medium text-slate-400 ring-1 ring-inset ring-slate-700 mt-1">N = ${reps} reps</span>
      </div>
    </div>
  </header>

  <main class="max-w-7xl mx-auto px-4 py-8 sm:px-6 lg:px-8">
    ${
      totalRateLimits > 0
        ? `
    <div class="mb-8 p-4 bg-red-50 border-l-4 border-red-500 rounded-r-md">
      <div class="flex">
        <div class="flex-shrink-0">
          <svg class="h-5 w-5 text-red-400" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd" />
          </svg>
        </div>
        <div class="ml-3">
          <h3 class="text-sm font-medium text-red-800">API Rate Limiting Warning</h3>
          <p class="text-sm text-red-700 mt-1">
            There were <strong>${totalRateLimits}</strong> rate-limiting event(s) (429) caught and handled with exponential backoff during this run.
          </p>
        </div>
      </div>
    </div>
    `
        : ""
    }

    <section class="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
      <div class="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
        <h3 class="text-sm font-medium text-gray-500 uppercase tracking-wider">Total Scenarios</h3>
        <p class="text-3xl font-semibold text-gray-900 mt-2" id="stat-scenarios">-</p>
      </div>
      <div class="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
        <h3 class="text-sm font-medium text-gray-500 uppercase tracking-wider">Paradigms Tested</h3>
        <p class="text-3xl font-semibold text-gray-900 mt-2" id="stat-paradigms">-</p>
      </div>
      <div class="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
        <h3 class="text-sm font-medium text-gray-500 uppercase tracking-wider">Overall Success Rate</h3>
        <p class="text-3xl font-semibold text-emerald-600 mt-2" id="stat-success">-</p>
      </div>
      <div class="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
        <h3 class="text-sm font-medium text-gray-500 uppercase tracking-wider">Total Actions Taken</h3>
        <p class="text-3xl font-semibold text-gray-900 mt-2" id="stat-actions">-</p>
      </div>
    </section>

    <section class="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
      <div class="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
        <h3 class="text-lg font-semibold text-gray-900 mb-4">Success Rate by Paradigm</h3>
        <div class="h-64">
          <canvas id="chart-success"></canvas>
        </div>
      </div>
      <div class="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
        <h3 class="text-lg font-semibold text-gray-900 mb-4">Average Latency (Seconds)</h3>
        <div class="h-64">
          <canvas id="chart-latency"></canvas>
        </div>
      </div>
    </section>

    <section class="bg-white p-6 rounded-lg shadow-sm border border-gray-200 mb-8">
      <h3 class="text-lg font-semibold text-gray-900 mb-4">Performance Metrics (Passing Runs Only)</h3>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
        <div>
          <h4 class="text-sm font-medium text-gray-500 uppercase tracking-wider mb-2">Turns/Steps to Success</h4>
          <div class="h-64">
            <canvas id="chart-passing-steps"></canvas>
          </div>
        </div>
        <div>
          <h4 class="text-sm font-medium text-gray-500 uppercase tracking-wider mb-2">Total Tokens Consumed (In + Out)</h4>
          <div class="h-64">
            <canvas id="chart-passing-tokens"></canvas>
          </div>
        </div>
      </div>
    </section>

    <section class="bg-white shadow-sm border border-gray-200 rounded-lg overflow-hidden">
      <div class="px-6 py-4 border-b border-gray-200 bg-gray-50 flex justify-between items-center">
        <h3 class="text-lg font-semibold text-gray-900">Scenario Breakdown</h3>
        <div class="text-xs text-gray-500">All data represents averaged trial values</div>
      </div>
      <div class="overflow-x-auto">
        <table class="min-w-full divide-y divide-gray-200 text-sm">
          <thead class="bg-gray-50">
            <tr>
              <th scope="col" class="px-6 py-3 text-left font-medium text-gray-500 uppercase tracking-wider">Paradigm</th>
              <th scope="col" class="px-6 py-3 text-left font-medium text-gray-500 uppercase tracking-wider">Scenario</th>
              <th scope="col" class="px-6 py-3 text-center font-medium text-gray-500 uppercase tracking-wider">Success Rate</th>
              <th scope="col" class="px-6 py-3 text-center font-medium text-gray-500 uppercase tracking-wider">Fidelity</th>
              <th scope="col" class="px-6 py-3 text-center font-medium text-gray-500 uppercase tracking-wider">XML Delta</th>
              <th scope="col" class="px-6 py-3 text-center font-medium text-gray-500 uppercase tracking-wider">Avg Passing Steps</th>
              <th scope="col" class="px-6 py-3 text-center font-medium text-gray-500 uppercase tracking-wider">Median Passing Steps</th>
              <th scope="col" class="px-6 py-3 text-right font-medium text-gray-500 uppercase tracking-wider">Avg Passing Tokens</th>
              <th scope="col" class="px-6 py-3 text-right font-medium text-gray-500 uppercase tracking-wider">Median Passing Tokens</th>
            </tr>
          </thead>
          <tbody class="bg-white divide-y divide-gray-200" id="table-body">
            <!-- Dynamically filled -->
          </tbody>
        </table>
      </div>
    </section>
  </main>

  <footer class="bg-slate-100 border-t border-gray-200 mt-16 py-8">
    <div class="max-w-7xl mx-auto px-4 text-center text-sm text-gray-500 sm:px-6 lg:px-8">
      <p>Adeu Benchmark Suite &bull; Engineered for rigorous document-agent performance evaluations.</p>
    </div>
  </footer>

  <script>
    const data = ${jsonData};

    // Calculate quick high level stats
    const uniqueScenarios = [...new Set(data.map(d => d.scenarioId))];
    const uniqueTools = [...new Set(data.map(d => d.tool))];
    
    let totalReps = 0;
    let totalSuccesses = 0;
    let totalActions = 0;

    data.forEach(d => {
      totalReps += d.reps;
      const [succ, total] = d.successRate.split('/').map(Number);
      totalSuccesses += succ;
      totalActions += (d.roundTrips.mean * d.reps);
    });

    document.getElementById('stat-scenarios').innerText = uniqueScenarios.length;
    document.getElementById('stat-paradigms').innerText = uniqueTools.length;
    document.getElementById('stat-success').innerText = ((totalSuccesses / totalReps) * 100).toFixed(1) + '%';
    document.getElementById('stat-actions').innerText = Math.round(totalActions).toLocaleString();

    // Fill table
    const tbody = document.getElementById('table-body');
    data.forEach(row => {
      const tr = document.createElement('tr');
      tr.className = 'hover:bg-gray-50 transition-colors';
      
      const successColor = row.successRate.startsWith('0/') ? 'text-red-600 bg-red-50' : 'text-emerald-600 bg-emerald-50';
      const stepsMean = row.passingSteps ? row.passingSteps.mean.toFixed(1) : '-';
      const stepsMedian = row.passingSteps && row.passingSteps.median !== undefined ? row.passingSteps.median.toFixed(1) : '-';
      const tokensMean = row.passingTokensTotal ? Math.round(row.passingTokensTotal.mean).toLocaleString() : '-';
      const tokensMedian = row.passingTokensTotal && row.passingTokensTotal.median !== undefined ? Math.round(row.passingTokensTotal.median).toLocaleString() : '-';

      tr.innerHTML = \`
        <td class="px-6 py-4 font-medium text-gray-900">\${row.tool}</td>
        <td class="px-6 py-4 text-gray-600">\&lt;code\&gt;\${row.scenarioId}\&lt;/code\&gt;</td>
        <td class="px-6 py-4 text-center">
          <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium \${successColor}">
            \${row.successRate}
          </span>
        </td>
        <td class="px-6 py-4 text-center text-gray-700">\${row.fidelity.mean.toFixed(1)}%</td>
        <td class="px-6 py-4 text-center text-gray-700">\${Math.round(row.xmlDelta.mean)}</td>
        <td class="px-6 py-4 text-center text-gray-600">\&lt;span class="font-semibold text-slate-900"\&gt;\${stepsMean}\&lt;/span\&gt;</td>
        <td class="px-6 py-4 text-center text-gray-600 font-medium">\${stepsMedian}</td>
        <td class="px-6 py-4 text-right text-gray-600 font-semibold text-slate-900">\${tokensMean}</td>
        <td class="px-6 py-4 text-right text-gray-600 font-medium">\&lt;span class="font-semibold text-slate-900"\&gt;\${tokensMedian}\&lt;/span\&gt;</td>
      \`;
      tbody.appendChild(tr);
    });

    // Success Chart
    const tools = [...new Set(data.map(d => d.tool))];
    const scenarios = [...new Set(data.map(d => d.scenarioId))];
    
    const successDatasets = tools.map((tool, idx) => {
      const colors = ['rgba(14, 165, 233, 0.85)', 'rgba(16, 185, 129, 0.85)', 'rgba(245, 158, 11, 0.85)'];
      const borderColors = ['rgb(14, 165, 233)', 'rgb(16, 185, 129)', 'rgb(245, 158, 11)'];
      return {
        label: tool,
        backgroundColor: colors[idx % colors.length],
        borderColor: borderColors[idx % borderColors.length],
        borderWidth: 1,
        data: scenarios.map(sc => {
          const matched = data.find(d => d.tool === tool && d.scenarioId === sc);
          if (!matched) return 0;
          const [succ, total] = matched.successRate.split('/').map(Number);
          return (succ / total) * 100;
        })
      };
    });

    new Chart(document.getElementById('chart-success'), {
      type: 'bar',
      data: {
        labels: scenarios,
        datasets: successDatasets
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: {
            beginAtZero: true,
            max: 100,
            title: { display: true, text: 'Success Rate (%)', font: { weight: 'bold' } }
          },
          x: { title: { display: true, text: 'Scenarios', font: { weight: 'bold' } } }
        }
      }
    });

    // Latency Chart
    const latencyDatasets = tools.map((tool, idx) => {
      const colors = ['rgba(14, 165, 233, 0.7)', 'rgba(16, 185, 129, 0.7)', 'rgba(245, 158, 11, 0.7)'];
      return {
        label: tool,
        backgroundColor: colors[idx % colors.length],
        data: scenarios.map(sc => {
          const matched = data.find(d => d.tool === tool && d.scenarioId === sc);
          return matched ? matched.latency.mean / 1000 : 0;
        })
      };
    });

    new Chart(document.getElementById('chart-latency'), {
      type: 'bar',
      data: {
        labels: scenarios,
        datasets: latencyDatasets
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: {
            beginAtZero: true,
            title: { display: true, text: 'Latency (Seconds)', font: { weight: 'bold' } }
          }
        }
      }
    });

    // Steps Chart (Passing Only)
    const stepsDatasets = tools.map((tool, idx) => {
      const colors = ['rgba(14, 165, 233, 0.8)', 'rgba(16, 185, 129, 0.8)', 'rgba(245, 158, 11, 0.8)'];
      return {
        label: tool,
        backgroundColor: colors[idx % colors.length],
        data: scenarios.map(sc => {
          const matched = data.find(d => d.tool === tool && d.scenarioId === sc);
          return (matched && matched.passingSteps) ? matched.passingSteps.mean : 0;
        })
      };
    });

    new Chart(document.getElementById('chart-passing-steps'), {
      type: 'bar',
      data: {
        labels: scenarios,
        datasets: stepsDatasets
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: {
            beginAtZero: true,
            title: { display: true, text: 'Steps (Mean)', font: { weight: 'bold' } }
          }
        }
      }
    });

    // Tokens Chart (Passing Only)
    const tokensDatasets = tools.map((tool, idx) => {
      const colors = ['rgba(14, 165, 233, 0.8)', 'rgba(16, 185, 129, 0.8)', 'rgba(245, 158, 11, 0.8)'];
      return {
        label: tool,
        backgroundColor: colors[idx % colors.length],
        data: scenarios.map(sc => {
          const matched = data.find(d => d.tool === tool && d.scenarioId === sc);
          return (matched && matched.passingTokensTotal) ? matched.passingTokensTotal.mean : 0;
        })
      };
    });

    new Chart(document.getElementById('chart-passing-tokens'), {
      type: 'bar',
      data: {
        labels: scenarios,
        datasets: tokensDatasets
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: {
            beginAtZero: true,
            title: { display: true, text: 'Mean Tokens (In + Out)', font: { weight: 'bold' } }
          }
        }
      }
    });
  </script>
</body>
</html>`;
}

export function writeLiveResultsFiles(summaries: LiveTrialSummary[], reps: number) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join("./results", `${timestamp}.json`);
  const mdPath = path.join("./results", `${timestamp}.md`);
  const csvPath = path.join("./results", `${timestamp}.csv`);
  const htmlPath = path.join("./results", `${timestamp}.html`);

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

  const htmlStr = buildHtml(summaries, reps);
  fs.writeFileSync(htmlPath, htmlStr, "utf-8");
  fs.writeFileSync("./live_benchmark_results.html", htmlStr, "utf-8");
  fs.writeFileSync("./index.html", htmlStr, "utf-8");
  console.log(
    `\x1b[32m[HTML Report Written]\x1b[0m Saved to ${htmlPath}, ./live_benchmark_results.html, and ./index.html`,
  );

  const totalRateLimits = summaries.reduce((acc, s) => acc + (s.rateLimitCount || 0), 0);

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

  if (totalRateLimits > 0) {
    md += `> [!WARNING]\n`;
    md += `> **Encountered ${totalRateLimits} API rate limit (429) events during the benchmark!** These calls were successfully recovered via exponential backoff, but indicate high concurrency or rate-limit saturation.\n\n`;
  }

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

  md += `## Passing Trials Performance Metrics\n\n`;
  md += `> [!IMPORTANT]\n`;
  md += `> The following metrics are calculated **exclusively for passing trials** to represent the true baseline of successful task execution.\n\n`;

  for (const sId of scenariosGrouped) {
    const sResults = summaries.filter((s) => s.scenarioId === sId);
    md += `### Scenario: ${sResults[0]?.scenarioName} (\`${sId}\` - Passing Runs Only)\n\n`;
    md += `| Paradigm | Success Rate | Steps (Avg [Min-Max] / Median) | Input Tokens (Avg / Median) | Output Tokens (Avg / Median) | Total Tokens (Avg / Median) |\n`;
    md += `| :--- | :---: | :---: | :---: | :---: | :---: |\n`;

    for (const s of sResults) {
      const stepsStr = s.passingSteps
        ? `${s.passingSteps.mean.toFixed(1)} [${s.passingSteps.min}-${s.passingSteps.max}] / ${s.passingSteps.median?.toFixed(1)}`
        : "-";
      const inStr = s.passingTokensIn
        ? `${Math.round(s.passingTokensIn.mean).toLocaleString()} / ${Math.round(s.passingTokensIn.median || 0).toLocaleString()}`
        : "-";
      const outStr = s.passingTokensOut
        ? `${Math.round(s.passingTokensOut.mean).toLocaleString()} / ${Math.round(s.passingTokensOut.median || 0).toLocaleString()}`
        : "-";
      const totStr = s.passingTokensTotal
        ? `${Math.round(s.passingTokensTotal.mean).toLocaleString()} / ${Math.round(s.passingTokensTotal.median || 0).toLocaleString()}`
        : "-";
      md += `| **${s.tool}** | ${s.successRate} | ${stepsStr} | ${inStr} | ${outStr} | ${totStr} |\n`;
    }
    md += `\n`;
  }

  fs.writeFileSync(mdPath, md, "utf-8");
  fs.writeFileSync("./live_benchmark_results.md", md, "utf-8");
  console.log(
    `\x1b[32m[Markdown Results Written]\x1b[0m Saved to ${mdPath} and ./live_benchmark_results.md`,
  );
}
