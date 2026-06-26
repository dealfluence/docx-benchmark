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

/**
 * Minimum fraction of the original document's text length the output must retain.
 * Guards against a tool truncating the document or overwriting it with a smaller
 * one (e.g. saving DPA bytes into the CSA slot). Every scenario only adds or
 * swaps content, so a legitimate output is never substantially smaller.
 */
const MIN_SIZE_RATIO = 0.7;

/**
 * Base-integrity invariant: the output must still be the original document with the
 * task applied on top — at least MIN_SIZE_RATIO of its text length must remain, and
 * every distinctive `anchors` substring (structural content the task does not
 * remove) must still be present. Catches truncation, overwrite-with-another-doc,
 * and wholesale replacement that a value-presence check alone would miss.
 */
function baseIntact(
  originalDoc: DocumentObject,
  modifiedDoc: DocumentObject,
  anchors: string[],
  minRatio = MIN_SIZE_RATIO,
): boolean {
  const orig = plainText(originalDoc);
  const mod = plainText(modifiedDoc);
  if (orig.length > 0 && mod.length < orig.length * minRatio) return false;
  return anchors.every((a) => hasNorm(mod, a));
}

/** Raw text of all comment parts (lowercased) — reliable for checking a specific comment survived. */
function rawCommentsText(doc: DocumentObject): string {
  return doc.pkg.parts
    .filter((p) => p.partname.includes("comments"))
    .map((p) => String(p.blob))
    .join("\n")
    .toLowerCase();
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
        hasAllValues &&
        hasPurchaseAmount &&
        hasValuationCap &&
        noPlaceholders &&
        noDollarBlanks &&
        baseIntact(originalDoc, modifiedDoc, ["Post-Money Valuation Cap"])
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

      return (
        noOldParties &&
        consistentParties &&
        baseIntact(originalDoc, modifiedDoc, ["Series Seed Preferred Stock"])
      );
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

      return (
        governingLawFlagged &&
        liabilityAddressed &&
        standardTermsAddressed &&
        baseIntact(originalDoc, modifiedDoc, ["Order Form", "Subscription Period"])
      );
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

      // Negotiation invariant: the reviewer must engage the counterparty ON TOP of
      // their comment, not by deleting it. The seed counterparty comment (authored
      // "Supplier's Counsel") contains the distinctive phrase "robust protection";
      // it must still be present in the output. Rejecting their tracked *change* is
      // fair game, but discarding their comment is not.
      const counterpartyCommentKept = rawCommentsText(modifiedDoc).includes("robust protection");

      return (
        proposesTwoPercent &&
        referencesBaseRate &&
        onTopic &&
        counterpartyCommentKept &&
        baseIntact(originalDoc, modifiedDoc, ["the Authority", "the Supplier"])
      );
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

        const valuesOk =
          hasNorm(csaPlain, customer) &&
          hasNorm(dpaPlain, customer) &&
          hasNorm(csaPlain, effectiveDate) &&
          hasNorm(dpaPlain, effectiveDate);

        // Base-integrity: the CSA must still be the CSA (not overwritten with DPA
        // bytes or another doc) — CSA-unique anchors present + size floor vs the
        // original CSA. "Order Form"/"Subscription Period" appear only in the CSA,
        // never the DPA, so a CSA-as-DPA overwrite fails here.
        const csaIntact = baseIntact(originalDoc, modifiedDoc, [
          "Order Form",
          "Subscription Period",
        ]);

        // The DPA must still be the DPA ("Processor" is DPA-unique) and not have
        // been shrunk/overwritten — size floor vs the original DPA fixture.
        let dpaSizeOk = true;
        try {
          const dpaOrig = await DocumentObject.load(
            fs.readFileSync(path.resolve("fixtures/common-paper/dpa-module.docx")),
          );
          dpaSizeOk = dpaPlain.length >= plainText(dpaOrig).length * MIN_SIZE_RATIO;
        } catch {
          // Original DPA baseline unavailable — skip the DPA size floor.
        }
        const dpaIntact = hasNorm(dpaPlain, "Processor") && dpaSizeOk;

        return valuesOk && csaIntact && dpaIntact;
      } catch (err) {
        console.error("Error verifying DPA in success criteria:", err);
        return false;
      }
    }

    default:
      return false;
  }
}
