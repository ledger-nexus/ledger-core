// Balance-assertion checker tests.
//
// Fixture: one JE on 2026-05-15 — Dr CASH 1000 / Cr REV 1000 — then a set of
// assertions on CASH at distinct dates (the unique key is
// (entity, book, account, currency, asOf), so each case gets its own date).
// One checkBalanceAssertions() call covers them all, which also exercises the
// per-date trial-balance batching.
//
// Cases:
//   A 2026-05-31  expect 1000        no tol   -> PASS  (exact)
//   B 2026-06-30  expect  900        no tol   -> FAIL  (delta 100)
//   C 2026-07-31  expect 1000.50     tol 1.00 -> PASS  (explicit tol overrides
//                                                the 0.01 default it'd fail under)
//   D 2026-08-31  expect 1000.02     no tol   -> FAIL  (0.02 > USD default 0.01)
//   E 2026-05-14  expect    0        no tol   -> PASS  (END-of-day asOf: the
//                                                05-15 entry is excluded)
// Plus tenant isolation and the persist-cache path.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { postJournalEntry } from "@/lib/accounting/post-journal";
import { checkBalanceAssertions, type AssertionCheckResult } from "@/lib/accounting/balance-assertions";
import { withAuditLogMutableTransaction } from "./_helpers/audit-log-cleanup";

const prisma = new PrismaClient();

const SUFFIX = ("BAS" + Date.now().toString(36) + Math.floor(Math.random() * 9999)).toUpperCase();
const ENTITY_CODE = `BAS-${SUFFIX}`;

let tenantId: string;
let userId: string;
let entityId: string;
let bookId: string;
let cashAccountId: string;

async function addAssertion(asOf: string, expected: string, tolerance: string | null) {
  return prisma.balanceAssertion.create({
    data: {
      tenantId,
      entityId,
      bookId,
      accountId: cashAccountId,
      currencyId: "USD",
      asOf: new Date(asOf),
      expectedAmount: expected,
      tolerance,
    },
  });
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
    data: { email: `bal-assert-${SUFFIX}@example.test`, displayName: "Assertion tester", isActive: true },
  });
  userId = u.id;

  const tenant = await prisma.tenant.create({
    data: { slug: `bas-${SUFFIX.toLowerCase()}`, name: "Assertion tenant", ownerUserId: u.id },
  });
  tenantId = tenant.id;

  const entity = await prisma.legalEntity.create({
    data: { tenantId, code: ENTITY_CODE, name: "Assertion Co.", functionalCurrencyId: "USD" },
  });
  entityId = entity.id;

  await prisma.account.createMany({
    data: [
      { tenantId, entityId, code: "CASH", name: "Cash", type: "ASSET", normalBalance: "DEBIT" },
      { tenantId, entityId, code: "REV", name: "Revenue", type: "REVENUE", normalBalance: "CREDIT" },
    ],
  });
  const cash = await prisma.account.findFirstOrThrow({
    where: { entityId, code: "CASH" },
    select: { id: true },
  });
  cashAccountId = cash.id;

  await postJournalEntry(prisma, {
    tenantId,
    entityCode: ENTITY_CODE,
    bookCode: "US_GAAP",
    documentDate: new Date("2026-05-15"),
    memo: "Cash sale",
    source: "MANUAL",
    lines: [
      { accountCode: "CASH", debit: "1000" },
      { accountCode: "REV", credit: "1000" },
    ],
  });

  await addAssertion("2026-05-31", "1000", null);
  await addAssertion("2026-06-30", "900", null);
  await addAssertion("2026-07-31", "1000.50", "1.00");
  await addAssertion("2026-08-31", "1000.02", null);
  await addAssertion("2026-05-14", "0", null);
});

afterAll(async () => {
  await prisma.balanceAssertion.deleteMany({ where: { entityId } });
  await prisma.journalLine.deleteMany({ where: { entry: { entityId } } });
  await prisma.journalEntry.deleteMany({ where: { entityId } });
  await prisma.account.deleteMany({ where: { entityId } });
  await prisma.legalEntity.deleteMany({ where: { id: entityId } });
  // app_user hard-delete runs the audit_log FK check, which the append-only
  // RULE rewrites -> XX000. Suspend the rules for the tenant/user teardown.
  await withAuditLogMutableTransaction(prisma, async (tx) => {
    await tx.auditLog.deleteMany({ where: { OR: [{ tenantId }, { actorUserId: userId }] } });
    await tx.tenant.delete({ where: { id: tenantId } });
    await tx.user.delete({ where: { id: userId } });
  });
  await prisma.$disconnect();
});

function byDate(results: AssertionCheckResult[]) {
  return new Map(results.map((r) => [r.asOf.toISOString().slice(0, 10), r]));
}

describe("checkBalanceAssertions", () => {
  it("PASSes an exact match and FAILs a real discrepancy", async () => {
    const m = byDate(await checkBalanceAssertions(prisma, { tenantId, entityCode: ENTITY_CODE }));

    const exact = m.get("2026-05-31")!;
    expect(exact.status).toBe("PASS");
    expect(exact.observed.toFixed(2)).toBe("1000.00");
    expect(exact.delta.toFixed(2)).toBe("0.00");

    const off = m.get("2026-06-30")!;
    expect(off.status).toBe("FAIL");
    expect(off.delta.toFixed(2)).toBe("100.00"); // observed − expected
  });

  it("honours an explicit tolerance that overrides the currency default", async () => {
    const m = byDate(await checkBalanceAssertions(prisma, { tenantId, entityCode: ENTITY_CODE }));
    const r = m.get("2026-07-31")!;
    // |1000 − 1000.50| = 0.50: inside the explicit 1.00, but well outside the
    // 0.01 USD default — so this PASSing proves the override is applied.
    expect(r.tolerance.toFixed(2)).toBe("1.00");
    expect(r.status).toBe("PASS");
  });

  it("derives the default tolerance from Currency.decimals (USD -> 0.01)", async () => {
    const m = byDate(await checkBalanceAssertions(prisma, { tenantId, entityCode: ENTITY_CODE }));
    const r = m.get("2026-08-31")!;
    expect(r.tolerance.toFixed(2)).toBe("0.01");
    // 0.02 drift is outside 0.01 -> FAIL.
    expect(r.status).toBe("FAIL");
  });

  it("uses END-of-day asOf — an entry dated after the assertion is excluded", async () => {
    const m = byDate(await checkBalanceAssertions(prisma, { tenantId, entityCode: ENTITY_CODE }));
    const r = m.get("2026-05-14")!;
    // The only entry is dated 2026-05-15, so on 05-14 the account is at zero.
    expect(r.observed.toFixed(2)).toBe("0.00");
    expect(r.status).toBe("PASS");
  });

  it("is tenant-scoped — another tenant sees none of these assertions", async () => {
    const results = await checkBalanceAssertions(prisma, {
      tenantId: "00000000-0000-0000-0000-000000000000",
      entityCode: ENTITY_CODE,
    });
    expect(results).toHaveLength(0);
  });

  it("caches the result on the assertion row when persist is set", async () => {
    await checkBalanceAssertions(prisma, { tenantId, entityCode: ENTITY_CODE }, { persist: true });
    const row = await prisma.balanceAssertion.findFirstOrThrow({
      where: { entityId, asOf: new Date("2026-06-30") },
      select: { lastStatus: true, lastObservedAmount: true, lastCheckedAt: true },
    });
    expect(row.lastStatus).toBe("FAIL");
    expect(row.lastObservedAmount?.toFixed(2)).toBe("1000.00");
    expect(row.lastCheckedAt).not.toBeNull();
  });
});
