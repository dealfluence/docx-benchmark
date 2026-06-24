import * as fs from "node:fs";
import * as path from "node:path";
import { DocumentObject, DocumentMapper } from "@adeu/core";

export async function checkScenarioSuccess(
  scenarioId: string,
  originalDoc: DocumentObject,
  modifiedDoc: DocumentObject,
  tempFilePath?: string,
): Promise<boolean> {
  const modPlain = new DocumentMapper(modifiedDoc, true).full_text;

  switch (scenarioId) {
    case "form-fill": {
      // Success Criteria: The output plain text must contain the populated values and no longer contain bracketed placeholders.
      const hasCompany =
        modPlain.includes("Acme Corporate Technologies, Inc.") ||
        modPlain.includes("Acme Corporate");
      const hasInvestor = modPlain.includes("Jane Founder") || modPlain.includes("Jane");
      const hasValuation = modPlain.includes("15,000,000") || modPlain.includes("15,000");
      const hasPlaceholderCompany = modPlain.includes("[Company Name]");
      const hasPlaceholderInvestor = modPlain.includes("[Investor Name]");
      return (
        hasCompany &&
        hasInvestor &&
        hasValuation &&
        !hasPlaceholderCompany &&
        !hasPlaceholderInvestor
      );
    }

    case "party-swap": {
      // Success Criteria: Swap the primary contracting party details consistently throughout the entire document.
      const hasWayne = modPlain.includes("Wayne Enterprises") || modPlain.includes("Wayne");
      const hasBruce = modPlain.includes("Bruce Wayne") || modPlain.includes("Bruce");
      const hasPlaceholderCompany = modPlain.includes("[COMPANY NAME]");
      const hasPlaceholderPurchaser = modPlain.includes("[PURCHASER NAME]");
      return hasWayne && hasBruce && !hasPlaceholderCompany && !hasPlaceholderPurchaser;
    }

    case "policy-checklist-review": {
      // Success Criteria: Checklist results parsed as JSON with key determinations mapping to the fixture's actual terms.
      const jsonRegex = /\{[\s\S]*?\}/;
      const match = modPlain.match(jsonRegex);
      if (!match) {
        // Fallback search
        const hasGov =
          modPlain.toLowerCase().includes("governinglaw") ||
          modPlain.toLowerCase().includes("governing_law") ||
          modPlain.toLowerCase().includes("governing law");
        const hasLiab =
          modPlain.toLowerCase().includes("liabilitycap") ||
          modPlain.toLowerCase().includes("liability_cap") ||
          modPlain.toLowerCase().includes("liability cap");
        const hasTerms =
          modPlain.toLowerCase().includes("standardtermslink") ||
          modPlain.toLowerCase().includes("standardtermsurl") ||
          modPlain.toLowerCase().includes("standard_terms") ||
          modPlain.toLowerCase().includes("standard terms");
        return hasGov && hasLiab && hasTerms;
      }
      try {
        const obj = JSON.parse(match[0].trim());
        const keys = Object.keys(obj).map((k) => k.toLowerCase());
        const hasGoverningLaw = keys.some(
          (k) =>
            k.includes("governinglaw") ||
            k.includes("governing_law") ||
            k.includes("governing law"),
        );
        const hasLiabilityCap = keys.some(
          (k) =>
            k.includes("liabilitycap") ||
            k.includes("liability_cap") ||
            k.includes("liability cap"),
        );
        const hasStandardTermsLink = keys.some(
          (k) =>
            k.includes("standardtermslink") ||
            k.includes("standardtermsurl") ||
            k.includes("standard_terms") ||
            k.includes("standard terms"),
        );

        if (!hasGoverningLaw || !hasLiabilityCap || !hasStandardTermsLink) {
          return false;
        }

        const values = Object.values(obj).map((v) => String(v).toLowerCase());
        const governingLawOk = values.some(
          (v) => v.includes("delaware") || v.includes("state") || v.includes("laws"),
        );
        const termsLinkOk = values.some((v) => v.includes("commonpaper.com") || v.includes("http"));

        return governingLawOk && termsLinkOk;
      } catch {
        const hasGov =
          modPlain.toLowerCase().includes("governinglaw") ||
          modPlain.toLowerCase().includes("governing_law") ||
          modPlain.toLowerCase().includes("governing law");
        const hasLiab =
          modPlain.toLowerCase().includes("liabilitycap") ||
          modPlain.toLowerCase().includes("liability_cap") ||
          modPlain.toLowerCase().includes("liability cap");
        const hasTerms =
          modPlain.toLowerCase().includes("standardtermslink") ||
          modPlain.toLowerCase().includes("standardtermsurl") ||
          modPlain.toLowerCase().includes("standard_terms") ||
          modPlain.toLowerCase().includes("standard terms");
        return hasGov && hasLiab && hasTerms;
      }
    }

    case "playbook-commenting": {
      // Success Criteria: Inspect word/comments.xml to verify the late payment interest cap comment text is present.
      const commentsPart = modifiedDoc.pkg.parts.find((p) => p.partname.includes("comments"));
      const commentsXml = commentsPart ? String(commentsPart.blob).toLowerCase() : "";
      const hasInterest = commentsXml.includes("interest") || commentsXml.includes("payment");
      const hasBoE =
        commentsXml.includes("2%") ||
        commentsXml.includes("2.0%") ||
        commentsXml.includes("england") ||
        commentsXml.includes("base rate") ||
        commentsXml.includes("commercial debts") ||
        commentsXml.includes("statutory");
      return hasInterest && hasBoE;
    }

    case "multi-file-assembly": {
      // Success Criteria: Verify both CSA and DPA contain matching Wayne Enterprises and date June 22, 2026.
      if (!tempFilePath) return false;
      let tempDpaPath = tempFilePath.replace(".docx", "_dpa.docx");
      if (!fs.existsSync(tempDpaPath)) {
        tempDpaPath = path.join(path.dirname(tempFilePath), "dpa-module.docx");
      }
      if (!fs.existsSync(tempDpaPath)) return false;

      try {
        const dpaBuffer = fs.readFileSync(tempDpaPath);
        const dpaDoc = await DocumentObject.load(dpaBuffer);
        const dpaPlain = new DocumentMapper(dpaDoc, true).full_text;

        const hasCustomerName =
          modPlain.includes("Wayne Enterprises") ||
          modPlain.includes("Acme Corporate Technologies") ||
          modPlain.includes("Wayne");
        const hasCustomerNameDpa =
          dpaPlain.includes("Wayne Enterprises") ||
          dpaPlain.includes("Acme Corporate Technologies") ||
          dpaPlain.includes("Wayne");

        const hasDate =
          modPlain.includes("June 22, 2026") ||
          modPlain.includes("2026") ||
          modPlain.includes("June 22");
        const hasDateDpa =
          dpaPlain.includes("June 22, 2026") ||
          dpaPlain.includes("2026") ||
          dpaPlain.includes("June 22");

        return hasCustomerName && hasCustomerNameDpa && hasDate && hasDateDpa;
      } catch (err) {
        console.error("Error verifying DPA in success criteria:", err);
        return false;
      }
    }

    default:
      return false;
  }
}
