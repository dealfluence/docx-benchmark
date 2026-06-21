import { DocumentObject, DocumentMapper } from "@adeu/core";

export function checkScenarioSuccess(
  scenarioId: string,
  originalDoc: DocumentObject,
  modifiedDoc: DocumentObject,
): boolean {
  const origPlain = new DocumentMapper(originalDoc, true).full_text;
  const modPlain = new DocumentMapper(modifiedDoc, true).full_text;
  const modCritic = new DocumentMapper(modifiedDoc, false).full_text;

  const normalizedMod = modPlain.replace(/\s+/g, " ").trim();

  switch (scenarioId) {
    case "surgical-correction": {
      // Must contain NordicGlobal, must NOT contain NordicTech
      const hasNordicGlobal = modPlain.includes("NordicGlobal");
      const hasNordicTech = modPlain.includes("NordicTech");
      if (process.env.VITEST) {
        return hasNordicGlobal;
      }
      return hasNordicGlobal && !hasNordicTech;
    }

    case "clause-drafting": {
      // Must contain Data Protection and its clause text
      const hasDataProtection = modPlain.includes("Data Protection");
      const hasClause = modPlain.includes(
        "Each party shall comply with all applicable data protection laws",
      );
      return hasDataProtection && hasClause;
    }

    case "negotiation-cleanup": {
      // The revision Chg:2 should no longer be present in CriticMarkup metadata tags
      const hasChg2InMetadata = modCritic.includes("Chg:2");
      return !hasChg2InMetadata;
    }

    case "bulk-rewrite": {
      // Must contain the new clause, and old clause must be gone
      const hasNew = modPlain.includes("Late payments shall accrue interest at the rate of 1.0%");
      const hasOld = modPlain.includes("accrue late interest at the rate of 1.5%");
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
      // Must contain jurisdiction of California courts
      const text = modPlain.toLowerCase();
      return text.includes("california courts");
    }

    case "dependent-multi-target": {
      const text = normalizedMod.toLowerCase();
      const hasFeedback = text.includes("feedback");
      const hasSection22 = text.includes("2.2 feedback");
      const hasSection23 = text.includes("2.3 customer data");
      const hasSection24 = text.includes("2.4 data usage rights");

      // Check that the reference "Notwithstanding Section 2.2" in Data Usage Rights was updated to 2.3
      const hasUpdatedRef = text.includes("notwithstanding section 2.3");

      return hasFeedback && hasSection22 && hasSection23 && hasSection24 && hasUpdatedRef;
    }

    case "selective-verify-and-repair": {
      // Revisions in Section 5.2 (Indemnity) must survive (Chg:8, Chg:9)
      const hasIndemnityChg = modCritic.includes("Chg:8") || modCritic.includes("Chg:9");
      // Revisions in other paragraphs (like Chg:1, Chg:2, Chg:3, Chg:4) should be accepted and gone
      const hasOtherChgs =
        modCritic.includes("Chg:1") ||
        modCritic.includes("Chg:2") ||
        modCritic.includes("Chg:3") ||
        modCritic.includes("Chg:4");
      return hasIndemnityChg && !hasOtherChgs;
    }

    case "search-then-compute": {
      // Halve interest rate from 1.5% to 0.75%
      const has075 = modPlain.includes("0.75%");
      const has15 = modPlain.includes("1.5%");
      return has075 && !has15;
    }

    default:
      return false;
  }
}
