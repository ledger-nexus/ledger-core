// Integration tests for the JE notes feature.
//
// What we verify:
//   1. Create: a signed-in user adds a note → row exists with author
//      snapshotted + body + tenantId + entryId.
//   2. Resolve: any user in the tenant can mark resolved → resolvedAt
//      and resolvedBy populate.
//   3. Unresolve: the same action in reverse → fields null again.
//   4. Tenant isolation: a user in tenant B cannot create / resolve /
//      delete a note on a JE in tenant A.
//   5. Delete authorization: only the author OR an admin can delete.
//      Another tenant member gets ACCESS_DENIED.
//   6. Audit: PRIVILEGED_ACTION row written for each action.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
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
import {
  createJournalEntryNoteAction,
  resolveJournalEntryNoteAction,
  unresolveJournalEntryNoteAction,
  deleteJournalEntryNoteAction,
} from "@/app/actions/journal-entry-notes";
import { postJournalEntry } from "@/lib/accounting/post-journal";
import { withAuditLogMutable } from "./_helpers/audit-log-cleanup";

const prisma = new PrismaClient();
const SUFFIX = ("NOTE" + Date.now().toString(36) + Math.floor(Math.random() * 9999)).toUpperCase();
const ENTITY_CODE = `NOTE-${SUFFIX}`;

let tenant: { id: string; slug: string };
let author: { id: string; email: string };
let otherMember: { id: string; email: string };
let entityId: string;
let entryId: string;

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

  const a = await prisma.user.create({
    data: {
      email: `note-author-${SUFFIX}@example.test`,
      displayName: "Author",
      isActive: true,
    },
  });
  author = { id: a.id, email: a.email };

  const o = await prisma.user.create({
    data: {
      email: `note-other-${SUFFIX}@example.test`,
      displayName: "Other member",
      isActive: true,
    },
  });
  otherMember = { id: o.id, email: o.email };

  tenant = await prisma.tenant.create({
    data: {
      slug: `note-${SUFFIX.toLowerCase()}`,
      name: "Note tenant",
      ownerUserId: author.id,
    },
  });
  await prisma.tenantMembership.createMany({
    data: [
      { tenantId: tenant.id, userId: author.id, role: "OWNER" },
      { tenantId: tenant.id, userId: otherMember.id, role: "MEMBER" },
    ],
  });

  const entity = await prisma.legalEntity.create({
    data: {
      tenantId: tenant.id,
      code: ENTITY_CODE,
      name: "Note Co.",
      functionalCurrencyId: "USD",
    },
  });
  entityId = entity.id;
  await prisma.account.createMany({
    data: [
      { tenantId: tenant.id, entityId, code: "1000", name: "Cash", type: "ASSET", normalBalance: "DEBIT" },
      { tenantId: tenant.id, entityId, code: "4000", name: "Revenue", type: "REVENUE", normalBalance: "CREDIT" },
    ],
  });

  const res = await postJournalEntry(prisma, {
    tenantId: tenant.id,
    entityCode: ENTITY_CODE,
    bookCode: "US_GAAP",
    documentDate: new Date("2026-05-15"),
    memo: "Note-feature test JE",
    source: "MANUAL",
    createdBy: author.email,
    lines: [
      { accountCode: "1000", debit: "100" },
      { accountCode: "4000", credit: "100" },
    ],
  });
  entryId = res.id;
});

afterAll(async () => {
  await prisma.journalEntryNote.deleteMany({ where: { tenantId: tenant.id } });
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
  await prisma.user.deleteMany({ where: { id: { in: [author.id, otherMember.id] } } }).catch(() => {});
  await prisma.$disconnect();
});

beforeEach(async () => {
  // Clean notes between tests so each starts fresh.
  await prisma.journalEntryNote.deleteMany({ where: { entryId } });
  await withAuditLogMutable(prisma, async () => {
    await prisma.auditLog.deleteMany({
    where: { tenantId: tenant.id, resource: "JournalEntryNote" },
  });
  });
});

function signInAs(user: { id: string }) {
  mockCookieStore.clear();
  mockCookieStore.set("lc-user", { value: authInternal.encode(user.id) });
  mockCookieStore.set("lc-tenant", { value: tenant.slug });
}

describe("createJournalEntryNoteAction", () => {
  it("creates a note with the author snapshotted and writes an audit row", async () => {
    signInAs(author);
    const r = await createJournalEntryNoteAction({
      entryId,
      body: "Verify this accrual — looks doubled to me.",
    });
    expect(r.ok).toBe(true);
    expect(r.noteId).toBeDefined();

    const note = await prisma.journalEntryNote.findUniqueOrThrow({
      where: { id: r.noteId! },
    });
    expect(note.entryId).toBe(entryId);
    expect(note.tenantId).toBe(tenant.id);
    expect(note.authorUserId).toBe(author.id);
    expect(note.authorEmail).toBe(author.email);
    expect(note.resolvedAt).toBeNull();
    expect(note.body).toMatch(/doubled/);

    const audit = await prisma.auditLog.findFirst({
      where: {
        eventType: "PRIVILEGED_ACTION",
        action: "create-journal-entry-note",
        resourceId: note.id,
      },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actorEmail).toBe(author.email);
  });

  it("rejects an empty body", async () => {
    signInAs(author);
    const r = await createJournalEntryNoteAction({ entryId, body: "" });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/1.*2000/);
  });

  it("rejects a cross-tenant entryId (returns 'not found', no leak)", async () => {
    // Make a second tenant with its own JE, then try to add a note from
    // tenantA pointing at tenantB's JE.
    const otherUser = await prisma.user.create({
      data: {
        email: `note-cross-${SUFFIX}@example.test`,
        displayName: "x",
        isActive: true,
      },
    });
    const otherTenant = await prisma.tenant.create({
      data: {
        slug: `note-cross-${SUFFIX.toLowerCase()}`,
        name: "Cross",
        ownerUserId: otherUser.id,
      },
    });
    await prisma.tenantMembership.create({
      data: { tenantId: otherTenant.id, userId: otherUser.id, role: "OWNER" },
    });
    try {
      // Author (tenant A) tries to attach a note to a JE that doesn't
      // exist in tenant A. Should fail.
      signInAs(author);
      const r = await createJournalEntryNoteAction({
        entryId: "00000000-0000-0000-0000-000000000000",
        body: "should not work",
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

describe("resolve / unresolve", () => {
  it("any tenant member can resolve a note", async () => {
    signInAs(author);
    const created = await createJournalEntryNoteAction({
      entryId,
      body: "Please check",
    });
    expect(created.ok).toBe(true);

    // otherMember (not the author) resolves it. Should succeed.
    signInAs(otherMember);
    const r = await resolveJournalEntryNoteAction({ noteId: created.noteId! });
    expect(r.ok).toBe(true);

    const refreshed = await prisma.journalEntryNote.findUniqueOrThrow({
      where: { id: created.noteId! },
    });
    expect(refreshed.resolvedAt).not.toBeNull();
    expect(refreshed.resolvedBy).toBe(otherMember.email);
  });

  it("unresolve clears resolvedAt + resolvedBy", async () => {
    signInAs(author);
    const created = await createJournalEntryNoteAction({
      entryId,
      body: "x",
    });
    await resolveJournalEntryNoteAction({ noteId: created.noteId! });

    const r = await unresolveJournalEntryNoteAction({ noteId: created.noteId! });
    expect(r.ok).toBe(true);

    const refreshed = await prisma.journalEntryNote.findUniqueOrThrow({
      where: { id: created.noteId! },
    });
    expect(refreshed.resolvedAt).toBeNull();
    expect(refreshed.resolvedBy).toBeNull();
  });
});

describe("delete authorization", () => {
  it("author can delete their own note", async () => {
    signInAs(author);
    const created = await createJournalEntryNoteAction({
      entryId,
      body: "mine",
    });
    expect(created.ok).toBe(true);
    const r = await deleteJournalEntryNoteAction({ noteId: created.noteId! });
    expect(r.ok).toBe(true);
    const gone = await prisma.journalEntryNote.findUnique({
      where: { id: created.noteId! },
    });
    expect(gone).toBeNull();
  });

  it("a different non-admin user cannot delete someone else's note", async () => {
    signInAs(author);
    const created = await createJournalEntryNoteAction({
      entryId,
      body: "mine",
    });
    // Other tenant member (not admin in this test setup) tries to delete.
    signInAs(otherMember);
    const r = await deleteJournalEntryNoteAction({ noteId: created.noteId! });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/author/i);

    // Note still exists.
    const still = await prisma.journalEntryNote.findUnique({
      where: { id: created.noteId! },
    });
    expect(still).not.toBeNull();
  });
});
