# DOCX Benchmark Methodology

## 1. Core Paradigms Compared

> [!NOTE]
> This benchmark focuses exclusively on multi-turn, agentic round-trip workflows. There are **no one-shot** workflows measured.

The suite measures two agentic programmatic editing strategies:

1. **`adeu`**: For complex agentic scenarios, executes a multi-turn tool-calling loop over `@adeu/mcp-server` via standard stdio transport, applying a structured JSON array of surgical modifications.
2. **`safe-docx`**: A real-world agentic tool using the Model Context Protocol (MCP) tool-calling standard. The model executes a multi-turn tool-calling loop against `@usejunior/safe-docx` (Apache-2.0) to inspect, edit, and save the document. We report both the total all-in token cost and a floor representing genuinely new content tokens (excluding tool definitions and prior turn history) to distinguish paradigm overhead from raw document-handling capacity.

## 2. Metric Definitions

### 2.1 Task Success (`success`)
A dynamic check that verifies whether the model successfully performed the requested edit. Success is checked against the plain text mapper of the modified document (see §4). 

> [!IMPORTANT]
> Token and cost savings only matter when **Success Rate** is high. A paradigm that achieves low token counts but fails tasks or corrupts document styling has zero utility.

### 2.2 XML Integrity (`xmlIntegrity`)
A strict structural evaluation. The modified document is zipped back into a `.docx` package and parsed.
*   **`PASS`**: The package re-zips into a fully valid, loadable ZIP file, and the internal XML parses cleanly with no well-formedness or tag-mismatch errors.
*   **`FAIL`**: The XML contains parsing errors, tag mismatches, or the package fails to compress and reload. If `xmlIntegrity` is `FAIL`, the trial's fidelity score is forced to `0%`.

### 2.3 Fidelity Score (`fidelity`)
Measures the preservation of high-fidelity, non-text Word features. It starts at a baseline of 20% (representing unmutated paragraph run content) and awards +20% for each of the following four dimensions preserved:
1.  **Styles**: Awarded if no custom paragraph/run styles present in the original document (extracted from `word/styles.xml`) are lost.
2.  **Headers/Footers**: Awarded if original headers/footers remain intact, or if they were originally absent (vacuous preservation).
3.  **Margin Comments**: Awarded if original margin comments remain intact, or if they were originally absent.
4.  **Tracked Changes**: Awarded if unmutated tracked changes (revisions) are preserved, or if none were present (vacuous preservation). In `negotiation-cleanup`, accepting specific target revisions is allowed and does not count as loss.

$$\text{Fidelity Score} = 20\% + (\text{Styles} \times 20\%) + (\text{Headers/Footers} \times 20\%) + (\text{Comments} \times 20\%) + (\text{Tracked Changes} \times 20\%)$$

### 2.4 XML Delta / Surgicality Metric (`xmlDelta`)
To objectively measure the "surgicality" of modifications, the suite calculates the edit distance delta between the original and modified XML structures. Line-by-line diffing on single-line compressed OpenXML produces binary all-or-nothing changes. To prevent this, the algorithm tokenizes strings at closing tag boundaries and computes token-level edit distances.

1. **Tag-Boundary Tokenization:**
The XML strings are normalized (newlines aligned to `\n`), split at every closing `>` tag boundary, trimmed of whitespace, and empty tokens are filtered. This yields arrays of structured XML tokens:
$$O = \{o_1, o_2, \dots, o_N\} \quad \text{and} \quad M = \{m_1, m_2, \dots, m_M\}$$

2. **Longest Common Subsequence (LCS):**
For $N, M \le 4000$, we compute the Longest Common Subsequence of tokens via dynamic programming:
$$\text{LCS}(i, j) = \begin{cases} 
0 & \text{if } i=0 \text{ or } j=0 \\
\text{LCS}(i-1, j-1) + 1 & \text{if } o_i = m_j \\
\max(\text{LCS}(i-1, j), \text{LCS}(i, j-1)) & \text{if } o_i \neq m_j 
\end{cases}$$

3. **Character Delta Aggregation:**
By backtracking from $\text{LCS}(N, M)$, the set of deleted tokens $D \subset O$ and added tokens $A \subset M$ are isolated. The final `xmlDelta` value represents the sum of the string lengths of all mutated elements:
$$\text{XML Delta} = \sum_{d \in D} \text{len}(d) + \sum_{a \in A} \text{len}(a)$$
A perfectly preserved, untouched document yields a delta of `0`.

4. **Computational Complexity Guard:**
For large documents where token arrays exceed $4000$ elements, calculating an $O(N \times M)$ DP matrix risks heap exhaustion. The algorithm therefore falls back to a highly reliable, linear-time character-by-character scan:
$$\text{matchingChars} = \sum_{k=1}^{\min(|O|, |M|)} [O[k] == M[k]]$$
$$\text{XML Delta} = (|O| - \text{matchingChars}) + (|M| - \text{matchingChars})$$

> [!TIP]
> A lower **XML Delta** corresponds to highly surgical mutations that leave irrelevant XML tags completely untouched. This is a critical indicator of a paradigm's precision.

---

## 3. Scenario Specifications and Success Rules

### Scenario 1: Surgical Correction (Terminology Update)
*   **ID**: `surgical-correction`
*   **Description**: A 20-page document where a single word needs to be updated. Shows the massive advantage of Adeu's surgical JSON output over full-document XML/Markdown re-emission.
*   **Success Rule**:
    *   The plain text must contain "Vendor".
    *   The plain text must NOT contain "Seller".

### Scenario 2: Clause Drafting (Section Insertion)
*   **ID**: `clause-drafting`
*   **Description**: Inserting a structured 3-paragraph clause including a new Heading 2. Measures formatting inheritance and paragraph-break tracking.
*   **Success Rule**:
    *   The plain text must contain "Data Protection".
    *   The plain text must contain the clause text: `"Each party shall comply with all applicable data protection laws"`.

### Scenario 3: Negotiation Cleanup (Track Changes Accept)
*   **ID**: `negotiation-cleanup`
*   **Description**: Finalizing an existing tracked change. Demonstrates that alternative baselines cannot natively execute review operations without completely breaking XML references.
*   **Success Rule**:
    *   The revision with ID `Chg:12` must no longer be present in CriticMarkup metadata tags.

### Scenario 4: Bulk Rewrite (Clause/Section Replacement)
*   **ID**: `bulk-rewrite`
*   **Description**: Rewriting an entire multi-paragraph section. In this scenario, the output-token advantages of surgical patching vs full re-emission are minimized, testing the paradigm boundaries.
*   **Success Rule**:
    *   The plain text must contain `"establish the terms of service"`.
    *   The plain text must NOT contain `"Typing some. Typing some text"` or `"Typing some text"`.

### Scenario 5: Whole Document Restyle (Capitalization / Global Change)
*   **ID**: `whole-document-restyle`
*   **Description**: A global change touching document elements. Tests cases where the patch size is equal to or larger than full re-emission.
*   **Success Rule**:
    *   The plain text must contain `"GOVERNING LAW"`.
    *   The plain text must NOT contain `"Governing Law"`.

### Scenario 6: No-Op / Already Correct (Robustness Test)
*   **ID**: `no-op`
*   **Description**: Instructs the model to modify a term that does not exist in the document. Correct behavior is to perform no edits, testing robustness against hallucinated edits.
*   **Success Rule**:
    *   The plain text must be identical to the original.
    *   The plain text must NOT contain `"ShouldNotBeInserted"`.

---

## 4. Tokenization and Counting

Tokens are counted exactly as returned by the API providers.
*   For **Gemini**, we use the `usageMetadata` prompt and candidates token counts (`promptTokenCount`, `candidatesTokenCount`) from the API response.
*   For the offline estimate, we use the `js-tiktoken` package with `o200k_base` encoding as a consistent model-free proxy to measure input sizes.

### 4.1 Estimated Token Breakdown Splits
Because multi-turn conversation loops incur substantial overhead by re-transmitting tool schemas and context history, the benchmark splits the total input token count ($T_{in}$) into three components:
1. **Schema Tokens (`schemaTokens`)**: The portion of input tokens consumed by registering and transferring tool declarations. This is measured by comparing the model's token count with and without the tool schemas registered.
2. **History Tokens (`historyTokens`)**: The portion of input tokens used to re-transmit the accumulated conversation messages and tool responses from previous turns.
3. **New Content Tokens (`newContentTokens`)**: The estimated core payload of the current turn, calculated by subtracting the schema and history tokens from the total prompt token count.

These splits are computed turn-by-turn as follows:
* $S_{turn} = \min(\text{schemaTokensPerTurn}, \text{promptTokensThisTurn})$
* $H_{turn} = \min(\text{historyAccumulated}, \text{promptTokensThisTurn} - S_{turn})$
* $N_{turn} = \text{promptTokensThisTurn} - S_{turn} - H_{turn}$

This division provides an honest metric separating conversation architecture overhead from active document processing.

---

## 5. Execution Loops, Schemas, and Logging

To ensure a rigorous and balanced comparison between all four paradigms, the agentic execution loops adhere to strict standardization principles:

### 5.1 Unified Conversational Turn Limits
Both agentic loop implementations (`safe-docx` and `adeu` loops) are restricted to an identical maximum turn cap of **`MAX_TURNS = 10`**. Turn limits are applied symmetrically to eliminate runtime biases.

### 5.2 Single-Path Schema Normalization
Tool definitions originating from third-party MCP servers undergo standard dynamic schema normalization in `cleanSchema` before being registered with Google Gemini. This translation process enforces:
* **Uppercase Enum Translation**: Schema types are cast to uppercase strings (e.g., `SchemaType.OBJECT`).
* **Complex Union Flattening**: Sub-schemas defined via `anyOf` or `oneOf` unions are dynamically compiled and flattened into discrete, single-type properties compatible with the Gemini parameters parser.
* **Fallback Arrays**: Default item specifications are supplied for array configurations that lack them.

### 5.3 Structured JSON Execution Logs
Multi-turn agentic steps are reported in a structured, single-line JSON format:
`{"turn": 1, "paradigm": "Safe Docx Loop", "tool": "grep", "args": {"pattern": "NordicTech"}, "ok": true, "resultBytes": 320, "elapsedMs": 412}`
This guarantees uniform logging across loops, enabling clean parsing of intermediate executions without polluting stdout. Extended tool call payloads and responses are gated behind the `--verbose` flag.

---

## 6. Threats to Validity

To maintain the highest level of scientific rigor and benchmark credibility, we must honestly document the limitations of this measurement suite:

1.  **Single Golden Document**: The benchmark is currently run against a single contract file (`golden.docx`). While it exercises styles, comments, and tracked revisions, results may vary depending on the structure, schema, size, and layout complexity of other documents.
2.  **Prompt Sensitivity**: LLMs are highly sensitive to system and user prompts. It is possible that alternative system prompts could improve the `raw-xml` or `markdown-roundtrip` baselines' success rates or output formatting, or conversely, make them more expensive.
3.  **Model Version Drift**: The APIs called represent specific model versions snapshot at a point in time. Future model updates, deprecations, or changes to quantization and reasoning capabilities will impact output tokens, latencies, and success behaviors.
4.  **List Price vs. Enterprise Pricing**: Cost estimations are computed using standard public list prices. Real-world corporate or volume-discounted pricing agreements will yield different economic comparisons.
5.  **XML Parsing and Merging Limitations**: The `raw-xml` baseline uses a custom search/replace XML block parser to steelman its performance. While this is highly competitive, complex document modifications can easily break XML well-formedness if the model makes minor syntax mistakes, causing immediate integrity failure.
