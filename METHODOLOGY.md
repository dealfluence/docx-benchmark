# Adeu Benchmark Suite Methodology

This document details the metrics, formulas, scenario specifications, and evaluation criteria used in the live docx-benchmark measurement suite. The suite is designed to provide a fair, transparent, and reproducible comparison of different paradigms for programmatically editing Microsoft Word (`.docx`) documents using large language models.

---

## 1. Core Paradigms Compared

The suite measures four programmatic editing strategies:

1. **`raw-xml`**: The model is provided with the raw XML of the main document part (`word/document.xml`) along with system instructions to perform the edit. The model returns either the edited XML body or targeted search/replace patches which are then merged.
2. **`markdown-roundtrip`**: The Word document is projected into plain Markdown text (`DocumentMapper(doc, true)`). The model receives and edits the Markdown, and the document is then reconstructed back into `.docx` format using document-building primitives.
3. **`adeu`**: The Word document is projected into CriticMarkup (`DocumentMapper(doc, false)`). The model receives this markup and outputs a structured JSON array of surgical `DocumentChange` instructions (e.g., `modify`, `accept`, `reject`, `reply`). These instructions are applied directly to the document using `@adeu/core`'s `RedlineEngine`.
4. **`safe-docx`**: A real-world agentic competitor using the Model Context Protocol (MCP) tool-calling standard. The model executes a multi-turn tool-calling loop against `@usejunior/safe-docx` (Apache-2.0, version 0.5.2) to inspect, edit, and save the document. We report both the total all-in token cost and a floor representing genuinely new content tokens (excluding tool definitions and prior turn history) to distinguish paradigm overhead from raw document-handling capacity.

---

## 2. Cost Formulas

Token pricing is model-specific and based on official list prices per million tokens:

*   **Google Gemini 3.5 Flash (`gemini-3.5-flash`)**:
    *   Input: **$0.075** per million tokens
    *   Output: **$0.30** per million tokens
*   **OpenAI GPT-4o-mini (`gpt-4o-mini`)**:
    *   Input: **$0.15** per million tokens
    *   Output: **$0.60** per million tokens
*   **Anthropic Claude 3.5 Haiku (`claude-3-5-haiku-20241022`)**:
    *   Input: **$0.80** per million tokens
    *   Output: **$4.00** per million tokens
*   **Fallback Blended Rate** (when a model is not explicitly mapped):
    *   Input: **$3.00** per million tokens
    *   Output: **$15.00** per million tokens

The cost is computed exactly as:
$$\text{Cost} = \left(\frac{\text{Tokens In} \times \text{Input Price}}{1,000,000}\right) + \left(\frac{\text{Tokens Out} \times \text{Output Price}}{1,000,000}\right)$$

---

## 3. Metric Definitions

### 3.1 Task Success (`success`)
A dynamic check that verifies whether the model successfully performed the requested edit. Success is checked against the plain text mapper of the modified document (see §4). 

> [!IMPORTANT]
> Token and cost savings only matter when **Success Rate** is high. A paradigm that achieves low token counts but fails tasks or corrupts document styling has zero utility.

### 3.2 XML Integrity (`xmlIntegrity`)
A strict structural evaluation. The modified document is zipped back into a `.docx` package and parsed.
*   **`PASS`**: The package re-zips into a fully valid, loadable ZIP file, and the internal XML parses cleanly with no well-formedness or tag-mismatch errors.
*   **`FAIL`**: The XML contains parsing errors, tag mismatches, or the package fails to compress and reload. If `xmlIntegrity` is `FAIL`, the trial's fidelity score is forced to `0%`.

### 3.3 Fidelity Score (`fidelity`)
Measures the preservation of high-fidelity, non-text Word features. It starts at a baseline of 20% (representing unmutated paragraph run content) and awards +20% for each of the following four dimensions preserved:
1.  **Styles**: Awarded if no custom paragraph/run styles present in the original document (extracted from `word/styles.xml`) are lost.
2.  **Headers/Footers**: Awarded if original headers/footers remain intact, or if they were originally absent (vacuous preservation).
3.  **Margin Comments**: Awarded if original margin comments remain intact, or if they were originally absent.
4.  **Tracked Changes**: Awarded if unmutated tracked changes (revisions) are preserved, or if none were present (vacuous preservation). In `negotiation-cleanup`, accepting specific target revisions is allowed and does not count as loss.

$$\text{Fidelity Score} = 20\% + (\text{Styles} \times 20\%) + (\text{Headers/Footers} \times 20\%) + (\text{Comments} \times 20\%) + (\text{Tracked Changes} \times 20\%)$$

### 3.4 XML Delta / Surgicality Metric (`xmlDelta`)
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

## 4. Scenario Specifications and Success Rules

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

## 5. Tokenization and Counting

Tokens are counted exactly as returned by the API providers.
*   For **OpenAI** and **Anthropic**, we use the respective SDK token usage fields (`prompt_tokens`, `completion_tokens`, `input_tokens`, `output_tokens`) returned in the response payload.
*   For **Gemini**, we use the `usageMetadata` prompt and candidates token counts (`promptTokenCount`, `candidatesTokenCount`) from the API response.
*   For the offline estimate, we use the `js-tiktoken` package with `o200k_base` encoding as a consistent model-free proxy to measure input sizes.

---

## 6. Threats to Validity

To maintain the highest level of scientific rigor and benchmark credibility, we must honestly document the limitations of this measurement suite:

1.  **Single Golden Document**: The benchmark is currently run against a single contract file (`golden.docx`). While it exercises styles, comments, and tracked revisions, results may vary depending on the structure, schema, size, and layout complexity of other documents.
2.  **Prompt Sensitivity**: LLMs are highly sensitive to system and user prompts. It is possible that alternative system prompts could improve the `raw-xml` or `markdown-roundtrip` baselines' success rates or output formatting, or conversely, make them more expensive.
3.  **Model Version Drift**: The APIs called represent specific model versions snapshot at a point in time. Future model updates, deprecations, or changes to quantization and reasoning capabilities will impact output tokens, latencies, and success behaviors.
4.  **List Price vs. Enterprise Pricing**: Cost estimations are computed using standard public list prices. Real-world corporate or volume-discounted pricing agreements will yield different economic comparisons.
5.  **XML Parsing and Merging Limitations**: The `raw-xml` baseline uses a custom search/replace XML block parser to steelman its performance. While this is highly competitive, complex document modifications can easily break XML well-formedness if the model makes minor syntax mistakes, causing immediate integrity failure.
