# Extensible Document Redlining & Processing Benchmark Suite

An extensible, rigorous, and mathematically sound benchmarking suite designed to measure the efficiency, token consumption, financial cost, and formatting fidelity of differing patterns for processing Microsoft Word (`.docx`) documents in LLM-driven workflows.

This suite compares **Adeu** (a surgical XML patcher / Virtual DOM) against its primary rich-text editor/MCP competitor **Safe Docx** (`@usejunior/safe-docx`), alongside two standard alternative paradigms: **Raw XML (Flat OPC) manipulation** and **Naïve Markdown Round-tripping**.

Detailed design choices, cost formulas, and scoring rules are documented in the [METHODOLOGY.md](METHODOLOGY.md) file.

---

## Key Metrics Evaluated

1.  **Task Success Rate (`success`)**: A dynamic check confirming whether the model successfully completed the specific scenario's target edit without hallucinating or introducing secondary errors.
2.  **Formatting Fidelity Preservation (`fidelity`)**: Percentage metric reflecting whether untouched document paragraphs, styles, headers, footers, comments, and tracked revisions survive the editing round-trip.
3.  **XML Schema Integrity (`xmlIntegrity`)**: An observed check of whether the edited DOCX package can be successfully parsed, re-zipped, and loaded by standard Word parsers.
4.  **Token Consumption ($T_{in}$, $T_{out}$)**: The real prompt and completion token counts reported directly by the model APIs.
5.  **Financial API Cost ($C$)**: Calculated based on exact, model-specific list prices (or a blended fallback rate) per million tokens.

---

## Scenarios Measured

1.  **Surgical Correction (`surgical-correction`)**: Modifies a single word in a 20-page document.
2.  **Clause Drafting (`clause-drafting`)**: Inserts a structured 3-paragraph section, measuring format inheritance.
3.  **Negotiation Cleanup (`negotiation-cleanup`)**: Finalizes an existing tracked revision.
4.  **Bulk Rewrite (`bulk-rewrite`)**: Rewrites an entire section. Testing the boundaries where surgical output advantages are minimized.
5.  **Whole Document Restyle (`whole-document-restyle`)**: Global capitalization check touching most document elements.
6.  **No-Op / Already Correct (`no-op`)**: Robustness check where the target edit is absent; tests whether the model hallucinates modifications.

---

## Installation & Setup

Ensure you have Node.js (>= 22.0.0) installed.

```bash
# Install dependencies
npm install

# Set up your environment variables
cp .env.example .env
```

Open `.env` and fill in your API key for Google Gemini (`GEMINI_API_KEY`). You can also configure other providers by supplying `OPENAI_API_KEY` and/or `ANTHROPIC_API_KEY`.

---

## Running the Benchmark

To execute the live benchmarking suite and run active document redlining scenarios against the configured LLMs:

```bash
# Run the live API benchmark suite
npm run benchmark:live
```

You can configure the number of repetitions per trial using the `--reps <N>` option (default is `3`):

```bash
# Run with 1 rep for a quick smoke test
npm run benchmark:live -- --reps 1
```

The live benchmark will compile the codebase, detect active keys in the environment, make actual API calls to run each paradigm and scenario, dynamically verify success, assess fidelity, and write reports to `results/<ISO>.json` and `results/<ISO>.md`.

---

## Quality Control & Development

For local validation, cost-free testing, and offline checks:

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

---

## Live Benchmark Results

*   **Run Date**: June 21, 2026
*   **Model Used**: `gemini-3.5-flash`
*   **Repetitions (N)**: 5
*   **Temperature**: 0.0
*   **Competitor**: `@usejunior/safe-docx` (Apache-2.0, version 0.5.2)
*   **Reproduction command**: `npm run benchmark:live -- --quick --reps 5`

> [!IMPORTANT]
> Token and cost savings only matter when **Success Rate** is high. A paradigm that achieves low token counts but consistently fails tasks or corrupts document styling has zero utility.

We evaluate performance across two distinct operational regimes: **Simple Single Edits** (e.g. surgical correction of a term) and **Agentic Multi-Step Tasks** (e.g. conditional formatting and venue insertion).

---

### Regime 1: Simple Single Edits

For simple single edits, one-shot paradigms are structurally cheaper than multi-turn agentic loops. Adeu's one-shot patch is exceptionally efficient, needing only 521 prompt and 42 completion tokens on average.

To make an honest architectural comparison, we report both **all-in total tokens** and a **`newContentTokens` floor** for Safe Docx. The floor represents the genuinely new content tokens (tool results and reasoning), excluding schema and conversation re-transmission overhead. Even when looking at the floor, Adeu achieves massive efficiency advantages due to its surgical projection design.

#### 1. Surgical Correction (Terminology Update) (`surgical-correction`)
| Paradigm | Success Rate | Fidelity Score (Avg [Min–Max]) | XML Integrity | Input Tokens (Avg [Min–Max]) | Output Tokens (Avg [Min–Max]) | Total Tokens (Avg [Min–Max]) | Cost (Avg [Min–Max]) | Latency (Avg [Min–Max]) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **raw-xml** | 3/5 | 60.0% [0–100] | 3/5 | 3,934 [3,934–3,934] | 3,756 [3,717–3,815] | 7,690 [7,651–7,749] | $0.00142 [$0.00141–$0.00144] | 16.0s [15.5–16.5] |
| **markdown-roundtrip** | 5/5 | 40.0% [40–40] | 5/5 | 142 [142–142] | 16 [16–16] | 158 [158–158] | $0.00002 [$0.00002–$0.00002] | 0.7s [0.7–0.7] |
| **adeu** | 5/5 | 100.0% [100–100] | 5/5 | 521 [521–521] | 42 [42–42] | 563 [563–563] | $0.00005 [$0.00005–$0.00005] | 1.1s [0.9–1.2] |
| **safe-docx** | 5/5 | 100.0% [100–100] | 5/5 | 3,389 / 26,917 [3,363–3,402 / 26,864–26,945] (floor/total) | 273 [257–317] | 3,662 / 27,190 [3,620–3,719 / 27,121–27,262] (floor/total) | $0.00210 [$0.00209–$0.00212] | 6.1s [5.2–6.7] |

---

### Regime 2: Agentic Multi-Step Tasks

For agentic scenarios involving multi-turn loops, both architectures converge in round-trips. Adeu operates via its own CriticMarkup multi-turn loop, and Safe Docx executes tool-calling MCP cycles.

In this regime, we track agentic performance metrics, including average round-trips, average turns to success, and recovery rate from mid-loop errors. Safe Docx achieves high success with premium 100.0% formatting preservation, while Adeu provides incredibly lightweight token usage.

#### 2. Conditional Clause Insertion (US vs State) (`conditional-edit`)
| Paradigm | Success Rate | Fidelity Score (Avg [Min–Max]) | XML Integrity | Round Trips (Avg) | Turns to Success (Avg) | Recovery Rate (Avg) | Input Tokens (Avg [Min–Max]) | Output Tokens (Avg [Min–Max]) | Total Tokens (Avg [Min–Max]) | Cost (Avg [Min–Max]) | Latency (Avg [Min–Max]) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **raw-xml** | 0/5 | 0.0% [0–0] | 0/5 | 1.0 | 0.0 | 0.0% | 3,930 [3,930–3,930] | 3,722 [3,722–3,722] | 7,652 [7,652–7,652] | $0.00141 [$0.00141–$0.00141] | 14.9s [13.9–15.9] |
| **markdown-roundtrip** | 0/5 | 40.0% [40–40] | 5/5 | 1.0 | 0.0 | 0.0% | 138 [138–138] | 16 [16–16] | 154 [154–154] | $0.00002 [$0.00002–$0.00002] | 0.7s [0.6–1.0] |
| **adeu** | 3/5 | 60.0% [0–100] | 3/5 | 6.0 | 1.2 | 0.0% | 14,233 [0–31,578] | 742 [0–2,203] | 14,975 [0–33,781] | $0.00129 [$0.00000–$0.00303] | 72.7s [24.3–105.6] |
| **safe-docx** | 4/5 | 100.0% [100–100] | 5/5 | 3.6 | 5.2 | 0.0% | 2,240 / 30,792 [299–2,974 / 5,600–41,100] (floor/total) | 371 [0–508] | 2,611 / 31,163 [299–3,482 / 5,600–41,608] (floor/total) | $0.00242 [$0.00042–$0.00323] | 12.3s [9.5–20.1] |

---

## Limitations

*   **Single Golden Document**: Evaluation is conducted using a single multi-page Word document (`golden.docx`). While it exercises styles, comments, and tracked revisions, results may vary for other document layouts or schemas.
*   **Prompt Sensitivity**: System and user prompts heavily influence model performance. A different prompt engineering approach could alter success rates, output token length, and XML schema validity for competing baselines.
*   **Model Version Drift**: Results are locked to a specific model version (`gemini-2.5-flash`). Future releases, parameter fine-tuning, or quantization updates by the model host can influence costs, latencies, and success behavior.
*   **Pricing Basis**: Estimated costs are computed on public retail list prices. Large enterprise or volume pricing plans may alter real financial ratios.

---

## License

This repository is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0-only)**.
