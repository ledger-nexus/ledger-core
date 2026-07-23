// padBalanceAssertionAction tests.
//
// Fixture: an entity with CASH (DEBIT-normal), LOAN (CREDIT-normal) and an
// OPENING equity account, and NO transactions — the opening-balance case pad
// exists for. Assertions then claim balances the ledger cannot yet support,
// and pad posts the entries that make them true.
//
// Verified:
//   1. DEBIT-normal, short   -> Dr account / Cr pad; assertion then holds.
//   2. CREDIT-normal, short  -> Cr account / Dr pad (direction is derived from
//                               normalBalance, never supplied).
//   3. Already-satisfied assertion -> refused, nothing posted.
//   4. Idempotency: a second pad of the same assertion is refused by the
//      lineage partial-unique index (P2002), not by a status flag.
//   5. Tenant isolation: another tenant gets "not found".
//   6. Audit: a PRIVILEGED_ACTION row with the pad metadata.

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
import { padBalanceAssertionAction } from "@/app/actions/pad-balance-assertion";
import { checkBalanceAssertions } from "@/lib/accounting/balance-assertions";
import { postJournalEntry } from "@/lib/accounting/post-journal";
import { withAuditLogMutableTransaction } from "./_helpers/audit-log-cleanup";

const prisma = new PrismaClient();

const SUFFIX = ("PAD" + Date.now().toString(36) + Math.floor(Math.random() * 9999)).toUpperCase();
const ENTITY_CODE = `PAD-${SUFFIX}`;
const AS_OF = "2026-01-01";

let tenant: { id: string; slug: string };
let user: { id: string; email: string };
let entityId: string;
let bookId: string;
let cashAssertionId: string;
let loanAssertionId: string;
let satisfiedAssertionId: string;

async function accountId(code: string) {
  const a = await prisma.account.findFirstOrThrow({ where: { entityId, code }, select: { id: true } });
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
    data: { email: `pad-${SUFFIX}@example.test`, displayName: "Pad tester", isActive: true },
  });
  user = { id: u.id, email: u.email };

  tenant = await prisma.tenant.create({
    data: { slug: `pad-${SUFFIX.toLowerCase()}`, name: "Pad tenant", ownerUserId: u.id },
  });
  await prisma.tenantMembership.create({
    data: { tenantId: tenant.id, userId: u.id, role: "OWNER" },
  });

  const entity = await prisma.legalEntity.create({
    data: { tenantId: tenant.id, code: ENTITY_CODE, name: "Pad Co.", functionalCurrencyId: "USD" },
  });
  entityId = entity.id;

  await prisma.account.createMany({
    data: [
      { tenantId: tenant.id, entityId, code: "CASH", name: "Cash", type: "ASSET", normalBalance: "DEBIT" },
      { tenantId: tenant.id, entityId, code: "LOAN", name: "Loan payable", type: "LIABILITY", normalBalance: "CREDIT" },
      { tenantId: tenant.id, entityId, code: "OPENING", name: "Opening balance equity", type: "EQUITY", normalBalance: "CREDIT" },
      // Deliberately untouched by every other case in this file, so the
      // "already holds" assertion below stays true regardless of test order.
      // (OPENING is NOT safe for that: it is the pad offset for both pads
      // above, so it moves as soon as they run.)
      { tenantId: tenant.id, entityId, code: "SUSPENSE", name: "Suspense", type: "ASSET", normalBalance: "DEBIT" },
    ],
  });

  const base = {
    tenantId: tenant.id,
    entityId,
    bookId,
    currencyId: "USD",
    asOf: new Date(AS_OF),
  };
  cashAssertionId = (
    await prisma.balanceAssertion.create({
      data: { ...base, accountId: await accountId("CASH"), expectedAmount: "5000" },
    })
  ).id;
  loanAssertionId = (
    await prisma.balanceAssertion.create({
      data: { ...base, accountId: await accountId("LOAN"), expectedAmount: "2500" },
    })
  ).id;
  // SUSPENSE is never posted to or padded against, so this assertion of 0
  // holds no matter what order the tests run in.
  satisfiedAssertionId = (
    await prisma.balanceAssertion.create({
      data: { ...base, accountId: await accountId("SUSPENSE"), expectedAmount: "0" },
    })
  ).id;
});

afterAll(async () => {
  await prisma.balanceAssertion.deleteMany({ where: { entityId } });
  await prisma.journalLine.deleteMany({ where: { entry: { entityId } } });
  await prisma.journalEntry.deleteMany({ where: { entityId } });
  await prisma.account.deleteMany({ where: { entityId } });
  await prisma.recordEvent.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.legalEntity.deleteMany({ where: { id: entityId } });
  await withAuditLogMutableTransaction(prisma, async (tx) => {
    await tx.auditLog.deleteMany({
      where: { OR: [{ tenantId: tenant.id }, { actorUserId: user.id }] },
    });
    await tx.tenantMembership.deleteMany({ where: { tenantId: tenant.id } });
    await tx.tenant.delete({ where: { id: tenant.id } });
    await tx.user.delete({ where: { id: user.id } });
  });
  await prisma.$disconnect();
});

function signIn() {
  mockCookieStore.clear();
  mockCookieStore.set("lc-user", { value: authInternal.encode(user.id) });
  mockCookieStore.set("lc-tenant", { value: tenant.slug });
}

async function linesOf(entryId: string) {
  const e = await prisma.journalEntry.findUniqueOrThrow({
    where: { id: entryId },
    include: { lines: { include: { account: { select: { code: true } } }, orderBy: { lineNo: "asc" } } },
  });
  return e.lines.map((l) => ({
    code: l.account.code,
    debit: l.debit.toFixed(2),
    credit: l.credit.toFixed(2),
  }));
}

describe("padBalanceAssertionAction — DEBIT-normal account", () => {
  it("debits the short account and credits the pad account, satisfying the assertion", async () => {
    signIn();
    const r = await padBalanceAssertionAction({
      assertionId: cashAssertionId,
      padAccountCode: "OPENING",
    });
    expect(r.ok).toBe(true);
    expect(r.entryId).toBeDefined();

    // CASH is DEBIT-normal and short 5000 -> Dr CASH / Cr OPENING.
    expect(await linesOf(r.entryId!)).toEqual([
      { code: "CASH", debit: "5000.00", credit: "0.00" },
      { code: "OPENING", debit: "0.00", credit: "5000.00" },
    ]);

    // The assertion now holds when re-checked against the real ledger.
    const results = await checkBalanceAssertions(prisma, {
      tenantId: tenant.id,
      entityCode: ENTITY_CODE,
    });
    expect(results.find((x) => x.assertionId === cashAssertionId)!.status).toBe("PASS");
  });

  it("writes a PRIVILEGED_ACTION audit row", async () => {
    const row = await prisma.auditLog.findFirst({
      where: {
        eventType: "PRIVILEGED_ACTION",
        action: "pad-balance-assertion",
        tenantId: tenant.id,
        resourceId: cashAssertionId,
      },
      orderBy: { occurredAt: "desc" },
      select: { metadata: true, actorEmail: true, outcome: true },
    });
    expect(row).not.toBeNull();
    expect(row!.outcome).toBe("SUCCESS");
    expect(row!.actorEmail).toBe(user.email);
    const meta = row!.metadata as Record<string, unknown>;
    expect(meta.accountCode).toBe("CASH");
    expect(meta.padAccountCode).toBe("OPENING");
    expect(meta.padAmount).toBe("5000.00");
  });
});

describe("padBalanceAssertionAction — CREDIT-normal account", () => {
  it("credits the short account and debits the pad account", async () => {
    signIn();
    const r = await padBalanceAssertionAction({
      assertionId: loanAssertionId,
      padAccountCode: "OPENING",
    });
    expect(r.ok).toBe(true);
    // LOAN is CREDIT-normal and short 2500 -> Cr LOAN / Dr OPENING.
    expect(await linesOf(r.entryId!)).toEqual([
      { code: "LOAN", debit: "0.00", credit: "2500.00" },
      { code: "OPENING", debit: "2500.00", credit: "0.00" },
    ]);
  });
});

describe("padBalanceAssertionAction — guards", () => {
  it("refuses when the assertion already holds", async () => {
    signIn();
    const r = await padBalanceAssertionAction({
      assertionId: satisfiedAssertionId,
      padAccountCode: "CASH",
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/nothing to pad/i);
  });

  it("refuses a second pad of the same assertion (lineage unique index)", async () => {
    // The first pad satisfied CASH, so simply re-padding would stop at the
    // "already holds" branch and never reach the index. Disturb the balance so
    // the assertion FAILS again — now the only thing standing between us and a
    // duplicate pad is the DB, which is exactly what we want to prove.
    await postJournalEntry(prisma, {
      tenantId: tenant.id,
      entityCode: ENTITY_CODE,
      bookCode: "US_GAAP",
      documentDate: new Date("2025-12-31"),
      memo: "Activity that breaks the padded assertion",
      source: "MANUAL",
      lines: [
        { accountCode: "CASH", debit: "100" },
        { accountCode: "OPENING", credit: "100" },
      ],
    });

    signIn();
    const r = await padBalanceAssertionAction({
      assertionId: cashAssertionId,
      padAccountCode: "OPENING",
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/already been padded/i);
  });

  it("refuses when the pad account is the asserted account", async () => {
    signIn();
    const r = await padBalanceAssertionAction({
      assertionId: loanAssertionId,
      padAccountCode: "LOAN",
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/must differ/i);
  });
});

describe("padBalanceAssertionAction — tenant isolation", () => {
  it("returns 'not found' for another tenant's assertion", async () => {
    const otherUser = await prisma.user.create({
      data: { email: `pad-other-${SUFFIX}@example.test`, displayName: "other", isActive: true },
    });
    const otherTenant = await prisma.tenant.create({
      data: { slug: `pad-other-${SUFFIX.toLowerCase()}`, name: "Other", ownerUserId: otherUser.id },
    });
    await prisma.tenantMembership.create({
      data: { tenantId: otherTenant.id, userId: otherUser.id, role: "OWNER" },
    });
    try {
      mockCookieStore.clear();
      mockCookieStore.set("lc-user", { value: authInternal.encode(otherUser.id) });
      mockCookieStore.set("lc-tenant", { value: otherTenant.slug });
      const r = await padBalanceAssertionAction({
        assertionId: cashAssertionId,
        padAccountCode: "OPENING",
      });
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/not found/i);
    } finally {
      await prisma.tenantMembership.deleteMany({ where: { tenantId: otherTenant.id } });
      await prisma.tenant.delete({ where: { id: otherTenant.id } });
      await prisma.user.delete({ where: { id: otherUser.id } }).catch(() => {});
    }
  });
});
