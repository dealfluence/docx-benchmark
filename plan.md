# RFC: Extensible Document Redlining & Processing Benchmark Suite

*   **Status**: Proposed
*   **Target Repository**: `adeu-benchmark`
*   **License**: GNU Affero General Public License v3.0 (AGPL-3.0-only)
*   **Target Runtime**: Node.js (>= 22.0.0)
*   **Language**: TypeScript (ES2022 / NodeNext)

---

## 1. Objective

This document defines the specification for an offline, extensible, and mathematically sound benchmarking suite designed to measure the efficiency and fidelity of differing patterns for processing Microsoft Word (`.docx`) documents in LLM-driven workflows. 

The suite compares **Adeu** (a surgical XML patcher / Virtual DOM) against two common alternative paradigms: **Raw XML (Flat OPC) manipulation** and **Naïve Markdown Round-tripping**. The core objective is to generate clear, empirical data regarding token consumption, visual formatting preservation, and XML schema stability.

---

## 2. System Architecture & Layout

An agent executing this RFC must scaffold the repository according to the following layout:

```text
adeu-benchmark/
├── LICENSE (AGPL-3.0)
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts        # CLI Entry point & report formatter
    ├── tokenizers.ts   # Offline token counters (cl100k_base & o200k_base)
    ├── scenarios.ts    # Declarative test scenario structures
    └── baselines.ts    # Simulation algorithms for each processing model
```

### 2.1 Dependencies (`package.json`)
The benchmark must run entirely offline without external API dependencies.
*   `@adeu/core`: The underlying TypeScript document manipulation engine. Used to load DOCX structures and extract projected representations.
*   `js-tiktoken`: A pure-JS, zero-dependency implementation of OpenAI's tiktoken.
*   `typescript`, `@types/node` (dev dependencies).

### 2.2 Compilation Target (`tsconfig.json`)
Target ES2022 with NodeNext module resolution to support modern async/await, native ESM imports, and Node.js built-ins.

---

## 3. Metric Calculation & Math Models

The benchmarking agent must calculate metrics using the following equations and parameters:

### 3.1 Token Calculations ($T_{in}, T_{out}$)
All token calculations must utilize `js-tiktoken` to compute counts for two common vocabulary encodings:
*   `cl100k_base`: The encoding utilized by GPT-4 and Claude 3/3.5 models.
*   `o200k_base`: The encoding utilized by GPT-4o.

### 3.2 Cost Approximations ($C$)
To ground the metrics financially, the suite must estimate API costs based on a blended industry average of:
*   **Input Tokens**: \$3.00 per 1,000,000 tokens ($R_{in} = 3.00 \times 10^{-6}$)
*   **Output Tokens**: \$15.00 per 1,000,000 tokens ($R_{out} = 15.00 \times 10^{-6}$)

$$C = (T_{in} \times R_{in}) + (T_{out} \times R_{out})$$

### 3.3 Fidelity Preservation Score ($F$)
Fidelity is measured as a percentage ($0 \le F \le 100$) reflecting whether critical document metadata and unmutated structures survive the round-trip process:

*   **Unrelated Content Runs**: 20% (Do untouched paragraphs remain physically unmodified?)
*   **Headers & Footers**: 20% (Are header/footer parts and their relationships preserved?)
*   **Margin Comment Threads**: 20% (Do existing comment records survive?)
*   **Style Sheets & Custom XML**: 20% (Are custom fonts, numbering schemes, and bindings kept?)
*   **Tracked Revisions History**: 20% (Is prior track-changes history preserved?)

---

## 4. Evaluated Baselines (The Competitors)

The benchmarking agent must simulate three processing strategies:

### 4.1 Baseline 1: Raw XML / Flat OPC (XML-to-XML)
*   **Description**: The document is converted to Flat OPC XML (or its main `document.xml` part is extracted). The entire XML tree is passed to the LLM. The LLM must output the entire updated XML block back to maintain integrity.
*   **Calculation Model**:
    *   $T_{in} = \text{Tokens}(\text{document.xml}) + \text{Tokens}(\text{System Prompt})$
    *   $T_{out} = \text{Tokens}(\text{document.xml})$ (since any truncation results in structural corruption).
    *   $F = 100\%$ (If successful, the XML preserves all structures natively).
    *   **XML Integrity**: Marked as `FAIL` because raw XML generation by LLMs regularly violates XSD schemas, introduces namespace errors, or breaks internal relationship IDs.

### 4.2 Baseline 2: Naïque Markdown Round-Trip (MD-to-DOCX)
*   **Description**: The document is converted to plain text or standard Markdown. The LLM edits the Markdown. The final DOCX is regenerated from scratch from the edited Markdown (e.g., via Pandoc).
*   **Calculation Model**:
    *   $T_{in} = \text{Tokens}(\text{Plain Markdown}) + \text{Tokens}(\text{System Prompt})$
    *   $T_{out}$: Under surgical edits, the LLM outputs only the modified paragraph. Under complex edits, it outputs the full section.
    *   $F = 30\%$ (All headers, footers, footnotes, comment threads, custom styles, and prior tracking are lost upon regeneration).
    *   **XML Integrity**: Marked as `PASS` (since fresh XML is generated, though original layout/structure is lost).

### 4.3 Baseline 3: Adeu Virtual DOM
*   **Description**: The document is projected into raw Markdown with CriticMarkup. The LLM outputs only the surgical patch as a JSON array of `DocumentChange` objects.
*   **Calculation Model**:
    *   $T_{in} = \text{Tokens}(\text{CriticMarkup Markdown}) + \text{Tokens}(\text{System Prompt})$
    *   $T_{out} = \text{Tokens}(\text{Changes JSON Array})$
    *   $F = 100\%$ (Only modified runs are mutated; all other XML parts are left untouched).
    *   **XML Integrity**: Marked as `PASS` (Adeu mathematically guarantees XML validity during reconciliation).

---

## 5. Concrete Scenarios

The suite must declare and run these three scenarios to generate comparative data:

```typescript
export interface Scenario {
  id: string;
  name: string;
  description: string;
  targetText: string;
  replacementText: string;
  comment?: string;
  reviewAction?: {
    type: "accept" | "reject" | "reply";
    targetId: string;
    payload?: string;
  };
}
```

### Scenario 1: Surgical Correction (Terminology Update)
*   **Target Text**: `"Seller"`
*   **Replacement Text**: `"Vendor"`
*   **Context**: A 20-page document where a single word needs to be updated. Shows the massive advantage of Adeu's surgical JSON output over full-document XML/Markdown re-emission.

### Scenario 2: Clause Drafting (Section Insertion)
*   **Target Text**: `"## 8. Governing Law"`
*   **Replacement Text**: `"## 8. Governing Law\n\n## 9. Data Protection\n\nEach party shall comply with all applicable data protection laws..."`
*   **Context**: Inserting a structured 3-paragraph clause including a new Heading 2. Measures formatting inheritance and paragraph-break tracking.

### Scenario 3: Negotiation Cleanup (Track Changes Accept)
*   **Target Text**: `""` (Action-only)
*   **Review Action**: `type: "accept", targetId: "Chg:12"`
*   **Context**: Finalizing an existing tracked change. Demonstrates that alternative baselines cannot natively execute review operations without completely breaking XML references.

---

## 6. Implementation Directives for the Agent

When writing the code, the executing agent must adhere to these directives:

1.  **Strict Path Resolution**: Search for the source document (`golden.docx`) in a list of candidates (e.g., standard testing fixtures) so that the benchmark can be executed easily inside or alongside the main workspace.
2.  **`js-tiktoken` Integration**: Initialize the tokenizer statically using ESM imports:
    ```typescript
    import { getEncoding } from "js-tiktoken";
    const cl100k = getEncoding("cl100k_base");
    ```
3.  **Output Formatters**: Output the final results in two ways:
    *   A beautiful, color-coded ANSI table printed to the terminal console using `console.table`.
    *   A clean Markdown table printed directly to stdout, ready to be copied into the benchmark repository's `README.md`.
4.  **No Mocked Values**: The script must physically load the `.docx` file, read its XML parts via `DocumentObject`, run actual tokenizers on the extracted text, and calculate all statistics dynamically. The output must be authentic and mathematically correct.
