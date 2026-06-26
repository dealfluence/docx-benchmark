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

/** Finalized ("accepted") plain text of a document. */
function plainText(doc: DocumentObject): string {
  return new DocumentMapper(doc, true).full_text;
}

/** CriticMarkup view: original text plus {++insert++}, {--delete--}, {>>comment<<}. */
function criticText(doc: DocumentObject): string {
  return new DocumentMapper(doc, false).full_text;
}

/** Does the package carry a comments part? */
function hasCommentsPart(doc: DocumentObject): boolean {
  return doc.pkg.parts.some((p) => p.partname.includes("comments"));
}

/** Count of native OOXML tracked changes (insertions + deletions). */
function trackedChangeCount(doc: DocumentObject): number {
  const xml = doc.part.blob;
  return (xml.match(/<w:ins\s/g) || []).length + (xml.match(/<w:del\s/g) || []).length;
}

/**
 * The reviewer's ADDED content only — text inside insertions ({++..++}) and
 * comments ({>>..<<}) — lowercased. Deliberately excludes the original body so a
 * redline-review scenario cannot "pass" on words that were already in the
 * document (e.g. the clause heading "Governing Law").
 */
function addedReviewText(doc: DocumentObject): string {
  const critic = criticText(doc);
  const parts: string[] = [];
  for (const m of critic.matchAll(/\{\+\+([\s\S]*?)\+\+\}/g)) parts.push(m[1]);
  for (const m of critic.matchAll(/\{>>([\s\S]*?)<<\}/g)) parts.push(m[1]);
  return parts.join(" \n ").toLowerCase();
}

export async function checkScenarioSuccess(
  scenarioId: string,
  originalDoc: DocumentObject,
  modifiedDoc: DocumentObject,
  tempFilePath?: string,
): Promise<boolean> {
  switch (scenarioId) {
    case "form-fill": {
      // All values are sourced from deal-data-sheet.docx; every SAFE placeholder
      // now has corresponding data, so a complete fill is well-defined.
      const m = plainText(modifiedDoc);

      const requiredValues = [
        "Acme Robotics, Inc.", // Company Name
        "Vertex Seed Fund, L.P.", // Investor Name
        "Delaware", // State of Incorporation + Governing Law Jurisdiction
        "John Carter", // Company Signatory Name
        "Chief Executive Officer", // Company Signatory Title
        "June 22, 2026", // Date of Safe
      ];
      const hasAllValues = requiredValues.every((v) => hasNorm(m, v));
      const hasPurchaseAmount = hasNorm(m, "$500,000") || hasNorm(m, "500,000");
      const hasValuationCap = hasNorm(m, "$15,000,000") || hasNorm(m, "15,000,000");

      const placeholders = [
        "[Company Name]",
        "[Investor Name]",
        "[Date of Safe]",
        "[State of Incorporation]",
        "[Governing Law Jurisdiction]",
        "[_name_]",
        "[_title_]",
      ];
      const noPlaceholders = placeholders.every((p) => !m.includes(p));
      const noDollarBlanks = !/\$\[_+\]/.test(m);

      return (
        hasAllValues && hasPurchaseAmount && hasValuationCap && noPlaceholders && noDollarBlanks
      );
    }

    case "party-swap": {
      // The fixture is an EXECUTED contract with the prior deal's real parties baked
      // in. Success requires a complete re-template onto the new parties with NO
      // residual prior-party data (the realistic "old client left in the template"
      // failure mode).
      const m = plainText(modifiedDoc);
      const nm = normalize(m);

      const noOldParties =
        !hasNorm(m, "Stark Industries") &&
        !hasNorm(m, "Pym Particle") &&
        !hasNorm(m, "Anthony Stark") &&
        !m.toLowerCase().includes("starkindustries.com");

      // New parties must appear at least as often as the originals did
      // (Company 3x, Lead investor 2x, Key Holder/founder 3x).
      const consistentParties =
        countLiteral(nm, normalize("Wayne Enterprises")) >= 3 &&
        countLiteral(nm, normalize("Fox Capital Partners")) >= 2 &&
        countLiteral(nm, normalize("Bruce Wayne")) >= 3;

      return noOldParties && consistentParties;
    }

    case "policy-checklist-review": {
      // The review must live IN the document as comments and/or tracked changes,
      // addressing all three checklist points. Scored on the reviewer's ADDED
      // content so the original body's vocabulary cannot satisfy the check.
      if (!hasCommentsPart(modifiedDoc) && trackedChangeCount(modifiedDoc) === 0) return false;
      const review = addedReviewText(modifiedDoc);

      const blankWords = [
        "unspecified",
        "not specified",
        "blank",
        "missing",
        "not stated",
        "no governing",
        "fill in",
        "none",
        "n/a",
        "left blank",
        "not filled",
        "not been filled",
        "not provided",
        "not selected",
        "not defined",
      ];
      const governingLawFlagged =
        review.includes("governing law") && blankWords.some((w) => review.includes(w));
      const liabilityAddressed =
        review.includes("liability") ||
        review.includes("general cap") ||
        review.includes("cap amount") ||
        review.includes("limitation");
      const standardTermsAddressed =
        review.includes("standard terms") ||
        review.includes("common paper") ||
        review.includes("commonpaper");

      return governingLawFlagged && liabilityAddressed && standardTermsAddressed;
    }

    case "playbook-commenting": {
      // The fixture already carries the counterparty's proposal (an 8% / statutory
      // tracked change + comment). Success requires the reviewer to (a) keep
      // comments present and (b) propose the playbook-conforming cap of 2.0% above
      // the Bank of England base rate. The seed contains "8%"/"base rate"/"statutory"
      // but NOT "2%", so the 2% proposal cleanly identifies the model's own review.
      if (!hasCommentsPart(modifiedDoc)) return false;
      const review = addedReviewText(modifiedDoc);

      const proposesTwoPercent =
        /\b2(\.0)?\s*%/.test(review) ||
        review.includes("2 percent") ||
        review.includes("2 per cent");
      const referencesBaseRate = review.includes("base rate") || review.includes("bank of england");
      const onTopic =
        review.includes("interest") ||
        review.includes("late payment") ||
        review.includes("statutory");

      return proposesTwoPercent && referencesBaseRate && onTopic;
    }

    case "multi-file-assembly": {
      // Customer name and effective date are sourced from deal-intake-sheet.docx and
      // must be propagated into BOTH the CSA (primary) and the DPA (companion).
      if (!tempFilePath) return false;
      let dpaPath = tempFilePath.replace(".docx", "_dpa.docx");
      if (!fs.existsSync(dpaPath)) {
        dpaPath = path.join(path.dirname(tempFilePath), "dpa-module.docx");
      }
      if (!fs.existsSync(dpaPath)) return false;

      try {
        const csaPlain = plainText(modifiedDoc);
        const dpaDoc = await DocumentObject.load(fs.readFileSync(dpaPath));
        const dpaPlain = plainText(dpaDoc);

        const customer = "Wayne Enterprises, Inc.";
        const effectiveDate = "June 22, 2026";

        return (
          hasNorm(csaPlain, customer) &&
          hasNorm(dpaPlain, customer) &&
          hasNorm(csaPlain, effectiveDate) &&
          hasNorm(dpaPlain, effectiveDate)
        );
      } catch (err) {
        console.error("Error verifying DPA in success criteria:", err);
        return false;
      }
    }

    default:
      return false;
  }
}
