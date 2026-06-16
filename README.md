# Extensible Document Redlining & Processing Benchmark Suite

An offline, extensible, and mathematically sound benchmarking suite designed to measure the efficiency, token consumption, financial cost, and formatting fidelity of differing patterns for processing Microsoft Word (`.docx`) documents in LLM-driven workflows.

This suite compares **Adeu** (a surgical XML patcher / Virtual DOM) against two common alternative paradigms: **Raw XML (Flat OPC) manipulation** and **Naïve Markdown Round-tripping**.

---

## Key Metrics Evaluated

1. **Token Consumption ($T_{in}, T_{out}$)**: Powered by `js-tiktoken` using `cl100k_base` (GPT-4 / Claude 3.5) and `o200k_base` (GPT-4o) encodings.
2. **Estimated API Costs ($C$)**: Blended industry average costs (\$3.00/M input tokens, \$15.00/M output tokens).
3. **Fidelity Preservation Score ($F$)**: Percentage metric reflecting whether untouched document paragraphs, headers, footers, comment threads, style sheets, and tracked revisions survive the round-trip process intact.
4. **XML Schema Integrity**: Strict evaluation of whether the output complies with Microsoft OpenXML/Word XSD standards without introducing namespace errors, structural corruption, or dangling reference IDs.

---

## Installation & Setup

Ensure you have Node.js (>= 22.0.0) installed.

```bash
# Install offline dependencies
npm install

# Build the TypeScript compiler outputs
npm run build
```

---

## Running the Benchmark

You can run the offline simulation suite using the following commands:

```bash
# Execute the benchmark CLI
node dist/index.js

# Run the Vitest unit testing suite
npm run test

# Run linter and prettier checks
npm run lint
npm run format
```

---

## Simulation Results

Offline calculations are computed dynamically using actual OpenXML parsing of `golden.docx` via the `@adeu/core` library. Below are the standard benchmark results:

### Surgical Correction (Terminology Update)
| Baseline Paradigm | Tokenizer | Input Tokens | Output Tokens | Total Tokens | Estimated Cost | Fidelity Score | XML Schema Integrity |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Raw XML / Flat OPC** | `cl100k_base` | 1,536 | 1,463 | 2,999 | $0.026553 | 100% | ❌ FAIL |
| **Naïve Markdown Round-Trip** | `cl100k_base` | 65 | 12 | 77 | $0.000375 | 30% | ✅ PASS |
| **Adeu Virtual DOM** | `cl100k_base` | 363 | 17 | 380 | $0.001344 | 100% | ✅ PASS |
| **Raw XML / Flat OPC** | `o200k_base` | 1,566 | 1,494 | 3,060 | $0.027108 | 100% | ❌ FAIL |
| **Naïve Markdown Round-Trip** | `o200k_base` | 65 | 12 | 77 | $0.000375 | 30% | ✅ PASS |
| **Adeu Virtual DOM** | `o200k_base` | 364 | 17 | 381 | $0.001347 | 100% | ✅ PASS |

### Clause Drafting (Section Insertion)
| Baseline Paradigm | Tokenizer | Input Tokens | Output Tokens | Total Tokens | Estimated Cost | Fidelity Score | XML Schema Integrity |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Raw XML / Flat OPC** | `cl100k_base` | 1,536 | 1,463 | 2,999 | $0.026553 | 100% | ❌ FAIL |
| **Naïve Markdown Round-Trip** | `cl100k_base` | 65 | 26 | 91 | $0.000585 | 30% | ✅ PASS |
| **Adeu Virtual DOM** | `cl100k_base` | 363 | 50 | 413 | $0.001839 | 100% | ✅ PASS |
| **Raw XML / Flat OPC** | `o200k_base` | 1,566 | 1,494 | 3,060 | $0.027108 | 100% | ❌ FAIL |
| **Naïve Markdown Round-Trip** | `o200k_base` | 65 | 26 | 91 | $0.000585 | 30% | ✅ PASS |
| **Adeu Virtual DOM** | `o200k_base` | 364 | 50 | 414 | $0.001842 | 100% | ✅ PASS |

### Negotiation Cleanup (Track Changes Accept)
| Baseline Paradigm | Tokenizer | Input Tokens | Output Tokens | Total Tokens | Estimated Cost | Fidelity Score | XML Schema Integrity |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Raw XML / Flat OPC** | `cl100k_base` | 1,536 | 1,463 | 2,999 | $0.026553 | 100% | ❌ FAIL |
| **Naïve Markdown Round-Trip** | `cl100k_base` | 65 | 16 | 81 | $0.000435 | 30% | ✅ PASS |
| **Adeu Virtual DOM** | `cl100k_base` | 363 | 15 | 378 | $0.001314 | 100% | ✅ PASS |
| **Raw XML / Flat OPC** | `o200k_base` | 1,566 | 1,494 | 3,060 | $0.027108 | 100% | ❌ FAIL |
| **Naïve Markdown Round-Trip** | `o200k_base` | 65 | 16 | 81 | $0.000435 | 30% | ✅ PASS |
| **Adeu Virtual DOM** | `o200k_base` | 364 | 15 | 379 | $0.001317 | 100% | ✅ PASS |

---

## License

This repository is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0-only)**.
