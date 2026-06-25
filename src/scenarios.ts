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
  fixturePath: string;
}

export const scenarios: Scenario[] = [
  {
    id: "form-fill",
    name: "Form Fill (SAFE Deal Data)",
    description:
      "Populate the placeholders in the Post-Money SAFE template with this deal data: the Company Name is 'Acme Corporate Technologies, Inc.', the Investor Name is 'Jane Founder', and the Post-Money Valuation Cap is '$15,000,000'. Leave no unfilled placeholder remaining.",
    targetText: "",
    replacementText: "",
    isAgentic: true,
    fixturePath: "fixtures/ycombinator/post-money-safe.docx",
  },
  {
    id: "party-swap",
    name: "Contract Clone & Party Swap (Investment Agreement)",
    description:
      "Globally swap contracting party details throughout the Series Seed Investment Agreement: change every occurrence of the placeholder '[COMPANY NAME]' to 'Wayne Enterprises, Inc.' and every occurrence of '[PURCHASER NAME]' to 'Bruce Wayne'. The swap must be applied consistently at all of places, leaving no placeholder behind.",
    targetText: "",
    replacementText: "",
    isAgentic: true,
    fixturePath: "fixtures/series-seed/investment-agreement.docx",
  },
  {
    id: "policy-checklist-review",
    name: "Policy Checklist Review (CSA Analysis)",
    description:
      "Analyze the Cloud Service Agreement against a 3-point legal compliance checklist: (1) Governing Law, (2) Limitation of Liability cap, and (3) Standard Terms URL. Append the final results as a clean JSON review summary at the very end of the document using keys 'governingLaw', 'liabilityCap', and 'standardTermsLink'.",
    targetText: "",
    replacementText: "",
    isAgentic: true,
    fixturePath: "fixtures/common-paper/cloud-service-agreement.docx",
  },
  {
    id: "playbook-commenting",
    name: "Playbook-based Commenting (Late Payment Interest Cap)",
    description:
      "Review the Model Services Contract against a specific corporate playbook rule: 'The interest rate for late payments must not refer to statutory rates under the Late Payment of Commercial Debts Act 1998. It must be explicitly capped at 2.0% above the Bank of England base rate per annum.' Locate the non-conforming late payment interest reference in the contract and insert an OOXML margin comment anchored to that text run containing the playbook feedback.",
    targetText: "",
    replacementText: "",
    isAgentic: true,
    fixturePath: "fixtures/uk-gov/model-services-contract.docx",
  },
  {
    id: "multi-file-assembly",
    name: "Multi-file Deal Assembly (Consistent CSA & DPA)",
    description:
      "Ensure cross-document consistency by propagating a synchronized set of variables ('Wayne Enterprises, Inc.' as Customer Name, and 'June 22, 2026' as Effective Date) across both the Cloud Service Agreement (CSA) and the Data Processing Agreement (DPA) in a single transactional run.",
    targetText: "",
    replacementText: "",
    isAgentic: true,
    fixturePath: "fixtures/common-paper/cloud-service-agreement.docx",
  },
];
