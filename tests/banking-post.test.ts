// The bank-feed categorization posts real journal entries, so the
// debit/credit derivation is money math and gets pinned here. Covers both
// account normal sides and both money directions — the four cases that must
// all balance and move the category the right way.

import { describe, it, expect } from "vitest";
import { Decimal } from "decimal.js";
import { deriveCategorizationLines } from "../src/lib/banking/post";

function balanced(lines: { debit?: string; credit?: string }[]): boolean {
  const dr = lines.reduce((a, l) => a.plus(l.debit ?? 0), new Decimal(0));
  const cr = lines.reduce((a, l) => a.plus(l.credit ?? 0), new Decimal(0));
  return dr.equals(cr);
}

describe("deriveCategorizationLines", () => {
  it("bank deposit (debit-normal, +): Dr bank / Cr category", () => {
    const [bank, cat] = deriveCategorizationLines({
      bankAccountCode: "1000",
      bankNormalIsDebit: true,
      categoryAccountCode: "4000",
      amount: new Decimal("1000"),
    });
    expect(bank).toMatchObject({ accountCode: "1000", debit: "1000.0000" });
    expect(cat).toMatchObject({ accountCode: "4000", credit: "1000.0000" });
    expect(balanced([bank, cat])).toBe(true);
  });

  it("bank spend (debit-normal, -): Cr bank / Dr category", () => {
    const [bank, cat] = deriveCategorizationLines({
      bankAccountCode: "1000",
      bankNormalIsDebit: true,
      categoryAccountCode: "5200",
      amount: new Decimal("-50"),
    });
    expect(bank).toMatchObject({ accountCode: "1000", credit: "50.0000" });
    expect(cat).toMatchObject({ accountCode: "5200", debit: "50.0000" });
    expect(balanced([bank, cat])).toBe(true);
  });

  it("card charge (credit-normal, +): Cr card / Dr category — liability grows", () => {
    const [bank, cat] = deriveCategorizationLines({
      bankAccountCode: "2000",
      bankNormalIsDebit: false,
      categoryAccountCode: "5200",
      amount: new Decimal("50"),
    });
    expect(bank).toMatchObject({ accountCode: "2000", credit: "50.0000" });
    expect(cat).toMatchObject({ accountCode: "5200", debit: "50.0000" });
    expect(balanced([bank, cat])).toBe(true);
  });

  it("card payment (credit-normal, -): Dr card / Cr category — a transfer down", () => {
    const [bank, cat] = deriveCategorizationLines({
      bankAccountCode: "2000",
      bankNormalIsDebit: false,
      categoryAccountCode: "1000",
      amount: new Decimal("-200"),
    });
    expect(bank).toMatchObject({ accountCode: "2000", debit: "200.0000" });
    expect(cat).toMatchObject({ accountCode: "1000", credit: "200.0000" });
    expect(balanced([bank, cat])).toBe(true);
  });

  it("carries the description onto both lines", () => {
    const [bank, cat] = deriveCategorizationLines({
      bankAccountCode: "1000",
      bankNormalIsDebit: true,
      categoryAccountCode: "5200",
      amount: new Decimal("-9.99"),
      description: "COFFEE",
    });
    expect(bank.description).toBe("COFFEE");
    expect(cat.description).toBe("COFFEE");
  });
});
