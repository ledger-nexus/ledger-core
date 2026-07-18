// Integration tests for reclassifyJournalEntryAction.
//
// What we verify:
//   1. Happy path: a POSTED entry that booked Dr EXP_WRONG / Cr CASH is
//      reclassified EXP_WRONG → EXP_RIGHT → a new balanced correcting entry
//      (Cr EXP_WRONG / Dr EXP_RIGHT), correctionOfId set to the source, source
//      LEFT POSTED (a correction supplements, it does not negate).
//   2. Guard — amount exceeds what the source booked on the from-account.
//   3. Guard — from-account not present in the source entry.
//   4. Guard — source is not POSTED (REVERSED here).
//   5. Tenant isolation: another tenant cannot reclassify this JE (not found).
//   6. Audit: a PRIVILEGED_ACTION row with action=reclassify-journal-entry and
//      metadata.{from,to}AccountCode + amount.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
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
import { reclassifyJournalEntryAction } from "@/app/actions/reclassify-journal-entry";
import { postJournalEntry } from "@/lib/accounting/post-journal";
import { withAuditLogMutableTransaction } from "./_helpers/audit-log-cleanup";

const prisma = new PrismaClient();

const SUFFIX = ("RCL" + Date.now().toString(36) + Math.floor(Math.random() * 9999)).toUpperCase();
const ENTITY_CODE = `RCL-${SUFFIX}`;

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
      email: `reclass-${SUFFIX}@example.test`,
      displayName: "Reclass tester",
      isActive: true,
    },
  });
  user = { id: u.id, email: u.email };

  tenant = await prisma.tenant.create({
    data: {
      slug: `rcl-${SUFFIX.toLowerCase()}`,
      name: "Reclass tenant",
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
      name: "Reclass Co.",
      functionalCurrencyId: "USD",
    },
  });
  entityId = entity.id;

  await prisma.account.createMany({
    data: [
      { tenantId: tenant.id, entityId, code: "EXP_WRONG", name: "Wrong expense", type: "EXPENSE", normalBalance: "DEBIT" },
      { tenantId: tenant.id, entityId, code: "EXP_RIGHT", name: "Right expense", type: "EXPENSE", normalBalance: "DEBIT" },
      { tenantId: tenant.id, entityId, code: "CASH", name: "Cash", type: "ASSET", normalBalance: "DEBIT" },
    ],
  });

  // The source JE — an expense that hit the WRONG account: Dr EXP_WRONG / Cr CASH.
  const result = await postJournalEntry(prisma, {
    tenantId: tenant.id,
    entityCode: ENTITY_CODE,
    bookCode: "US_GAAP",
    documentDate: new Date("2026-06-15"),
    memo: "Expense booked to the wrong account",
    source: "MANUAL",
    createdBy: user.email,
    lines: [
      { accountCode: "EXP_WRONG", debit: "1000" },
      { accountCode: "CASH", credit: "1000" },
    ],
  });
  postedEntryId = result.id;
});

afterAll(async () => {
  await prisma.journalLine.deleteMany({ where: { entry: { entityId } } });
  await prisma.journalEntry.deleteMany({ where: { entityId } });
  await prisma.account.deleteMany({ where: { entityId } });
  await prisma.recordEvent.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.legalEntity.deleteMany({ where: { id: entityId } });
  await withAuditLogMutableTransaction(prisma, async (tx) => {
    await tx.auditLog.deleteMany({
      where: {
        OR: [{ tenantId: tenant.id }, { actorUserId: user.id }],
      },
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

describe("reclassifyJournalEntryAction — happy path", () => {
  it("posts a balanced correcting entry, links correctionOfId, leaves source POSTED", async () => {
    signIn();
    const r = await reclassifyJournalEntryAction({
      id: postedEntryId,
      fromAccountCode: "EXP_WRONG",
      toAccountCode: "EXP_RIGHT",
      amount: "1000",
      reclassDate: "2026-06-30",
    });
    expect(r.ok).toBe(true);
    expect(r.reclassId).toBeDefined();
    expect(r.reclassEntryNumber).toMatch(/RCL-/);

    const reclass = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: r.reclassId! },
      include: {
        lines: {
          include: { account: { select: { code: true } } },
          orderBy: { lineNo: "asc" },
        },
      },
    });
    expect(reclass.documentDate.toISOString().slice(0, 10)).toBe("2026-06-30");
    expect(reclass.correctionOfId).toBe(postedEntryId);
    expect(reclass.source).toBe("SYSTEM");
    expect(reclass.memo).toMatch(/Reclass of /);
    expect(reclass.lines).toHaveLength(2);

    // Source net-debited EXP_WRONG, so the reclass CREDITS it out...
    const wrongLine = reclass.lines.find((l) => l.account.code === "EXP_WRONG");
    expect(wrongLine).toBeDefined();
    expect(wrongLine!.debit.toString()).toBe("0");
    expect(wrongLine!.credit.toString()).toBe("1000");

    // ...and DEBITS the amount into EXP_RIGHT.
    const rightLine = reclass.lines.find((l) => l.account.code === "EXP_RIGHT");
    expect(rightLine).toBeDefined();
    expect(rightLine!.debit.toString()).toBe("1000");
    expect(rightLine!.credit.toString()).toBe("0");

    // A correction supplements — the source stays POSTED (NOT reversed).
    const refreshed = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: postedEntryId },
      select: { status: true },
    });
    expect(refreshed.status).toBe("POSTED");

    // Audit row written.
    const auditRow = await prisma.auditLog.findFirst({
      where: {
        eventType: "PRIVILEGED_ACTION",
        action: "reclassify-journal-entry",
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
    expect(meta.fromAccountCode).toBe("EXP_WRONG");
    expect(meta.toAccountCode).toBe("EXP_RIGHT");
    expect(meta.amount).toBe("1000.00");
    expect(meta.reclassEntryNumber).toBe(reclass.entryNumber);
  });
});

describe("reclassifyJournalEntryAction — guards", () => {
  it("refuses an amount larger than the source booked on the from-account", async () => {
    signIn();
    const r = await reclassifyJournalEntryAction({
      id: postedEntryId,
      fromAccountCode: "EXP_WRONG",
      toAccountCode: "EXP_RIGHT",
      amount: "2000",
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/exceeds/i);
  });

  it("refuses when the from-account is not in the source entry", async () => {
    signIn();
    // EXP_RIGHT exists as an account but is NOT a line on the source JE.
    const r = await reclassifyJournalEntryAction({
      id: postedEntryId,
      fromAccountCode: "EXP_RIGHT",
      toAccountCode: "EXP_WRONG",
      amount: "100",
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/no balance/i);
  });

  it("refuses to reclassify a non-POSTED entry", async () => {
    signIn();
    // A separate entry, flipped to REVERSED for the guard.
    const other = await postJournalEntry(prisma, {
      tenantId: tenant.id,
      entityCode: ENTITY_CODE,
      bookCode: "US_GAAP",
      documentDate: new Date("2026-06-15"),
      memo: "Another expense",
      source: "MANUAL",
      createdBy: user.email,
      lines: [
        { accountCode: "EXP_WRONG", debit: "500" },
        { accountCode: "CASH", credit: "500" },
      ],
    });
    await prisma.journalEntry.update({
      where: { id: other.id },
      data: { status: "REVERSED" },
    });
    const r = await reclassifyJournalEntryAction({
      id: other.id,
      fromAccountCode: "EXP_WRONG",
      toAccountCode: "EXP_RIGHT",
      amount: "500",
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/POSTED/i);
  });
});

describe("reclassifyJournalEntryAction — tenant isolation", () => {
  it("returns 'not found' when called from a different tenant", async () => {
    const otherUser = await prisma.user.create({
      data: {
        email: `reclass-other-${SUFFIX}@example.test`,
        displayName: "other",
        isActive: true,
      },
    });
    const otherTenant = await prisma.tenant.create({
      data: {
        slug: `rcl-other-${SUFFIX.toLowerCase()}`,
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
      const r = await reclassifyJournalEntryAction({
        id: postedEntryId,
        fromAccountCode: "EXP_WRONG",
        toAccountCode: "EXP_RIGHT",
        amount: "100",
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
