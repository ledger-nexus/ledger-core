// DSR export + erasure (#46 harvest slice ⑥). Privacy TSC / GDPR
// Art. 15 + Art. 17.
//
// The contract:
//   - export: the subject can pull their own bundle; ADMIN+ can pull
//     for a co-tenant member; a MEMBER cannot pull someone else's; a
//     subject outside the actor's tenant is invisible; DATA_EXPORT
//     audit row carries COUNTS, not content
//   - erase: OWNER-only, co-tenant-only, self-erase refused. The User
//     row's PII redacts in place; EmailDelivery.toEmail rows redact
//     (matched via the encrypted column's search-hash rewrite);
//     JournalEntryNote.authorEmail snapshots redact BY authorUserId
//     (that column is encrypted with NO search hash — deliberately —
//     so the user-id key is the only reliable one). Financial records
//     and audit rows keep the bare user-id pointer (Art. 17(3)
//     retention exemption). The DATA_ERASURE audit row carries a HASH
//     of the original email, never the plaintext.
//   - idempotent: erasing twice is a no-op with zero counts
//   - Zod: malformed subject ids refused before any query

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  vi,
} from "vitest";
import { PrismaClient } from "@prisma/client";
import { withAuditLogMutable } from "./_helpers/audit-log-cleanup";

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

import {
  exportUserDataAction,
  eraseUserPiiAction,
} from "@/app/actions/data-subject-request";
import { postJournalEntry } from "@/lib/accounting/post-journal";
import { _internal as authInternal } from "@/lib/auth/current-user";
import { prisma as appPrisma } from "@/lib/db";

const prisma = new PrismaClient();
const SUFFIX = "azd" + Date.now().toString(36) + Math.floor(Math.random() * 9999);
const USER_MARKER = "AZD DSR Fixture";
const ENTITY_CODE = `AZD${SUFFIX}`.toUpperCase().slice(0, 14);

let tenantA: { id: string; slug: string };
let owner: { id: string; email: string };
let admin: { id: string; email: string };
let member: { id: string; email: string };
/** The data subject whose PII gets exported + erased. */
let subject: { id: string; email: string };
let noteId: string;

function signInAs(userId: string) {
  mockCookieStore.clear();
  mockCookieStore.set("lc-user", { value: authInternal.encode(userId) });
  mockCookieStore.set("lc-tenant", { value: tenantA.slug });
}

async function scrub(tIds: string[], uIds: string[]) {
  if (tIds.length > 0) {
    await prisma.journalEntryNote.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.journalLine.deleteMany({
      where: { entry: { tenantId: { in: tIds } } },
    });
    await prisma.journalEntry.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.recordEvent.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.emailDelivery.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.notification.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.period.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.fiscalCalendar.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.account.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.legalEntity.deleteMany({ where: { tenantId: { in: tIds } } });
    await withAuditLogMutable(prisma, async () => {
      await prisma.auditLog.deleteMany({ where: { tenantId: { in: tIds } } });
    });
    await prisma.tenant.deleteMany({ where: { id: { in: tIds } } });
  }
  if (uIds.length > 0) {
    await withAuditLogMutable(prisma, async () => {
      await prisma.auditLog.deleteMany({ where: { actorUserId: { in: uIds } } });
      await prisma.user.deleteMany({ where: { id: { in: uIds } } });
    });
  }
}

beforeAll(async () => {
  // Self-healing scrub of prior-run residue.
  const staleTenants = await prisma.tenant.findMany({
    where: { slug: { startsWith: "azd" } },
    select: { id: true },
  });
  const staleUsers = await prisma.user.findMany({
    where: { displayName: { startsWith: USER_MARKER } },
    select: { id: true },
  });
  await scrub(staleTenants.map((t) => t.id), staleUsers.map((u) => u.id));

  const mk = (label: string) =>
    appPrisma.user.create({
      data: {
        email: `azd-${label}-${SUFFIX}@example.test`,
        displayName: `${USER_MARKER} ${label}`,
      },
      select: { id: true, email: true },
    });
  owner = await mk("owner");
  admin = await mk("admin");
  member = await mk("member");
  subject = await mk("subject");

  tenantA = await prisma.tenant.create({
    data: { slug: `azd-a-${SUFFIX}`, name: "AZD A", ownerUserId: owner.id },
    select: { id: true, slug: true },
  });
  await prisma.tenantMembership.createMany({
    data: [
      { tenantId: tenantA.id, userId: owner.id, role: "OWNER" },
      { tenantId: tenantA.id, userId: admin.id, role: "ADMIN" },
      { tenantId: tenantA.id, userId: member.id, role: "MEMBER" },
      { tenantId: tenantA.id, userId: subject.id, role: "MEMBER" },
    ],
  });

  // Subject's data footprint: an email delivery + a JE note authored
  // by them (the note needs a real posted entry underneath).
  await appPrisma.emailDelivery.create({
    data: {
      tenantId: tenantA.id,
      toEmail: subject.email,
      template: "test_fixture",
      subject: "fixture",
      status: "LOGGED_ONLY",
    },
  });

  const entity = await prisma.legalEntity.create({
    data: {
      tenantId: tenantA.id,
      code: ENTITY_CODE,
      name: "AZD Co.",
      functionalCurrencyId: "USD",
    },
    select: { id: true },
  });
  const cal = await prisma.fiscalCalendar.create({
    data: {
      tenantId: tenantA.id,
      entityId: entity.id,
      code: "STD_2026",
      name: "2026",
      periodFrequency: "MONTHLY",
    },
    select: { id: true },
  });
  await prisma.period.create({
    data: {
      tenantId: tenantA.id,
      calendarId: cal.id,
      code: "2026-06",
      ordinal: 6,
      startsOn: new Date("2026-06-01"),
      endsOn: new Date("2026-06-30"),
    },
  });
  for (const [code, name, type, nb] of [
    ["1000", "Cash", "ASSET", "DEBIT"],
    ["4000", "Revenue", "REVENUE", "CREDIT"],
  ] as const) {
    await prisma.account.create({
      data: { tenantId: tenantA.id, entityId: entity.id, code, name, type, normalBalance: nb },
    });
  }
  const entry = await postJournalEntry(appPrisma, {
    tenantId: tenantA.id,
    entityCode: ENTITY_CODE,
    bookCode: "US_GAAP",
    documentDate: new Date("2026-06-10"),
    memo: `azd fixture ${SUFFIX}`,
    createdBy: subject.email,
    lines: [
      { accountCode: "1000", debit: "10" },
      { accountCode: "4000", credit: "10" },
    ],
  });
  const note = await appPrisma.journalEntryNote.create({
    data: {
      tenantId: tenantA.id,
      entryId: entry.id,
      authorUserId: subject.id,
      authorEmail: subject.email,
      body: "fixture note by the data subject",
    },
    select: { id: true },
  });
  noteId = note.id;
});

afterAll(async () => {
  if (tenantA) {
    await scrub([tenantA.id], [owner.id, admin.id, member.id, subject.id]);
  }
  await prisma.$disconnect();
  await appPrisma.$disconnect();
});

describe("exportUserDataAction", () => {
  it("rejects a malformed subject id before any query", async () => {
    signInAs(admin.id);
    const r = await exportUserDataAction("not-a-uuid");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Invalid user id");
  });

  it("the subject can export their own bundle; audit row carries counts", async () => {
    signInAs(subject.id);
    const r = await exportUserDataAction(subject.id);
    expect(r.ok).toBe(true);
    expect(r.payload?.subject.userId).toBe(subject.id);
    expect(r.payload?.subject.email).toBe(subject.email);
    expect(
      r.payload?.memberships.some((m) => m.tenantId === tenantA.id)
    ).toBe(true);

    const audit = await prisma.auditLog.findFirst({
      where: {
        eventType: "DATA_EXPORT",
        action: "data_subject.export",
        resourceId: subject.id,
        actorUserId: subject.id,
      },
      orderBy: { occurredAt: "desc" },
    });
    expect(audit).not.toBeNull();
    // Counts only — the bundle's PII must not land in the audit row.
    expect(JSON.stringify(audit?.metadata)).not.toContain(subject.email);
  });

  it("ADMIN can export a co-tenant member; MEMBER cannot export someone else", async () => {
    signInAs(admin.id);
    const ok = await exportUserDataAction(subject.id);
    expect(ok.ok).toBe(true);

    signInAs(member.id);
    const refused = await exportUserDataAction(subject.id);
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain("ADMIN or OWNER");
  });
});

describe("eraseUserPiiAction", () => {
  it("refuses non-OWNER actors and OWNER self-erasure", async () => {
    signInAs(admin.id);
    const asAdmin = await eraseUserPiiAction(subject.id);
    expect(asAdmin.ok).toBe(false);
    expect(asAdmin.message).toContain("OWNER");

    signInAs(owner.id);
    const self = await eraseUserPiiAction(owner.id);
    expect(self.ok).toBe(false);
    expect(self.message).toContain("cannot erase their own");
  });

  it("OWNER erases the subject: user + deliveries + note-author snapshots redact; audit row holds a hash, not the email", async () => {
    signInAs(owner.id);
    const r = await eraseUserPiiAction(subject.id);
    expect(r.ok).toBe(true);
    expect(r.payload?.emailDeliveriesRedacted).toBeGreaterThanOrEqual(1);
    expect(r.payload?.journalEntryNotesRedacted).toBe(1);

    const redactedEmail = `redacted-${subject.id}@deleted.local`;
    const after = await appPrisma.user.findUnique({
      where: { id: subject.id },
      select: { email: true, displayName: true, isActive: true },
    });
    expect(after?.email).toBe(redactedEmail);
    expect(after?.displayName).toBe("[Redacted User]");
    expect(after?.isActive).toBe(false);

    const note = await appPrisma.journalEntryNote.findUnique({
      where: { id: noteId },
      select: { authorEmail: true, body: true, authorUserId: true },
    });
    expect(note?.authorEmail).toBe(redactedEmail);
    // The note BODY survives — it annotates a financial record.
    expect(note?.body).toContain("fixture note");
    expect(note?.authorUserId).toBe(subject.id);

    const audit = await prisma.auditLog.findFirst({
      where: { eventType: "DATA_ERASURE", resourceId: subject.id },
      orderBy: { occurredAt: "desc" },
    });
    expect(audit).not.toBeNull();
    expect(JSON.stringify(audit?.metadata)).not.toContain(
      `azd-subject-${SUFFIX}`
    );
  });

  it("erasing twice is an idempotent no-op", async () => {
    signInAs(owner.id);
    const again = await eraseUserPiiAction(subject.id);
    expect(again.ok).toBe(true);
    expect(again.payload?.emailDeliveriesRedacted).toBe(0);
    expect(again.payload?.journalEntryNotesRedacted).toBe(0);
  });
});
