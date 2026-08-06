// postRevaluation tests (src/lib/accounting/revaluation-posting.ts).
//
// Pins the write path on top of the computeRevaluation engine:
//   1. Posts a balanced adjustment JE (source=AI_APPROVED, FX_REVAL
//      lineage) + a reversing entry dated day 1 of the next period,
//      linked via reversalOfId. Cash +$30 + AR +$50 → offset 8300 −$80.
//   2. Reverse-next-period mechanic — the gain stands at period end
//      (8300 shows the $80 gain as of 2026-06-30) and nets to zero once
//      the reversal lands (as of 2026-07-31). This is why each period
//      revalues against the original basis without compounding.
//   3. Idempotent — a second call finds the existing adjustment on the
//      lineage triple and is a no-op (no duplicate JEs).
//   4. No-op — a period with no foreign monetary balances posts nothing.
//
// Same multi-currency fixture as fx-revaluation.test.ts (USD entity
// holding EUR balances), plus the 8300 Unrealized FX Gain/Loss account
// and a July period so the reversal lands cleanly.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { Decimal } from "@/lib/utils/decimal";

import { postJournalEntry } from "@/lib/accounting/post-journal";
import { postRevaluation } from "@/lib/accounting/revaluation-posting";
import { getTrialBalance } from "@/lib/accounting/reports";

const prisma = new PrismaClient();
const SUFFIX = "fxp" + Date.now().toString(36) + Math.floor(Math.random() * 9999);
const ENTITY = `FXP-${SUFFIX}`.slice(0, 50);

let tenantId: string;
let entityId: string;
let bookId: string;
let partyId: string;

const CASH = `FXPCASH_${SUFFIX}`.slice(0, 20);
const AR = `FXPAR_${SUFFIX}`.slice(0, 20);
const EQ = `FXPEQ_${SUFFIX}`.slice(0, 20);
const REV = `FXPREV_${SUFFIX}`.slice(0, 20);
const FXGL = `FXPGL_${SUFFIX}`.slice(0, 20); // Unrealized FX Gain/Loss

beforeAll(async () => {
  for (const code of ["USD", "EUR"]) {
    await prisma.currency.upsert({
      where: { code },
      create: { code, name: code, decimals: 2, symbol: code === "USD" ? "$" : "€" },
      update: {},
    });
  }
  await prisma.fxRate.upsert({
    where: {
      fromCurrencyId_toCurrencyId_asOf_rateType: {
        fromCurrencyId: "EUR",
        toCurrencyId: "USD",
        asOf: new Date("2026-06-30"),
        rateType: "CLOSE",
      },
    },
    create: {
      fromCurrencyId: "EUR",
      toCurrencyId: "USD",
      asOf: new Date("2026-06-30"),
      rateType: "CLOSE",
      rate: "1.1150",
    },
    update: { rate: "1.1150" },
  });

  const owner = await prisma.user.findUnique({
    where: { email: "controller@northwind.test" },
    select: { id: true },
  });
  if (!owner) throw new Error("Run Northwind seed first.");

  const tenant = await prisma.tenant.create({
    data: { slug: `fxp-${SUFFIX}`.slice(0, 60), name: `FX Post Tenant ${SUFFIX}`, ownerUserId: owner.id },
  });
  tenantId = tenant.id;
  await prisma.tenantMembership.create({ data: { tenantId, userId: owner.id, role: "OWNER" } });

  const entity = await prisma.legalEntity.create({
    data: { tenantId, code: ENTITY, name: "FX Post Co.", functionalCurrencyId: "USD" },
    select: { id: true },
  });
  entityId = entity.id;

  const book = await prisma.book.upsert({
    where: { code: "US_GAAP" },
    create: { code: "US_GAAP", name: "US GAAP", basis: "US_GAAP", reportingCurrencyId: "USD" },
    update: {},
  });
  bookId = book.id;

  const cal = await prisma.fiscalCalendar.create({
    data: { tenantId, entityId, code: `FXPC-${SUFFIX}`.slice(0, 32), name: "Cal", periodFrequency: "MONTHLY" },
    select: { id: true },
  });
  await prisma.period.createMany({
    data: [
      { tenantId, calendarId: cal.id, code: "2026-05", ordinal: 5, startsOn: new Date("2026-05-01"), endsOn: new Date("2026-05-31") },
      { tenantId, calendarId: cal.id, code: "2026-06", ordinal: 6, startsOn: new Date("2026-06-01"), endsOn: new Date("2026-06-30") },
      { tenantId, calendarId: cal.id, code: "2026-07", ordinal: 7, startsOn: new Date("2026-07-01"), endsOn: new Date("2026-07-31") },
    ],
  });

  await prisma.account.createMany({
    data: [
      { tenantId, entityId, code: CASH, name: "FX Cash", type: "ASSET", normalBalance: "DEBIT", isBank: true, isMonetary: true, subtype: "CASH" },
      { tenantId, entityId, code: AR, name: "FX AR", type: "ASSET", normalBalance: "DEBIT", isControlAccount: true, isMonetary: true, subtype: "AR_TRADE" },
      { tenantId, entityId, code: EQ, name: "FX Equity", type: "EQUITY", normalBalance: "CREDIT", isMonetary: false },
      { tenantId, entityId, code: REV, name: "FX Revenue", type: "REVENUE", normalBalance: "CREDIT", isMonetary: false },
      // The offset account — subtype is what postRevaluation resolves on.
      { tenantId, entityId, code: FXGL, name: "Unrealized FX Gain/Loss", type: "EXPENSE", normalBalance: "DEBIT", isMonetary: false, subtype: "FX_GAIN_LOSS_UNREALIZED" },
    ],
  });

  const party = await prisma.party.create({
    data: { tenantId, entityId, code: `CUST_${SUFFIX}`.slice(0, 20), displayName: "EU Customer" },
    select: { id: true },
  });
  partyId = party.id;
  await prisma.partyRole.create({ data: { tenantId, partyId: party.id, role: "CUSTOMER" } });

  // EUR cash €1,000 @ 1.085 → $1,085 carrying.
  await postJournalEntry(prisma, {
    tenantId, entityCode: ENTITY, bookCode: "US_GAAP", currencyCode: "EUR",
    documentDate: new Date("2026-06-15"), memo: "EUR capital contribution",
    lines: [
      { accountCode: CASH, debit: "1085.00", transactionAmount: "1000.00" },
      { accountCode: EQ, credit: "1085.00", transactionAmount: "-1000.00" },
    ],
  });

  // EUR invoice €2,000 @ 1.090 → $2,180 carrying.
  const invoice = await postJournalEntry(prisma, {
    tenantId, entityCode: ENTITY, bookCode: "US_GAAP", currencyCode: "EUR",
    documentDate: new Date("2026-06-15"), memo: "EUR invoice — EU Customer",
    lines: [
      { accountCode: AR, debit: "2180.00", transactionAmount: "2000.00" },
      { accountCode: REV, credit: "2180.00", transactionAmount: "-2000.00" },
    ],
  });
  await prisma.arOpenItem.create({
    data: {
      tenantId, entityId, bookId, partyId, openedByEntryId: invoice.id,
      referenceNumber: "INV-EUR-001", openedDate: new Date("2026-06-15"), dueDate: new Date("2026-07-15"),
      originalAmount: "2000.00", currentBalance: "2000.00", currencyId: "EUR", status: "OPEN", controlAccountCode: AR,
    },
  });
});

afterAll(async () => {
  await prisma.arOpenItem.deleteMany({ where: { tenantId } });
  await prisma.journalLine.deleteMany({ where: { tenantId } });
  await prisma.journalEntry.deleteMany({ where: { tenantId } });
  await prisma.account.deleteMany({ where: { tenantId } });
  await prisma.partyRole.deleteMany({ where: { party: { tenantId } } });
  await prisma.party.deleteMany({ where: { tenantId } });
  await prisma.period.deleteMany({ where: { tenantId } });
  await prisma.fiscalCalendar.deleteMany({ where: { tenantId } });
  await prisma.legalEntity.deleteMany({ where: { tenantId } });
  await prisma.tenantMembership.deleteMany({ where: { tenantId } });
  try {
    await prisma.tenant.delete({ where: { id: tenantId } });
  } catch {
    /* audit_log append-only — leak */
  }
  await prisma.$disconnect();
});

const SCOPE = { entityCode: ENTITY, bookCode: "US_GAAP", periodCode: "2026-06" } as const;

describe("postRevaluation", () => {
  it("posts a balanced adjustment + a reversing entry dated next period", async () => {
    const r = await postRevaluation(prisma, { ...SCOPE, tenantId }, { createdBy: "controller@test" });
    expect(r.posted).toBe(true);
    expect(r.wasDuplicate).toBe(false);
    expect(r.noop).toBe(false);
    expect(r.computed.totalUnrealizedGainLoss.equals(new Decimal("80"))).toBe(true);

    // Adjustment entry: source AI_APPROVED, dated period end, FX_REVAL lineage.
    const adj = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: r.adjustmentEntryId! },
      include: { lines: { include: { account: { select: { code: true } } } } },
    });
    expect(adj.source).toBe("AI_APPROVED");
    expect(adj.sourceSystem).toBe("FX_REVAL");
    expect(adj.sourceRecordType).toBe("MonetaryRevaluation");
    expect(adj.documentDate.toISOString().slice(0, 10)).toBe("2026-06-30");

    // Lines: Dr Cash 30, Dr AR 50, Cr 8300 80 (the gain credited to P&L).
    const byAcct = new Map(adj.lines.map((l) => [l.account.code, l]));
    expect(new Decimal(byAcct.get(CASH)!.debit.toString()).equals(new Decimal("30"))).toBe(true);
    expect(new Decimal(byAcct.get(AR)!.debit.toString()).equals(new Decimal("50"))).toBe(true);
    expect(new Decimal(byAcct.get(FXGL)!.credit.toString()).equals(new Decimal("80"))).toBe(true);

    // Reversal: dated 2026-07-01, links back via reversalOfId, flipped.
    const rev = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: r.reversalEntryId! },
      include: { lines: { include: { account: { select: { code: true } } } } },
    });
    expect(rev.reversalOfId).toBe(adj.id);
    expect(rev.documentDate.toISOString().slice(0, 10)).toBe("2026-07-01");
    const revByAcct = new Map(rev.lines.map((l) => [l.account.code, l]));
    expect(new Decimal(revByAcct.get(FXGL)!.debit.toString()).equals(new Decimal("80"))).toBe(true);
    expect(new Decimal(revByAcct.get(CASH)!.credit.toString()).equals(new Decimal("30"))).toBe(true);
  });

  it("reverse-next-period: the gain stands at period end and nets to zero after", async () => {
    // As of 2026-06-30 the adjustment stands → 8300 holds the $80 gain.
    // 8300 is an EXPENSE (debit-normal); a credit balance is a gain, so
    // its normal-side balance is −80.
    const tbJun = await getTrialBalance(prisma, { entityCode: ENTITY, bookCode: "US_GAAP", tenantId }, new Date("2026-06-30"));
    const fxJun = tbJun.rows.find((r) => r.accountCode === FXGL);
    expect(fxJun).toBeDefined();
    expect(fxJun!.balance.equals(new Decimal("-80"))).toBe(true);

    // As of 2026-07-31 the reversal has landed → 8300 nets to zero.
    const tbJul = await getTrialBalance(prisma, { entityCode: ENTITY, bookCode: "US_GAAP", tenantId }, new Date("2026-07-31"));
    const fxJul = tbJul.rows.find((r) => r.accountCode === FXGL);
    // Either the row is absent (no net activity) or its balance is zero.
    if (fxJul) expect(fxJul.balance.equals(new Decimal("0"))).toBe(true);
  });

  it("is idempotent: a second call finds the existing adjustment (no duplicate)", async () => {
    const before = await prisma.journalEntry.count({
      where: { tenantId, sourceSystem: "FX_REVAL" },
    });
    const r = await postRevaluation(prisma, { ...SCOPE, tenantId });
    expect(r.posted).toBe(false);
    expect(r.wasDuplicate).toBe(true);
    const after = await prisma.journalEntry.count({
      where: { tenantId, sourceSystem: "FX_REVAL" },
    });
    expect(after).toBe(before); // no new entries
  });

  it("is a no-op for a period with no foreign monetary balances", async () => {
    const r = await postRevaluation(prisma, { entityCode: ENTITY, bookCode: "US_GAAP", periodCode: "2026-05", tenantId });
    expect(r.posted).toBe(false);
    expect(r.noop).toBe(true);
    expect(r.wasDuplicate).toBe(false);
    const cnt = await prisma.journalEntry.count({
      where: { tenantId, sourceSystem: "FX_REVAL", sourceRecordId: `${ENTITY}-US_GAAP-2026-05` },
    });
    expect(cnt).toBe(0);
  });
});
