// Integration test for RLS Phase 2b — paste-journal-entry + journal-entry-notes.
//
// Both are "helper-already-tx-aware" shapes (paste) and Class W
// (journal-entry-notes — single-table mutations, no helpers). The notes
// file is interesting because four Server Actions share the same
// withTenantContext pattern; this test pins the GUC for the
// representative ones (create + delete) so a future refactor that
// inadvertently drops the wrap would fail loudly.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  withTenantContext,
  currentTenantId,
} from "../src/lib/tenant-context";
import { postJournalEntry } from "../src/lib/accounting/post-journal";
import { deleteEntries } from "./helpers/ledger-cleanup";

const prisma = new PrismaClient();
// Every entry this suite posts, so afterAll can remove exactly those.
// Delete-by-id is the only precise option here: these suites stamp
// generic domain sourceRecordTypes (VendorBill, CustomerInvoice,
// Payment) that the Northwind seed also uses, so a marker sweep would
// take seed rows with it.
const createdEntryIds: string[] = [];

let tenantId: string;
let entityCode: string;
let bookCode: string;
let currencyCode: string;

beforeAll(async () => {
  const tenant = await prisma.tenant.findFirstOrThrow({
    where: { slug: "default" },
    select: { id: true },
  });
  tenantId = tenant.id;
  const entity = await prisma.legalEntity.findFirstOrThrow({
    where: { tenantId, code: "NORTHWIND" },
    select: { code: true },
  });
  entityCode = entity.code;
  bookCode = "US_GAAP";
  currencyCode = "USD";
});

afterAll(async () => {
  // This suite writes into the SHARED Northwind entity. Leaving entries
  // behind drifts every exact-total assertion downstream of it.
  await deleteEntries(prisma, createdEntryIds).catch(() => {});
  await prisma.$disconnect();
});

describe("paste-journal-entry RLS plumbing", () => {
  it("postJournalEntry runs inside withTenantContext with GUC set", async () => {
    let observedGuc: string | null = null;
    const entry = await withTenantContext(prisma, tenantId, async (tx) => {
      observedGuc = await currentTenantId(tx);
      return postJournalEntry(tx, {
        tenantId,
        entityCode,
        bookCode,
        currencyCode,
        documentDate: new Date("2026-06-20"),
        memo: "RLS plumbing — pasted",
        source: "MANUAL",
        sourceRecordType: "RlsPlumbing",
        sourceRecordId: `RLS-PASTE-${Date.now()}`,
        createdBy: "test",
        lines: [
          { accountCode: "1000", debit: "5.00", description: "Cash" },
          { accountCode: "4000", credit: "5.00", description: "Revenue" },
        ],
      });
    });
    // Posted via `return postJournalEntry(tx, …)` INSIDE the withTenantContext
    // callback, so the id lands on the outer variable — the plain
    // `const x = await postJournalEntry(` capture misses it entirely. This is
    // the one that kept leaking after the first pass.
    createdEntryIds.push(entry.id);
    expect(observedGuc).toBe(tenantId);
    expect(entry.id).toMatch(/^[0-9a-f-]{36}$/i);
  });
});

describe("journal-entry-notes RLS plumbing", () => {
  it("create-note: findFirst + create inside one withTenantContext tx", async () => {
    // Setup: a JE to attach the note to.
    const entry = await postJournalEntry(prisma, {
      tenantId,
      entityCode,
      bookCode,
      currencyCode,
      documentDate: new Date("2026-06-01"),
      memo: "RLS plumbing — note target",
      source: "MANUAL",
      sourceRecordType: "RlsPlumbing",
      sourceRecordId: `RLS-NOTE-TGT-${Date.now()}`,
      createdBy: "test",
      lines: [
        { accountCode: "1000", debit: "1.00", description: "Cash" },
        { accountCode: "4000", credit: "1.00", description: "Revenue" },
      ],
    });
    createdEntryIds.push(entry.id);

    // Resolve a real user id + ensure it's a member of this tenant.
    // The seed doesn't create memberships and the shared dev DB may
    // have none, so upsert one (matching the pattern in main's own
    // tenant-scoped tests) rather than assuming one exists.
    const someUser = await prisma.user.findFirstOrThrow({
      select: { id: true, email: true },
    });
    const membership = await prisma.tenantMembership.upsert({
      where: { tenantId_userId: { tenantId, userId: someUser.id } },
      create: { tenantId, userId: someUser.id, role: "OWNER" },
      update: {},
      select: { userId: true, user: { select: { email: true } } },
    });

    let observedGuc: string | null = null;
    const noteId = await withTenantContext(prisma, tenantId, async (tx) => {
      observedGuc = await currentTenantId(tx);

      const e = await tx.journalEntry.findFirstOrThrow({
        where: { id: entry.id, tenantId },
        select: { id: true, entryNumber: true },
      });

      const note = await tx.journalEntryNote.create({
        data: {
          tenantId,
          entryId: e.id,
          authorUserId: membership.userId,
          authorEmail: membership.user.email,
          body: "RLS plumbing test note",
        },
        select: { id: true },
      });
      return note.id;
    });

    expect(observedGuc).toBe(tenantId);
    expect(noteId).toMatch(/^[0-9a-f-]{36}$/i);

    // Cleanup so the test doesn't leak data.
    await prisma.journalEntryNote.delete({ where: { id: noteId } });
  });

  it("delete-note: findFirst + delete each inside their own withTenantContext tx", async () => {
    // Setup: JE + note.
    const entry = await postJournalEntry(prisma, {
      tenantId,
      entityCode,
      bookCode,
      currencyCode,
      documentDate: new Date("2026-06-01"),
      memo: "RLS plumbing — delete-note target",
      source: "MANUAL",
      sourceRecordType: "RlsPlumbing",
      sourceRecordId: `RLS-DEL-TGT-${Date.now()}`,
      createdBy: "test",
      lines: [
        { accountCode: "1000", debit: "1.00", description: "Cash" },
        { accountCode: "4000", credit: "1.00", description: "Revenue" },
      ],
    });
    createdEntryIds.push(entry.id);
    const membership = await prisma.tenantMembership.findFirstOrThrow({
      where: { tenantId },
      select: { userId: true, user: { select: { email: true } } },
    });
    const note = await prisma.journalEntryNote.create({
      data: {
        tenantId,
        entryId: entry.id,
        authorUserId: membership.userId,
        authorEmail: membership.user.email,
        body: "to be deleted",
      },
      select: { id: true },
    });

    // The action wraps the lookup AND the delete each in withTenantContext
    // (two separate txs with the authorization check in between).
    const found = await withTenantContext(prisma, tenantId, async (tx) =>
      tx.journalEntryNote.findFirst({
        where: { id: note.id, tenantId },
        select: { id: true, authorUserId: true },
      })
    );
    expect(found?.id).toBe(note.id);

    await withTenantContext(prisma, tenantId, async (tx) =>
      tx.journalEntryNote.delete({ where: { id: note.id } })
    );

    const after = await prisma.journalEntryNote.findUnique({
      where: { id: note.id },
    });
    expect(after).toBeNull();
  });
});
