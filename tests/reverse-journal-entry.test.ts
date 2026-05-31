// Integration tests for reverseJournalEntryAction.
//
// What we verify:
//   1. Happy path: a POSTED 2-line JE reverses → new entry exists with
//      sign-flipped lines, reversalOfId set, source flipped to REVERSED.
//   2. Idempotency / status: reversing an already-REVERSED entry refuses
//      with a clear error and DOESN'T post a duplicate.
//   3. Tenant isolation: a tenant cannot reverse another tenant's JE
//      (returns "not found" — no cross-tenant leak).
//   4. Audit: a PRIVILEGED_ACTION row is written with action=
//      reverse-journal-entry and metadata.{source,reversal}EntryNumber.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { withAuditLogMutable } from "./_helpers/audit-log-cleanup";
import { PrismaClient } from "@prisma/client";

const mockCookieStore = new Map<string, { value: string }>();
vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) => mockCookieStore.get(name),
    set: (
      opts: { name: string; value: string } | string,
      maybeValue?: string
    ) => {
      if (typeof opts === "string") {
        mockCookieStore.set(opts, { value: maybeValue ?? "" });
      } else {
        mockCookieStore.set(opts.name, { value: opts.value });
      }
    },
    delete: (name: string) => mockCookieStore.delete(name),
  }),
  headers: () => ({ get: () => null }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { _internal as authInternal } from "@/lib/auth/current-user";
import { reverseJournalEntryAction } from "@/app/actions/reverse-journal-entry";
import { postJournalEntry } from "@/lib/accounting/post-journal";

const prisma = new PrismaClient();

const SUFFIX = ("REV" + Date.now().toString(36) + Math.floor(Math.random() * 9999)).toUpperCase();
const ENTITY_CODE = `REV-${SUFFIX}`;

let tenant: { id: string; slug: string };
let user: { id: string; email: string };
let entityId: string;
let postedEntryId: string;

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
    data: {
      email: `reverse-${SUFFIX}@example.test`,
      displayName: "Reverse tester",
      isActive: true,
    },
  });
  user = { id: u.id, email: u.email };

  tenant = await prisma.tenant.create({
    data: {
      slug: `rev-${SUFFIX.toLowerCase()}`,
      name: "Reverse tenant",
      ownerUserId: user.id,
    },
  });
  await prisma.tenantMembership.create({
    data: { tenantId: tenant.id, userId: user.id, role: "OWNER" },
  });

  const entity = await prisma.legalEntity.create({
    data: {
      tenantId: tenant.id,
      code: ENTITY_CODE,
      name: "Reverse Co.",
      functionalCurrencyId: "USD",
    },
  });
  entityId = entity.id;

  await prisma.account.createMany({
    data: [
      {
        tenantId: tenant.id,
        entityId,
        code: "EXP",
        name: "Expense",
        type: "EXPENSE",
        normalBalance: "DEBIT",
      },
      {
        tenantId: tenant.id,
        entityId,
        code: "ACCRUAL",
        name: "Accrued liability",
        type: "LIABILITY",
        normalBalance: "CREDIT",
      },
    ],
  });

  // The source JE — a classic Dec 31 accrual: Dr Expense / Cr Accrual.
  const result = await postJournalEntry(prisma, {
    tenantId: tenant.id,
    entityCode: ENTITY_CODE,
    bookCode: "US_GAAP",
    documentDate: new Date("2026-12-31"),
    memo: "Dec 31 expense accrual",
    source: "MANUAL",
    createdBy: user.email,
    lines: [
      { accountCode: "EXP", debit: "1000" },
      { accountCode: "ACCRUAL", credit: "1000" },
    ],
  });
  postedEntryId = result.id;
});

afterAll(async () => {
  // audit_log is DB-level append-only — use the test-only escape
  // hatch so cleanup can delete the rows that block the cascading
  // tenant.delete FK.
  await withAuditLogMutable(prisma, async () => {
    await prisma.auditLog.deleteMany({ where: { tenantId: tenant.id } });
  });
  await prisma.journalLine.deleteMany({ where: { entry: { entityId } } });
  await prisma.journalEntry.deleteMany({ where: { entityId } });
  await prisma.account.deleteMany({ where: { entityId } });
  await prisma.recordEvent.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.legalEntity.deleteMany({ where: { id: entityId } });
  await prisma.tenantMembership.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.tenant.delete({ where: { id: tenant.id } });
  await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  await prisma.$disconnect();
});

function signIn() {
  mockCookieStore.clear();
  mockCookieStore.set("lc-user", { value: authInternal.encode(user.id) });
  mockCookieStore.set("lc-tenant", { value: tenant.slug });
}

describe("reverseJournalEntryAction — happy path", () => {
  it("posts a sign-flipped reversal, links via reversalOfId, flips source to REVERSED", async () => {
    signIn();
    const r = await reverseJournalEntryAction({
      id: postedEntryId,
      reversalDate: "2027-01-01",
    });
    expect(r.ok).toBe(true);
    expect(r.reversalId).toBeDefined();
    expect(r.reversalEntryNumber).toMatch(/REV-/);

    // Reversal exists, dated 2027-01-01, with sign-flipped lines.
    const reversal = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: r.reversalId! },
      include: {
        lines: {
          include: { account: { select: { code: true } } },
          orderBy: { lineNo: "asc" },
        },
      },
    });
    expect(reversal.documentDate.toISOString().slice(0, 10)).toBe("2027-01-01");
    expect(reversal.reversalOfId).toBe(postedEntryId);
    expect(reversal.source).toBe("SYSTEM");
    expect(reversal.memo).toMatch(/Reversal of /);
    expect(reversal.lines).toHaveLength(2);

    // Find the EXP line on the reversal — it should now be a CREDIT.
    const expLine = reversal.lines.find((l) => l.account.code === "EXP");
    expect(expLine).toBeDefined();
    expect(expLine!.debit.toString()).toBe("0");
    expect(expLine!.credit.toString()).toBe("1000");

    const accrualLine = reversal.lines.find((l) => l.account.code === "ACCRUAL");
    expect(accrualLine).toBeDefined();
    expect(accrualLine!.debit.toString()).toBe("1000");
    expect(accrualLine!.credit.toString()).toBe("0");

    // Source flipped to REVERSED.
    const refreshed = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: postedEntryId },
      select: { status: true },
    });
    expect(refreshed.status).toBe("REVERSED");

    // Audit row written.
    const auditRow = await prisma.auditLog.findFirst({
      where: {
        eventType: "PRIVILEGED_ACTION",
        action: "reverse-journal-entry",
        tenantId: tenant.id,
        resourceId: postedEntryId,
      },
      orderBy: { occurredAt: "desc" },
      select: { metadata: true, actorEmail: true, outcome: true },
    });
    expect(auditRow).not.toBeNull();
    expect(auditRow!.outcome).toBe("SUCCESS");
    expect(auditRow!.actorEmail).toBe(user.email);
    const meta = auditRow!.metadata as Record<string, unknown>;
    expect(meta.sourceEntryNumber).toMatch(/REV-/);
    expect(meta.reversalEntryNumber).toBe(reversal.entryNumber);
    expect(meta.lineCount).toBe(2);
  });
});

describe("reverseJournalEntryAction — refuses to re-reverse", () => {
  it("returns ok:false when called on an already-REVERSED entry", async () => {
    // postedEntryId was reversed in the test above. Second call must fail.
    signIn();
    const r = await reverseJournalEntryAction({ id: postedEntryId });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/already reversed/i);
  });
});

describe("reverseJournalEntryAction — tenant isolation", () => {
  it("returns 'not found' when called from a different tenant", async () => {
    const otherUser = await prisma.user.create({
      data: {
        email: `reverse-other-${SUFFIX}@example.test`,
        displayName: "other",
        isActive: true,
      },
    });
    const otherTenant = await prisma.tenant.create({
      data: {
        slug: `rev-other-${SUFFIX.toLowerCase()}`,
        name: "Other",
        ownerUserId: otherUser.id,
      },
    });
    await prisma.tenantMembership.create({
      data: { tenantId: otherTenant.id, userId: otherUser.id, role: "OWNER" },
    });
    try {
      mockCookieStore.clear();
      mockCookieStore.set("lc-user", { value: authInternal.encode(otherUser.id) });
      mockCookieStore.set("lc-tenant", { value: otherTenant.slug });
      const r = await reverseJournalEntryAction({ id: postedEntryId });
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/not found/i);
    } finally {
      await prisma.tenantMembership.deleteMany({ where: { tenantId: otherTenant.id } });
      await prisma.tenant.delete({ where: { id: otherTenant.id } });
      await prisma.user.delete({ where: { id: otherUser.id } }).catch(() => {});
    }
  });
});
