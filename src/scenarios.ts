export interface Scenario {
  id: string;
  name: string;
  description: string;
  targetText: string;
  replacementText: string;
  comment?: string;
  reviewAction?: {
    type: "accept" | "reject" | "reply";
    targetId: string;
    payload?: string;
  };
  isAgentic?: boolean;
}

export const scenarios: Scenario[] = [
  {
    id: "surgical-correction",
    name: "Surgical Correction (Terminology Update)",
    description:
      "A 20-page document where a single word needs to be updated. Shows the massive advantage of Adeu's surgical JSON output over full-document XML/Markdown re-emission.",
    targetText: "Seller",
    replacementText: "Vendor",
  },
  {
    id: "clause-drafting",
    name: "Clause Drafting (Section Insertion)",
    description:
      "Inserting a structured 3-paragraph clause including a new Heading 2. Measures formatting inheritance and paragraph-break tracking.",
    targetText: "## 8. Governing Law",
    replacementText:
      "## 8. Governing Law\n\n## 9. Data Protection\n\nEach party shall comply with all applicable data protection laws...",
  },
  {
    id: "negotiation-cleanup",
    name: "Negotiation Cleanup (Track Changes Accept)",
    description:
      "Finalizing an existing tracked change. Demonstrates that alternative baselines cannot natively execute review operations without completely breaking XML references.",
    targetText: "",
    replacementText: "",
    reviewAction: {
      type: "accept",
      targetId: "Chg:12",
    },
  },
  {
    id: "bulk-rewrite",
    name: "Bulk Rewrite (Clause/Section Replacement)",
    description:
      "Rewriting an entire multi-paragraph section. In this scenario, the output-token advantages of surgical patching vs full re-emission are minimized, testing the paradigm boundaries.",
    targetText: "Typing some. Typing some text",
    replacementText: "This agreement is drafted to establish the terms of service.",
  },
  {
    id: "whole-document-restyle",
    name: "Whole Document Restyle (Capitalization / Global Change)",
    description:
      "A global change touching document elements. Tests cases where the patch size is equal to or larger than full re-emission.",
    targetText: "Governing Law",
    replacementText: "GOVERNING LAW",
  },
  {
    id: "no-op",
    name: "No-Op / Already Correct (Robustness Test)",
    description:
      "Instructs the model to modify a term that does not exist in the document. Correct behavior is to perform no edits, testing robustness against hallucinated edits.",
    targetText: "NonExistentWord",
    replacementText: "ShouldNotBeInserted",
  },
  {
    id: "conditional-edit",
    name: "Conditional Clause Insertion (US vs State)",
    description:
      "Observe Governing Law (Section 8 / Heading 8). If the section has no text or does not specify a state, assume the US state is New York, write that the governing law is New York, and append a New York state venue clause. If a country, append an arbitration clause.",
    targetText: "",
    replacementText: "",
    isAgentic: true,
  },
  {
    id: "dependent-multi-target",
    name: "Dependent Multi-Target (Section Renumbering)",
    description:
      "Insert Section 5 Confidentiality, renumber subsequent sections, and update cross-reference in Section 8 (Notices) to point to shifted Section 6.",
    targetText: "",
    replacementText: "",
    isAgentic: true,
  },
  {
    id: "selective-verify-and-repair",
    name: "Selective Verify and Repair (Indemnity Exemption)",
    description:
      "Accept all tracked changes in the document, except those in Section 6 (Indemnity).",
    targetText: "",
    replacementText: "",
    isAgentic: true,
  },
  {
    id: "search-then-compute",
    name: "Search-then-Compute (Halve Liability Cap)",
    description:
      "Find the liability cap value in Section 5, halve the amount, and replace the old cap with the new halved value.",
    targetText: "",
    replacementText: "",
    isAgentic: true,
  },
];
