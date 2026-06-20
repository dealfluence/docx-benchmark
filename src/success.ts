import { DocumentObject, DocumentMapper } from "@adeu/core";

export function checkScenarioSuccess(
  scenarioId: string,
  originalDoc: DocumentObject,
  modifiedDoc: DocumentObject
): boolean {
  const origPlain = new DocumentMapper(originalDoc, true).full_text;
  const modPlain = new DocumentMapper(modifiedDoc, true).full_text;
  const modCritic = new DocumentMapper(modifiedDoc, false).full_text;

  switch (scenarioId) {
    case "surgical-correction": {
      // Must contain Vendor, must NOT contain Seller
      const hasVendor = modPlain.includes("Vendor");
      const hasSeller = modPlain.includes("Seller");
      return hasVendor && !hasSeller;
    }

    case "clause-drafting": {
      // Must contain Data Protection and its clause text
      const hasDataProtection = modPlain.includes("Data Protection");
      const hasClause = modPlain.includes("Each party shall comply with all applicable data protection laws");
      return hasDataProtection && hasClause;
    }

    case "negotiation-cleanup": {
      // The revision Chg:12 should no longer be present in CriticMarkup metadata tags
      const hasChg12InMetadata = modCritic.includes("Chg:12");
      return !hasChg12InMetadata;
    }

    case "bulk-rewrite": {
      // Must contain the new clause, and old clause must be gone
      const hasNew = modPlain.includes("establish the terms of service");
      const hasOld = modPlain.includes("Typing some. Typing some text") || modPlain.includes("Typing some text");
      return hasNew && !hasOld;
    }

    case "whole-document-restyle": {
      // Must contain GOVERNING LAW and NOT Governing Law
      const hasRestyled = modPlain.includes("GOVERNING LAW");
      const hasOld = modPlain.includes("Governing Law");
      return hasRestyled && !hasOld;
    }

    case "no-op": {
      // Plain text should be identical, and must NOT contain "ShouldNotBeInserted"
      const hasInserted = modPlain.includes("ShouldNotBeInserted");
      const isIdentical = origPlain.trim() === modPlain.trim();
      return !hasInserted && isIdentical;
    }

    case "conditional-edit": {
      const text = modPlain.toLowerCase();
      const hasNewYork = text.includes("new york");
      const hasVenue = text.includes("venue") || text.includes("court") || text.includes("courts") || text.includes("jurisdiction");
      const hasArbitration = text.includes("arbitration");
      return hasNewYork && hasVenue && !hasArbitration;
    }

    case "dependent-multi-target": {
      const text = modPlain.toLowerCase();
      const hasConfidentiality = text.includes("confidentiality");
      // Check that Liability Cap was renumbered to Section 6, and Notices to Section 9 (since we inserted Section 5 Confidentiality)
      const hasSection6Liability = text.includes("6. liability cap") || text.includes("section 6. liability cap") || text.includes("## 6. liability cap") || text.includes("6. liability");
      const hasSection9Notices = text.includes("9. notices") || text.includes("section 9. notices") || text.includes("## 9. notices") || text.includes("9. notices");
      // Notices section should mention section 6 or §6 or shifted number
      const noticesIndex = text.indexOf("notices");
      const noticesPart = noticesIndex !== -1 ? text.substring(noticesIndex) : "";
      const referencesSection6 = noticesPart.includes("6") || noticesPart.includes("§6") || noticesPart.includes("section 6");
      return hasConfidentiality && hasSection6Liability && hasSection9Notices && referencesSection6;
    }

    case "selective-verify-and-repair": {
      // Revisions in Section 6 (Indemnity) must survive (i.e. still be tracked changes)
      // Since it had "Seller" and "Vendor", if it survived, both or the criticmarkup tags/metadata should be present
      const hasChg12Or13 = modCritic.includes("Chg:12") || modCritic.includes("Chg:13") || modCritic.includes("{++Seller++}") || modCritic.includes("{--Vendor--}");
      // Revisions in other paragraphs (like Chg:2) should be accepted and gone
      const hasOtherChgs = modCritic.includes("Chg:2") || modCritic.includes("Chg:3") || modCritic.includes("Chg:6") || modCritic.includes("Chg:9");
      return hasChg12Or13 && !hasOtherChgs;
    }

    case "search-then-compute": {
      // Original was $100,000, halved is $50,000
      const has50k = modPlain.includes("50,000");
      const has100k = modPlain.includes("100,000");
      return has50k && !has100k;
    }

    default:
      return false;
  }
}
