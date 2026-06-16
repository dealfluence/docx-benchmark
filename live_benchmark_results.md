# Live Provider Grounded Evaluation Report

This report outlines the **live, grounded performance and correctness metrics** evaluated across Gemini, Anthropic, and OpenAI providers without using LLM-as-a-judge.

## Provider: Gemini (gemini-3.5-flash)

| Scenario | Processing Paradigm | Latency (s) | Input Tokens | Output Tokens | Total Tokens | Syntax Valid | Edit Correct | Structural Integrity | Fidelity Score |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| surgical-correction | **Raw XML / Flat OPC** | 34.94s | 3,934 | 3,860 | 7,794 | ❌ FAIL | ✅ PASS | ❌ FAIL | 0% |
| surgical-correction | **Naïve Markdown** | 1.60s | 133 | 1 | 134 | ✅ PASS | ✅ PASS | ✅ PASS | 40% |
| surgical-correction | **Adeu Virtual DOM** | 2.16s | 521 | 42 | 563 | ✅ PASS | ✅ PASS | ✅ PASS | 100% |
| clause-drafting | **Raw XML / Flat OPC** | 28.68s | 3,962 | 4,016 | 7,978 | ❌ FAIL | ❌ FAIL | ❌ FAIL | 0% |
| clause-drafting | **Naïve Markdown** | 2.54s | 161 | 25 | 186 | ✅ PASS | ✅ PASS | ✅ PASS | 40% |
| clause-drafting | **Adeu Virtual DOM** | 2.47s | 549 | 76 | 625 | ✅ PASS | ✅ PASS | ✅ PASS | 100% |
| negotiation-cleanup | **Raw XML / Flat OPC** | 33.22s | 3,930 | 3,805 | 7,735 | ✅ PASS | ✅ PASS | ✅ PASS | 100% |
| negotiation-cleanup | **Naïve Markdown** | 2.88s | 129 | 16 | 145 | ✅ PASS | ✅ PASS | ✅ PASS | 60% |
| negotiation-cleanup | **Adeu Virtual DOM** | 2.38s | 530 | 36 | 566 | ✅ PASS | ✅ PASS | ✅ PASS | 100% |

