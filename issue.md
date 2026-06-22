# RFC: Benchmark v2 — Real-world Legal Document Scenarios

## Motivation

Current scenarios test isolated editing operations on a synthetic document. We need realistic end-to-end workflows using openly-licensed legal documents that reflect actual in-house legal work.

## Target Scenarios

### 1. Form Fill
Populate a template .docx with company/deal data (name, address, registration number, dates, amounts). Tests bulk placeholder replacement + field logic.

### 2. Contract Clone & Party Swap
Copy an executed agreement and swap all party-specific details (names, addresses, signatories, defined terms) to create a new agreement for a different client. Tests whole-document contextual awareness.

### 3. Policy Checklist Review
Read a contract draft and verify N items from a compliance checklist (e.g., GDPR DPA requirements, liability caps, termination notice periods). Report gaps/issues. Tests reasoning + read-only analysis.

### 4. Playbook-based Commenting
Read counterparty's draft and add comments based on own company's negotiation playbook (e.g., "our standard is 30 days, this says 90", "missing IP assignment clause"). Tests multi-step reasoning + comment insertion.

### 5. Multi-file Deal Assembly
Contracts often span multiple .docx files (MSA + DPA + SLA + SOW + Order Form). Test cross-document awareness: e.g., verify DPA references match MSA definitions, or populate SOW from MSA terms.

## Complex DOCX Patterns to Stress-Test

These are hypothesized differentiators between good and bad implementations:

| Pattern | Why it's hard |
|---------|--------------|
| **Footnotes / Endnotes** | Content lives in separate XML part; edits must target correct part |
| **Cross-references** | Field codes (REF, PAGEREF) that auto-update; agents must understand linkage |
| **Automatic heading numbering** | List numbering XML (w:num) — inserting/deleting sections must maintain sequence |
| **Table of Contents** | Field-based TOC that references heading styles; structural edits invalidate it |
| **Nested tables** | Common in schedules/appendices; positional editing becomes ambiguous |
| **Content controls (SDTs)** | Structured data fields used in templates; different editing semantics |
| **Linked/embedded OLE objects** | Excel tables embedded in contracts |
| **Multi-level list numbering** | 1.1, 1.1.1, 1.2 — legal numbering schemes with complex w:abstractNum |
| **Section breaks** | Different headers/footers per section; landscape pages for schedules |
| **Tracked changes in footnotes** | Revisions inside footnotes/endnotes — compound complexity |
| **Bookmarks spanning runs** | Named ranges used for cross-refs that span multiple XML runs |
| **Custom XML parts** | Metadata/data bindings used by document automation systems |

## Open-Source Document Sources

### Primary (clear open licenses)

| Source | Content | License | URL |
|--------|---------|---------|-----|
| **Common Paper** | Cloud Agreement, NDA, SLA, DPA | CC BY 4.0 | https://github.com/CommonPaper/standard-agreements |
| **NVCA** | Model Legal Documents (NDA, Term Sheet, SPA, IRA, ROFR, Voting Agreement) | Free to use | https://nvca.org/model-legal-documents/ |
| **Y Combinator SAFE** | Simple Agreement for Future Equity | Free to use | https://www.ycombinator.com/documents |
| **Bonterms** | Cloud Terms, DPA, SLA (standardized SaaS) | CC BY 4.0 | https://bonterms.com/ |
| **Series Seed** | Preferred Stock Investment docs | Open | https://www.seriesseed.com/ |
| **Openlaw / DAOstack** | Smart contract legal wrappers | Various open | GitHub |

### Secondary (verify per-document)

| Source | Content | Notes |
|--------|---------|-------|
| **EU Model Clauses** | GDPR Standard Contractual Clauses | Official EU docs, public domain intent |
| **UK Gov** | Model contracts, procurement templates | Open Government Licence v3.0 |
| **World Bank** | Procurement docs (FIDIC-style) | Check per-doc |
| **Creative Commons** | CC license legal code as .docx | CC0 / CC BY |

### Multi-file Structures

- **Common Paper**: Core agreement + DPA module + SLA module (natural multi-file)
- **NVCA**: SPA + Disclosure Schedules + Side Letters + IRA + Voting Agreement (5+ docs per deal)
- **Bonterms**: Base Terms + Cloud Terms + DPA + Order Form

## License Compatibility

Target repo license: **AGPL-3.0-only**

- CC BY 4.0 documents: ✅ Compatible (attribution required, include notice)
- CC0 documents: ✅ Compatible
- "Free to use" (NVCA/YC): ✅ Compatible for test fixtures (not derivative works of the docs themselves — they're test inputs)
- Open Government Licence v3: ✅ Compatible

## Proposed Structure

```
fixtures/
  common-paper/
    cloud-agreement.docx
    dpa-module.docx
    sla-module.docx
    LICENSE-CC-BY-4.0
  nvca/
    model-nda.docx
    term-sheet.docx
    LICENSE
  templates/
    form-fill-template.docx    # with {{placeholders}}
    playbook.json              # negotiation rules
    policy-checklist.json      # compliance checks
```

## Success Criteria

Each scenario needs:
1. **Input**: One or more .docx files + instruction context (playbook, checklist, data)
2. **Expected output**: Verifiable assertions (text present/absent, comments added, structure intact)
3. **Complexity tag**: Which DOCX patterns are exercised (footnotes, cross-refs, numbering, etc.)

## Next Steps

- [ ] Download and audit licenses for Common Paper + Bonterms + NVCA docs
- [ ] Identify which documents exercise which complex patterns naturally
- [ ] Design 4-5 scenarios per workflow type
- [ ] Implement multi-file harness in benchmark runner
- [ ] Add complexity pattern tags to scoring matrix
