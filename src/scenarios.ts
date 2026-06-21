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
      "A contract where a corporate party name needs to be updated. Tests the capability to perform highly targeted search-and-replace edits.",
    targetText: "NordicTech",
    replacementText: "NordicGlobal",
  },
  {
    id: "clause-drafting",
    name: "Clause Drafting (Section Insertion)",
    description:
      "Inserting a structured data protection clause at the end of the General Provisions section. Measures formatting inheritance and layout consistency.",
    targetText:
      "8.3 Entire Agreement.\n\nThis Agreement is the entire agreement between Provider and Customer regarding Customer’s use of Services and supersedes all prior and contemporaneous agreements, proposals or representations, written or oral, concerning its subject matter.",
    replacementText:
      "8.3 Entire Agreement.\n\nThis Agreement is the entire agreement between Provider and Customer regarding Customer’s use of Services and supersedes all prior and contemporaneous agreements, proposals or representations, written or oral, concerning its subject matter.\n\n8.4 Data Protection.\n\nEach party shall comply with all applicable data protection laws.",
  },
  {
    id: "negotiation-cleanup",
    name: "Negotiation Cleanup (Track Changes Accept)",
    description:
      "Accepting an existing tracked revision in the document. Demonstrates whether the paradigm can cleanly execute review operations on native XML nodes.",
    targetText: "",
    replacementText: "",
    reviewAction: {
      type: "accept",
      targetId: "Chg:2",
    },
  },
  {
    id: "bulk-rewrite",
    name: "Bulk Rewrite (Clause/Section Replacement)",
    description:
      "Replacing an entire clause with a rewritten standard. Evaluates cost advantages of surgical patching vs full re-emission when block changes are larger.",
    targetText:
      "If any invoiced amount is not received by Provider by the due date, then without limiting Provider’s rights or remedies, those charges may accrue late interest at the rate of 1.5% of the outstanding balance per month, or the maximum rate permitted by law, whichever is lower.",
    replacementText:
      "Late payments shall accrue interest at the rate of 1.0% per month on any outstanding balance.",
  },
  {
    id: "whole-document-restyle",
    name: "Whole Document Restyle (Capitalization / Global Change)",
    description:
      "Capitalizing section titles globally throughout the contract to check formatting consistency on multiple targets.",
    targetText: "Governing Law",
    replacementText: "GOVERNING LAW",
  },
  {
    id: "no-op",
    name: "No-Op / Already Correct (Robustness Test)",
    description:
      "Instructing the model to edit a term that does not exist in the contract. Correct behavior is to perform zero modifications, verifying resistance to hallucination.",
    targetText: "NonExistentWord",
    replacementText: "ShouldNotBeInserted",
  },
  {
    id: "conditional-edit",
    name: "Conditional Clause Insertion (State Venue)",
    description:
      "Inspect the Governing Law and Venue clause in Section 8.1. If the governing law is California, append the sentence: 'The parties irrevocably submit to the jurisdiction of California courts.' If any other state, do nothing.",
    targetText: "",
    replacementText: "",
    isAgentic: true,
  },
  {
    id: "dependent-multi-target",
    name: "Dependent Multi-Target (Section Renumbering)",
    description:
      "Insert a new Section 2.2 'Feedback' allowing Provider to use Customer suggestions. Renumber the subsequent sections in Article 2 (original 2.2 'Customer Data' becomes 2.3, and original 2.3 'Data Usage Rights' becomes 2.4). Also, update the cross-reference inside the newly-renumbered Section 2.4 to point to Section 2.3 instead of Section 2.2 (it currently says 'Notwithstanding Section 2.2').",
    targetText: "",
    replacementText: "",
    isAgentic: true,
  },
  {
    id: "selective-verify-and-repair",
    name: "Selective Verify and Repair (Indemnity Exemption)",
    description:
      "Accept all tracked changes in the document, EXCEPT those in Section 5.2 (Indemnification by Provider) which must remain intact as tracked changes.",
    targetText: "",
    replacementText: "",
    isAgentic: true,
  },
  {
    id: "search-then-compute",
    name: "Search-then-Compute (Halve Interest Rate)",
    description:
      "Find the late interest percentage rate in Section 3.3, halve the numeric value, and replace the old rate with the new halved value (from 1.5% to 0.75%).",
    targetText: "",
    replacementText: "",
    isAgentic: true,
  },
];
