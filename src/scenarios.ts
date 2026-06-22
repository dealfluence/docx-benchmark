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
    description: "Locate bracketed placeholders or blank fields for 'Company Name', 'Investor Name'/'Founder Name', and 'Valuation Cap' in the Post-Money SAFE template and populate them with specific deal data: Company Name is 'Acme Corporate Technologies, Inc.', Investor Name is 'Jane Founder', and Valuation Cap is '$15,000,000'.",
    targetText: "",
    replacementText: "",
    isAgentic: true,
    fixturePath: "fixtures/ycombinator/post-money-safe.docx",
  },
  {
    id: "party-swap",
    name: "Contract Clone & Party Swap (Investment Agreement)",
    description: "Globally swap contracting party details (change '[COMPANY NAME]' to 'Wayne Enterprises, Inc.' and '[PURCHASER NAME]' to 'Bruce Wayne') consistently throughout the Series Seed Investment Agreement, updating definitions and signature blocks.",
    targetText: "",
    replacementText: "",
    isAgentic: true,
    fixturePath: "fixtures/series-seed/investment-agreement.docx",
  },
  {
    id: "policy-checklist-review",
    name: "Policy Checklist Review (CSA Analysis)",
    description: "Analyze the Cloud Service Agreement against a 3-point legal compliance checklist: (1) Governing Law, (2) Limitation of Liability cap, and (3) Standard Terms URL. Append the final results as a clean JSON review summary at the very end of the document using keys 'governingLaw', 'liabilityCap', and 'standardTermsLink'.",
    targetText: "",
    replacementText: "",
    isAgentic: true,
    fixturePath: "fixtures/common-paper/cloud-service-agreement.docx",
  },
  {
    id: "playbook-commenting",
    name: "Playbook-based Commenting (Late Payment Interest Cap)",
    description: "Review the Cloud Service Agreement against a specific corporate playbook rule: 'Late payment interest cannot exceed 1.0% per month'. Locate the non-conforming late payment interest rate (which is currently 1.5% per month) and insert an OOXML margin comment anchored to that text run containing the playbook feedback.",
    targetText: "",
    replacementText: "",
    isAgentic: true,
    fixturePath: "fixtures/common-paper/cloud-service-agreement.docx",
  },
  {
    id: "multi-file-assembly",
    name: "Multi-file Deal Assembly (Consistent CSA & DPA)",
    description: "Ensure cross-document consistency by propagating a synchronized set of variables ('Wayne Enterprises, Inc.' as Customer Name, and 'June 22, 2026' as Effective Date) across both the Cloud Service Agreement (CSA) and the Data Processing Agreement (DPA) in a single transactional run.",
    targetText: "",
    replacementText: "",
    isAgentic: true,
    fixturePath: "fixtures/common-paper/cloud-service-agreement.docx",
  },
];
