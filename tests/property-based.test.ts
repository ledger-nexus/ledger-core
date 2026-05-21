// Property-based tests using fast-check.
//
// Per-example invariant tests check specific cases. Property-based tests
// generate ARBITRARY inputs that satisfy a precondition and assert that
// invariants hold for all of them. fast-check explores edge cases the
// human author wouldn't think of.
//
// The properties below stress the posting boundary itself: any balanced
// entry should be accepted; any unbalanced one rejected; any sequence of
// balanced entries leaves the TB and BS balanced; the AR open-item
// reconciliation invariant survives arbitrary application sequences.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fc from "fast-check";
import { PrismaClient } from "@prisma/client";
import { Decimal } from "decimal.js";
import { postJournalEntry } from "../src/lib/accounting/post-journal";
import { getTrialBalance, getBalanceSheet } from "../src/lib/accounting/reports";
import { UnbalancedEntryError } from "../src/lib/accounting/types";
import { openArItem, applyArPayment, openArBalance } from "../src/lib/accounting/sub-ledgers/ar";
import { CHART_OF_ACCOUNTS } from "../src/lib/db/chart-of-accounts";

const prisma = new PrismaClient();
const ENTITY = "PROP_TEST";
const SCOPE = { entityCode: ENTITY, bookCode: "US_GAAP" };

// Account codes safe to use in tests (small enough that we can pick from a
// finite set). All asset/liability/equity so the BS invariant has real
// movement to check.
const ACCOUNTS = ["1000", "1010", "1200", "2000", "2100", "3000", "3100"] as const;

async function clearLedger() {
  await prisma.arApplication.deleteMany();
  await prisma.apApplication.deleteMany();
  await prisma.arOpenItem.deleteMany();
  await prisma.apOpenItem.deleteMany();
  await prisma.journalLine.deleteMany();
  await prisma.journalEntry.deleteMany();
}

async function seedMasterData() {
  await prisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    update: {},
  });
  const entity = await prisma.legalEntity.upsert({
    where: { code: ENTITY },
    create: { code: ENTITY, name: "Property Test Co.", functionalCurrencyId: "USD" },
    update: {},
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
  const calendar = await prisma.fiscalCalendar.upsert({
    where: { entityId_code: { entityId: entity.id, code: "STANDARD_2026" } },
    create: {
      entityId: entity.id,
      code: "STANDARD_2026",
      name: "2026",
      periodFrequency: "MONTHLY",
    },
    update: {},
  });
  for (let m = 1; m <= 12; m++) {
    const code = `2026-${String(m).padStart(2, "0")}`;
    await prisma.period.upsert({
      where: { calendarId_code: { calendarId: calendar.id, code } },
      create: {
        calendarId: calendar.id,
        code,
        ordinal: m,
        startsOn: new Date(Date.UTC(2026, m - 1, 1)),
        endsOn: new Date(Date.UTC(2026, m, 0)),
      },
      update: {},
    });
  }
  for (const a of CHART_OF_ACCOUNTS) {
    await prisma.account.upsert({
      where: { entityId_code: { entityId: null as any, code: a.code } as any },
      create: {
        code: a.code,
        name: a.name,
        type: a.type,
        normalBalance: a.normalBalance,
        isContra: a.isContra ?? false,
        isControlAccount: a.isControlAccount ?? false,
        isBank: a.isBank ?? false,
        subtype: a.subtype,
      },
      update: {},
    });
  }
  await prisma.party.upsert({
    where: { entityId_code: { entityId: entity.id, code: "PROP_CUSTOMER" } },
    create: { entityId: entity.id, code: "PROP_CUSTOMER", displayName: "Prop Test Customer" },
    update: {},
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
// fast-check arbitraries — generators for balanced entries
// =========================================================================

// Two-line balanced entry: pick two distinct accounts and a positive amount.
// Amount is in cents to avoid fractional-cent precision noise — the
// invariant holds either way, but cents keeps logs readable.
const balancedTwoLineEntryArb = fc
  .record({
    debitAccountIdx: fc.integer({ min: 0, max: ACCOUNTS.length - 1 }),
    creditAccountOffset: fc.integer({ min: 1, max: ACCOUNTS.length - 1 }),
    amountCents: fc.integer({ min: 1, max: 1_000_000 }), // up to $10,000
  })
  .map(({ debitAccountIdx, creditAccountOffset, amountCents }) => {
    const creditAccountIdx = (debitAccountIdx + creditAccountOffset) % ACCOUNTS.length;
    const amount = (amountCents / 100).toFixed(2);
    return {
      debitAccountCode: ACCOUNTS[debitAccountIdx],
      creditAccountCode: ACCOUNTS[creditAccountIdx],
      amount,
    };
  });

// Multi-line balanced entry: K debits totaling X, K credits totaling X.
// fast-check generates the debit amounts; the last credit absorbs the
// rounding remainder so the entry is exactly balanced.
const balancedMultiLineEntryArb = fc
  .record({
    debitAmountsCents: fc.array(fc.integer({ min: 1, max: 100_000 }), { minLength: 2, maxLength: 4 }),
    creditAmountsCents: fc.array(fc.integer({ min: 1, max: 100_000 }), { minLength: 2, maxLength: 4 }),
  })
  .map(({ debitAmountsCents, creditAmountsCents }) => {
    const debitTotal = debitAmountsCents.reduce((a, b) => a + b, 0);
    const creditTotal = creditAmountsCents.reduce((a, b) => a + b, 0);
    // Absorb the diff into the last credit so totals match.
    const diff = debitTotal - creditTotal;
    const adjustedCredits = [...creditAmountsCents];
    adjustedCredits[adjustedCredits.length - 1] += diff;
    // If the last credit went negative (unlikely with min=1 but possible
    // if diff is very negative), swap it. Easier: filter precondition.
    if (adjustedCredits[adjustedCredits.length - 1] <= 0) {
      return null;
    }
    return {
      debitLines: debitAmountsCents.map((c, i) => ({
        accountCode: ACCOUNTS[i % ACCOUNTS.length],
        amount: (c / 100).toFixed(2),
      })),
      creditLines: adjustedCredits.map((c, i) => ({
        accountCode: ACCOUNTS[(i + ACCOUNTS.length / 2) % ACCOUNTS.length],
        amount: (c / 100).toFixed(2),
      })),
    };
  })
  .filter((x): x is NonNullable<typeof x> => x !== null);

// =========================================================================
// Property 1: any balanced two-line entry is accepted; TB balances after
// =========================================================================

describe("property: balanced entries produce balanced trial balances", () => {
  it("two-line entries — TB.totalDebit === TB.totalCredit", async () => {
    await fc.assert(
      fc.asyncProperty(balancedTwoLineEntryArb, async (entry) => {
        await clearLedger();
        await postJournalEntry(prisma, {
          ...SCOPE,
          documentDate: new Date("2026-03-15"),
          memo: "prop test 2L",
          source: "SEED",
          lines: [
            { accountCode: entry.debitAccountCode, debit: entry.amount },
            { accountCode: entry.creditAccountCode, credit: entry.amount },
          ],
        });
        const tb = await getTrialBalance(prisma, SCOPE, new Date("2026-12-31"));
        return tb.totalDebit.equals(tb.totalCredit);
      }),
      { numRuns: 20 } // keep round trip count modest — each run hits Postgres
    );
  });

  it("multi-line entries — TB balances after each post", async () => {
    await fc.assert(
      fc.asyncProperty(balancedMultiLineEntryArb, async (entry) => {
        await clearLedger();
        const lines = [
          ...entry.debitLines.map((l) => ({ accountCode: l.accountCode, debit: l.amount })),
          ...entry.creditLines.map((l) => ({ accountCode: l.accountCode, credit: l.amount })),
        ];
        await postJournalEntry(prisma, {
          ...SCOPE,
          documentDate: new Date("2026-03-15"),
          memo: "prop test ML",
          source: "SEED",
          lines,
        });
        const tb = await getTrialBalance(prisma, SCOPE, new Date("2026-12-31"));
        return tb.totalDebit.equals(tb.totalCredit);
      }),
      { numRuns: 15 }
    );
  });
});

// =========================================================================
// Property 2: unbalanced entries are always rejected
// =========================================================================

describe("property: unbalanced entries are always rejected", () => {
  it("any debit/credit pair with non-zero diff throws UnbalancedEntryError", async () => {
    const unbalancedArb = fc
      .record({
        accountIdx: fc.integer({ min: 0, max: ACCOUNTS.length - 1 }),
        offset: fc.integer({ min: 1, max: ACCOUNTS.length - 1 }),
        debitCents: fc.integer({ min: 1, max: 100_000 }),
        diffCents: fc.integer({ min: 1, max: 100_000 }), // strictly nonzero
      });

    await fc.assert(
      fc.asyncProperty(unbalancedArb, async ({ accountIdx, offset, debitCents, diffCents }) => {
        await clearLedger();
        const debit = (debitCents / 100).toFixed(2);
        const credit = ((debitCents + diffCents) / 100).toFixed(2);
        try {
          await postJournalEntry(prisma, {
            ...SCOPE,
            documentDate: new Date("2026-03-15"),
            memo: "prop unbalanced",
            source: "SEED",
            lines: [
              { accountCode: ACCOUNTS[accountIdx], debit },
              { accountCode: ACCOUNTS[(accountIdx + offset) % ACCOUNTS.length], credit },
            ],
          });
          return false; // post succeeded — invariant violated
        } catch (e) {
          return e instanceof UnbalancedEntryError;
        }
      }),
      { numRuns: 20 }
    );
  });
});

// =========================================================================
// Property 3: arbitrary sequence of balanced entries leaves BS balanced
// =========================================================================

describe("property: sequence of balanced entries leaves BS balanced", () => {
  it("3-7 entries in random order — BS.balances === true throughout", async () => {
    const sequenceArb = fc.array(balancedTwoLineEntryArb, { minLength: 3, maxLength: 7 });

    await fc.assert(
      fc.asyncProperty(sequenceArb, async (entries) => {
        await clearLedger();
        for (const entry of entries) {
          await postJournalEntry(prisma, {
            ...SCOPE,
            documentDate: new Date("2026-03-15"),
            memo: "prop seq",
            source: "SEED",
            lines: [
              { accountCode: entry.debitAccountCode, debit: entry.amount },
              { accountCode: entry.creditAccountCode, credit: entry.amount },
            ],
          });
        }
        const bs = await getBalanceSheet(prisma, SCOPE, new Date("2026-12-31"));
        return bs.balances === true && bs.totalAssets.equals(bs.totalLiabilitiesAndEquity);
      }),
      { numRuns: 10 }
    );
  });
});

// =========================================================================
// Property 4: AR open-item invariant survives arbitrary apply sequences
// =========================================================================

describe("property: AR open-item sum equals AR control after arbitrary applies", () => {
  it("multiple partial applications preserve sum-of-open = control", async () => {
    // Generator: open one item with random amount, then apply between 0
    // and 5 partial payments adding up to no more than the open balance.
    const lifecycleArb = fc
      .record({
        invoiceCents: fc.integer({ min: 100, max: 100_000 }),
        paymentSplits: fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 0, maxLength: 5 }),
      })
      .map(({ invoiceCents, paymentSplits }) => {
        if (paymentSplits.length === 0) return { invoiceCents, paymentCents: [] as number[] };
        // Scale splits so their sum is ≤ invoiceCents.
        const totalSplit = paymentSplits.reduce((a, b) => a + b, 0);
        const scaled = paymentSplits.map((s) => Math.floor((s / totalSplit) * invoiceCents * 0.8));
        return { invoiceCents, paymentCents: scaled.filter((c) => c > 0) };
      });

    await fc.assert(
      fc.asyncProperty(lifecycleArb, async ({ invoiceCents, paymentCents }) => {
        await clearLedger();
        const invoiceAmt = (invoiceCents / 100).toFixed(2);

        const invoiceEntry = await postJournalEntry(prisma, {
          ...SCOPE,
          documentDate: new Date("2026-02-01"),
          memo: "prop invoice",
          source: "SEED",
          lines: [
            { accountCode: "1200", debit: invoiceAmt, partyCode: "PROP_CUSTOMER" },
            { accountCode: "4000", credit: invoiceAmt },
          ],
        });
        const item = await openArItem(prisma, {
          entityCode: ENTITY,
          bookCode: "US_GAAP",
          partyCode: "PROP_CUSTOMER",
          openedByEntryId: invoiceEntry.id,
          openedDate: new Date("2026-02-01"),
          amount: invoiceAmt,
          currencyCode: "USD",
          controlAccountCode: "1200",
        });

        for (const cents of paymentCents) {
          const payAmt = (cents / 100).toFixed(2);
          const paymentEntry = await postJournalEntry(prisma, {
            ...SCOPE,
            documentDate: new Date("2026-03-01"),
            memo: "prop payment",
            source: "SEED",
            lines: [
              { accountCode: "1000", debit: payAmt },
              { accountCode: "1200", credit: payAmt, partyCode: "PROP_CUSTOMER" },
            ],
          });
          await applyArPayment(prisma, {
            openItemId: item.id,
            appliedByEntryId: paymentEntry.id,
            appliedAmount: payAmt,
            appliedDate: new Date("2026-03-01"),
          });
        }

        const openBal = await openArBalance(prisma, ENTITY, "US_GAAP");
        const bs = await getBalanceSheet(prisma, SCOPE, new Date("2026-12-31"));
        const arRow = bs.assets.find((a) => a.code === "1200");
        if (!arRow) return openBal.isZero();
        return openBal.equals(arRow.amount);
      }),
      { numRuns: 10 }
    );
  });
});
