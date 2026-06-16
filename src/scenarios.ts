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
];
