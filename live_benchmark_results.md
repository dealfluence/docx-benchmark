# Live Provider Grounded Evaluation Report

This report outlines the **live, grounded performance and correctness metrics** evaluated across Gemini, Anthropic, and OpenAI providers without using LLM-as-a-judge.

## Provider: Gemini (gemini-3.5-flash)

| Scenario | Processing Paradigm | Latency (s) | Input Tokens | Output Tokens | Exact Cost | Syntax Valid | Edit Correct | Structural Integrity | Fidelity Score |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| surgical-correction | **Raw XML / Flat OPC** | 33.59s | 3,934 | 3,860 | $0.001453 | ❌ FAIL | ✅ PASS | ❌ FAIL | 0% |
| surgical-correction | **Naïve Markdown** | 1.82s | 133 | 1 | $0.000010 | ✅ PASS | ✅ PASS | ✅ PASS | 30% |
| surgical-correction | **Adeu Virtual DOM** | 2.22s | 521 | 42 | $0.000052 | ✅ PASS | ✅ PASS | ✅ PASS | 100% |
| clause-drafting | **Raw XML / Flat OPC** | 29.09s | 3,962 | 4,016 | $0.001502 | ❌ FAIL | ❌ FAIL | ❌ FAIL | 0% |
| clause-drafting | **Naïve Markdown** | 2.65s | 161 | 25 | $0.000020 | ✅ PASS | ✅ PASS | ✅ PASS | 30% |
| clause-drafting | **Adeu Virtual DOM** | 2.55s | 549 | 76 | $0.000064 | ✅ PASS | ✅ PASS | ✅ PASS | 100% |
| negotiation-cleanup | **Raw XML / Flat OPC** | 30.78s | 3,930 | 3,805 | $0.001436 | ✅ PASS | ✅ PASS | ✅ PASS | 100% |
| negotiation-cleanup | **Naïve Markdown** | 2.96s | 129 | 16 | $0.000014 | ✅ PASS | ✅ PASS | ✅ PASS | 30% |
| negotiation-cleanup | **Adeu Virtual DOM** | 2.33s | 530 | 36 | $0.000051 | ✅ PASS | ✅ PASS | ✅ PASS | 100% |

