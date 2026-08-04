// createBalanceAssertionAction tests.
//
// This is the action that ARMS the tripwire — before it, assertions could be
// checked and padded but never created, so nothing was ever armed.
//
// Verified:
//   1. Happy path: a row lands, scoped to the caller's tenant, and the checker
//      immediately picks it up (create → check is the whole loop).
//   2. Not signed in -> refused, nothing written (the authorization-failure
//      path, not just the happy one).
//   3. Cross-tenant: an entity belonging to ANOTHER tenant reads as unknown,
//      even with a valid code — entity codes are unique only per tenant.
//   4. Unknown account -> refused with a message naming the code.
//   5. Garbage amount -> refused, not silently coerced to zero.
//   6. Duplicate (same account + date) -> refused by the composite unique.
//   7. Audit: a PRIVILEGED_ACTION row carrying the asserted figure.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

const mockCookieStore = new Map<string, { value: string }>();
vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) => mockCookieStore.get(name),
    set: (opts: { name: string; value: string } | string, maybeValue?: string) => {
      if (typeof opts === "string") mockCookieStore.set(opts, { value: maybeValue ?? "" });
      else mockCookieStore.set(opts.name, { value: opts.value });
    },
    delete: (name: string) => mockCookieStore.delete(name),
  }),
  headers: () => ({ get: () => null }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { _internal as authInternal } from "@/lib/auth/current-user";
import { createBalanceAssertionAction } from "@/app/actions/create-balance-assertion";
import { checkBalanceAssertions } from "@/lib/accounting/balance-assertions";
import { withAuditLogMutableTransaction } from "./_helpers/audit-log-cleanup";

const prisma = new PrismaClient();

const SUFFIX = ("CBA" + Date.now().toString(36) + Math.floor(Math.random() * 9999)).toUpperCase();
const ENTITY_CODE = `CBA-${SUFFIX}`;
const OTHER_ENTITY_CODE = `CBAX-${SUFFIX}`;
const AS_OF = "2026-03-31";

let tenant: { id: string; slug: string };
let otherTenant: { id: string; slug: string };
let user: { id: string; email: string };
let otherUser: { id: string; email: string };
let entityId: string;
let otherEntityId: string;

beforeAll(async () => {
  await prisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    update: {},
  });
  await prisma.book.upsert({
    where: { code: "US_GAAP" },
    create: { code: "US_GAAP", name: "US GAAP", basis: "US_GAAP", reportingCurrencyId: "USD" },
    update: {},
  });

  const u = await prisma.user.create({
    data: { email: `cba-${SUFFIX}@example.test`, displayName: "Assertion tester", isActive: true },
  });
  user = { id: u.id, email: u.email };
  tenant = await prisma.tenant.create({
    data: { slug: `cba-${SUFFIX.toLowerCase()}`, name: "Assertion tenant", ownerUserId: u.id },
  });
  await prisma.tenantMembership.create({
    data: { tenantId: tenant.id, userId: u.id, role: "OWNER" },
  });

  // A second tenant with its own entity — the cross-tenant case below proves
  // the action pins the entity lookup by tenant, not just by code.
  const ou = await prisma.user.create({
    data: { email: `cbax-${SUFFIX}@example.test`, displayName: "Other tenant", isActive: true },
  });
  otherUser = { id: ou.id, email: ou.email };
  otherTenant = await prisma.tenant.create({
    data: { slug: `cbax-${SUFFIX.toLowerCase()}`, name: "Other tenant", ownerUserId: ou.id },
  });
  await prisma.tenantMembership.create({
    data: { tenantId: otherTenant.id, userId: ou.id, role: "OWNER" },
  });

  const entity = await prisma.legalEntity.create({
    data: { tenantId: tenant.id, code: ENTITY_CODE, name: "Assert Co.", functionalCurrencyId: "USD" },
  });
  entityId = entity.id;
  const otherEntity = await prisma.legalEntity.create({
    data: {
      tenantId: otherTenant.id,
      code: OTHER_ENTITY_CODE,
      name: "Other Co.",
      functionalCurrencyId: "USD",
    },
  });
  otherEntityId = otherEntity.id;

  await prisma.account.createMany({
    data: [
      { tenantId: tenant.id, entityId, code: "CASH", name: "Cash", type: "ASSET", normalBalance: "DEBIT" },
      { tenantId: tenant.id, entityId, code: "LOAN", name: "Loan payable", type: "LIABILITY", normalBalance: "CREDIT" },
    ],
  });
});

afterAll(async () => {
  await prisma.balanceAssertion.deleteMany({ where: { entityId: { in: [entityId, otherEntityId] } } });
  await prisma.account.deleteMany({ where: { entityId } });
  await prisma.recordEvent.deleteMany({ where: { tenantId: { in: [tenant.id, otherTenant.id] } } });
  await prisma.legalEntity.deleteMany({ where: { id: { in: [entityId, otherEntityId] } } });
  await withAuditLogMutableTransaction(prisma, async (tx) => {
    await tx.auditLog.deleteMany({
      where: {
        OR: [
          { tenantId: { in: [tenant.id, otherTenant.id] } },
          { actorUserId: { in: [user.id, otherUser.id] } },
        ],
      },
    });
    await tx.tenantMembership.deleteMany({ where: { tenantId: { in: [tenant.id, otherTenant.id] } } });
    await tx.tenant.deleteMany({ where: { id: { in: [tenant.id, otherTenant.id] } } });
    await tx.user.deleteMany({ where: { id: { in: [user.id, otherUser.id] } } });
  });
  await prisma.$disconnect();
});

function signIn() {
  mockCookieStore.clear();
  mockCookieStore.set("lc-user", { value: authInternal.encode(user.id) });
  mockCookieStore.set("lc-tenant", { value: tenant.slug });
}

function signOut() {
  mockCookieStore.clear();
}

describe("createBalanceAssertionAction — happy path", () => {
  it("records the assertion and the checker picks it up immediately", async () => {
    signIn();
    const r = await createBalanceAssertionAction({
      entityCode: ENTITY_CODE,
      bookCode: "US_GAAP",
      accountCode: "CASH",
      asOf: AS_OF,
      expectedAmount: "5000",
    });
    expect(r.ok).toBe(true);
    expect(r.assertionId).toBeDefined();

    const row = await prisma.balanceAssertion.findUniqueOrThrow({
      where: { id: r.assertionId! },
      select: { tenantId: true, expectedAmount: true, currencyId: true, tolerance: true },
    });
    expect(row.tenantId).toBe(tenant.id);
    expect(row.expectedAmount.toFixed(2)).toBe("5000.00");
    // Currency is the BOOK's reporting currency, never client-supplied.
    expect(row.currencyId).toBe("USD");
    // Omitted tolerance stays NULL so the checker derives it from precision.
    expect(row.tolerance).toBeNull();

    // The loop that matters: create -> check. CASH has no postings, so the
    // books say 0 against an asserted 5000 — a real, reportable FAIL.
    const results = await checkBalanceAssertions(prisma, {
      tenantId: tenant.id,
      entityCode: ENTITY_CODE,
      bookCode: "US_GAAP",
    });
    const mine = results.find((x) => x.assertionId === r.assertionId);
    expect(mine).toBeDefined();
    expect(mine!.status).toBe("FAIL");
    expect(mine!.observed.toFixed(2)).toBe("0.00");
    expect(mine!.delta.toFixed(2)).toBe("-5000.00");
  });

  it("an explicit tolerance is stored as given", async () => {
    signIn();
    const r = await createBalanceAssertionAction({
      entityCode: ENTITY_CODE,
      bookCode: "US_GAAP",
      accountCode: "LOAN",
      asOf: AS_OF,
      expectedAmount: "0",
      tolerance: "2.50",
    });
    expect(r.ok).toBe(true);
    const row = await prisma.balanceAssertion.findUniqueOrThrow({
      where: { id: r.assertionId! },
      select: { tolerance: true },
    });
    expect(row.tolerance?.toFixed(2)).toBe("2.50");
  });

  it("writes a PRIVILEGED_ACTION audit row carrying the asserted figure", async () => {
    const log = await prisma.auditLog.findFirst({
      where: { tenantId: tenant.id, action: "BALANCE_ASSERTION_CREATED" },
      orderBy: { occurredAt: "desc" },
      select: { eventType: true, actorUserId: true, metadata: true, resource: true },
    });
    expect(log).toBeTruthy();
    expect(log!.eventType).toBe("PRIVILEGED_ACTION");
    expect(log!.actorUserId).toBe(user.id);
    expect(log!.resource).toBe("BalanceAssertion");
    const meta = log!.metadata as Record<string, unknown>;
    expect(meta.accountCode).toBeDefined();
    expect(meta.expectedAmount).toBeDefined();
  });
});

describe("createBalanceAssertionAction — refusals", () => {
  it("refuses when not signed in", async () => {
    signOut();
    const before = await prisma.balanceAssertion.count({ where: { entityId } });
    const r = await createBalanceAssertionAction({
      entityCode: ENTITY_CODE,
      bookCode: "US_GAAP",
      accountCode: "CASH",
      asOf: "2026-04-30",
      expectedAmount: "1",
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/signed in/i);
    const after = await prisma.balanceAssertion.count({ where: { entityId } });
    expect(after).toBe(before);
  });

  it("cannot assert against another tenant's entity, even with a valid code", async () => {
    signIn(); // signed in as tenant A
    const r = await createBalanceAssertionAction({
      entityCode: OTHER_ENTITY_CODE, // belongs to tenant B
      bookCode: "US_GAAP",
      accountCode: "CASH",
      asOf: AS_OF,
      expectedAmount: "100",
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/unknown entity/i);
    const leaked = await prisma.balanceAssertion.count({ where: { entityId: otherEntityId } });
    expect(leaked).toBe(0);
  });

  it("refuses an unknown account and names it", async () => {
    signIn();
    const r = await createBalanceAssertionAction({
      entityCode: ENTITY_CODE,
      bookCode: "US_GAAP",
      accountCode: "NOPE",
      asOf: AS_OF,
      expectedAmount: "1",
    });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("NOPE");
  });

  it("refuses a non-numeric amount rather than coercing it to zero", async () => {
    signIn();
    const r = await createBalanceAssertionAction({
      entityCode: ENTITY_CODE,
      bookCode: "US_GAAP",
      accountCode: "CASH",
      asOf: "2026-05-31",
      expectedAmount: "about five thousand",
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/must be a number/i);
  });

  it("refuses a malformed date", async () => {
    signIn();
    const r = await createBalanceAssertionAction({
      entityCode: ENTITY_CODE,
      bookCode: "US_GAAP",
      accountCode: "CASH",
      asOf: "31/03/2026",
      expectedAmount: "1",
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/YYYY-MM-DD/);
  });

  it("refuses a second assertion for the same account and date", async () => {
    signIn();
    // CASH @ AS_OF was created by the happy-path test above.
    const r = await createBalanceAssertionAction({
      entityCode: ENTITY_CODE,
      bookCode: "US_GAAP",
      accountCode: "CASH",
      asOf: AS_OF,
      expectedAmount: "9999",
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/already exists/i);
  });
});
