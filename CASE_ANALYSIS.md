# adeu vs safe-docx: .docx-Editing Benchmark Analysis
*Same model (gemini-3.5-flash), `--think-aloud`, 5 scenarios*

## 1. Per-Scenario Verdicts

| Scenario | Winner | Core reason (one line) |
|---|---|---|
| **form-fill** | **safe-docx** | Both PASS, but id-scoped `replace_text` hit all 11 placeholders first-try while adeu's literal-anchor batch broke on bold-wrapped `$[___]` → 40% faster, ~6.5x less reasoning, cleaner 1:1 redlines. |
| **party-swap** | **safe-docx** | adeu made every edit *correctly* in temp but burned its 80-step budget fighting the batch linter on duplicate signature blocks and **never called `complete_task`** → graded as unchanged original. FAIL. |
| **policy-checklist-review** | **safe-docx** | Both PASS; id-based `add_comment` placed 3 comments in 18 steps vs adeu's 46 steps of anchor-hunting + a `modify` op that shredded sentences and duplicated comments ~9x. |
| **playbook-commenting** | **adeu** | adeu's atomic "insert tracked change + comment" batch did it in 14 steps / 142k tok with a faithful redline; safe-docx took 24 steps / 336k tok, *deleted the counterparty's insertion*, and lost its own reply comment. |
| **multi-file-assembly** | **adeu** | Both scored PASS, but safe-docx's PASS is a **false positive**: it overwrote the CSA with DPA bytes (byte-identical files). adeu produced two correct distinct outputs via separate `*_processed.docx` filenames + read-back. |

**Tally:** safe-docx wins 3 (form-fill, party-swap, policy-checklist), adeu wins 2 (playbook-commenting, multi-file-assembly) — but adeu's two wins expose *correctness* failures in safe-docx, while safe-docx's three wins are largely *efficiency* wins on tasks where both were functionally correct.

## 2. Cross-Cutting Patterns: Tool Primitives → Task Fit

The entire benchmark turns on **how each MCP addresses an edit location**:

- **safe-docx** exposes `grep` + `replace_text` + `add_comment`, all addressed by a **stable `target_paragraph_id`** (`_bk_…`) with `old_string`/`new_string`. The paragraph id is resolved *before* string matching, so run/run-boundary fragmentation is invisible to the model.
- **adeu** exposes `read_docx` (with `search_query` probing) + a single `process_document_batch` that matches on **literal `target_text` against run-fragmented XML**, guarded by a linter (no cross-paragraph spans with body text on both sides; **global-uniqueness / "unique-match"** requirement).

This produces a clean three-way mapping of strategy to task type:

**(a) Consistent search-replace (form-fill, party-swap, multi-file value propagation).**
This is exactly where id-scoped `replace_text` dominates *per-edit robustness*. In form-fill, "the paragraph-id-scoped replace_text resolved placeholders directly without needing to discover run boundaries, so no dry-runs or retries were needed" — all 11 succeeded first try, including the `$[_____________]` cap that forced adeu into "~3 wasted dry-run cycles." adeu's literal-anchor batch "matches on literal target_text against the document's run-fragmented XML, so bold/italic run boundaries around placeholders … broke its anchors." **However**, safe-docx's per-field overwrite model is *fragile to file targeting*: in multi-file-assembly its two saves "resolved to a colliding/mis-captured primary slot," delivering the DPA twice. adeu's batch + distinct `*_processed.docx` naming + read-back was robust there.

**(b) In-place redline / comment review (policy-checklist, playbook-commenting).**
Two different sub-cases:
- *Pure commenting* (policy-checklist): safe-docx's dedicated `add_comment(target_paragraph_id, anchor_text)` is the natural primitive — "three findings, three calls, done." adeu has **no comment-only primitive**; it had to route comments through `process_document_batch` `modify` ops, which "shredded the target sentences into many fragments with the same comment duplicated on each."
- *Coupled redline+comment* (playbook-commenting): here adeu's single batch that "couples 'insert tracked change + attach comment' into one atomic, dry-runnable operation" *wins*, because safe-docx must split it across `add_comment` + `replace_text` + a thick inspection layer (`has_tracked_changes` x2, `extract_revisions` x2) — 2x steps, 2.4x tokens, and worse fidelity.

**(c) Multi-file find-and-place (multi-file-assembly).**
adeu's design (batch mutation + tracked changes + **separate output filenames** + post-save re-read) is structurally robust to multi-file targeting. safe-docx's "per-field overwrite-in-place design is fragile to it" — it saved both docs over identically-named working files in one shared session workspace and never verified.

**Net pattern:** id-addressing wins the *matching* problem (tasks a, b-comment); atomic-batch + dry-run + distinct-output wins the *coordination/safety* problem (tasks b-coupled, c). The tools are mirror images: safe-docx is robust where adeu is brittle (run fragmentation) and brittle where adeu is robust (file targeting, atomic redline+comment).

## 3. Systematic Strengths & Weaknesses

### adeu (`read_docx` + `process_document_batch`)
**Strengths**
- **Atomic, dry-runnable batches.** `dry_run` repeatedly let it discover constraints cheaply and route around them — e.g. in playbook-commenting it hit "Modification targets an active insertion from another author … Accept that change first," then "pivoted instead of calling accept_all_changes," appending its own insertion and leaving the supplier's change intact (the more faithful artifact).
- **Coupled redline+comment** in one call — the decisive edge in playbook-commenting (14 vs 24 steps, 142k vs 336k tok).
- **Multi-file safety discipline:** distinct `*_processed.docx` outputs + read-back verification → the only correct multi-file result.

**Weaknesses**
- **Literal-anchor fragility.** Run boundaries (bold/italic/markdown `**`, `_`, `(1)`) break `target_text`. form-fill: "bold-wrapped placeholder … word-splits in the diff engine." policy-checklist: anchor "contains tokenization-splitting punctuation ('_' or '-')."
- **Linter friction on duplicates.** party-swap: "Ambiguous match" + "spans a paragraph boundary" forced a placeholder-token-chaining campaign across 3 batches that consumed the entire budget.
- **No comment-only primitive** → `modify`-based commenting shreds text and duplicates notes (policy-checklist [Com:1] repeated ~9x; playbook [Com:2] duplicated).
- **High exploration overhead.** 13–17 `read_docx` calls before first edit in most scenarios; the costliest run overall (party-swap 3.73M tokIn).
- **Coarse, formatting-lossy redlines.** form-fill: multi-fragment deletions (del=25 vs 11) and *lost bold/italic* on the title-block name and signatory.

### safe-docx (`grep` + `replace_text` + `add_comment`)
**Strengths**
- **Robust id-scoped addressing** → near-zero retries. form-fill 11/11 first try; party-swap 10/10; policy-checklist 3/3. "Targeting by paragraph id sidesteps cross-paragraph ambiguity entirely."
- **Lean, linear paths** → consistently fewer steps and faster on functionally-equal tasks (form-fill 32 vs 46; policy-checklist 18 vs 46).
- **Cleaner 1:1 redlines** and better formatting fidelity in form-fill — preserved `**Acme Robotics, Inc.**` (bold) and `_John Carter_` (italic) that adeu dropped.

**Weaknesses**
- **Fragile file/output targeting.** multi-file-assembly: overwrote the CSA with DPA bytes (`diff -q` IDENTICAL), and `complete_task` "confidently claimed both docs were updated consistently" — the model never detected the corruption.
- **No atomic redline+comment**, and a tendency to **lose comments**: playbook-commenting "only ONE comment survived … the model never actually left a textual REPLY"; the same scenario it "DELETED the supplier's tracked insertion" (more destructive than adeu).
- **`replace_text` cannot match an empty string.** multi-file-assembly T52 `old_string:""` → `TEXT_NOT_FOUND`; the Customer signature date was never written (the dropped 20% fidelity dimension).
- **Token-heavy on whole-doc reads.** multi-file-assembly tokIn 2.94M (run-high, ~2.1x adeu) from repeated TOON-format full-document reads + per-field round-trips — and still wrong.
- **Inspection-scaffolding bloat** in redline tasks (playbook: `has_tracked_changes` x2, `extract_revisions` x2).

## 4. Correctness Anomalies Worth Flagging

1. **adeu's terminal submission omission (party-swap, FAIL).** Every edit was correct in temp — "T76/78/80 read_docx for Stark/Pym/Anthony all return 'No match found'" — but adeu "never issued the mandatory complete_task," spending its last steps on "redundant 'search … again' verifications" until the cap. The harness grades only submitted work, so the graded artifact was the unchanged original (ins=0/del=0). *This is a process failure, not an editing failure, and is the most consequential anomaly for adeu.* Directly contradicts `loops.ts:160`: "Writing a final message in plain text will NOT complete the task."

2. **safe-docx wrong-file / lost-content corruption (multi-file-assembly, false-positive PASS).** The CSA output is **byte-identical to the DPA** (both 24227 chars). "The real CSA content (Order Form, Key Terms, two CSA signature blocks) was lost/overwritten with DPA content." It PASSes only because the DPA bytes occupying the CSA slot happen to contain "Wayne Enterprises" and "June 22, 2026." Fidelity correctly dropped to 80%. **This is the most serious correctness defect in the entire run** — silent destruction of a whole document the model never noticed.

3. **Edits left unaccepted (form-fill).** BOTH docs were left as **unaccepted tracked changes**; the "adeu clean / safe-docx unaccepted" headline actually reflects ins/del counts, not an acceptance step. adeu "did NOT run accept_all_changes in this trial." It passes only because the success checker reads the finalized/accepted view via `DocumentMapper(doc, true)`.

4. **Missing edit sites.** safe-docx's `replace_text` empty-string limitation left the Customer signature date blank in multi-file-assembly (the dropped dimension).

5. **Fidelity / redline-quality drops.**
   - adeu lost **bold/italic formatting** on form-fill's title-block name and signatory (safe-docx preserved both).
   - adeu's `modify`-based comments **duplicated** the same note many times (policy-checklist ~9x; playbook 2–3x) and shredded body text into fragment runs.
   - safe-docx, conversely, was **more destructive to others' content** in playbook-commenting (deleted the supplier's insertion) and **lost its own reply comment** — passing on a lenient predicate that "does not require the comment to be the reviewer's reply."

6. **Two scoring blind spots exposed.** multi-file-assembly success never asserts the CSA slot *contains CSA content* (only that the strings appear), and playbook-commenting passes on `hasCommentsPart` regardless of whether the surviving comment is the reviewer's. Both let a substantively wrong/weak artifact pass.

## 5. Bottom Line — Which Tool for Which Work

- **High-volume, single-file find-and-replace / form-filling and per-paragraph commenting → safe-docx.** Its id-scoped `replace_text` / `add_comment` are immune to the run-fragmentation that repeatedly stalls adeu, yielding fewer steps, lower tokens, and cleaner, more formatting-faithful 1:1 redlines (form-fill, policy-checklist, party-swap-the-edits).

- **Coupled redline-plus-comment review, and any multi-file assembly → adeu.** Its atomic, dry-runnable batch is the right primitive for "propose a change *and* explain it" (playbook-commenting: faster, cheaper, more faithful, non-destructive to the counterparty), and its distinct-output-filename + read-back discipline is the only design that survived multi-file targeting without silently corrupting a document.

- **The two decisive caveats are operational, not algorithmic:**
  - adeu must reliably call `complete_task` — its party-swap loss was a perfect edit campaign thrown away by never submitting. Its other recurring tax is literal-anchor/linter friction on formatted or duplicated text.
  - safe-docx must guard file/output targeting and stop losing comments/insertions — its multi-file "win" was a corrupted DPA-as-CSA, and it twice discarded review content (playbook reply comment; multi-file signature date).

**One-line summary:** safe-docx is the better *per-edit* engine (robust matching, clean redlines, efficient) and the default for single-file edit/comment work; adeu is the better *workflow* engine (atomic redline+comment, dry-run safety, multi-file output isolation) but is undermined by literal-anchor fragility and, critically, by skipping the mandatory submission step.

---
*All claims above are grounded in the supplied per-scenario findings; no external files were read for this analysis.*
