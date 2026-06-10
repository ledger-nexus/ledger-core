// computeRevaluation engine tests (src/lib/accounting/revaluation.ts).
//
// Pins the ASC 830 remeasurement math against a real Postgres with a
// multi-currency fixture (USD functional/reporting entity holding EUR
// monetary balances):
//   1. GL cash — a EUR cash balance revalues at the period-end CLOSE
//      rate; gain = foreign × close − carrying. source = GL, no openItems.
//   2. AR sub-ledger — a EUR receivable revalues from the GL, AND the
//      row is enriched with the open-item detail; openItemForeignTotal
//      reconciles to the GL foreign balance. source = AR_SUBLEDGER.
//   3. Same-currency exclusion — a USD line on the same monetary account
//      is NOT revalued (transactionCurrency == reporting currency).
//   4. Total — net unrealized gain/loss sums every line.
//   5. Empty — a period with no foreign monetary balances → no lines.
//
// Booking rates differ from the CLOSE rate so the gain/loss is non-zero
// and the arithmetic is checkable by hand:
//   EUR cash:  €1,000 booked at 1.085 ($1,085 carrying); CLOSE 1.115 →
//              revalued $1,115; gain +$30.
//   EUR AR:    €2,000 booked at 1.090 ($2,180 carrying); CLOSE 1.115 →
//              revalued $2,230; gain +$50.
//   net gain = +$80.
//
// Convention: debit/credit carry the reporting-currency (USD) amount
// (the balance invariant + trial balance run on them); transactionAmount
// is overridden to the foreign (EUR) amount; fxRate left at 1 so
// reportingAmount defaults to the USD signed amount. currencyCode = EUR
// stamps transactionCurrencyId on every line.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { Decimal } from "decimal.js";

import { postJournalEntry } from "@/lib/accounting/post-journal";
import { computeRevaluation } from "@/lib/accounting/revaluation";

const prisma = new PrismaClient();
const SUFFIX = "fxr" + Date.now().toString(36) + Math.floor(Math.random() * 9999);
const ENTITY = `FXR-${SUFFIX}`.slice(0, 50);

let tenantId: string;
let entityId: string;
let bookId: string;
let partyId: string;

// Unique account codes so we never collide with the shared chart.
const CASH = `FXCASH_${SUFFIX}`.slice(0, 20);
const AR = `FXAR_${SUFFIX}`.slice(0, 20);
const EQ = `FXEQ_${SUFFIX}`.slice(0, 20);
const REV = `FXREV_${SUFFIX}`.slice(0, 20);

beforeAll(async () => {
  for (const code of ["USD", "EUR"]) {
    await prisma.currency.upsert({
      where: { code },
      create: {
        code,
        name: code === "USD" ? "US Dollar" : "Euro",
        decimals: 2,
        symbol: code === "USD" ? "$" : "€",
      },
      update: {},
    });
  }
  // EUR->USD CLOSE at the period end. Matches Northwind's seeded value
  // (idempotent upsert) but we seed it here so the test stands alone.
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
    data: {
      slug: `fxr-${SUFFIX}`.slice(0, 60),
      name: `FX Reval Tenant ${SUFFIX}`,
      ownerUserId: owner.id,
    },
  });
  tenantId = tenant.id;
  await prisma.tenantMembership.create({
    data: { tenantId, userId: owner.id, role: "OWNER" },
  });

  const entity = await prisma.legalEntity.create({
    data: { tenantId, code: ENTITY, name: "FX Reval Co.", functionalCurrencyId: "USD" },
    select: { id: true },
  });
  entityId = entity.id;

  // US_GAAP book reports in USD (shared across tenants in this schema).
  const book = await prisma.book.upsert({
    where: { code: "US_GAAP" },
    create: { code: "US_GAAP", name: "US GAAP", basis: "US_GAAP", reportingCurrencyId: "USD" },
    update: {},
  });
  bookId = book.id;

  const cal = await prisma.fiscalCalendar.create({
    data: {
      tenantId,
      entityId,
      code: `FXRC-${SUFFIX}`.slice(0, 32),
      name: "Cal",
      periodFrequency: "MONTHLY",
    },
    select: { id: true },
  });
  // June 2026 (the revaluation period) + May 2026 (the empty-period test).
  await prisma.period.createMany({
    data: [
      {
        tenantId,
        calendarId: cal.id,
        code: "2026-05",
        ordinal: 5,
        startsOn: new Date("2026-05-01"),
        endsOn: new Date("2026-05-31"),
      },
      {
        tenantId,
        calendarId: cal.id,
        code: "2026-06",
        ordinal: 6,
        startsOn: new Date("2026-06-01"),
        endsOn: new Date("2026-06-30"),
      },
    ],
  });

  // Accounts — entity-specific, unique codes. Cash + AR monetary; AR
  // carries the AR_TRADE subtype so the engine classifies it as a
  // sub-ledger row. Equity + revenue are non-monetary (never revalued).
  await prisma.account.createMany({
    data: [
      { tenantId, entityId, code: CASH, name: "FX Cash", type: "ASSET", normalBalance: "DEBIT", isBank: true, isMonetary: true, subtype: "CASH" },
      { tenantId, entityId, code: AR, name: "FX AR", type: "ASSET", normalBalance: "DEBIT", isControlAccount: true, isMonetary: true, subtype: "AR_TRADE" },
      { tenantId, entityId, code: EQ, name: "FX Equity", type: "EQUITY", normalBalance: "CREDIT", isMonetary: false },
      { tenantId, entityId, code: REV, name: "FX Revenue", type: "REVENUE", normalBalance: "CREDIT", isMonetary: false },
    ],
  });

  const party = await prisma.party.create({
    data: { tenantId, entityId, code: `CUST_${SUFFIX}`.slice(0, 20), displayName: "EU Customer" },
    select: { id: true },
  });
  partyId = party.id;
  await prisma.partyRole.create({
    data: { tenantId, partyId: party.id, role: "CUSTOMER" },
  });

  // ── Scenario 1: EUR cash contribution (GL source) ──
  // €1,000 booked at 1.085 → $1,085 carrying.
  await postJournalEntry(prisma, {
    tenantId,
    entityCode: ENTITY,
    bookCode: "US_GAAP",
    currencyCode: "EUR",
    documentDate: new Date("2026-06-15"),
    memo: "EUR capital contribution",
    lines: [
      { accountCode: CASH, debit: "1085.00", transactionAmount: "1000.00" },
      { accountCode: EQ, credit: "1085.00", transactionAmount: "-1000.00" },
    ],
  });

  // ── Same-currency control: a USD cash receipt on the SAME cash account.
  // transactionCurrency == reporting (USD) → must be excluded from reval.
  await postJournalEntry(prisma, {
    tenantId,
    entityCode: ENTITY,
    bookCode: "US_GAAP",
    documentDate: new Date("2026-06-16"),
    memo: "USD cash receipt (must not revalue)",
    lines: [
      { accountCode: CASH, debit: "500.00" },
      { accountCode: REV, credit: "500.00" },
    ],
  });

  // ── Scenario 2: EUR invoice (AR sub-ledger source) ──
  // €2,000 booked at 1.090 → $2,180 carrying.
  const invoice = await postJournalEntry(prisma, {
    tenantId,
    entityCode: ENTITY,
    bookCode: "US_GAAP",
    currencyCode: "EUR",
    documentDate: new Date("2026-06-15"),
    memo: "EUR invoice — EU Customer",
    lines: [
      { accountCode: AR, debit: "2180.00", transactionAmount: "2000.00" },
      { accountCode: REV, credit: "2180.00", transactionAmount: "-2000.00" },
    ],
  });

  // Open the AR item (foreign currency, full balance outstanding).
  await prisma.arOpenItem.create({
    data: {
      tenantId,
      entityId,
      bookId,
      partyId,
      openedByEntryId: invoice.id,
      referenceNumber: "INV-EUR-001",
      openedDate: new Date("2026-06-15"),
      dueDate: new Date("2026-07-15"),
      originalAmount: "2000.00",
      currentBalance: "2000.00",
      currencyId: "EUR",
      status: "OPEN",
      controlAccountCode: AR,
    },
  });
});

afterAll(async () => {
  // Tear down in FK order. Tenant restrict on audit_log may leave a row;
  // swallow that like the other suites do.
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

describe("computeRevaluation", () => {
  it("revalues a EUR cash balance from the GL at the period-end CLOSE rate", async () => {
    const r = await computeRevaluation(prisma, {
      tenantId,
      entityCode: ENTITY,
      bookCode: "US_GAAP",
      periodCode: "2026-06",
    });
    const cash = r.lines.find((l) => l.accountCode === CASH);
    expect(cash).toBeDefined();
    expect(cash!.source).toBe("GL");
    expect(cash!.currency).toBe("EUR");
    // Same-currency USD receipt excluded → foreign balance is the EUR 1,000 only.
    expect(cash!.foreignBalance.equals(new Decimal("1000"))).toBe(true);
    expect(cash!.carryingReportingBalance.equals(new Decimal("1085"))).toBe(true);
    expect(cash!.closeRate.equals(new Decimal("1.115"))).toBe(true);
    expect(cash!.revaluedReportingBalance.equals(new Decimal("1115"))).toBe(true);
    expect(cash!.unrealizedGainLoss.equals(new Decimal("30"))).toBe(true);
    expect(cash!.openItems).toBeUndefined();
  });

  it("revalues a EUR receivable from the GL and enriches the row with open-item detail", async () => {
    const r = await computeRevaluation(prisma, {
      tenantId,
      entityCode: ENTITY,
      bookCode: "US_GAAP",
      periodCode: "2026-06",
    });
    const ar = r.lines.find((l) => l.accountCode === AR);
    expect(ar).toBeDefined();
    expect(ar!.source).toBe("AR_SUBLEDGER");
    expect(ar!.foreignBalance.equals(new Decimal("2000"))).toBe(true);
    expect(ar!.carryingReportingBalance.equals(new Decimal("2180"))).toBe(true);
    expect(ar!.revaluedReportingBalance.equals(new Decimal("2230"))).toBe(true);
    expect(ar!.unrealizedGainLoss.equals(new Decimal("50"))).toBe(true);
    // Enrichment: one open invoice, reconciling to the GL foreign balance.
    expect(ar!.openItems).toHaveLength(1);
    expect(ar!.openItems![0].referenceNumber).toBe("INV-EUR-001");
    expect(ar!.openItems![0].currentBalance.equals(new Decimal("2000"))).toBe(true);
    expect(ar!.openItemForeignTotal!.equals(new Decimal("2000"))).toBe(true);
    // Sub-ledger ties to GL: |foreignBalance| == open-item foreign total.
    expect(ar!.openItemForeignTotal!.equals(ar!.foreignBalance.abs())).toBe(true);
  });

  it("nets the total unrealized gain/loss across all lines", async () => {
    const r = await computeRevaluation(prisma, {
      tenantId,
      entityCode: ENTITY,
      bookCode: "US_GAAP",
      periodCode: "2026-06",
    });
    // +30 (cash) +50 (AR) = +80.
    expect(r.totalUnrealizedGainLoss.equals(new Decimal("80"))).toBe(true);
    expect(r.reportingCurrency).toBe("USD");
    expect(r.functionalCurrency).toBe("USD");
    expect(r.asOf.toISOString().slice(0, 10)).toBe("2026-06-30");
    // Exactly two revalued lines (cash + AR); equity/revenue non-monetary.
    expect(r.lines).toHaveLength(2);
  });

  it("returns no lines for a period with no foreign monetary balances", async () => {
    // May 2026 — nothing posted into it.
    const r = await computeRevaluation(prisma, {
      tenantId,
      entityCode: ENTITY,
      bookCode: "US_GAAP",
      periodCode: "2026-05",
    });
    expect(r.lines).toHaveLength(0);
    expect(r.totalUnrealizedGainLoss.equals(new Decimal("0"))).toBe(true);
  });
});
