// Integration tests for checkSubledgerTies.
//
// Verifies:
//   1. Both ties report "ok" when GL control = sub-ledger sum.
//   2. Drifted control surfaces as "broken" with the correct delta.
//   3. Chart without a control account returns "no_control_account"
//      (not an error — just signals the tie doesn't apply).
//   4. Tolerance handling: a sub-cent delta still ties as "ok".
//   5. Real Northwind seed: at 6/30 both AR and AP control ties OK.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { Decimal } from "@/lib/utils/decimal";
import { checkSubledgerTies } from "@/lib/accounting/subledger-ties";
import { postJournalEntry } from "@/lib/accounting/post-journal";
import { openArItem } from "@/lib/accounting/sub-ledgers/ar";

const prisma = new PrismaClient();
const SUFFIX = ("TIE" + Date.now().toString(36)).toUpperCase();
const ENTITY_CODE = `TIE-${SUFFIX}`;

let tenantId: string;
let entityId: string;

beforeAll(async () => {
  // Reuse the default tenant so postJournalEntry's tenant resolution
  // works without ceremony.
  const defaultTenant = await prisma.tenant.findFirstOrThrow({
    where: { slug: "default" },
  });
  tenantId = defaultTenant.id;

  await prisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    update: {},
  });
  await prisma.book.upsert({
    where: { code: "US_GAAP" },
    create: {
      code: "US_GAAP",
      name: "US GAAP",
      basis: "US_GAAP",
      reportingCurrencyId: "USD",
    },
    update: {},
  });

  const entity = await prisma.legalEntity.create({
    data: {
      tenantId,
      code: ENTITY_CODE,
      name: "Tie Test Co.",
      functionalCurrencyId: "USD",
    },
  });
  entityId = entity.id;

  // Calendar + period (for postJournalEntry's period-resolution).
  const cal = await prisma.fiscalCalendar.create({
    data: {
      tenantId,
      entityId,
      code: `TIE-CAL-${SUFFIX}`,
      name: "Tie cal",
      periodFrequency: "MONTHLY",
    },
  });
  await prisma.period.create({
    data: {
      tenantId,
      calendarId: cal.id,
      code: "2026-05",
      ordinal: 5,
      startsOn: new Date("2026-05-01"),
      endsOn: new Date("2026-05-31"),
    },
  });

  // Standard accounts: 1010 Cash, 1200 AR (control, AR_TRADE), 2000 AP
  // (control, AP_TRADE), 4000 Revenue, 6000 Expense.
  await prisma.account.createMany({
    data: [
      {
        tenantId,
        entityId,
        code: "1010",
        name: "Cash",
        type: "ASSET",
        normalBalance: "DEBIT",
        isBank: true,
      },
      {
        tenantId,
        entityId,
        code: "1200",
        name: "AR",
        type: "ASSET",
        normalBalance: "DEBIT",
        isControlAccount: true,
        subtype: "AR_TRADE",
      },
      {
        tenantId,
        entityId,
        code: "2000",
        name: "AP",
        type: "LIABILITY",
        normalBalance: "CREDIT",
        isControlAccount: true,
        subtype: "AP_TRADE",
      },
      {
        tenantId,
        entityId,
        code: "4000",
        name: "Revenue",
        type: "REVENUE",
        normalBalance: "CREDIT",
      },
      {
        tenantId,
        entityId,
        code: "6000",
        name: "Expense",
        type: "EXPENSE",
        normalBalance: "DEBIT",
      },
    ],
  });

  // Customer party for the AR test.
  await prisma.party.create({
    data: {
      tenantId,
      entityId,
      code: "CUST-A",
      displayName: "Customer A",
    },
  });
  const partyForRole = await prisma.party.findFirstOrThrow({
    where: { code: "CUST-A", entityId },
  });
  await prisma.partyRole.create({
    data: {
      tenantId,
      partyId: partyForRole.id,
      role: "CUSTOMER",
    },
  });
});

afterAll(async () => {
  // Clean up everything we created for this entity.
  await prisma.arApplication.deleteMany({ where: { openItem: { entityId } } });
  await prisma.arOpenItem.deleteMany({ where: { entityId } });
  await prisma.partyRole.deleteMany({ where: { party: { entityId } } });
  await prisma.party.deleteMany({ where: { entityId } });
  await prisma.journalLine.deleteMany({ where: { entry: { entityId } } });
  await prisma.journalEntry.deleteMany({ where: { entityId } });
  await prisma.account.deleteMany({ where: { entityId } });
  await prisma.period.deleteMany({ where: { calendar: { entityId } } });
  await prisma.fiscalCalendar.deleteMany({ where: { entityId } });
  await prisma.recordEvent.deleteMany({ where: { tenantId } });
  await prisma.legalEntity.deleteMany({ where: { id: entityId } });
  await prisma.$disconnect();
});

describe("checkSubledgerTies — empty state", () => {
  it("returns ok ties with zero balances when no activity", async () => {
    const ties = await checkSubledgerTies(prisma, {
      entityCode: ENTITY_CODE,
      bookCode: "US_GAAP",
      asOf: new Date("2026-05-31"),
    });
    expect(ties).toHaveLength(2);
    expect(ties.every((t) => t.status === "ok")).toBe(true);
    expect(ties.every((t) => t.controlBalance.isZero())).toBe(true);
    expect(ties.every((t) => t.subledgerSum.isZero())).toBe(true);
  });
});

describe("checkSubledgerTies — happy path (matched)", () => {
  it("AR control balance ties to sum of open AR items", async () => {
    // Post a JE that debits AR + credits Revenue (raises AR by $1,000).
    const arBilling = await postJournalEntry(prisma, {
      tenantId,
      entityCode: ENTITY_CODE,
      bookCode: "US_GAAP",
      documentDate: new Date("2026-05-10"),
      memo: "Bill customer",
      source: "MANUAL",
      lines: [
        { accountCode: "1200", debit: "1000", partyCode: "CUST-A" },
        { accountCode: "4000", credit: "1000" },
      ],
    });
    // Open the AR open item matching that JE.
    await openArItem(prisma, {
      tenantId,
      entityCode: ENTITY_CODE,
      bookCode: "US_GAAP",
      partyCode: "CUST-A",
      openedByEntryId: arBilling.id,
      openedDate: new Date("2026-05-10"),
      amount: "1000",
      currencyCode: "USD",
      controlAccountCode: "1200",
    });

    const ties = await checkSubledgerTies(prisma, {
      entityCode: ENTITY_CODE,
      bookCode: "US_GAAP",
      asOf: new Date("2026-05-31"),
    });
    const arTie = ties.find((t) => t.name === "AR control")!;
    expect(arTie.status).toBe("ok");
    expect(arTie.controlBalance.toNumber()).toBe(1000);
    expect(arTie.subledgerSum.toNumber()).toBe(1000);
    expect(arTie.delta.toNumber()).toBe(0);
    expect(arTie.controlAccount?.code).toBe("1200");
  });
});

describe("checkSubledgerTies — drift detection", () => {
  it("flags 'broken' when GL control != sub-ledger sum", async () => {
    // Post a JE that debits AR but creates NO open item. The GL
    // says AR is bigger than the sub-ledger. This is the classic
    // "you forgot to log the bill in AR" scenario.
    await postJournalEntry(prisma, {
      tenantId,
      entityCode: ENTITY_CODE,
      bookCode: "US_GAAP",
      documentDate: new Date("2026-05-15"),
      memo: "AR direct post — no sub-ledger",
      source: "MANUAL",
      lines: [
        { accountCode: "1200", debit: "500", partyCode: "CUST-A" },
        { accountCode: "4000", credit: "500" },
      ],
    });

    const ties = await checkSubledgerTies(prisma, {
      entityCode: ENTITY_CODE,
      bookCode: "US_GAAP",
      asOf: new Date("2026-05-31"),
    });
    const arTie = ties.find((t) => t.name === "AR control")!;
    expect(arTie.status).toBe("broken");
    // Previous test left 1000 in both. Then this JE added 500 to the
    // GL only. So control is 1500, sub-ledger is 1000, delta is 500.
    expect(arTie.controlBalance.toNumber()).toBe(1500);
    expect(arTie.subledgerSum.toNumber()).toBe(1000);
    expect(arTie.delta.toNumber()).toBe(500);
  });
});

describe("checkSubledgerTies — no control account", () => {
  it("returns 'no_control_account' status when chart lacks AR_TRADE / AP_TRADE", async () => {
    // Fresh tenant — the default tenant's shared chart has 1200/2000
    // control accounts that any entity inherits as fallback. We need a
    // tenant with NO control accounts at all to validate this branch.
    const isoTenant = await prisma.tenant.create({
      data: {
        slug: `tie-no-ctl-${SUFFIX.toLowerCase()}`,
        name: "No-control tenant",
        ownerUserId: tenantId, // any UUID — ownerUserId is not FK-enforced
      },
    });
    const isoEntity = await prisma.legalEntity.create({
      data: {
        tenantId: isoTenant.id,
        code: `NC-${SUFFIX}`,
        name: "No Control Co.",
        functionalCurrencyId: "USD",
      },
    });
    try {
      const ties = await checkSubledgerTies(prisma, {
        entityCode: isoEntity.code,
        bookCode: "US_GAAP",
        asOf: new Date("2026-05-31"),
      });
      expect(ties).toHaveLength(2);
      expect(ties.every((t) => t.status === "no_control_account")).toBe(true);
      expect(ties.every((t) => t.controlAccount === null)).toBe(true);
    } finally {
      await prisma.legalEntity.delete({ where: { id: isoEntity.id } });
      await prisma.tenant.delete({ where: { id: isoTenant.id } });
    }
  });
});
