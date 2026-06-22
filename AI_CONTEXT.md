# Adeu Benchmark Suite: Technical Context & Architecture

This document serves as the long-term context file for developers and AI agents working on the `adeu-benchmark` repository. It records the core architecture, deterministic metric designs, known constraints, and critical patterns established across the suite.

---

## 1. Core Architecture & Paradigms

> [!NOTE]
> This benchmark focuses exclusively on multi-turn, agentic round-trip workflows. There are **no one-shot** workflows included in the suite.

The benchmark measures and compares two agentic document-editing paradigms on equal terms (same model, temperature, reps, and tokenizer settings) over standard stdio transport:

1. **`adeu`**: Projects the document to CriticMarkup and applies structured modification instructions using a multi-turn tool-calling loop against the `@adeu/mcp-server`.
2. **`safe-docx`**: Executes a stateful, multi-turn tool-calling loop against the `@usejunior/safe-docx` MCP server.

---

## 2. Key Metrics & Unified Deterministic Evaluation

All evaluation metrics are calculated dynamically at runtime using the unified `evaluateTrial(originalDoc, finalDoc, scenarioId)` pipeline. All trials across all four paradigms are evaluated under identical conditions to ensure consistency. Hardcoded or simulated metric assignments are forbidden.

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

### 2.3 Surgicality vs. Virtual DOM Normalization
While both `safe-docx` and `adeu` preserve identical visual fidelity (100% score), their structural impact on raw XML differs:
*   **Surgical Node Replacements**: Localized text-replacement actions (e.g. `safe-docx` block-level replacements) mutate very few XML characters (low `xmlDelta`).
*   **Virtual DOM Serialization**: Models modifying the complete virtual DOM hierarchy (e.g. `adeu`) can incur higher `xmlDelta` values due to element/attribute ordering normalization, even when the visual output remains identical.

---

## 3. Schema & Integration Constraints

### 3.1 Generic Schema Flattening for Google Gemini
Google Gemini has strict rules regarding the parameters schema of its registered tools:
*   **Uppercase Enums**: Schema types must match uppercase strings (e.g. `SchemaType.OBJECT` = `"OBJECT"`, `SchemaType.ARRAY` = `"ARRAY"`). Providing lowercase `"object"` or `"array"` triggers immediate serialization or API validation failures.
*   **Flattening Unions**: Gemini does not natively support complex JSON schema unions (`anyOf` or `oneOf` blocks) inside tool definitions.
*   **Dynamic Cleanup (`cleanSchema`)**: Tool schemas extracted from third-party MCP servers are dynamically transformed into flat, single-type property schemas without relying on hardcoded pattern-matching or fossil schema definitions.

### 3.2 Token Breakdown and Loop Overhead
To make an honest architectural comparison with multi-turn loops, `safe-docx` token metrics are broken down per turn into:
*   `schemaTokens`: Portion used to re-transmit tool schemas.
*   `historyTokens`: Portion used to re-transmit conversation history.
*   `newContentTokens`: Real document-handling output and execution content.
Both **Total Tokens** and the **`newContentTokens` floor** are reported to distinguish platform overhead from core document handling.

### 3.3 Unified Loop Turn Limit
Both the `safe-docx` and `adeu` agentic loops are governed by a unified execution ceiling of `MAX_TURNS = 20` conversational turns to eliminate execution biases.

### 3.4 Tool Call Observability
Multi-turn agent executions must report intermediate steps as single-line structured JSON objects rather than scattered stdout logs. This guarantees clean diagnostic paths for automated performance parsers.

### 3.5 Double-Serialization Boundary Failures
When designing tool schemas with complex nesting (such as arrays of object unions):
*   **Schema Enforcement**: APIs must strictly enforce leaf-level properties when possible, as LLMs frequently fallback to stringifying JSON within arrays (double-serialization).
*   **Defensive Parsing**: Downstream MCP tools or executors should implement defensive parsing to gracefully handle stringified JSON array parameters and prevent immediate runtime failures.

### 3.6 Automated Pre-Commit Safety & Cross-Platform Integrity
*   **Continuous Quality Guard (Husky)**: A pre-commit hook runs automated code formatting (`prettier`), linting (`eslint`), and type verification (`tsc --noEmit`) before any commit is accepted, preventing syntax or structural regressions from entering the branch.
*   **Deterministic Line Endings (`.gitattributes`)**: A workspace-wide Git attributes configuration forces LF (Unix) line endings for code, markdown, and configuration files. This eliminates line-ending conflicts across development environments while explicitly identifying `.docx` packages as binary files.