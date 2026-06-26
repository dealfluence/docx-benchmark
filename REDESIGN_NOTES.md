# Benchmark Case Redesign — Notes for Review

**Branch:** `case-redesign` (one commit attempted; see "Git / signing" below).
**Goal:** rework the 5 cases so each tests a clear document-handling capability with
data-grounded, robust success gates — fixing the drift you flagged ("not what I
originally aimed for").

> [!IMPORTANT]
> **The work is NOT committed.** `commit.gpgsign=true` requires a GPG passphrase
> that isn't available in this non-interactive session, so commits hang. I did
> **not** bypass signing (policy). Everything is in the working tree on the
> `case-redesign` branch — review with `git diff` / `git status`, then commit
> (signed) yourself. A ready commit message is at
> `…/scratchpad/commitmsg.txt` if useful.
>
> Separately, the **pre-commit hook hangs** in this environment because it runs
> the MCP-spawning live test (`npm run test` → the F4 test launches a real
> `@usejunior/safe-docx` server). All gates were verified manually instead:
> `prettier` ✓, `eslint` ✓, `tsc --noEmit` ✓, `vitest` (24 tests) ✓. You may want
> to drop the live test from the pre-commit hook.

---

## What changed at the framework level

- **`src/scenarios.ts`** — new `Scenario` schema. Dropped the legacy
  `targetText`/`replacementText`/`reviewAction` fields. Added:
  - `companionFiles?: string[]` — additional docs the model also edits.
  - `inputFiles?: string[]` — read-only data sources the model must consult.
  Both are copied into the per-trial session dir and named in the system prompt.
- **`src/loops.ts`** — `runToolLoop` now copies companion + input files into the
  session (replacing the hardcoded multi-file DPA special-case); `buildSystemPrompt`
  lists "primary (edit)", "additional to edit", and "input (read-only)" docs
  distinctly.
- **`src/live.ts`** — passes `scenario.companionFiles` / `scenario.inputFiles` to
  `runToolLoop`.
- **`src/reporting.ts`** — `getFullTaskDescription` simplified (description is now
  the complete instruction).
- **`src/success.ts`** — rewritten per case (below). Redline cases are scored on
  the reviewer's **ADDED** content only (text inside `{++insert++}` / `{>>comment<<}`),
  so the original body's vocabulary can't satisfy the check.

## Fixtures created (authored this session)

| File | How | Purpose |
|---|---|---|
| `fixtures/ycombinator/deal-data-sheet.docx` | python-docx | form-fill data source (covers EVERY SAFE field) |
| `fixtures/series-seed/investment-agreement-executed.docx` | python-docx run-merge replace | party-swap: executed contract with real prior parties baked in |
| `fixtures/uk-gov/model-services-contract-redlined.docx` | adeu `process_document_batch` | playbook: seeded with a counterparty proposal (tracked change + comment) |
| `fixtures/common-paper/deal-intake-sheet.docx` | python-docx | multi-file data source (Customer + Effective Date) |

The original fixtures are untouched (`investment-agreement.docx`,
`model-services-contract.docx` remain as the clean source docs).

---

## Per-case redesign

### 1. form-fill
- **Was:** task supplied only 3 values but the gate required removing 2 `$[___]`
  blanks (only 1 had data) → under-specified, nondeterministic.
- **Now:** `deal-data-sheet.docx` supplies data for **every** SAFE placeholder
  (company, state, investor, purchase amount, valuation cap, date, governing law,
  signatory name + title). Task = read the sheet, fill all. Description does NOT
  contain the values — the model must read them.
- **Success:** all values present + no bracketed placeholders + no `$[_+]` blanks.

### 2. party-swap
- **Was:** started from `[COMPANY NAME]`-style placeholders, not a real contract.
- **Now:** `investment-agreement-executed.docx` has real prior parties baked in:
  Stark Industries, Inc. (×3), Pym Particle Ventures, L.P. (×2), Anthony Stark
  (×3), `anthony@starkindustries.com` (×2). Task = re-template onto Wayne
  Enterprises, Inc. / Fox Capital Partners, L.P. / Bruce Wayne (+ email domain).
- **Success:** ZERO leftover prior-party data (the realistic failure mode) AND new
  parties present at ≥ the original counts (3 / 2 / 3).

### 3. policy-checklist-review
- **Was:** appended an external JSON summary (brittle "last JSON block" parse;
  not really document editing).
- **Now:** redline + comment **in place** — no external output. Task = comment on
  the 3 checklist points (governing law, liability cap, standard terms).
- **Success:** comments and/or tracked changes present, and the reviewer's added
  content addresses all 3 points (governing-law flagged as blank/unspecified;
  liability/cap; standard terms / Common Paper).

### 4. playbook-commenting
- **Was:** only checked that *a* comment with keywords existed; didn't verify the
  reviewer engaged a counterparty position, and the keyword set was loose.
- **Now:** `model-services-contract-redlined.docx` is seeded with the Supplier's
  counterparty proposal on the late-payment clause (a tracked change pegging
  interest to "8% above base rate, or the statutory rate, whichever is higher"
  + a justifying comment). Task = review per the playbook (interest must be 2.0%
  above BoE base, not statutory).
- **Success:** comments still present AND the reviewer proposes the conforming
  **2%** cap (the seed contains "8%"/"base rate"/"statutory" but NOT "2%", so the
  2% proposal uniquely identifies the model's own review).

### 5. multi-file-assembly
- **Was:** values were embedded in the prompt; the model just typed them in.
- **Now:** `deal-intake-sheet.docx` is the data source. Task = find Customer name +
  Effective Date in the intake sheet and place them into BOTH the CSA and the DPA.
- **Success:** both CSA and DPA carry the customer name + effective date.

---

## Canonical data values (input docs ⇄ success gates kept in sync)

- **form-fill:** Acme Robotics, Inc. · Delaware · Vertex Seed Fund, L.P. ·
  $500,000 · $15,000,000 · June 22, 2026 · John Carter · Chief Executive Officer
- **party-swap:** Stark Industries, Inc.→Wayne Enterprises, Inc. ·
  Pym Particle Ventures, L.P.→Fox Capital Partners, L.P. · Anthony Stark→Bruce Wayne
- **multi-file:** Customer = Wayne Enterprises, Inc. · Effective Date = June 22, 2026

## Tests
- `scenarios.test.ts` updated (new fixture paths, companion/input declarations).
- `live.test.ts` F6 rewritten: pass+fail discrimination for form-fill, party-swap,
  multi-file; negative guards for policy & playbook (unreviewed fixtures must fail).
- Positive path for the two **redline** cases is validated by the **live run**
  (they need authentic OOXML comments/tracked changes that are impractical to
  synthesize in a unit test).

## Validation run (N=1, concurrency 10, gemini-3.5-flash) — clean, exit 0

| Case | adeu | safe-docx | Notes |
|---|---|---|---|
| form-fill | 🟢 | 🟢 | both read the data sheet (read_docx / read_file) and filled all fields |
| party-swap | 🔴 | 🟢 | adeu churned to the 40-turn cap (23 edits, 0 submits); safe-docx clean swap |
| policy-checklist-review | 🟢 | 🟢 | **positive path confirmed** — model comment: "Governing Law is not specified…" |
| playbook-commenting | 🟢 | 🟢 | **positive path confirmed** — model proposed "2.0% above the Bank of England base rate" (its own counter, not the 8% seed) |
| multi-file-assembly | 🔴 | 🟢 | adeu hit the turn cap; safe-docx propagated intake-sheet values to CSA + DPA |
| **Total** | **3/5** | **5/5** | N=1, noisy |

Harness verification (the point of the run):
- Input data sheets ARE consulted by the model (verified read calls on
  deal-data-sheet / deal-intake-sheet).
- The two redline scenarios' POSITIVE paths work and are legitimate (the model's
  added comments/edits — not the original body or the seed — satisfy the gates).
- The hard cases discriminate: party-swap and multi-file are genuinely failed by
  adeu (turn-cap, never submitted) while passed by safe-docx — i.e. the success
  gates are neither trivially-passable nor harness-broken.
- No exceptions / 429s; jsonl tail intact (flush fix holds).

## complete_task now enforced

`live.ts` now scores `success = loopRes.success && evalResult.success`. `loopRes.success`
is true only when the model explicitly called `complete_task` and passed the
validation gate, so a correct-but-never-submitted document no longer passes.
Verified: every `success=YES` row has `taskSubmits=1`; the lone failure
(adeu/party-swap, 40-turn cap) has `taskSubmits=0`.

## Output inspection switch

`BENCHMARK_KEEP_OUTPUTS=1 npm run benchmark:quick` copies each trial's final
document (and the DPA companion) to `results/outputs/<trialId>.docx` for manual
review (they are otherwise deleted).

## Document audit (N=1, outputs read back via @adeu/core)

All passing cases produced **correct** deliverables; the one failure was a genuinely
wrong+unsubmitted doc — no false positives.

- **form-fill** (adeu ✓, safe-docx ✓): all 8 values filled, zero leftover
  placeholders. NOTE: safe-docx applied the fills as **unaccepted tracked changes**
  (ins=11); adeu produced clean text (ins=0). Success scores the accepted view, so
  both pass — see the open design question below.
- **party-swap** (safe-docx ✓, adeu ✗): safe-docx = new parties present, zero old
  parties (applied as 10 tracked changes). adeu = document still entirely
  Stark/Pym/Anthony with no swap (hit turn cap, never submitted) → correct fail.
- **policy-checklist-review** (both ✓): three substantively correct comments each —
  governing law correctly flagged as an unfilled placeholder; General Cap identified
  as a 12-month-fees multiplier with the multiplier left blank; Standard Terms
  confirmed as Common Paper v2.1 (safe-docx cited the URL). Real legal review, not
  keyword gaming.
- **playbook-commenting** (both ✓): both redlined the counterparty's non-conforming
  "8%/statutory" proposal down to the conforming "2.0% above the Bank of England
  base rate"; the counterparty's original text remains as a visible tracked deletion.
- **multi-file-assembly** (both ✓): Customer name + Effective Date propagated into
  both the CSA and the DPA.

### Open design question (for your call)
For the **fill / swap / assembly** cases, success is scored on the *accepted* view,
so a tool that leaves all its edits as **unaccepted tracked changes** (as safe-docx
does) still passes. If the intended deliverable is a *clean finished document*,
success could additionally require no pending tracked changes for those scenarios
(while the **redline** cases — policy, playbook — should of course keep them).

## Base-integrity & size invariants (added)

Every scenario's success gate now also requires the output to still BE the original
document with the task applied on top, via `baseIntact(original, modified, anchors)`
in `success.ts`:
- **Size floor:** modified plain-text length >= 70% of the original's (`MIN_SIZE_RATIO`).
  Catches truncation / overwrite-with-a-smaller-doc.
- **Anchor presence:** distinctive original content the task must not remove:
  form-fill "Post-Money Valuation Cap"; party-swap "Series Seed Preferred Stock";
  policy & multi-file CSA "Order Form" + "Subscription Period" (both 0× in the DPA);
  playbook "the Authority" + "the Supplier"; multi-file DPA "Processor" (DPA-unique)
  plus a size floor vs the DPA fixture.

This directly closes the multi-file false positive: re-evaluating the last run's
preserved outputs, **safe-docx/multi-file flips PASS -> FAIL** (its CSA was
overwritten with DPA bytes — fails the "Order Form" anchor and the size floor),
while every legitimate pass is unchanged.

### Negotiation invariant (playbook) — counterparty comment must survive

Closes the CASE_ANALYSIS.md §4 blind spot. The playbook gate now also requires the
counterparty's comment to be PRESERVED in the output (review-on-top, not destructive
replacement): the seed comment authored "Supplier's Counsel" carries the distinctive
phrase "robust protection", which must still appear in the output's comment parts
(`rawCommentsText`). Rejecting their tracked *change* is fair negotiation; deleting
their *comment* now fails the case. Re-evaluating the last run, both tools preserved
it (no false-fail); a tool that discards the counterparty comment will now fail even
if it proposes the conforming 2% cap.

## Possible follow-ups
- `fidelity.ts` still has a dead `negotiation-cleanup` branch (no such scenario) —
  harmless, left as-is.
- Consider removing the live test from the pre-commit hook (it hangs / is slow).
- README "Scenarios Measured" section should be refreshed to describe these 5
  redesigned cases (currently describes the prior versions).
