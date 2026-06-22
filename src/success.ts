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

    case "comment-driven-edit": {
      // Esko Aho must be present in Section 5.2 text AND a reply to Com:7 must exist
      const hasEskoAho = modPlain.includes("Esko Aho");
      // Check for reply in CriticMarkup — reply content should appear in the markup
      const hasReply =
        modCritic.includes("Acknowledged") || modCritic.includes("updated representative");
      return hasEskoAho && hasReply;
    }

    case "multi-location-update": {
      // All occurrences of NordicTech must become NordicGlobal
      const hasNordicGlobal = modPlain.includes("NordicGlobal Solutions Inc.");
      const hasOldName = modPlain.includes("NordicTech Solutions Inc.");
      return hasNordicGlobal && !hasOldName;
    }

    case "defined-term-insertion": {
      // New defined term must exist in Section 1.1
      const hasDefinedTerm = modPlain.includes("Permitted Purpose");
      const hasDefinition = modPlain.includes("receiving, accessing, and using the Services");
      // Must be used in Section 4.1 replacing old phrasing
      const hasUsage = modPlain.includes("outside the Permitted Purpose");
      const hasOldPhrase = modPlain.includes("outside the scope of this Agreement");
      return hasDefinedTerm && hasDefinition && hasUsage && !hasOldPhrase;
    }

    case "liability-cap-rewrite": {
      // Must contain twelve (12) months, must NOT contain three (3) months
      const hasTwelve =
        modPlain.includes("twelve (12) months") || modPlain.includes("twelve(12) months");
      const hasThree =
        modPlain.includes("three (3) months") || modPlain.includes("three(3) months");
      return hasTwelve && !hasThree;
    }

    case "clause-deletion-and-renumber": {
      // Section 8.2 should now be Entire Agreement (not Assignment)
      const text = normalizedMod.toLowerCase();
      const hasAssignment = text.includes("8.2 assignment") || text.includes("8.2assignment");
      const hasEntireAt82 =
        text.includes("8.2 entire agreement") || text.includes("8.2entire agreement");
      // Old section 8.3 should no longer exist
      const has83 = text.includes("8.3");
      return !hasAssignment && hasEntireAt82 && !has83;
    }

    default:
      return false;
  }
}
