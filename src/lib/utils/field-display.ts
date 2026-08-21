// When a detail-page field has nothing to show.
//
// §5 of docs/design/campfire-product-surface.md: "Empty is `-`, never blank",
// and "every field shows, even when null". A CPA reading a journal entry needs
// to know that `Mapping version` is a field that exists and is empty — not
// wonder whether this screen omits it. Collapsing empty fields is a
// consumer-app instinct and it is wrong on an accounting document.
//
// ⚠️ ZERO IS NOT EMPTY. This is the rule that makes the helper worth extracting
// rather than writing `value || "—"` at each site: on a ledger, `0` and `0.00`
// are answers, and `||` turns both into a dash. So does an empty-string check
// applied to a number. The test for this is the reason the file exists.

/** What an empty field renders. An em dash, not a hyphen — it is a value, not a range. */
export const EMPTY_FIELD = "—";

/**
 * Whether a field value should render as {@link EMPTY_FIELD}.
 *
 * Empty: `null`, `undefined`, a string that is empty or only whitespace, and
 * an empty array.
 *
 * NOT empty: `0`, `0.00`, `false`, `NaN` — every one of those is something the
 * source actually said, and replacing it with a dash loses that. `false` in
 * particular is a real answer to `Auto renew`.
 */
export function isEmptyFieldValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}
