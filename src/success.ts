import * as fs from "node:fs";
import * as path from "node:path";
import { DocumentObject, DocumentMapper } from "@adeu/core";

/**
 * Normalize text for tolerant-but-distinctive matching:
 * lowercase, collapse all whitespace to single spaces, drop commas/periods.
 * This lets "Wayne Enterprises, Inc." == "Wayne Enterprises Inc" while still
 * requiring the full distinctive token (bare "wayne" will NOT match "wayne enterprises").
 */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[,.]/g, " ").replace(/\s+/g, " ").trim();
}

/** True if `needle` (normalized) appears in `haystack` (normalized). */
function hasNorm(haystack: string, needle: string): boolean {
  return normalize(haystack).includes(normalize(needle));
}

/** Count non-overlapping occurrences of a literal substring. */
function countLiteral(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

export async function checkScenarioSuccess(
  scenarioId: string,
  originalDoc: DocumentObject,
  modifiedDoc: DocumentObject,
  tempFilePath?: string,
): Promise<boolean> {
  const modPlain = new DocumentMapper(modifiedDoc, true).full_text;

  switch (scenarioId) {
    case "form-fill": {
      // Target values (exact, normalized): Company, Investor, and BOTH dollar blanks filled.
      const hasCompany = hasNorm(modPlain, "Acme Corporate Technologies, Inc.");
      const hasInvestor = hasNorm(modPlain, "Jane Founder");
      const hasValuation = hasNorm(modPlain, "$15,000,000") || hasNorm(modPlain, "15,000,000");

      // Placeholders must be gone. The fixture has TWO identical "$[_____________]" blanks
      // (Purchase Amount + Post-Money Valuation Cap); a half-fill leaves one behind.
      const noCompanyPlaceholder = !modPlain.includes("[Company Name]");
      const noInvestorPlaceholder = !modPlain.includes("[Investor Name]");
      const noDollarBlanks = !modPlain.includes("$[_____________]");

      return (
        hasCompany &&
        hasInvestor &&
        hasValuation &&
        noCompanyPlaceholder &&
        noInvestorPlaceholder &&
        noDollarBlanks
      );
    }

    case "party-swap": {
      // Exact target names, normalized so "Inc"/"Inc." punctuation doesn't matter,
      // but bare "Wayne" / "Bruce" no longer passes.
      const hasWayne = hasNorm(modPlain, "Wayne Enterprises, Inc.");
      const hasBruce = hasNorm(modPlain, "Bruce Wayne");

      const noCompanyPlaceholder = !modPlain.includes("[COMPANY NAME]");
      const noPurchaserPlaceholder = !modPlain.includes("[PURCHASER NAME]");

      // Consistency: the swap must hit every site, not just one.
      // Original fixture: [COMPANY NAME] appears 3x (definitions + signature),
      // [PURCHASER NAME] appears 2x (entity + individual signature blocks).
      // Require the new names to appear at least as often as the placeholders they replaced.
      const wayneCount = countLiteral(normalize(modPlain), normalize("Wayne Enterprises"));
      const bruceCount = countLiteral(normalize(modPlain), normalize("Bruce Wayne"));
      const consistentCompany = wayneCount >= 3;
      const consistentPurchaser = bruceCount >= 2;

      return (
        hasWayne &&
        hasBruce &&
        noCompanyPlaceholder &&
        noPurchaserPlaceholder &&
        consistentCompany &&
        consistentPurchaser
      );
    }

    case "policy-checklist-review": {
      // The model must append a JSON summary with keys governingLaw, liabilityCap, standardTermsLink.
      // GROUND TRUTH for this fixture:
      //   - Governing Law is an UNFILLED placeholder "[fill in state, province, and/or country]"
      //     => the correct determination is "unspecified/blank", NOT a hallucinated jurisdiction.
      //   - Liability cap is the "General Cap" mechanism.
      //   - Standard terms link is the commonpaper.com URL.

      // Extract the LAST balanced {...} block (the appended summary lives at the end),
      // avoiding the old greedy first-brace grab that snagged drafting artifacts.
      const extractLastJsonObject = (text: string): string | null => {
        const lastOpen = text.lastIndexOf("{");
        if (lastOpen === -1) return null;
        let depth = 0;
        for (let i = lastOpen; i < text.length; i++) {
          if (text[i] === "{") depth++;
          else if (text[i] === "}") {
            depth--;
            if (depth === 0) return text.slice(lastOpen, i + 1);
          }
        }
        // Unbalanced from lastOpen; try scanning forward from the first "{".
        const firstOpen = text.indexOf("{");
        if (firstOpen === -1) return null;
        depth = 0;
        for (let i = firstOpen; i < text.length; i++) {
          if (text[i] === "{") depth++;
          else if (text[i] === "}") {
            depth--;
            if (depth === 0) return text.slice(firstOpen, i + 1);
          }
        }
        return null;
      };

      const jsonStr = extractLastJsonObject(modPlain);
      if (!jsonStr) return false;

      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(jsonStr);
      } catch {
        return false;
      }

      const keys = Object.keys(obj).map((k) => k.toLowerCase());
      const hasGoverningLaw = keys.some(
        (k) =>
          k.includes("governinglaw") || k.includes("governing_law") || k.includes("governing law"),
      );
      const hasLiabilityCap = keys.some(
        (k) =>
          k.includes("liabilitycap") || k.includes("liability_cap") || k.includes("liability cap"),
      );
      const hasStandardTermsLink = keys.some(
        (k) =>
          k.includes("standardtermslink") ||
          k.includes("standardtermsurl") ||
          k.includes("standard_terms") ||
          k.includes("standard terms"),
      );
      if (!hasGoverningLaw || !hasLiabilityCap || !hasStandardTermsLink) return false;

      const getVal = (predicate: (k: string) => boolean): string => {
        const key = Object.keys(obj).find((k) => predicate(k.toLowerCase()));
        return key ? String(obj[key]).toLowerCase() : "";
      };

      const govVal = getVal((k) => k.includes("governing"));
      const liabVal = getVal((k) => k.includes("liab"));
      const termsVal = getVal((k) => k.includes("standard") || k.includes("terms"));

      // Governing law: fixture is UNFILLED. Reward an honest "unspecified/blank/not specified/
      // fill in" reading; reject hallucinated jurisdictions.
      const governingLawOk =
        govVal.includes("unspecified") ||
        govVal.includes("not specified") ||
        govVal.includes("blank") ||
        govVal.includes("fill in") ||
        govVal.includes("none") ||
        govVal.includes("n/a") ||
        govVal.includes("placeholder");

      // Liability cap: must reference the General Cap mechanism, not be empty.
      const liabilityCapOk =
        liabVal.includes("general cap") ||
        liabVal.includes("cap amount") ||
        liabVal.includes("limitation") ||
        liabVal.length > 0;

      // Standard terms link: must be the real commonpaper.com URL.
      const termsLinkOk = termsVal.includes("commonpaper.com");

      return governingLawOk && liabilityCapOk && termsLinkOk;
    }

    case "playbook-commenting": {
      // Verify word/comments.xml contains a comment referencing the late-payment interest cap.
      const commentsPart = modifiedDoc.pkg.parts.find((p) => p.partname.includes("comments"));
      const commentsXml = commentsPart ? String(commentsPart.blob).toLowerCase() : "";
      if (!commentsXml) return false;

      const hasInterest = commentsXml.includes("interest") || commentsXml.includes("payment");
      // Must reference the specific playbook remedy (2% over BoE base rate) OR flag the
      // non-conforming statutory/Commercial Debts Act basis.
      const hasCapReference =
        commentsXml.includes("2%") ||
        commentsXml.includes("2.0%") ||
        commentsXml.includes("england") ||
        commentsXml.includes("base rate") ||
        commentsXml.includes("commercial debts") ||
        commentsXml.includes("statutory");
      return hasInterest && hasCapReference;
    }

    case "multi-file-assembly": {
      // Both CSA (primary) and DPA must carry the synchronized variables:
      //   Customer Name = "Wayne Enterprises, Inc."   Effective Date = "June 22, 2026".
      // No bare-token fallbacks; no Acme leak from the form-fill scenario.
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

        const hasCustomerName = hasNorm(modPlain, "Wayne Enterprises, Inc.");
        const hasCustomerNameDpa = hasNorm(dpaPlain, "Wayne Enterprises, Inc.");
        const hasDate = hasNorm(modPlain, "June 22, 2026");
        const hasDateDpa = hasNorm(dpaPlain, "June 22, 2026");

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
