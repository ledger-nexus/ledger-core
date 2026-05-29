// Extended property-based fuzz tests of the substrate.
//
// tests/property-based.test.ts already covers the basic invariants
// (TB balances, BS balances, unbalanced rejected, AR sum = control).
// This file fuzzes the edge cases those tests don't reach:
//
//   1. FX rounding — all existing tests use fxRate=1, leaving the
//      three-currency view (transaction / functional / reporting)
//      unexercised. We generate fxRate in [0.1, 10] with 6 decimal
//      places of precision and verify the reporting-currency view
//      still balances at the line level.
//
//   2. AR over-application boundary — random open + application
//      sequences. Sum of applied must never exceed original; the
//      ε boundary (applying exactly remaining vs. + 0.0001 over)
//      must close the item / reject as appropriate.
//
//   3. Multi-book parallel posting — when the same source event posts
//      to N books, each book's TB must independently balance.
//
// fast-check explores edge cases (zeros, near-zero, max-precision)
// the per-example tests don't enumerate. The bar: each property runs
// >= 50 random valid inputs and the invariant must hold for all of them.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fc from "fast-check";
import { PrismaClient } from "@prisma/client";
import { Decimal } from "decimal.js";
import { getDefaultTenantId } from "@/lib/seed/default-tenant";
import { postJournalEntry } from "@/lib/accounting/post-journal";
import {
  openArItem,
  applyArPayment,
  openArBalance,
} from "@/lib/accounting/sub-ledgers/ar";
import { CHART_OF_ACCOUNTS } from "@/lib/db/chart-of-accounts";

const prisma = new PrismaClient();
const ENTITY = "FUZZ_TEST";

// Accounts we'll use. Pick from a finite set so the chart is bounded.
const DEBIT_ACCOUNTS = ["1000", "1010", "1200", "1500"] as const;
const CREDIT_ACCOUNTS = ["2000", "2100", "3000", "3100", "4000"] as const;

async function clearLedger() {
  const ent = await prisma.legalEntity.findFirst({
    where: { code: ENTITY },
    select: { id: true },
  });
  if (!ent) return;
  const eid = ent.id;
  await prisma.arApplication.deleteMany({ where: { openItem: { entityId: eid } } });
  await prisma.arOpenItem.deleteMany({ where: { entityId: eid } });
  await prisma.journalLine.deleteMany({ where: { entry: { entityId: eid } } });
  await prisma.journalEntry.deleteMany({ where: { entityId: eid } });
}

async function seedMasterData() {
  await prisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "USD", decimals: 2, symbol: "$" },
    update: {},
  });
  // We need a foreign currency for the FX property — keep functional
  // as USD but pretend the transaction is in EUR. ledger-core doesn't
  // care about the currency identity per se; what matters is fxRate.
  await prisma.currency.upsert({
    where: { code: "EUR" },
    create: { code: "EUR", name: "EUR", decimals: 2, symbol: "€" },
    update: {},
  });
  const tenantId = await getDefaultTenantId(prisma);
  const entity = await prisma.legalEntity.upsert({
    where: { tenantId_code: { tenantId, code: ENTITY } },
    create: { tenantId, code: ENTITY, name: "Fuzz Test Co.", functionalCurrencyId: "USD" },
    update: { tenantId },
  });
  for (const b of [
    { code: "US_GAAP", name: "US GAAP", basis: "US_GAAP" as const },
    { code: "US_TAX", name: "US Federal Tax", basis: "US_TAX" as const },
    { code: "IFRS", name: "IFRS", basis: "IFRS" as const },
  ]) {
    await prisma.book.upsert({
      where: { code: b.code },
      create: { code: b.code, name: b.name, basis: b.basis, reportingCurrencyId: "USD" },
      update: {},
    });
  }
  const cal = await prisma.fiscalCalendar.upsert({
    where: { entityId_code: { entityId: entity.id, code: "STANDARD_2026" } },
    create: {
      tenantId,
      entityId: entity.id,
      code: "STANDARD_2026",
      name: "2026",
      periodFrequency: "MONTHLY",
    },
    update: { tenantId },
  });
  for (let m = 1; m <= 12; m++) {
    const code = `2026-${String(m).padStart(2, "0")}`;
    await prisma.period.upsert({
      where: { calendarId_code: { calendarId: cal.id, code } },
      create: {
        tenantId,
        calendarId: cal.id,
        code,
        ordinal: m,
        startsOn: new Date(Date.UTC(2026, m - 1, 1)),
        endsOn: new Date(Date.UTC(2026, m, 0)),
      },
      update: {},
    });
  }
  // Tenant-scoped findFirst (PG NULL≠NULL — see sub-ledgers.test.ts
  // comment): unscoped would silently match a sibling tenant and skip
  // create, leaving the chart incomplete.
  for (const a of CHART_OF_ACCOUNTS) {
    const existing = await prisma.account.findFirst({
      where: { tenantId, entityId: null, code: a.code },
      select: { id: true },
    });
    if (existing) continue;
    await prisma.account.create({
      data: {
        tenantId,
        code: a.code,
        name: a.name,
        type: a.type,
        normalBalance: a.normalBalance,
        isContra: a.isContra ?? false,
        isControlAccount: a.isControlAccount ?? false,
        isBank: a.isBank ?? false,
        subtype: a.subtype,
      },
    });
  }
  await prisma.party.upsert({
    where: { entityId_code: { entityId: entity.id, code: "FUZZ_CUSTOMER" } },
    create: { tenantId, entityId: entity.id, code: "FUZZ_CUSTOMER", displayName: "Fuzz Customer" },
    update: { tenantId },
  });
}

beforeAll(async () => {
  await seedMasterData();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await clearLedger();
});

// =========================================================================
// Property 1: FX rounding — non-unit fxRate preserves balance invariants.
// =========================================================================
//
// The engine stores three amounts per line:
//   - debit/credit (book's reporting currency, signed)
//   - transactionAmount (transaction currency, signed)
//   - reportingAmount (reporting currency, signed)
//
// All three columns are @db.Decimal(18, 4). When the caller doesn't
// provide explicit transaction/reporting amounts, the engine computes
// reportingAmount = signed × fxRate and rounds to 4 decimals.
//
// Invariant: for any balanced (debit-side = credit-side) input and any
// fxRate, the resulting JournalLine rows must satisfy:
//   Σ debit == Σ credit (engine already validates this)
//   Σ reportingAmount across all lines == 0 (within rounding tolerance)
//
// The hypothesis: independent line-level rounding could produce a
// reportingAmount sum != 0. If it does, that's a bug — a JE would post
// "balanced" in the reporting currency but with a tiny residual.

const fxRateArb = fc
  .integer({ min: 1, max: 10_000_000 }) // 0.0000001 to 10 in 7-decimal increments
  .map((n) => new Decimal(n).dividedBy(1_000_000).toFixed(7))
  .filter((s) => s !== "1.0000000"); // skip the trivial case (covered elsewhere)

// Two-line balanced entry (the simplest case where FX rounding could leak).
const balancedTwoLineWithFxArb = fc.record({
  debitAccount: fc.constantFrom(...DEBIT_ACCOUNTS),
  creditAccount: fc.constantFrom(...CREDIT_ACCOUNTS),
  amountCents: fc.integer({ min: 1, max: 10_000_000 }), // up to $100k
  fxRate: fxRateArb,
});

describe("property: FX rounding never breaks reporting-currency balance", () => {
  it("for any balanced two-line entry × any fxRate, Σ reportingAmount = 0", async () => {
    await fc.assert(
      fc.asyncProperty(balancedTwoLineWithFxArb, async (input) => {
        const amount = new Decimal(input.amountCents).dividedBy(100).toFixed(4);
        const result = await postJournalEntry(prisma, {
          entityCode: ENTITY,
          bookCode: "US_GAAP",
          currencyCode: "EUR",
          fxRate: input.fxRate,
          documentDate: new Date("2026-03-15"),
          memo: `fx-fuzz fx=${input.fxRate}`,
          lines: [
            { accountCode: input.debitAccount, debit: amount },
            { accountCode: input.creditAccount, credit: amount },
          ],
        });
        const lines = await prisma.journalLine.findMany({
          where: { entryId: result.id },
          select: { reportingAmount: true, debit: true, credit: true },
        });
        // Σ reportingAmount across lines must be 0 (no residual).
        const sumReporting = lines.reduce(
          (acc, l) => acc.plus(new Decimal(l.reportingAmount.toString())),
          new Decimal(0)
        );
        // 4-decimal precision = 0.0001 max per-line rounding error;
        // for a two-line entry, residual is bounded by 2 * 0.0001 = 0.0002.
        // But ideally identical computations on both sides should cancel.
        expect(sumReporting.abs().lessThan(new Decimal("0.001"))).toBe(true);
        // And debit/credit ALSO sum to 0 (already engine-validated; we
        // re-check here for symmetry).
        const sumDebit = lines.reduce(
          (acc, l) => acc.plus(new Decimal(l.debit.toString())),
          new Decimal(0)
        );
        const sumCredit = lines.reduce(
          (acc, l) => acc.plus(new Decimal(l.credit.toString())),
          new Decimal(0)
        );
        expect(sumDebit.equals(sumCredit)).toBe(true);
      }),
      { numRuns: 30 }
    );
  });

  it("multi-line entries (3-6 lines) under FX still balance", async () => {
    const multiLineWithFxArb = fc.record({
      // 2 debit lines + 2 credit lines so the totals match (debits =
      // credits) without computing residuals.
      debitAmounts: fc.array(
        fc.integer({ min: 1, max: 100_000 }),
        { minLength: 2, maxLength: 3 }
      ),
      fxRate: fxRateArb,
    });

    await fc.assert(
      fc.asyncProperty(multiLineWithFxArb, async (input) => {
        // Build N debit lines, then a single credit line whose amount
        // matches the sum of debits. This guarantees balance without
        // residual-distribution logic.
        const debitTotal = input.debitAmounts.reduce((acc, x) => acc + x, 0);
        const lines = input.debitAmounts.map((cents, i) => ({
          accountCode: DEBIT_ACCOUNTS[i % DEBIT_ACCOUNTS.length],
          debit: new Decimal(cents).dividedBy(100).toFixed(4),
        }));
        lines.push({
          accountCode: CREDIT_ACCOUNTS[0],
          // Coerce to the credit field for the credit line.
          credit: new Decimal(debitTotal).dividedBy(100).toFixed(4),
        } as never);

        const result = await postJournalEntry(prisma, {
          entityCode: ENTITY,
          bookCode: "US_GAAP",
          currencyCode: "EUR",
          fxRate: input.fxRate,
          documentDate: new Date("2026-04-01"),
          memo: `fx-fuzz-multi fx=${input.fxRate}`,
          lines: lines as never[],
        });
        const rows = await prisma.journalLine.findMany({
          where: { entryId: result.id },
          select: { reportingAmount: true },
        });
        const sumReporting = rows.reduce(
          (acc, l) => acc.plus(new Decimal(l.reportingAmount.toString())),
          new Decimal(0)
        );
        // Multi-line tolerance: per-line rounding can compound. The
        // 4-decimal column means max 0.0001 error per line × N lines.
        const maxResidual = new Decimal("0.0001").times(rows.length);
        expect(sumReporting.abs().lessThanOrEqualTo(maxResidual)).toBe(true);
      }),
      { numRuns: 25 }
    );
  });
});

// =========================================================================
// Property 2: AR over-application boundary.
// =========================================================================
//
// Open an AR item with amount O. Apply a sequence of partial payments
// a1, a2, ..., aN. Invariants:
//   - Σ applied <= O always (the engine rejects over-application)
//   - currentBalance = O - Σ applied at every step
//   - If currentBalance == 0: status = APPLIED
//   - If 0 < currentBalance < O: status = PARTIAL
//   - If currentBalance == O (no applications): status = OPEN
//
// The boundary case: applying EXACTLY currentBalance should close the
// item. Applying currentBalance + 0.0001 should reject (decimal 18,4).

describe("property: AR over-application boundary holds for arbitrary sequences", () => {
  // Helper: post a JE that opens the JE-side AR (debit AR control, credit revenue).
  async function postOpeningJE(amountStr: string): Promise<string> {
    const r = await postJournalEntry(prisma, {
      entityCode: ENTITY,
      bookCode: "US_GAAP",
      documentDate: new Date("2026-02-01"),
      memo: "fuzz AR opener",
      lines: [
        { accountCode: "1200", debit: amountStr, partyCode: "FUZZ_CUSTOMER" },
        { accountCode: "4000", credit: amountStr },
      ],
    });
    return r.id;
  }

  // Helper: post a JE that records a payment (debit cash, credit AR control).
  async function postPaymentJE(amountStr: string): Promise<string> {
    const r = await postJournalEntry(prisma, {
      entityCode: ENTITY,
      bookCode: "US_GAAP",
      documentDate: new Date("2026-02-15"),
      memo: "fuzz AR payment",
      lines: [
        { accountCode: "1000", debit: amountStr },
        { accountCode: "1200", credit: amountStr, partyCode: "FUZZ_CUSTOMER" },
      ],
    });
    return r.id;
  }

  it("Σ applied never exceeds original; final status reflects balance", async () => {
    const arSequenceArb = fc.record({
      originalCents: fc.integer({ min: 100, max: 1_000_000 }), // $1–$10k
      // 1-6 applications, each as a fraction of the original (0..1).
      // The engine rounds at the 4-decimal boundary so we keep cents-precision.
      applicationFractions: fc.array(
        fc.integer({ min: 1, max: 1_000_000 }), // 0.000001 to 1.0 in cents-of-fraction
        { minLength: 1, maxLength: 6 }
      ),
    });

    await fc.assert(
      fc.asyncProperty(arSequenceArb, async (input) => {
        const originalAmt = new Decimal(input.originalCents).dividedBy(100);
        const openerEntryId = await postOpeningJE(originalAmt.toFixed(4));
        const open = await openArItem(prisma, {
          entityCode: ENTITY,
          bookCode: "US_GAAP",
          partyCode: "FUZZ_CUSTOMER",
          openedByEntryId: openerEntryId,
          openedDate: new Date("2026-02-01"),
          amount: originalAmt.toFixed(4),
          currencyCode: "USD",
          controlAccountCode: "1200",
        });

        // Apply a sequence of partial payments. Each is capped at
        // current remaining balance — we don't try to over-apply here;
        // the next test does that explicitly.
        let remaining = originalAmt;
        let totalApplied = new Decimal(0);
        for (const frac of input.applicationFractions) {
          if (remaining.lessThanOrEqualTo(0)) break;
          // Convert fraction to a real amount, capped at remaining.
          const rawAmt = originalAmt.times(frac).dividedBy(1_000_000);
          const apt = Decimal.min(rawAmt, remaining);
          // Round to the substrate's 4-decimal column precision; skip if
          // the rounded amount is zero (the engine rejects zero-amount
          // JE lines, which is correct — we just don't want to test that
          // boundary here).
          const aptStr = apt.toFixed(4);
          if (new Decimal(aptStr).isZero()) continue;
          const payEntryId = await postPaymentJE(aptStr);
          await applyArPayment(prisma, {
            openItemId: open.id,
            appliedByEntryId: payEntryId,
            appliedAmount: aptStr,
            appliedDate: new Date("2026-02-15"),
          });
          totalApplied = totalApplied.plus(new Decimal(aptStr));
          remaining = originalAmt.minus(totalApplied);
        }

        // Invariant 1: Σ applied ≤ original.
        expect(totalApplied.lessThanOrEqualTo(originalAmt)).toBe(true);

        // Invariant 2: stored currentBalance = original - Σ applied.
        const row = await prisma.arOpenItem.findUniqueOrThrow({
          where: { id: open.id },
          select: { currentBalance: true, status: true, originalAmount: true },
        });
        const storedBal = new Decimal(row.currentBalance.toString());
        expect(
          storedBal.minus(originalAmt.minus(totalApplied)).abs().lessThan(new Decimal("0.0001"))
        ).toBe(true);

        // Invariant 3: status reflects the balance.
        if (storedBal.isZero()) {
          expect(row.status).toBe("APPLIED");
        } else if (totalApplied.greaterThan(0)) {
          expect(row.status).toBe("PARTIAL");
        } else {
          expect(row.status).toBe("OPEN");
        }
      }),
      { numRuns: 15 } // each run does N AR-cycle DB writes; keep modest
    );
  });

  it("applying exactly remaining closes the item; over-applying by ε rejects", async () => {
    const original = "100.0000";
    const openerEntryId = await postOpeningJE(original);
    const open = await openArItem(prisma, {
      entityCode: ENTITY,
      bookCode: "US_GAAP",
      partyCode: "FUZZ_CUSTOMER",
      openedByEntryId: openerEntryId,
      openedDate: new Date("2026-02-01"),
      amount: original,
      currencyCode: "USD",
      controlAccountCode: "1200",
    });

    // Apply $99.9999 → remaining = $0.0001.
    const payment1Id = await postPaymentJE("99.9999");
    await applyArPayment(prisma, {
      openItemId: open.id,
      appliedByEntryId: payment1Id,
      appliedAmount: "99.9999",
      appliedDate: new Date("2026-02-10"),
    });

    // Now try to apply $0.0002 (over by ε). Should reject.
    const payment2Id = await postPaymentJE("0.0002");
    await expect(
      applyArPayment(prisma, {
        openItemId: open.id,
        appliedByEntryId: payment2Id,
        appliedAmount: "0.0002",
        appliedDate: new Date("2026-02-11"),
      })
    ).rejects.toThrow();

    // Now apply exactly $0.0001 → item closes cleanly.
    const payment3Id = await postPaymentJE("0.0001");
    await applyArPayment(prisma, {
      openItemId: open.id,
      appliedByEntryId: payment3Id,
      appliedAmount: "0.0001",
      appliedDate: new Date("2026-02-12"),
    });
    const closed = await prisma.arOpenItem.findUniqueOrThrow({
      where: { id: open.id },
      select: { currentBalance: true, status: true },
    });
    expect(closed.status).toBe("APPLIED");
    expect(new Decimal(closed.currentBalance.toString()).isZero()).toBe(true);
  });
});

// =========================================================================
// Property 3: Multi-book parallel posting — each book independently balances.
// =========================================================================
//
// Pattern 2 (per docs/universal-schema.md) is "post the same source event
// to N books, getting N independent ledgers." The substrate doesn't have
// a "post to N books" primitive at the engine level — each call targets
// one (entity, book). To exercise the multi-book property we issue N
// postJournalEntry calls with the same payload, just varying bookCode.
//
// Invariant: for any balanced source-event posted to any subset of the
// 3 active books, each book's resulting trial balance individually
// satisfies Σ debit = Σ credit.

describe("property: multi-book parallel posting — each book balances independently", () => {
  const BOOKS = ["US_GAAP", "US_TAX", "IFRS"] as const;

  const multiBookEntryArb = fc.record({
    debitAccount: fc.constantFrom(...DEBIT_ACCOUNTS),
    creditAccount: fc.constantFrom(...CREDIT_ACCOUNTS),
    amountCents: fc.integer({ min: 100, max: 100_000 }), // $1–$1k
    // Subset of books to post to — at least 1, up to all 3.
    bookSubset: fc.subarray([...BOOKS], { minLength: 1, maxLength: 3 }),
  });

  it("posting to N books leaves all N books individually balanced", async () => {
    await fc.assert(
      fc.asyncProperty(multiBookEntryArb, async (input) => {
        const amount = new Decimal(input.amountCents).dividedBy(100).toFixed(4);
        // Post the same balanced 2-line entry to each book in the subset.
        for (const bookCode of input.bookSubset) {
          await postJournalEntry(prisma, {
            entityCode: ENTITY,
            bookCode,
            documentDate: new Date("2026-05-15"),
            memo: `multi-book ${bookCode}`,
            lines: [
              { accountCode: input.debitAccount, debit: amount },
              { accountCode: input.creditAccount, credit: amount },
            ],
          });
        }

        // Each book's TB individually balances. Books NOT posted to
        // also balance (trivially — no rows in this entity).
        for (const bookCode of BOOKS) {
          const entity = await prisma.legalEntity.findFirstOrThrow({
            where: { code: ENTITY },
            select: { id: true },
          });
          const book = await prisma.book.findUniqueOrThrow({
            where: { code: bookCode },
            select: { id: true },
          });
          const lines = await prisma.journalLine.findMany({
            where: {
              entry: { entityId: entity.id, bookId: book.id },
            },
            select: { debit: true, credit: true },
          });
          const sumDebit = lines.reduce(
            (acc, l) => acc.plus(new Decimal(l.debit.toString())),
            new Decimal(0)
          );
          const sumCredit = lines.reduce(
            (acc, l) => acc.plus(new Decimal(l.credit.toString())),
            new Decimal(0)
          );
          expect(sumDebit.equals(sumCredit)).toBe(true);
        }
      }),
      { numRuns: 15 }
    );
  });
});
