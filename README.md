# Document Redlining & Processing Benchmark

Benchmarking suite designed to measure the efficiency, token consumption, and formatting fidelity of agentic patterns for processing Microsoft Word (`.docx`) documents in LLM-driven workflows.

> [!NOTE]
> This benchmark contains **no one-shot** workflows. It strictly evaluates and compares multi-turn, agentic round-trip workflows.

The suite benchmarks **any set of MCP-based document tools** against the same scenarios on equal terms. The tools under test are declared in [`benchmark.tools.json`](benchmark.tools.json) — **bring your own MCP server** and benchmark it with no code changes. Out of the box it ships with two tools: **Adeu** (agentic loop over `@adeu/mcp-server`) and **Safe Docx** (`@usejunior/safe-docx`).

Detailed design choices, cost formulas, and scoring rules are documented in the [METHODOLOGY.md](METHODOLOGY.md) file.

---

## Key Metrics Evaluated

1.  **Task Success Rate (`success`)**: A dynamic check confirming whether the model successfully completed the specific scenario's target edit.
2.  **Formatting Fidelity Preservation (`fidelity`)**: Percentage metric reflecting whether untouched document paragraphs, styles, headers, footers, comments, and tracked revisions survive the editing round-trip.
3.  **XML Schema Integrity (`xmlIntegrity`)**: An observed check of whether the edited DOCX package can be successfully parsed, re-zipped, and loaded by standard Word parsers.
4.  **Token Consumption ($T_{in}$, $T_{out}$)**: The real prompt and completion token counts reported directly by the model APIs.

---

## Scenarios Measured

Scenarios are data-driven and defined in [`src/scenarios.ts`](src/scenarios.ts). Each targets one document-handling capability; several require reading a separate **input document** for their data (so the task is finding-and-placing, not transcribing from the prompt):

1.  **Form Fill (`form-fill`)**: Read a deal **data sheet** and fill *every* placeholder in a Post-Money SAFE template — leaving no bracketed placeholder or blank behind.
2.  **Template Reuse & Party Swap (`party-swap`)**: Re-template an **executed** Series Seed agreement (real prior parties baked in) onto new parties, consistently everywhere. A single leftover prior-party reference is a failure.
3.  **Policy Checklist Review (`policy-checklist-review`)**: Redline and **comment in place** against a 3-point checklist on a Cloud Service Agreement — no external output or summary.
4.  **Playbook Review of Counterparty Redlines (`playbook-commenting`)**: The fixture arrives with the counterparty's proposed **tracked changes + comments**; review them against the negotiation playbook (late-payment interest must be 2.0% over the Bank of England base rate, not statutory) using your own redlines/comments.
5.  **Multi-file Deal Assembly (`multi-file-assembly`)**: Read a deal **intake sheet** and propagate its values (Customer, Effective Date) into both the Cloud Service Agreement and its companion Data Processing Agreement.

---

## Installation & Setup

Ensure you have Node.js (>= 22.0.0) installed.

```bash
# Install dependencies
npm install

# Set up your environment variables
cp .env.example .env
```

Open `.env` and fill in your API key for Google Gemini (`GEMINI_API_KEY`).

---

## Configuring Tools Under Test

The tools the benchmark runs are declared in [`benchmark.tools.json`](benchmark.tools.json), using the familiar `mcpServers` shape. Each entry is an MCP server launched over stdio:

```json
{
  "tools": {
    "adeu": {
      "displayName": "Adeu MCP",
      "command": "npx",
      "args": ["-y", "@adeu/mcp-server", "--scope", "docx"]
    },
    "my-tool": {
      "displayName": "My MCP Tool",
      "command": "python",
      "args": ["-m", "my_mcp_server"],
      "env": { "MY_FLAG": "1" },
      "argDefaults": { "save": { "allow_overwrite": true } }
    }
  }
}
```

- **`command` / `args` / `env`**: how to launch the MCP server (any runtime — node, python, docker, …).
- **`displayName`**: the label shown to the model (defaults to the tool id).
- **`argDefaults`** *(optional)*: per-tool-name argument defaults merged into every matching MCP call — useful for tool-specific quirks without code changes.

To benchmark **your own** MCP server, add an entry here and run the suite — no code changes required. Point at a different file with `--tools <path>` or the `BENCHMARK_TOOLS` env var. If no config file exists, the suite falls back to the bundled `adeu` + `safe-docx` defaults.

### Comparing local dev builds vs. published versions

Because a tool is just an MCP launch spec, you can pit your **local working-tree** adeu servers against their **published** releases (and against each other across the Node and Python engines) in one run. A ready-made config ships as [`benchmark.tools.local.json`](benchmark.tools.local.json):

| Tool id | What it runs |
|---|---|
| `adeu-node-local` | `node ../adeu/node/packages/mcp-server/dist/index.js` |
| `adeu-node-published` | `npx -y @adeu/mcp-server` |
| `adeu-python-local` | `uv run --project ../adeu/python adeu-server` |
| `adeu-python-published` | `uvx --from adeu adeu-server` |
| `safe-docx` | `npx -y @usejunior/safe-docx` |

Prerequisites:

- The **adeu** repo checked out as a **sibling** of this one (`../adeu`). The relative paths resolve against this repo's root (the MCP child inherits the benchmark's working directory).
- The **Node** server built from source: `cd ../adeu/node && npm run build` (the local entry runs `dist/index.js`).
- **`uv`** on your `PATH` for the Python entries (`uv`/`uvx`). The Python entries set `FASTMCP_SHOW_SERVER_BANNER=false` and `FASTMCP_CHECK_FOR_UPDATES=off` to keep stdio clean and avoid a startup network call.

First, verify every server **launches and advertises its tools** — no API key, no scored run, no quota spent:

```bash
npm run tools:check -- --tools benchmark.tools.local.json
```

This connects to each configured tool over stdio, completes the MCP handshake, and lists the tools it exposes (exiting non-zero if any fail to launch). Then run the scored benchmark against the same config:

```bash
npm run benchmark -- --tools benchmark.tools.local.json
# or a quick 1-rep pass:
npm run benchmark:quick -- --tools benchmark.tools.local.json
```

> [!NOTE]
> The two engines expose slightly different docx tools (the Node build adds `finalize_document`; the Python build adds `open_local_file`), but both share the `read_docx` / `process_document_batch` / `diff_docx_files` / `accept_all_changes` core the scenarios exercise. Each tool's `displayName` is what appears in the report, so local and published columns stay distinct.

---

## Running the Benchmark

To execute the live benchmarking suite and run active document redlining scenarios against the configured LLMs:

```bash
# Run the full live API benchmark suite
npm run benchmark

# Run the quick live benchmark (1 rep)
npm run benchmark:quick

# Tune parallelism (trials run concurrently; default 10)
npm run benchmark -- --concurrency 8
# ...or via env
BENCHMARK_CONCURRENCY=8 npm run benchmark
```

Trials (tool × scenario × rep) run **in parallel** through a bounded concurrency pool — set `--concurrency N` / `BENCHMARK_CONCURRENCY` to trade wall-clock time against API rate limits. Repetitions are controlled with `--reps N` / `BENCHMARK_REPS`.

The live benchmark compiles the codebase, detects active keys in the environment, makes actual API calls to run each tool and scenario, verifies success, assesses fidelity, and writes reports:
- `results/<ISO>.json` and `results/<ISO>.md` — detailed summary with min/max.
- `results/<ISO>.csv` (and `./live_benchmark_results.csv`) — flat, spreadsheet-friendly results: one row per scenario × tool.

Additionally, all stdout logs and structured tool steps are written in real time to standard-compliant **JSON Lines** (`.jsonl`) files, with every line tagged by `trialId` / `toolId` / `scenario` / `rep` so a parallel run stays `jq`-grep-able:
- `./live_benchmark.jsonl` (always contains the logs of the latest benchmark run).
- `results/<ISO>.jsonl` (contains the logged history for that specific run).

```bash
# Example: extract one tool's tool-steps from a parallel run
jq -c 'select(.type=="tool_step" and .toolId=="adeu")' live_benchmark.jsonl
```

---

## Quality Control & Development

For local validation, and offline checks:

```bash
# Run the local offline simulation suite (compares projection input token sizes)
node dist/index.js

# Run the Vitest unit testing suite
npm run test

# Run code linter
npm run lint

# Run prettier code formatter
npm run format
```

## License

This repository is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0-only)**.
