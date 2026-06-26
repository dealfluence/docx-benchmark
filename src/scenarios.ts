export interface Scenario {
  id: string;
  name: string;
  /**
   * The full task instruction handed to the model. For scenarios that source
   * their data from an input document, this deliberately does NOT contain the
   * literal values — the model must read them from the `inputFiles`.
   */
  description: string;
  /** Primary document the model edits. */
  fixturePath: string;
  /**
   * Additional documents the model is also expected to edit (copied into the
   * session and named in the prompt). Example: the DPA in multi-file assembly.
   */
  companionFiles?: string[];
  /**
   * Read-only source documents the model must consult for data (copied into the
   * session and named in the prompt as inputs, not edit targets). Example: a
   * deal data sheet whose values must be transcribed into the contract.
   */
  inputFiles?: string[];
  isAgentic?: boolean;
}

export const scenarios: Scenario[] = [
  {
    id: "form-fill",
    name: "Form Fill (SAFE from Data Sheet)",
    description:
      "Complete the Post-Money SAFE template using ONLY the data provided in the accompanying deal data sheet. " +
      "Read the data sheet, then fill in every placeholder in the SAFE — the company name, state of incorporation, " +
      "investor name, purchase amount, post-money valuation cap, date, governing-law jurisdiction, and the company " +
      "signature block (signatory name and title) — with the matching value from the sheet. " +
      "Every bracketed placeholder and every blank ($[_____________]) must be replaced; leave nothing unfilled.",
    fixturePath: "fixtures/ycombinator/post-money-safe.docx",
    inputFiles: ["fixtures/ycombinator/deal-data-sheet.docx"],
    isAgentic: true,
  },
  {
    id: "party-swap",
    name: "Template Reuse & Party Swap (Executed Agreement)",
    description:
      "This executed Series Seed Investment Agreement is being reused as the template for a brand-new financing. " +
      "Replace every reference to the prior deal's parties with the new parties, consistently throughout the entire " +
      "document (defined terms, body, schedules/tables, signature blocks, and notice email addresses):\n" +
      "- Company: 'Stark Industries, Inc.' becomes 'Wayne Enterprises, Inc.'\n" +
      "- Lead investor: 'Pym Particle Ventures, L.P.' becomes 'Fox Capital Partners, L.P.'\n" +
      "- Key Holder / founder: 'Anthony Stark' becomes 'Bruce Wayne'\n" +
      "- Update the notice email address 'anthony@starkindustries.com' to 'bruce@wayne.enterprises'.\n" +
      "No trace of the prior parties may remain anywhere in the document — a single leftover reference is a failure.",
    fixturePath: "fixtures/series-seed/investment-agreement-executed.docx",
    isAgentic: true,
  },
  {
    id: "policy-checklist-review",
    name: "Policy Checklist Review (In-place Redline)",
    description:
      "Review this Cloud Service Agreement against a 3-point compliance checklist and record your findings DIRECTLY " +
      "in the document using margin comments and, where a fix is warranted, tracked-change edits. Do NOT produce any " +
      "separate file, summary, or appended text block — all findings must live as comments/redlines anchored to the " +
      "relevant clauses. The three checklist points are:\n" +
      "1. Governing Law — state whether a governing law is actually specified.\n" +
      "2. Limitation of Liability — identify the liability cap (the 'General Cap') mechanism and its amount.\n" +
      "3. Standard Terms — confirm the agreement incorporates the Common Paper Standard Terms.\n" +
      "Attach one comment per checklist point to the clause it concerns.",
    fixturePath: "fixtures/common-paper/cloud-service-agreement.docx",
    isAgentic: true,
  },
  {
    id: "playbook-commenting",
    name: "Playbook Review of Counterparty Redlines",
    description:
      "The Supplier's counsel has returned this Model Services Contract with proposed redlines and margin comments " +
      "(tracked changes already present in the document). Review their proposals against our negotiation playbook rule:\n" +
      "'Interest on late payments must NOT rely on the statutory rate under the Late Payment of Commercial Debts " +
      "(Interest) Act 1998. It must be explicitly capped at 2.0% above the Bank of England base rate per annum.'\n" +
      "Find the late-payment interest clause and the counterparty's proposal affecting it. Where it violates the " +
      "playbook, respond using margin comments and tracked-change edits: flag the non-conforming statutory-rate basis " +
      "and propose conforming wording (2.0% above the Bank of England base rate). Preserve the counterparty's existing " +
      "tracked changes and comments — add your review on top of them, do not discard them.",
    fixturePath: "fixtures/uk-gov/model-services-contract-redlined.docx",
    isAgentic: true,
  },
  {
    id: "multi-file-assembly",
    name: "Multi-file Deal Assembly (from Intake Sheet)",
    description:
      "A deal intake sheet accompanies this task. Read it to obtain the deal variables, then propagate those values " +
      "consistently into BOTH the Cloud Service Agreement (the primary document) AND the companion Data Processing " +
      "Agreement 'dpa-module.docx': set the Customer name and the Effective Date wherever they belong in each document. " +
      "Both documents must end up carrying the same Customer name and Effective Date taken from the intake sheet. " +
      "Save both documents.",
    fixturePath: "fixtures/common-paper/cloud-service-agreement.docx",
    companionFiles: ["fixtures/common-paper/dpa-module.docx"],
    inputFiles: ["fixtures/common-paper/deal-intake-sheet.docx"],
    isAgentic: true,
  },
];
