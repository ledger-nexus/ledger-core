// Unit tests for the paste-from-Excel parser. No DB; runs anywhere.

import { describe, it, expect } from "vitest";
import { Decimal } from "@/lib/utils/decimal";
import { parsePastedLines } from "@/lib/accounting/paste-parser";

describe("parsePastedLines — no-header tab-separated (Excel default paste)", () => {
  it("parses a simple balanced 2-line JE", () => {
    const text = "1000\t500\t\tCash received\n4000\t\t500\tRevenue earned";
    const r = parsePastedLines(text);
    expect(r.errors).toEqual([]);
    expect(r.isBalanced).toBe(true);
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0].accountCode).toBe("1000");
    expect(r.lines[0].debit.toNumber()).toBe(500);
    expect(r.lines[0].credit.toNumber()).toBe(0);
    expect(r.lines[0].description).toBe("Cash received");
    expect(r.lines[1].accountCode).toBe("4000");
    expect(r.lines[1].credit.toNumber()).toBe(500);
    expect(r.debitTotal.toNumber()).toBe(500);
    expect(r.creditTotal.toNumber()).toBe(500);
    expect(r.hadHeader).toBe(false);
  });

  it("handles a 5-line complex JE with all balanced", () => {
    const text = [
      "6000\t80000\t\tGross salaries",
      "6100\t6400\t\tEmployer payroll taxes",
      "6200\t8000\t\tHealth & benefits",
      "2100\t\t10000\tWithheld income tax",
      "1010\t\t84400\tNet cash out",
    ].join("\n");
    const r = parsePastedLines(text);
    expect(r.errors).toEqual([]);
    expect(r.isBalanced).toBe(true);
    expect(r.lines).toHaveLength(5);
    expect(r.debitTotal.equals(new Decimal(94400))).toBe(true);
    expect(r.creditTotal.equals(new Decimal(94400))).toBe(true);
  });

  it("handles thousands commas + dollar signs in numbers", () => {
    const text = "1000\t$1,250.00\t\nRevenue\n4000\t\t$1,250.00\tBilling";
    const r = parsePastedLines(text);
    expect(r.isBalanced).toBe(true);
    expect(r.debitTotal.toNumber()).toBe(1250);
  });

  it("handles accountant-paren-negatives in numbers", () => {
    // (100.00) means -100. We don't expect negatives in practice (one
    // would just put the value on the OTHER side), but we don't crash.
    const text = "1000\t(100)\t\n4000\t\t-100";
    const r = parsePastedLines(text);
    // Negative on debit side and negative on credit side leaves it balanced
    // mathematically but trips the "amounts must be non-negative" rule.
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it("drops empty trailing lines (Excel often appends blank rows)", () => {
    const text = "1000\t500\t\n4000\t\t500\n\n\n";
    const r = parsePastedLines(text);
    expect(r.lines).toHaveLength(2);
    expect(r.errors).toEqual([]);
  });

  it("handles CRLF (Windows / Excel) line endings", () => {
    const text = "1000\t500\t\r\n4000\t\t500";
    const r = parsePastedLines(text);
    expect(r.lines).toHaveLength(2);
    expect(r.isBalanced).toBe(true);
  });
});

describe("parsePastedLines — header detection", () => {
  it("detects a header row and uses column mapping", () => {
    const text = [
      "account\tdebit\tcredit\tdescription",
      "1000\t500\t\tCash received",
      "4000\t\t500\tRevenue earned",
    ].join("\n");
    const r = parsePastedLines(text);
    expect(r.hadHeader).toBe(true);
    expect(r.lines).toHaveLength(2);
    expect(r.isBalanced).toBe(true);
  });

  it("detects a header with different column order", () => {
    const text = [
      "description\taccount\tcredit\tdebit",
      "Cash received\t1000\t\t500",
      "Revenue earned\t4000\t500\t",
    ].join("\n");
    const r = parsePastedLines(text);
    expect(r.hadHeader).toBe(true);
    expect(r.lines[0].accountCode).toBe("1000");
    expect(r.lines[0].debit.toNumber()).toBe(500);
    expect(r.lines[0].description).toBe("Cash received");
    expect(r.isBalanced).toBe(true);
  });

  it("accepts header aliases (DR / CR / Acct)", () => {
    const text = [
      "acct\tdr\tcr",
      "1000\t500\t",
      "4000\t\t500",
    ].join("\n");
    const r = parsePastedLines(text);
    expect(r.hadHeader).toBe(true);
    expect(r.isBalanced).toBe(true);
  });

  it("does NOT misdetect a data-only row as a header", () => {
    // First row's first cell is "1000" — not a header token. Should
    // treat as data.
    const text = "1000\t500\t\n4000\t\t500";
    const r = parsePastedLines(text);
    expect(r.hadHeader).toBe(false);
    expect(r.lines).toHaveLength(2);
  });

  it("picks up optional party + item columns from a header", () => {
    const text = [
      "account\tdebit\tcredit\tdescription\tparty\titem",
      "1200\t1000\t\tInvoice #42\tACME\tWIDGET-A",
      "4000\t\t1000\tInvoice #42\tACME\tWIDGET-A",
    ].join("\n");
    const r = parsePastedLines(text);
    expect(r.lines[0].partyCode).toBe("ACME");
    expect(r.lines[0].itemCode).toBe("WIDGET-A");
    expect(r.isBalanced).toBe(true);
  });
});

describe("parsePastedLines — comma-separated", () => {
  it("falls back to comma when no tabs present", () => {
    const text = "1000,500,,Cash\n4000,,500,Revenue";
    const r = parsePastedLines(text);
    expect(r.lines).toHaveLength(2);
    expect(r.isBalanced).toBe(true);
  });
});

describe("parsePastedLines — error surfaces", () => {
  it("surfaces an UNBALANCED error when debits ≠ credits", () => {
    const text = "1000\t500\t\n4000\t\t400";
    const r = parsePastedLines(text);
    expect(r.isBalanced).toBe(false);
    expect(r.errors.some((e) => /Unbalanced/i.test(e))).toBe(true);
  });

  it("requires at least 2 lines", () => {
    const text = "1000\t500\t";
    const r = parsePastedLines(text);
    expect(r.errors.some((e) => /at least 2 lines/i.test(e))).toBe(true);
  });

  it("flags missing accountCode", () => {
    const text = "\t500\t\n4000\t\t500";
    const r = parsePastedLines(text);
    expect(r.errors.some((e) => /missing accountCode/i.test(e))).toBe(true);
  });

  it("flags non-numeric debit/credit", () => {
    const text = "1000\tNOT_A_NUMBER\t\n4000\t\t500";
    const r = parsePastedLines(text);
    expect(r.errors.some((e) => /not a valid number/i.test(e))).toBe(true);
  });

  it("flags a line with both debit and credit non-zero", () => {
    const text = "1000\t500\t500\n4000\t\t500";
    const r = parsePastedLines(text);
    expect(r.errors.some((e) => /XOR/i.test(e))).toBe(true);
  });

  it("warns on (and drops) a zero-amount line", () => {
    const text = "1000\t500\t\n4000\t0\t0\tjust a comment\n5000\t\t500";
    const r = parsePastedLines(text);
    expect(r.lines).toHaveLength(2);
    expect(r.warnings.some((w) => /both debit and credit are zero/i.test(w))).toBe(true);
    expect(r.isBalanced).toBe(true);
  });

  it("returns an explicit error on empty input", () => {
    const r = parsePastedLines("");
    expect(r.errors).toContain("No rows pasted.");
    expect(r.lines).toEqual([]);
  });
});

describe("parsePastedLines — row numbering", () => {
  it("numbers data rows starting at 1, after the header", () => {
    const text = "account\tdebit\tcredit\n1000\t500\t\n4000\t\t500";
    const r = parsePastedLines(text);
    expect(r.lines[0].rowNumber).toBe(1);
    expect(r.lines[1].rowNumber).toBe(2);
  });

  it("error messages reference the user-facing row number", () => {
    const text = "1000\t500\t\nBADROW\tNOT_A_NUMBER\t\n4000\t\t500";
    const r = parsePastedLines(text);
    expect(r.errors.some((e) => /Row 2/.test(e))).toBe(true);
  });
});
