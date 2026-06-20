# Adeu Benchmark Suite: Technical Context & Architecture

This document serves as the long-term context file for developers and AI agents working on the `adeu-benchmark` repository. It records the core architecture, deterministic metric designs, known constraints, and critical patterns established across the suite.

---

## 1. Core Architecture & Paradigms

The benchmark measures and compares four document-editing paradigms on equal terms (same model, temperature, reps, and tokenizer settings):

1. **`raw-xml`**: Provides the LLM with raw `word/document.xml`. Steelmanned to allow either full XML emission or surgical `SEARCH/REPLACE` blocks.
2. **`markdown-roundtrip`**: Projects the document to plain Markdown, receives edited Markdown, and regenerates a `.docx` document.
3. **`adeu`**: Projects the document to CriticMarkup and applies a structured JSON array of surgical `DocumentChange` instructions using `@adeu/core`'s `RedlineEngine`. For complex scenarios, executes a multi-turn tool-calling loop over `@adeu/mcp-server` via standard stdio transport.
4. **`safe-docx`**: Executes a stateful, multi-turn tool-calling loop against the `@usejunior/safe-docx` MCP server over stdio transport.

---

## 2. Key Metrics & Deterministic Evaluation

All evaluation metrics are calculated dynamically at runtime; hardcoded metric assignments are forbidden.

### 2.1 Formatting Fidelity Score (`fidelity`)
Measures structural and style preservation on a `0%` to `100%` scale. Evaluates five dimensions:
*   **Base (20%)**: Retains unmutated paragraph run content.
*   **Styles (+20%)**: Preserves original custom styles extracted from `word/styles.xml`.
*   **Headers/Footers (+20%)**: Preserves headers and footers.
*   **Comments (+20%)**: Retains margin comments.
*   **Tracked Changes (+20%)**: Preserves unmutated tracked changes (except explicit accepts in the negotiation scenario).

### 2.2 XML Delta / Surgicality Metric (`xmlDelta`)
Measures exact character changes to the XML structure rather than relying on LLM-driven judges:
1.  **Tokenization**: Splits raw XML at `>` tag boundaries and trims elements.
2.  **Longest Common Subsequence (LCS)**: Computes the LCS of tokens via dynamic programming (guarded with a linear fallback for arrays $> 4000$ elements to protect memory).
3.  **Aggregation**: Sums the character lengths of added and deleted XML segments.

---

## 3. Schema & Integration Constraints

### 3.1 Generic Schema Flattening for Google Gemini
Google Gemini has strict rules regarding the parameters schema of its registered tools:
*   **Uppercase Enums**: Schema types must match uppercase strings (e.g. `SchemaType.OBJECT` = `"OBJECT"`, `SchemaType.ARRAY` = `"ARRAY"`). Providing lowercase `"object"` or `"array"` triggers immediate serialization or API validation failures.
*   **Flattening Unions**: Gemini does not natively support complex JSON schema unions (`anyOf` or `oneOf` blocks) inside tool definitions.
*   **Handling of `cleanSchema`**: Tool schemas extracted from third-party MCP servers (like `@adeu/mcp-server`) must have their `anyOf`/`oneOf` array structures dynamically flattened into flat `object` properties. When mapping types to `SchemaType` enums, the mapping logic must inspect the *resolved/flattened* property type rather than the original input type, which may be `undefined`.

### 3.2 Token Breakdown and Loop Overhead
To make an honest architectural comparison with multi-turn loops, `safe-docx` token metrics are broken down per turn into:
*   `schemaTokens`: Portion used to re-transmit tool schemas.
*   `historyTokens`: Portion used to re-transmit conversation history.
*   `newContentTokens`: Real document-handling output and execution content.
Both **Total Tokens** and the **`newContentTokens` floor** are reported to distinguish platform overhead from core document handling.