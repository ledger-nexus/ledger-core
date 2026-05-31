// End-to-end test of the encrypted-fields Prisma extension against
// the live shared DB. Writes a JournalEntry with a memo, reads it
// back, and confirms:
//   1. The memo round-trips through the application surface
//      (plaintext in, plaintext out).
//   2. The on-disk row's memo is ACTUALLY encrypted (raw SQL probe).
// Confidentiality TSC.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { getDefaultTenantId } from "@/lib/seed/default-tenant";
import { postJournalEntry } from "@/lib/accounting/post-journal";
import { CHART_OF_ACCOUNTS } from "@/lib/db/chart-of-accounts";
import { looksEncrypted } from "@/lib/soc2/field-encryption";

// Standard PrismaClient — bypasses the singleton + extension so we
// can read the raw on-disk row. The app's prisma singleton has the
// extension applied and would auto-decrypt the memo.
const rawPrisma = new PrismaClient();

const ENTITY = "ENC_TEST";
const SUFFIX = randomBytes(4).toString("hex");

beforeAll(async () => {
  // The extension reads FIELD_ENCRYPTION_KEY at use time. Set a known
  // test key so we can verify ciphertext shape. Real production key
  // is provisioned via Vercel env.
  process.env.FIELD_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  // Reset the cached key inside field-encryption — beforeAll runs
  // after the extension may have read an unset env once.
  const { _setKeyForTesting } = await import("@/lib/soc2/field-encryption");
  _setKeyForTesting(null);

  // Standard seed: USD, US_GAAP book, the test entity, monthly
  // calendar + Jan 2026 period, full chart of accounts.
  await rawPrisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    update: {},
  });
  await rawPrisma.book.upsert({
    where: { code: "US_GAAP" },
    create: {
      code: "US_GAAP",
      name: "US GAAP",
      basis: "US_GAAP",
      reportingCurrencyId: "USD",
    },
    update: {},
  });

  const tenantId = await getDefaultTenantId(rawPrisma);
  const entity = await rawPrisma.legalEntity.upsert({
    where: { tenantId_code: { tenantId, code: ENTITY } },
    create: {
      tenantId,
      code: ENTITY,
      name: "Encryption Test Co.",
      functionalCurrencyId: "USD",
    },
    update: { tenantId },
  });
  const calendar = await rawPrisma.fiscalCalendar.upsert({
    where: { entityId_code: { entityId: entity.id, code: "STANDARD_2026" } },
    create: {
      tenantId,
      entityId: entity.id,
      code: "STANDARD_2026",
      name: "2026",
      periodFrequency: "MONTHLY",
    },
    update: {},
  });
  await rawPrisma.period.upsert({
    where: { calendarId_code: { calendarId: calendar.id, code: "2026-01" } },
    create: {
      tenantId,
      calendarId: calendar.id,
      code: "2026-01",
      ordinal: 1,
      startsOn: new Date(Date.UTC(2026, 0, 1)),
      endsOn: new Date(Date.UTC(2026, 0, 31)),
    },
    update: {},
  });
  for (const a of CHART_OF_ACCOUNTS) {
    const existing = await rawPrisma.account.findFirst({
      where: { tenantId, entityId: null, code: a.code },
      select: { id: true },
    });
    if (existing) continue;
    await rawPrisma.account.create({
      data: {
        tenantId,
        code: a.code,
        name: a.name,
        type: a.type,
        normalBalance: a.normalBalance,
        isContra: a.isContra ?? false,
        isControlAccount: a.isControlAccount ?? false,
        isBank: a.isBank ?? false,
        subtype: a.subtype,
      },
    });
  }
});

afterAll(async () => {
  // Targeted cleanup of test JEs + test EmailDelivery rows only.
  const ent = await rawPrisma.legalEntity.findFirst({
    where: { code: ENTITY },
    select: { id: true },
  });
  if (ent) {
    await rawPrisma.journalLine.deleteMany({
      where: { entry: { entityId: ent.id } },
    });
    await rawPrisma.journalEntry.deleteMany({ where: { entityId: ent.id } });
  }
  // EmailDelivery test rows: identified by the SUFFIX-stamped toEmail.
  await rawPrisma.emailDelivery.deleteMany({
    where: { toEmail: { contains: SUFFIX } },
  });
  // Party test rows: identified by the SUFFIX-stamped code.
  await rawPrisma.party.deleteMany({
    where: { code: { contains: SUFFIX } },
  });
  // Tenant test rows: identified by the SUFFIX-stamped slug. The new
  // tenant's owner user was a throwaway with SUFFIX-stamped email —
  // delete that too. Tenant has TenantMembership cascading via FK,
  // but the test never adds members, so a direct deleteMany is safe.
  await rawPrisma.tenant.deleteMany({
    where: { slug: { contains: SUFFIX } },
  });
  await rawPrisma.user.deleteMany({
    where: { email: { contains: `enc-tenant-owner-${SUFFIX}` } },
  });
  await rawPrisma.$disconnect();
});

describe("encrypted-fields extension (Confidentiality TSC)", () => {
  let entryId: string;
  const plaintextMemo = `Sensitive memo ${SUFFIX} — Vendor: Acme; Invoice #1234`;

  beforeEach(async () => {
    const { prisma } = await import("@/lib/db");
    // Post a JE via the standard path. The extension intercepts the
    // create and encrypts the memo before it reaches Postgres.
    const result = await postJournalEntry(prisma as PrismaClient, {
      entityCode: ENTITY,
      bookCode: "US_GAAP",
      documentDate: new Date("2026-01-15"),
      memo: plaintextMemo,
      source: "MANUAL",
      lines: [
        { accountCode: "1000", debit: 100 },
        { accountCode: "4000", credit: 100 },
      ],
    });
    entryId = result.id;
  });

  it("the on-disk memo is encrypted (rawPrisma sees ciphertext)", async () => {
    const raw = await rawPrisma.journalEntry.findUnique({
      where: { id: entryId },
      select: { memo: true },
    });
    expect(raw?.memo).toBeTruthy();
    expect(raw?.memo).not.toBe(plaintextMemo); // must NOT be plaintext
    expect(looksEncrypted(raw?.memo)).toBe(true); // version byte present
  });

  it("the app surface sees plaintext (extension auto-decrypts on read)", async () => {
    const { prisma } = await import("@/lib/db");
    const entry = await prisma.journalEntry.findUnique({
      where: { id: entryId },
      select: { memo: true },
    });
    expect(entry?.memo).toBe(plaintextMemo);
  });

  it("findMany also decrypts (every memo in a list)", async () => {
    const { prisma } = await import("@/lib/db");
    const ent = await rawPrisma.legalEntity.findFirstOrThrow({
      where: { code: ENTITY },
      select: { id: true },
    });
    const entries = await prisma.journalEntry.findMany({
      where: { entityId: ent.id },
      select: { memo: true },
    });
    for (const e of entries) {
      expect(e.memo).not.toMatch(/^[A-Za-z0-9+/=]{40,}$/); // not raw b64
      // Either the test plaintext or another test's plaintext.
      expect(typeof e.memo).toBe("string");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EmailDelivery — second column rollout
// ─────────────────────────────────────────────────────────────────────────────

describe("encrypted-fields extension: EmailDelivery (Confidentiality TSC)", () => {
  let deliveryId: string;
  const plaintextSubject = `Test subject ${SUFFIX}`;
  const plaintextBodyText = `Hi Alice,\n\nYour journal entry #1234 was approved.\n\n— Acme Co.\n[token: ${SUFFIX}]`;
  const plaintextBodyHtml = `<p>Hi Alice,</p><p>Your journal entry #1234 was approved.</p>`;

  beforeEach(async () => {
    const { prisma } = await import("@/lib/db");
    const created = await prisma.emailDelivery.create({
      data: {
        toEmail: `subject-${SUFFIX}@example.com`,
        template: "test_template",
        subject: plaintextSubject,
        bodyText: plaintextBodyText,
        bodyHtml: plaintextBodyHtml,
        status: "DELIVERED",
      },
    });
    deliveryId = created.id;
  });

  it("on-disk subject/bodyText/bodyHtml are encrypted (raw prisma probe)", async () => {
    const raw = await rawPrisma.emailDelivery.findUnique({
      where: { id: deliveryId },
      select: { subject: true, bodyText: true, bodyHtml: true, toEmail: true },
    });
    // Subject + bodies must be ciphertext.
    expect(raw?.subject).not.toBe(plaintextSubject);
    expect(looksEncrypted(raw?.subject)).toBe(true);
    expect(raw?.bodyText).not.toBe(plaintextBodyText);
    expect(looksEncrypted(raw?.bodyText)).toBe(true);
    expect(raw?.bodyHtml).not.toBe(plaintextBodyHtml);
    expect(looksEncrypted(raw?.bodyHtml)).toBe(true);
    // toEmail is intentionally NOT encrypted (we query by it for the
    // GDPR data subject request flow). Verify it's still plaintext.
    expect(raw?.toEmail).toBe(`subject-${SUFFIX}@example.com`);
  });

  it("app surface sees plaintext on all three columns", async () => {
    const { prisma } = await import("@/lib/db");
    const delivery = await prisma.emailDelivery.findUnique({
      where: { id: deliveryId },
    });
    expect(delivery?.subject).toBe(plaintextSubject);
    expect(delivery?.bodyText).toBe(plaintextBodyText);
    expect(delivery?.bodyHtml).toBe(plaintextBodyHtml);
  });

  it("findMany over EmailDelivery decrypts each row", async () => {
    const { prisma } = await import("@/lib/db");
    const rows = await prisma.emailDelivery.findMany({
      where: { id: deliveryId },
      select: { subject: true, bodyText: true },
    });
    expect(rows[0].subject).toBe(plaintextSubject);
    expect(rows[0].bodyText).toBe(plaintextBodyText);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Party — third column rollout (customer/vendor name)
// ─────────────────────────────────────────────────────────────────────────────

describe("encrypted-fields extension: Party (Confidentiality TSC)", () => {
  let partyId: string;
  const plaintextDisplayName = `Acme Co (encryption test ${SUFFIX})`;
  const partyCode = `ENC-PARTY-${SUFFIX}`;

  beforeEach(async () => {
    const { prisma } = await import("@/lib/db");
    const tenantId = await getDefaultTenantId(prisma as PrismaClient);
    const created = await prisma.party.create({
      data: {
        tenantId,
        code: partyCode,
        displayName: plaintextDisplayName,
      },
    });
    partyId = created.id;
  });

  it("on-disk displayName is encrypted (raw prisma probe)", async () => {
    const raw = await rawPrisma.party.findUnique({
      where: { id: partyId },
      select: { displayName: true, code: true },
    });
    expect(raw?.displayName).not.toBe(plaintextDisplayName);
    expect(looksEncrypted(raw?.displayName)).toBe(true);
    // `code` stays plaintext (NOT in the registry — it's the lookup
    // key used throughout the app).
    expect(raw?.code).toBe(partyCode);
  });

  it("app surface sees plaintext displayName", async () => {
    const { prisma } = await import("@/lib/db");
    const party = await prisma.party.findUnique({
      where: { id: partyId },
      select: { displayName: true, code: true },
    });
    expect(party?.displayName).toBe(plaintextDisplayName);
    expect(party?.code).toBe(partyCode);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// JournalEntryNote.body — fourth column rollout
// ─────────────────────────────────────────────────────────────────────────────

describe("encrypted-fields extension: JournalEntryNote (Confidentiality TSC)", () => {
  let noteId: string;
  let parentEntryId: string;
  const plaintextBody = `CPA prose ${SUFFIX} — disputed Acme invoice — see thread 4/22`;

  beforeEach(async () => {
    const { prisma } = await import("@/lib/db");
    // Need a JournalEntry to anchor the note (FK cascade). Reuse the
    // ENC_TEST entity + a fresh entry.
    const tenantId = await getDefaultTenantId(prisma as PrismaClient);
    const entry = await postJournalEntry(prisma as PrismaClient, {
      entityCode: ENTITY,
      bookCode: "US_GAAP",
      documentDate: new Date("2026-01-15"),
      memo: `Anchor for note encryption test ${SUFFIX}`,
      source: "MANUAL",
      lines: [
        { accountCode: "1000", debit: 50 },
        { accountCode: "4000", credit: 50 },
      ],
    });
    parentEntryId = entry.id;
    const note = await prisma.journalEntryNote.create({
      data: {
        tenantId,
        entryId: parentEntryId,
        body: plaintextBody,
      },
    });
    noteId = note.id;
  });

  it("on-disk body is encrypted (raw prisma probe)", async () => {
    const raw = await rawPrisma.journalEntryNote.findUnique({
      where: { id: noteId },
      select: { body: true },
    });
    expect(raw?.body).not.toBe(plaintextBody);
    expect(looksEncrypted(raw?.body)).toBe(true);
  });

  it("app surface sees plaintext body (auto-decrypt)", async () => {
    const { prisma } = await import("@/lib/db");
    const note = await prisma.journalEntryNote.findUnique({
      where: { id: noteId },
      select: { body: true },
    });
    expect(note?.body).toBe(plaintextBody);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tenant.name — fifth column rollout (customer organization name)
// ─────────────────────────────────────────────────────────────────────────────

describe("encrypted-fields extension: Tenant (Confidentiality TSC)", () => {
  let tenantId: string;
  let tenantSlug: string;
  const plaintextName = `Acme Corp (encryption test ${SUFFIX})`;

  beforeEach(async () => {
    const { prisma } = await import("@/lib/db");
    // Per-test unique slug + owner email — beforeEach runs once per
    // `it(...)` block so a constant SUFFIX would collide on the
    // tenant.slug unique index.
    const perTest = randomBytes(2).toString("hex");
    tenantSlug = `enc-tenant-${SUFFIX}-${perTest}`;
    // Spin up a throwaway owner user — Tenant.ownerUserId is NOT NULL.
    const owner = await rawPrisma.user.create({
      data: {
        email: `enc-tenant-owner-${SUFFIX}-${perTest}@deleted.local`,
        displayName: `Enc Tenant Owner ${SUFFIX}`,
      },
    });
    const created = await prisma.tenant.create({
      data: {
        slug: tenantSlug,
        name: plaintextName,
        ownerUserId: owner.id,
      },
    });
    tenantId = created.id;
  });

  it("on-disk tenant.name is encrypted (raw prisma probe)", async () => {
    const raw = await rawPrisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true, slug: true },
    });
    expect(raw?.name).not.toBe(plaintextName);
    expect(looksEncrypted(raw?.name)).toBe(true);
    // slug stays plaintext — it's the URL key, in WHERE clauses everywhere.
    expect(raw?.slug).toBe(tenantSlug);
  });

  it("app surface sees plaintext tenant.name", async () => {
    const { prisma } = await import("@/lib/db");
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true, slug: true },
    });
    expect(tenant?.name).toBe(plaintextName);
    expect(tenant?.slug).toBe(tenantSlug);
  });
});
