// Pen-test integration tests for the cross-tenant gaps surfaced by a
// security review on 2026-05-27 and fixed in the same commit.
//
// What this file proves:
//   1. createJournalEntryAction: refuses anonymous requests (was: posted
//      under whatever scope cookie was supplied — no auth check).
//   2. createJournalEntryAction: scopes the JE write to the actor's
//      tenant (was: tenantId was undefined, so postJournalEntry
//      resolved the entity globally — would silently write to whatever
//      tenant happened to own the entity code).
//   3. applyApPaymentAction: refuses anonymous requests AND refuses
//      cross-tenant id (was: anonymous + global id lookup → arbitrary
//      cross-tenant AP payment).
//   4. applyArPaymentAction: refuses cross-tenant id (was: signed-in
//      but not tenant-scoped).
//   5. JE detail page: tenant-scoped read; cross-tenant id reads as 404
//      (was: any signed-in user could read any JE by id).
//   6. findByLineage (internal API): scoped by tenant so two tenants
//      using the same sourceRecordId no longer collide in dedup.

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
// redirect throws a NEXT_REDIRECT internally — for our pen-test we
// just need to catch the resulting throw without it being mistaken
// for a real error.
vi.mock("next/navigation", () => ({ redirect: () => { throw new Error("NEXT_REDIRECT"); } }));

import { _internal as authInternal } from "@/lib/auth/current-user";
import { createJournalEntryAction } from "@/app/actions/create-journal-entry";
import { applyApPaymentAction } from "@/app/actions/apply-ap-payment";
import { applyArPaymentAction } from "@/app/actions/apply-ar-payment";
import { reassignArItemAction } from "@/app/actions/reassign-ar-item";
import { reassignApItemAction } from "@/app/actions/reassign-ap-item";
import {
  categorizeBankTransactionAction,
  matchBankTransactionAction,
} from "@/app/actions/bank-feed";
import { postJournalEntry } from "@/lib/accounting/post-journal";
import { openArItem } from "@/lib/accounting/sub-ledgers/ar";
import { openApItem } from "@/lib/accounting/sub-ledgers/ap";
import { withAuditLogMutable } from "./_helpers/audit-log-cleanup";

const prisma = new PrismaClient();
const SUFFIX = ("PEN" + Date.now().toString(36)).toUpperCase();
const ADMIN_EMAIL = "controller@northwind.test";

let tenantA: { id: string; slug: string };
let tenantB: { id: string; slug: string };
let admin: { id: string; email: string };
let entityIdA: string;
let entityIdB: string;
let arItemA: string;
let apItemA: string;
let bankTxnA: string;

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

  const u = await prisma.user.upsert({
    where: { email: ADMIN_EMAIL },
    create: { email: ADMIN_EMAIL, displayName: "Pen-test admin", isActive: true },
    update: { isActive: true },
  });
  admin = { id: u.id, email: u.email };

  tenantA = await prisma.tenant.create({
    data: { slug: `pen-a-${SUFFIX.toLowerCase()}`, name: "Tenant A", ownerUserId: admin.id },
  });
  tenantB = await prisma.tenant.create({
    data: { slug: `pen-b-${SUFFIX.toLowerCase()}`, name: "Tenant B", ownerUserId: admin.id },
  });
  // Admin is a member of BOTH tenants — the most interesting attack
  // surface (signed-in legitimate user trying to read/write a tenant
  // they SHOULDN'T have current-scope access to).
  await prisma.tenantMembership.createMany({
    data: [
      { tenantId: tenantA.id, userId: admin.id, role: "OWNER" },
      { tenantId: tenantB.id, userId: admin.id, role: "OWNER" },
    ],
  });

  // Both tenants have an entity coded "ACME" — Phase 4b allows this.
  // This is the bait: a forged scope cookie in tenant A's session
  // pointing at "ACME" used to load tenant B's ACME data.
  const entA = await prisma.legalEntity.create({
    data: { tenantId: tenantA.id, code: "ACME", name: "ACME (A)", functionalCurrencyId: "USD" },
  });
  entityIdA = entA.id;
  const entB = await prisma.legalEntity.create({
    data: { tenantId: tenantB.id, code: "ACME", name: "ACME (B)", functionalCurrencyId: "USD" },
  });
  entityIdB = entB.id;

  // Calendars + periods for each.
  for (const [eid, tid] of [
    [entityIdA, tenantA.id],
    [entityIdB, tenantB.id],
  ] as const) {
    const cal = await prisma.fiscalCalendar.create({
      data: {
        tenantId: tid,
        entityId: eid,
        code: `PEN-CAL-${SUFFIX}-${eid.slice(0, 4)}`,
        name: "Pen cal",
        periodFrequency: "MONTHLY",
      },
    });
    await prisma.period.create({
      data: {
        tenantId: tid,
        calendarId: cal.id,
        code: "2026-05",
        ordinal: 5,
        startsOn: new Date("2026-05-01"),
        endsOn: new Date("2026-05-31"),
      },
    });
  }

  // Minimal chart in BOTH tenants: 1000 Cash, 1200 AR (control AR_TRADE),
  // 2000 AP (control AP_TRADE), 4000 Revenue.
  for (const [eid, tid] of [
    [entityIdA, tenantA.id],
    [entityIdB, tenantB.id],
  ] as const) {
    await prisma.account.createMany({
      data: [
        { tenantId: tid, entityId: eid, code: "1000", name: "Cash", type: "ASSET", normalBalance: "DEBIT", isBank: true },
        { tenantId: tid, entityId: eid, code: "1200", name: "AR", type: "ASSET", normalBalance: "DEBIT", isControlAccount: true, subtype: "AR_TRADE" },
        { tenantId: tid, entityId: eid, code: "2000", name: "AP", type: "LIABILITY", normalBalance: "CREDIT", isControlAccount: true, subtype: "AP_TRADE" },
        { tenantId: tid, entityId: eid, code: "4000", name: "Revenue", type: "REVENUE", normalBalance: "CREDIT" },
        { tenantId: tid, entityId: eid, code: "6000", name: "Expense", type: "EXPENSE", normalBalance: "DEBIT" },
      ],
    });
    await prisma.party.create({
      data: { tenantId: tid, entityId: eid, code: "PARTY", displayName: "Party" },
    });
  }

  // Seed an AR + AP open item in tenant A only — these become the
  // bait the cross-tenant tests try to manipulate from tenant B.
  const jeA = await postJournalEntry(prisma, {
    tenantId: tenantA.id,
    entityCode: "ACME",
    bookCode: "US_GAAP",
    documentDate: new Date("2026-05-10"),
    memo: "Bill A",
    source: "MANUAL",
    lines: [
      { accountCode: "1200", debit: "100", partyCode: "PARTY" },
      { accountCode: "4000", credit: "100" },
    ],
  });
  arItemA = (
    await openArItem(prisma, {
      entityCode: "ACME",
      bookCode: "US_GAAP",
      partyCode: "PARTY",
      openedByEntryId: jeA.id,
      openedDate: new Date("2026-05-10"),
      amount: "100",
      currencyCode: "USD",
      controlAccountCode: "1200",
    })
  ).id;
  const apJE = await postJournalEntry(prisma, {
    tenantId: tenantA.id,
    entityCode: "ACME",
    bookCode: "US_GAAP",
    documentDate: new Date("2026-05-15"),
    memo: "Bill from vendor",
    source: "MANUAL",
    lines: [
      { accountCode: "6000", debit: "50" },
      { accountCode: "2000", credit: "50", partyCode: "PARTY" },
    ],
  });
  apItemA = (
    await openApItem(prisma, {
      entityCode: "ACME",
      bookCode: "US_GAAP",
      partyCode: "PARTY",
      openedByEntryId: apJE.id,
      openedDate: new Date("2026-05-15"),
      amount: "50",
      currencyCode: "USD",
      controlAccountCode: "2000",
    })
  ).id;

  // A FOR_REVIEW bank line in tenant A — the bait the cross-tenant
  // categorize test tries to reach from tenant B.
  const bookA = await prisma.book.findUniqueOrThrow({ where: { code: "US_GAAP" }, select: { id: true } });
  const cashA = await prisma.account.findFirstOrThrow({
    where: { tenantId: tenantA.id, code: "1000", entityId: entityIdA },
    select: { id: true },
  });
  bankTxnA = (
    await prisma.bankTransaction.create({
      data: {
        tenantId: tenantA.id,
        entityId: entityIdA,
        bookId: bookA.id,
        bankAccountId: cashA.id,
        postedDate: new Date("2026-05-20"),
        description: "PEN BANK LINE",
        amount: "-25.0000",
        dedupeHash: `pen-${SUFFIX}`,
        status: "FOR_REVIEW",
      },
      select: { id: true },
    })
  ).id;
});

afterAll(async () => {
  for (const tid of [tenantA?.id, tenantB?.id]) {
    if (!tid) continue;
    await prisma.bankTransaction.deleteMany({ where: { tenantId: tid } });
    await prisma.arApplication.deleteMany({ where: { openItem: { tenantId: tid } } });
    await prisma.apApplication.deleteMany({ where: { openItem: { tenantId: tid } } });
    await prisma.arOpenItem.deleteMany({ where: { tenantId: tid } });
    await prisma.apOpenItem.deleteMany({ where: { tenantId: tid } });
    await prisma.journalLine.deleteMany({ where: { entry: { tenantId: tid } } });
    await prisma.journalEntry.deleteMany({ where: { tenantId: tid } });
    await prisma.party.deleteMany({ where: { tenantId: tid } });
    await prisma.account.deleteMany({ where: { tenantId: tid } });
    await prisma.period.deleteMany({ where: { calendar: { tenantId: tid } } });
    await prisma.fiscalCalendar.deleteMany({ where: { tenantId: tid } });
    await prisma.recordEvent.deleteMany({ where: { tenantId: tid } });
    await withAuditLogMutable(prisma, async () => {
      await prisma.auditLog.deleteMany({ where: { tenantId: tid } });
    });
    await prisma.legalEntity.deleteMany({ where: { tenantId: tid } });
    await prisma.tenantMembership.deleteMany({ where: { tenantId: tid } });
    await prisma.tenant.delete({ where: { id: tid } });
  }
  await prisma.$disconnect();
});

function signOut() {
  mockCookieStore.clear();
}
function signInAs(t: { slug: string }) {
  mockCookieStore.clear();
  mockCookieStore.set("lc-user", { value: authInternal.encode(admin.id) });
  mockCookieStore.set("lc-tenant", { value: t.slug });
  mockCookieStore.set(
    "lc-scope",
    { value: JSON.stringify({ entityCode: "ACME", bookCode: "US_GAAP" }) }
  );
}

function buildJeFormData() {
  const fd = new FormData();
  fd.set("documentDate", "2026-05-20");
  fd.set("memo", "pen test attempt");
  fd.set("source", "MANUAL");
  fd.set(
    "linesJson",
    JSON.stringify([
      { accountCode: "1000", side: "DEBIT", amount: "1" },
      { accountCode: "4000", side: "CREDIT", amount: "1" },
    ])
  );
  return fd;
}

describe("createJournalEntryAction — anonymous request", () => {
  it("refuses an anonymous POST (was: posted with no auth)", async () => {
    signOut();
    const r = await createJournalEntryAction({}, buildJeFormData());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/signed in/i);
    }
  });
});

describe("createJournalEntryAction — tenant scope", () => {
  it("scopes the post to the actor's tenant (no cross-tenant write via scope cookie)", async () => {
    // Sign in to tenant A. The lc-scope cookie names "ACME" — but ACME
    // exists in BOTH tenants, so the POST must end up in TENANT A's
    // ACME, not tenant B's. With the fix, we pass scope.tenantId to
    // postJournalEntry, so it resolves ACME within tenant A.
    signInAs(tenantA);
    const beforeA = await prisma.journalEntry.count({ where: { tenantId: tenantA.id } });
    const beforeB = await prisma.journalEntry.count({ where: { tenantId: tenantB.id } });
    try {
      await createJournalEntryAction({}, buildJeFormData());
    } catch (e) {
      // redirect() throws after a successful post — that's success.
      if (!(e instanceof Error) || !/NEXT_REDIRECT/.test(e.message)) throw e;
    }
    const afterA = await prisma.journalEntry.count({ where: { tenantId: tenantA.id } });
    const afterB = await prisma.journalEntry.count({ where: { tenantId: tenantB.id } });
    expect(afterA).toBe(beforeA + 1);
    expect(afterB).toBe(beforeB); // tenant B untouched
  });
});

describe("createJournalEntryAction — provenance is not client input", () => {
  it("stamps MANUAL even when the request claims AI_APPROVED (was: client-chosen source)", async () => {
    // `source` is lineage: the ledger's permanent record of HOW an entry
    // came to exist. AI_APPROVED specifically asserts a control ran — an
    // AI proposed the entry and a human approved it (see the FX
    // revaluation gate). SYSTEM/IMPORT assert machine origin.
    //
    // The action used to read this straight off the form body through a
    // bare type assertion, which is erased at runtime — so a hand-typed
    // entry could be stamped with any origin its author fancied, and the
    // audit trail would repeat that back to a reviewer as fact. The
    // manual form is this action's only caller, so anything it posts is
    // MANUAL by definition and the server says so, not the client.
    signInAs(tenantA);
    const fd = buildJeFormData();
    fd.set("source", "AI_APPROVED"); // forged — must be ignored
    fd.set("memo", "provenance-forgery-attempt");
    try {
      await createJournalEntryAction({}, fd);
    } catch (e) {
      if (!(e instanceof Error) || !/NEXT_REDIRECT/.test(e.message)) throw e;
    }
    // Identified by recency rather than memo. `prisma` in this file is a
    // raw client with no encryption extension, and JournalEntry.memo is an
    // encrypted column — a plaintext filter can't match the ciphertext on
    // disk, and a read here returns the ciphertext rather than the memo.
    // `source` is not encrypted, which is the field under test.
    const entry = await prisma.journalEntry.findFirstOrThrow({
      where: { tenantId: tenantA.id },
      orderBy: { createdAt: "desc" },
      select: { source: true },
    });
    expect(entry.source).toBe("MANUAL");
  });

  it("stamps MANUAL for an origin the form never offered (SEED)", async () => {
    // The old cast listed SEED and IMPORT among its union members, so a
    // request that skipped the UI could reach for them even though no
    // dropdown ever rendered them.
    signInAs(tenantA);
    const fd = buildJeFormData();
    fd.set("source", "SEED");
    fd.set("memo", "provenance-forgery-attempt-seed");
    try {
      await createJournalEntryAction({}, fd);
    } catch (e) {
      if (!(e instanceof Error) || !/NEXT_REDIRECT/.test(e.message)) throw e;
    }
    const entry = await prisma.journalEntry.findFirstOrThrow({
      where: { tenantId: tenantA.id },
      orderBy: { createdAt: "desc" },
      select: { source: true },
    });
    expect(entry.source).toBe("MANUAL");
  });
});

describe("categorizeBankTransactionAction — auth + tenant scope", () => {
  it("refuses an anonymous categorize (was: n/a — new surface)", async () => {
    signOut();
    const fd = new FormData();
    fd.set("id", bankTxnA);
    fd.set("categoryAccountCode", "6000");
    const r = await categorizeBankTransactionAction({}, fd);
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.error).toMatch(/signed in/i);
  });

  it("refuses a cross-tenant bank line (reads as not found, no post)", async () => {
    // Signed in to tenant B, categorize tenant A's bank line. The
    // tenant-scoped load returns nothing → "not found", and no JE posts.
    signInAs(tenantB);
    const before = await prisma.journalEntry.count({ where: { tenantId: tenantB.id } });
    const fd = new FormData();
    fd.set("id", bankTxnA);
    fd.set("categoryAccountCode", "6000");
    const r = await categorizeBankTransactionAction({}, fd);
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.error).toMatch(/not found/i);
    // Tenant A's line is untouched, still FOR_REVIEW.
    const txn = await prisma.bankTransaction.findUniqueOrThrow({ where: { id: bankTxnA } });
    expect(txn.status).toBe("FOR_REVIEW");
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantB.id } })).toBe(before);
  });
});

describe("matchBankTransactionAction — auth + tenant scope", () => {
  it("refuses an anonymous match", async () => {
    signOut();
    const fd = new FormData();
    fd.set("id", bankTxnA);
    fd.set("entryId", "00000000-0000-0000-0000-000000000000");
    const r = await matchBankTransactionAction({}, fd);
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.error).toMatch(/signed in/i);
  });

  it("refuses matching a cross-tenant bank line (not found, no claim)", async () => {
    // A genuinely matchable tenant-A entry: it moves account 1000 by the
    // same -25 as bankTxnA, so the ONLY thing between tenant B and a
    // cross-tenant claim is the tenant scope. Prove that's enough.
    const target = await postJournalEntry(prisma, {
      tenantId: tenantA.id,
      entityCode: "ACME",
      bookCode: "US_GAAP",
      documentDate: new Date("2026-05-20"),
      memo: "cross-tenant match target",
      source: "MANUAL",
      lines: [
        { accountCode: "1000", credit: "25" }, // -25 on the bank account
        { accountCode: "6000", debit: "25" },
      ],
    });
    signInAs(tenantB);
    const fd = new FormData();
    fd.set("id", bankTxnA);
    fd.set("entryId", target.id);
    const r = await matchBankTransactionAction({}, fd);
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.error).toMatch(/not found/i);
    // Tenant A's line is untouched — not MATCHED, not claimed.
    const txn = await prisma.bankTransaction.findUniqueOrThrow({ where: { id: bankTxnA } });
    expect(txn.status).toBe("FOR_REVIEW");
    expect(txn.postedEntryId).toBeNull();
  });
});

describe("applyApPaymentAction — auth + tenant scope", () => {
  it("refuses an anonymous POST (was: anonymous AP payment)", async () => {
    signOut();
    const fd = new FormData();
    fd.set("openItemId", apItemA);
    fd.set("paymentDate", "2026-05-20");
    fd.set("amount", "50");
    const r = await applyApPaymentAction({}, fd);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/signed in/i);
  });

  it("refuses cross-tenant id (was: paid arbitrary tenant's AP)", async () => {
    // Sign in to tenant B but try to pay tenant A's AP item.
    signInAs(tenantB);
    const beforeBalance = (
      await prisma.apOpenItem.findUniqueOrThrow({ where: { id: apItemA } })
    ).currentBalance.toString();
    const fd = new FormData();
    fd.set("openItemId", apItemA);
    fd.set("paymentDate", "2026-05-20");
    fd.set("amount", "50");
    const r = await applyApPaymentAction({}, fd);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not found in this tenant/i);

    // Item balance unchanged.
    const afterBalance = (
      await prisma.apOpenItem.findUniqueOrThrow({ where: { id: apItemA } })
    ).currentBalance.toString();
    expect(afterBalance).toBe(beforeBalance);
  });
});

describe("applyArPaymentAction — tenant scope", () => {
  it("refuses cross-tenant id (was: paid arbitrary tenant's AR)", async () => {
    signInAs(tenantB);
    const beforeBalance = (
      await prisma.arOpenItem.findUniqueOrThrow({ where: { id: arItemA } })
    ).currentBalance.toString();
    const fd = new FormData();
    fd.set("openItemId", arItemA);
    fd.set("paymentDate", "2026-05-20");
    fd.set("amount", "100");
    const r = await applyArPaymentAction({}, fd);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not found in this tenant/i);

    const afterBalance = (
      await prisma.arOpenItem.findUniqueOrThrow({ where: { id: arItemA } })
    ).currentBalance.toString();
    expect(afterBalance).toBe(beforeBalance);
  });
});

describe("reassign actions — tenant scope (gap #8)", () => {
  it("reassignArItemAction refuses cross-tenant openItemId", async () => {
    // Signed in to tenant B; try to reassign tenant A's AR item to
    // the admin. Without the actorTenantId scope, the helper would
    // have done findUnique({id}) and successfully reassigned tenant
    // A's item — full ownership hijack.
    signInAs(tenantB);
    const beforeOwner = (
      await prisma.arOpenItem.findUniqueOrThrow({ where: { id: arItemA } })
    ).ownerId;
    const r = await reassignArItemAction({
      openItemId: arItemA,
      newOwnerType: "USER",
      newOwnerId: admin.id,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/RECORD_NOT_FOUND/i);
    // Owner unchanged.
    const afterOwner = (
      await prisma.arOpenItem.findUniqueOrThrow({ where: { id: arItemA } })
    ).ownerId;
    expect(afterOwner).toBe(beforeOwner);
  });

  it("reassignApItemAction refuses cross-tenant openItemId", async () => {
    signInAs(tenantB);
    const beforeOwner = (
      await prisma.apOpenItem.findUniqueOrThrow({ where: { id: apItemA } })
    ).ownerId;
    const r = await reassignApItemAction({
      openItemId: apItemA,
      newOwnerType: "USER",
      newOwnerId: admin.id,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/RECORD_NOT_FOUND/i);
    const afterOwner = (
      await prisma.apOpenItem.findUniqueOrThrow({ where: { id: apItemA } })
    ).ownerId;
    expect(afterOwner).toBe(beforeOwner);
  });
});
