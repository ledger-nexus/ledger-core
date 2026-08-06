// CSV parsing + dedupe hashing for the bank feed. Parsing must swallow the
// header shapes real banks emit; the hash must be stable so re-import is a
// no-op.

import { describe, it, expect } from "vitest";
import { Decimal } from "@/lib/utils/decimal";
import { parseBankCsv, computeDedupeHash, BankCsvError } from "../src/lib/banking/import";

describe("parseBankCsv", () => {
  it("parses a signed single-amount CSV", () => {
    const csv = [
      "Date,Description,Amount",
      "2026-07-15,ACME PAYROLL,1000.00",
      "2026-07-16,WHOLE FOODS,-52.40",
    ].join("\n");
    const r = parseBankCsv(csv);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0].description).toBe("ACME PAYROLL");
    expect(r.rows[0].amount.equals(new Decimal("1000"))).toBe(true);
    expect(r.rows[1].amount.equals(new Decimal("-52.40"))).toBe(true);
  });

  it("handles separate Deposit/Withdrawal columns (in +, out -)", () => {
    const csv = [
      "Posted Date,Memo,Deposit,Withdrawal",
      "07/15/2026,Refund,25.00,",
      "07/16/2026,Gas,,40.00",
    ].join("\n");
    const r = parseBankCsv(csv);
    expect(r.rows[0].amount.equals(new Decimal("25"))).toBe(true);
    expect(r.rows[1].amount.equals(new Decimal("-40"))).toBe(true);
  });

  it("handles $, thousands, and accounting parens for negatives", () => {
    const csv = ["Date,Description,Amount", "2026-07-15,Big bill,\"($1,234.56)\""].join("\n");
    const r = parseBankCsv(csv);
    expect(r.rows[0].amount.equals(new Decimal("-1234.56"))).toBe(true);
  });

  it("skips metadata lines above the header", () => {
    const csv = [
      "Account: Checking ****1234",
      "Statement period",
      "Date,Description,Amount",
      "2026-07-15,Coffee,-4.50",
    ].join("\n");
    const r = parseBankCsv(csv);
    expect(r.rows).toHaveLength(1);
  });

  it("skips zero-amount and malformed rows rather than failing the file", () => {
    const csv = [
      "Date,Description,Amount",
      "2026-07-15,Good,10.00",
      "2026-07-16,Zero,0.00",
      ",No date,5.00",
    ].join("\n");
    const r = parseBankCsv(csv);
    expect(r.rows).toHaveLength(1);
    expect(r.skipped).toBe(2);
  });

  it("throws a clear error when there is no amount column", () => {
    const csv = ["Date,Description", "2026-07-15,Coffee"].join("\n");
    expect(() => parseBankCsv(csv)).toThrow(BankCsvError);
  });
});

describe("computeDedupeHash", () => {
  const base = {
    bankAccountId: "acct-1",
    postedDate: new Date(Date.UTC(2026, 6, 15)),
    amount: new Decimal("-52.40"),
    description: "WHOLE FOODS #123",
    externalRef: "TXN-9",
  };

  it("is stable for the same content (re-import is a no-op)", () => {
    expect(computeDedupeHash(base)).toBe(computeDedupeHash({ ...base }));
  });

  it("ignores case + whitespace in the description", () => {
    expect(computeDedupeHash(base)).toBe(
      computeDedupeHash({ ...base, description: "  whole   foods #123 " })
    );
  });

  it("changes when the amount, date, or account changes", () => {
    expect(computeDedupeHash(base)).not.toBe(
      computeDedupeHash({ ...base, amount: new Decimal("-52.41") })
    );
    expect(computeDedupeHash(base)).not.toBe(
      computeDedupeHash({ ...base, postedDate: new Date(Date.UTC(2026, 6, 16)) })
    );
    expect(computeDedupeHash(base)).not.toBe(
      computeDedupeHash({ ...base, bankAccountId: "acct-2" })
    );
  });
});
