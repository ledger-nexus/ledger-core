// Balance-assertion pillar in the cross-pillar close-alerts aggregator.
//
// Pins the push half of Beancount adoption ①: a failing assertion has to reach
// the close dashboard and the Slack digest on its own, not wait for someone to
// open /assertions.
//
// Verified:
//   1. A cached FAIL inside the period → one high-severity alert.
//   2. A cached PASS → no alert (the tripwire is quiet when it should be).
//   3. UNCHECKED → a low-severity alert of its own: an assertion nobody has
//      verified is inert, and inert reads as silence rather than safety.
//   4. Period scoping: a FAIL whose asOf falls OUTSIDE the period is not this
//      period's problem.
//   5. Tenant isolation: another tenant's failing assertion never appears.
//   6. summarizeAlerts counts the new pillar.
//
// Fully isolated fixture (own tenant / entity / book scope) so these rows can
// never leak into the period the main close-alerts suite asserts counts on.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { getCloseAlerts, summarizeAlerts } from "@/lib/close/alerts";
import { withAuditLogMutableTransaction } from "./_helpers/audit-log-cleanup";

const prisma = new PrismaClient();

const SUFFIX = ("ap" + Date.now().toString(36) + Math.floor(Math.random() * 9999)).toLowerCase();
const NOW = new Date("2026-07-15T12:00:00Z");

let tenantId: string;
let otherTenantId: string;
let userId: string;
let otherUserId: string;
let entityId: string;
let otherEntityId: string;
let bookId: string;
let periodId: string;
const accountIds: string[] = [];

async function mintAccount(code: string): Promise<string> {
  const a = await prisma.account.create({
    data: {
      tenantId,
      entityId,
      code,
      name: `Account ${code}`,
      type: "ASSET",
      normalBalance: "DEBIT",
    },
    select: { id: true },
  });
  accountIds.push(a.id);
  return a.id;
}

beforeAll(async () => {
  await prisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    update: {},
  });
  const book = await prisma.book.upsert({
    where: { code: "US_GAAP" },
    create: { code: "US_GAAP", name: "US GAAP", basis: "US_GAAP", reportingCurrencyId: "USD" },
    update: {},
  });
  bookId = book.id;

  const u = await prisma.user.create({
    data: { email: `${SUFFIX}@example.test`, displayName: "Pillar tester", isActive: true },
  });
  userId = u.id;
  const t = await prisma.tenant.create({
    data: { slug: `${SUFFIX}-t`, name: "Pillar tenant", ownerUserId: u.id },
  });
  tenantId = t.id;

  const ou = await prisma.user.create({
    data: { email: `${SUFFIX}-x@example.test`, displayName: "Other", isActive: true },
  });
  otherUserId = ou.id;
  const ot = await prisma.tenant.create({
    data: { slug: `${SUFFIX}-x`, name: "Other tenant", ownerUserId: ou.id },
  });
  otherTenantId = ot.id;

  const entity = await prisma.legalEntity.create({
    data: { tenantId, code: `${SUFFIX}-E`.toUpperCase(), name: "Pillar Co.", functionalCurrencyId: "USD" },
  });
  entityId = entity.id;
  const otherEntity = await prisma.legalEntity.create({
    data: {
      tenantId: otherTenantId,
      code: `${SUFFIX}-X`.toUpperCase(),
      name: "Other Co.",
      functionalCurrencyId: "USD",
    },
  });
  otherEntityId = otherEntity.id;

  const cal = await prisma.fiscalCalendar.create({
    data: {
      tenantId,
      entityId,
      code: "STANDARD_2026",
      name: "2026",
      periodFrequency: "MONTHLY",
    },
    select: { id: true },
  });
  const p = await prisma.period.create({
    data: {
      tenantId,
      calendarId: cal.id,
      code: "2026-07",
      ordinal: 7,
      startsOn: new Date("2026-07-01"),
      endsOn: new Date("2026-07-31"),
    },
    select: { id: true },
  });
  periodId = p.id;

  const base = {
    tenantId,
    entityId,
    bookId,
    currencyId: "USD",
  };

  // 1. Cached FAIL inside the period.
  await prisma.balanceAssertion.create({
    data: {
      ...base,
      accountId: await mintAccount(`${SUFFIX}F`.toUpperCase().slice(0, 20)),
      asOf: new Date("2026-07-31"),
      expectedAmount: "5000",
      lastObservedAmount: "4200",
      lastStatus: "FAIL",
      lastCheckedAt: new Date("2026-07-14T00:00:00Z"),
    },
  });
  // 2. Cached PASS inside the period.
  await prisma.balanceAssertion.create({
    data: {
      ...base,
      accountId: await mintAccount(`${SUFFIX}P`.toUpperCase().slice(0, 20)),
      asOf: new Date("2026-07-31"),
      expectedAmount: "100",
      lastObservedAmount: "100",
      lastStatus: "PASS",
      lastCheckedAt: new Date("2026-07-14T00:00:00Z"),
    },
  });
  // 3. Never checked (default UNCHECKED).
  await prisma.balanceAssertion.create({
    data: {
      ...base,
      accountId: await mintAccount(`${SUFFIX}U`.toUpperCase().slice(0, 20)),
      asOf: new Date("2026-07-31"),
      expectedAmount: "42",
    },
  });
  // 4. FAIL but OUTSIDE the period.
  await prisma.balanceAssertion.create({
    data: {
      ...base,
      accountId: await mintAccount(`${SUFFIX}O`.toUpperCase().slice(0, 20)),
      asOf: new Date("2026-06-30"),
      expectedAmount: "7",
      lastObservedAmount: "0",
      lastStatus: "FAIL",
      lastCheckedAt: new Date("2026-07-14T00:00:00Z"),
    },
  });
  // 5. Another tenant's FAIL, same dates.
  const otherAccount = await prisma.account.create({
    data: {
      tenantId: otherTenantId,
      entityId: otherEntityId,
      code: `${SUFFIX}X`.toUpperCase().slice(0, 20),
      name: "Other acct",
      type: "ASSET",
      normalBalance: "DEBIT",
    },
    select: { id: true },
  });
  await prisma.balanceAssertion.create({
    data: {
      tenantId: otherTenantId,
      entityId: otherEntityId,
      bookId,
      currencyId: "USD",
      accountId: otherAccount.id,
      asOf: new Date("2026-07-31"),
      expectedAmount: "999",
      lastObservedAmount: "0",
      lastStatus: "FAIL",
      lastCheckedAt: new Date("2026-07-14T00:00:00Z"),
    },
  });
});

afterAll(async () => {
  await prisma.balanceAssertion.deleteMany({
    where: { entityId: { in: [entityId, otherEntityId] } },
  });
  await prisma.account.deleteMany({ where: { entityId: { in: [entityId, otherEntityId] } } });
  await prisma.period.deleteMany({ where: { tenantId } });
  await prisma.fiscalCalendar.deleteMany({ where: { tenantId } });
  await prisma.legalEntity.deleteMany({ where: { id: { in: [entityId, otherEntityId] } } });
  // app_user hard-deletes need the audit-mutable window even though this suite
  // writes no audit rows: Postgres runs a referential-integrity query for
  // audit_log_actorUserId_fkey, the append-only RULE rewrites it, and the
  // delete fails with XX000 "gave unexpected result".
  await withAuditLogMutableTransaction(prisma, async (tx) => {
    await tx.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } });
    await tx.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
  });
  await prisma.$disconnect();
});

describe("close alerts — balance-assertion pillar", () => {
  it("a cached FAIL inside the period raises one high-severity alert", async () => {
    const alerts = await getCloseAlerts(
      prisma,
      { tenantId, entityId, bookId, periodId, periodCode: "2026-07" },
      NOW
    );
    const failing = alerts.filter(
      (a) => a.pillar === "assertion" && a.severity === "high"
    );
    expect(failing).toHaveLength(1);
    expect(failing[0].title).toMatch(/Balance disagrees/);
    // Both figures belong in the description — the gap is the whole point.
    expect(failing[0].description).toContain("5000");
    expect(failing[0].description).toContain("4200");
    expect(failing[0].href).toBe("/assertions");
  });

  it("a cached PASS raises nothing", async () => {
    const alerts = await getCloseAlerts(
      prisma,
      { tenantId, entityId, bookId, periodId, periodCode: "2026-07" },
      NOW
    );
    const passAccount = `${SUFFIX}P`.toUpperCase().slice(0, 20);
    expect(alerts.some((a) => a.title.includes(passAccount))).toBe(false);
  });

  it("an UNCHECKED assertion raises a low-severity alert of its own", async () => {
    const alerts = await getCloseAlerts(
      prisma,
      { tenantId, entityId, bookId, periodId, periodCode: "2026-07" },
      NOW
    );
    const unchecked = alerts.filter(
      (a) => a.pillar === "assertion" && a.severity === "low"
    );
    expect(unchecked).toHaveLength(1);
    expect(unchecked[0].title).toMatch(/not yet checked/i);
  });

  it("a FAIL outside the period is not this period's problem", async () => {
    const alerts = await getCloseAlerts(
      prisma,
      { tenantId, entityId, bookId, periodId, periodCode: "2026-07" },
      NOW
    );
    const outsideAccount = `${SUFFIX}O`.toUpperCase().slice(0, 20);
    expect(alerts.some((a) => a.title.includes(outsideAccount))).toBe(false);
  });

  it("another tenant's failing assertion never appears", async () => {
    const alerts = await getCloseAlerts(
      prisma,
      { tenantId, entityId, bookId, periodId, periodCode: "2026-07" },
      NOW
    );
    const otherAccount = `${SUFFIX}X`.toUpperCase().slice(0, 20);
    expect(alerts.some((a) => a.title.includes(otherAccount))).toBe(false);
    expect(alerts.some((a) => a.description.includes("999"))).toBe(false);
  });

  it("summarizeAlerts counts the assertion pillar", async () => {
    const alerts = await getCloseAlerts(
      prisma,
      { tenantId, entityId, bookId, periodId, periodCode: "2026-07" },
      NOW
    );
    const h = summarizeAlerts(alerts);
    // One FAIL + one UNCHECKED from this fixture.
    expect(h.byPillar.assertion).toBe(2);
  });
});
