# docx-benchmark — Distillation TODO

Goal: live benchmark is the only thing; one MCP→Gemini schema path; clean JSON loop logging; one clear entry point. Fix the two fairness/correctness bugs while consolidating.

## Gates (decide before cutting)
- [ ] Keep the one-shot simple-edit path (raw-xml / markdown / one-shot adeu)? (recommend KEEP — it is the two-regime finding)
- [x] Delete `baselines.ts` + `index.ts` offline simulation outright? (recommend YES) (Staged index.ts and test suites for deletion)
- [ ] Cost column: publish it (fix pricing map) or drop it entirely? (no more `UNKNOWN`)
- [ ] Pin ONE model string for all runs (stop drifting 2.5 → 3.5 flash)

## Correctness / fairness bugs (do regardless of cleanup)
- [ ] **Unify MAX_TURNS across loops** — Adeu 15 vs SafeDocx 8 is an unfair invariant violation. One constant; report cap-hit rate.
- [ ] **Fix always-PASS xmlIntegrity** — loops set `xmlIntegrity="PASS"` the moment a buffer loads. Make it a real check: doc parses independently AND actually changed.
- [ ] **Honest token split** — `schemaTokens/historyTokens/newContentTokens` is an estimated subtraction, not a measurement. Either compute per-turn `countTokens` properly OR label it "estimated" in METHODOLOGY.
- [ ] **Single `evaluateTrial(originalDoc, finalDoc, scenario)`** returning `{success, fidelity, xmlDelta, integrity}` — used by BOTH loop and one-shot paths (kills the two success-eval routes).

## Point 1 — one schema path
- [ ] Strip `cleanSchema` to a generic MCP→Gemini normalizer (uppercase types, flatten anyOf/oneOf, default items for untyped arrays)
- [ ] Delete `ChangesItemsSchema` constant + the `if (description.includes("List of changes"))` hack (fossil — real schema now comes from `@adeu/mcp-server` via `listTools()`)
- [ ] Confirm single path: `listTools()` → `cleanSchema` → Gemini, for both servers
- [ ] Keep zod `AdeuOutputSchema` only if one-shot adeu path stays; else delete

## Point 2 — clean JSON loop logging
- [ ] Replace inline `[MCP TOOL CALL] ... Result: ${JSON.stringify(toolResult)}` prose dumps with ONE structured per-turn JSON line: `{turn, paradigm, tool, args, ok, resultBytes, elapsedMs}`
- [ ] Truncate/omit full result bodies by default; gate full dump behind `--verbose`
- [ ] Factor the two near-identical `executeTool` bodies into one `makeMcpToolExecutor(client, tools, tempPath, {forceSaveOverwrite})`
- [ ] Fold per-turn loop logs into the same structured line (drop scattered ANSI console.logs)

## Point 3 — live = the access point
- [ ] Delete the "backwards compatible exports" re-export block in `live.ts`
- [ ] Extract the inline one-shot path into `runOneShot(paradigm, scenario, doc, ...)`
- [ ] Slim `runLiveBenchmark` to: docSize → scenario → paradigm → reps → dispatch (loop | one-shot) → collect
- [ ] Move `XML_SYSTEM_PROMPT` / `ADEU_SYSTEM_PROMPT` next to paradigms; move `getGoldenDocxPath` to small `paths.ts`

## Deletions (no real loss)
- [x] `scratch_dump.js` (root)
- [x] `src/scripts/test-safe-docx.ts` (superseded by `loops.ts`)
- [x] `src/scripts/dump-text.ts`
- [/] `baselines.ts` + `index.ts` + their tests (index.ts/index.test.ts/baselines.test.ts deleted; baselines.ts pending helper relocation)
- [ ] Keep `scripts/inspect-golden.ts`, `scripts/generate-large.ts` (still useful)

## Test file collapse (989 → ~250)
- [ ] Drop "focused utility" micro-tests (lenient-spaces, missing-SEARCH, locale-format, verbose-description)
- [ ] Keep ~4 real invariants only: forbidden-literal (F1), success-discriminates (F6), token-summing (F4), breakdown-sums-to-total (TEST-C)
- [ ] Drop the anti-agent-cheating ratchet tests (F2/F5/F7/F8/F9, TEST-A/B) — threat is gone
- [ ] Update remaining tests to import from real modules (not the deleted live.ts re-exports)

## Docs
- [ ] Update METHODOLOGY: honest token-split label, unified MAX_TURNS + cap-hit, real xmlIntegrity definition
- [ ] Update AI_CONTEXT.md to match distilled architecture
- [ ] README: confirm pinned model, two-regime framing stays

## Verify
- [ ] `npm run build && npm run lint && npm run test` green
- [ ] `npm run benchmark:live -- --quick` on the pinned model, clean JSON logs, no UNKNOWN cost, terminates cleanly

## Target
~3,450 → ~1,400 lines; test file 989 → ~250; one schema path, one logger, one entry point.
