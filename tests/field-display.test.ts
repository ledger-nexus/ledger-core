// What counts as an empty field.
//
// This helper exists for one reason, and it is the reason worth testing: the
// obvious implementations are wrong on a ledger. `value || "—"` and
// `!value ? "—" : value` both turn **0** into a dash, and 0 is an answer — a
// zero balance, a zero-line entry, a fx rate of 0 is a data problem you need
// to SEE rather than have hidden behind punctuation.
//
// `false` is the same case in a different suit: `Auto renew: false` is a real
// answer to a real question, and rendering it as "—" says the field was never
// filled in.

import { describe, it, expect } from "vitest";

import { EMPTY_FIELD, isEmptyFieldValue } from "@/lib/utils/field-display";

describe("isEmptyFieldValue", () => {
  it("treats null and undefined as empty", () => {
    expect(isEmptyFieldValue(null)).toBe(true);
    expect(isEmptyFieldValue(undefined)).toBe(true);
  });

  it("treats an empty or whitespace-only string as empty", () => {
    // Whitespace matters: an imported field of "   " renders as a blank cell
    // that looks like a rendering bug rather than like missing data.
    expect(isEmptyFieldValue("")).toBe(true);
    expect(isEmptyFieldValue("   ")).toBe(true);
    expect(isEmptyFieldValue("\n\t")).toBe(true);
  });

  it("treats an empty array as empty", () => {
    // "Reversed by: []" is the shape of "this entry has not been reversed".
    expect(isEmptyFieldValue([])).toBe(true);
    expect(isEmptyFieldValue([1])).toBe(false);
  });

  it("⚠️ does NOT treat zero as empty", () => {
    // The whole reason this is a function and not `value || "—"`.
    expect(isEmptyFieldValue(0)).toBe(false);
    expect(isEmptyFieldValue(-0)).toBe(false);
    expect(isEmptyFieldValue(0.0)).toBe(false);
    expect(isEmptyFieldValue("0")).toBe(false);
    expect(isEmptyFieldValue("0.00")).toBe(false);
  });

  it("⚠️ does NOT treat false as empty", () => {
    // `Auto renew: false` is an answer. `Auto renew: —` is a different claim.
    expect(isEmptyFieldValue(false)).toBe(false);
  });

  it("does not treat NaN as empty", () => {
    // NaN reaching a field is a bug upstream, and it should be visible as one
    // rather than laundered into a dash that reads as "no data".
    expect(isEmptyFieldValue(Number.NaN)).toBe(false);
  });

  it("uses an em dash, not a hyphen", () => {
    // A hyphen reads as a range or a minus sign in a column of numbers.
    expect(EMPTY_FIELD).toBe("—");
    expect(EMPTY_FIELD).not.toBe("-");
  });
});
