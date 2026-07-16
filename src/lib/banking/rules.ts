// Learned categorization rules for the bank feed.
//
// The loop: every time a user categorizes a line, the merchant→category
// pairing is remembered (learnRule). At review time, each incoming line is
// tested against the tenant's rules (bestRuleFor) and the winning rule's
// category is PRE-SELECTED in the inbox. Suggestion only — the user still
// clicks Add, and posting stays the human's call. Auto-add (posting without
// review, QBO's "auto-add" rules) is deliberately not here; it would be a
// later, per-rule opt-in.

import { createHash } from "node:crypto";

/**
 * Normalize a bank description down to its merchant essence:
 * lowercase, collapse whitespace, strip digit-runs (store numbers, card
 * suffixes, dates) and reference punctuation. "WHOLE FOODS MARKET #123
 * SEATTLE 07/03" and "WHOLE FOODS MARKET #456" both normalize to
 * "whole foods market seattle" / "whole foods market" — close enough for
 * containment matching to connect them.
 */
export function normalizeMerchant(description: string): string {
  return description
    .toLowerCase()
    .replace(/[#*]/g, " ")
    .replace(/\d[\d/\-.:]*/g, " ") // digit runs incl. dates/times/ids
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

/** Deterministic hash for the (tenantId, matchHash) uniqueness key. */
export function computeMatchHash(normalizedText: string): string {
  return createHash("sha256").update(normalizedText).digest("hex");
}

export interface RuleForMatching {
  id: string;
  matchText: string; // decrypted, normalized
  bankAccountId: string | null;
  categoryAccountId: string;
  timesUsed: number;
}

/**
 * Pick the rule that should suggest a category for this line, or null.
 *
 * A rule matches when its matchText is CONTAINED in the line's normalized
 * description (so a rule learned from "whole foods market" still hits
 * "whole foods market seattle"), and its bank-account filter (if any)
 * agrees. Ties break by specificity (longer matchText), then by how often
 * the pairing has been confirmed.
 */
export function bestRuleFor(
  rules: RuleForMatching[],
  description: string,
  bankAccountId: string
): RuleForMatching | null {
  const norm = normalizeMerchant(description);
  if (!norm) return null;
  let best: RuleForMatching | null = null;
  for (const r of rules) {
    if (r.bankAccountId && r.bankAccountId !== bankAccountId) continue;
    if (!r.matchText || !norm.includes(r.matchText)) continue;
    if (
      !best ||
      r.matchText.length > best.matchText.length ||
      (r.matchText.length === best.matchText.length && r.timesUsed > best.timesUsed)
    ) {
      best = r;
    }
  }
  return best;
}
