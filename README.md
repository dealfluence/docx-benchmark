# Document Redlining & Processing Benchmark

Benchmarking suite designed to measure the efficiency, token consumption, and formatting fidelity of differing patterns for processing Microsoft Word (`.docx`) documents in LLM-driven workflows.

This suite compares **Adeu** (a surgical XML patcher / Virtual DOM) against **Safe Docx** (`@usejunior/safe-docx`), alongside two standard alternative paradigms: **Raw XML (Flat OPC) manipulation** and **Naïve Markdown Round-tripping**.

Detailed design choices, cost formulas, and scoring rules are documented in the [METHODOLOGY.md](METHODOLOGY.md) file.

---

## Key Metrics Evaluated

1.  **Task Success Rate (`success`)**: A dynamic check confirming whether the model successfully completed the specific scenario's target edit.
2.  **Formatting Fidelity Preservation (`fidelity`)**: Percentage metric reflecting whether untouched document paragraphs, styles, headers, footers, comments, and tracked revisions survive the editing round-trip.
3.  **XML Schema Integrity (`xmlIntegrity`)**: An observed check of whether the edited DOCX package can be successfully parsed, re-zipped, and loaded by standard Word parsers.
4.  **Token Consumption ($T_{in}$, $T_{out}$)**: The real prompt and completion token counts reported directly by the model APIs.

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

Open `.env` and fill in your API key for Google Gemini (`GEMINI_API_KEY`).

---

## Running the Benchmark

To execute the live benchmarking suite and run active document redlining scenarios against the configured LLMs:

```bash
# Run the full live API benchmark suite
npm run benchmark

# Run the quick live benchmark (1 rep, subset of scenarios)
npm run benchmark:quick
```

The live benchmark will compile the codebase, detect active keys in the environment, make actual API calls to run each paradigm and scenario, verify success, assess fidelity, and write reports to `results/<ISO>.json` and `results/<ISO>.md`.

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
