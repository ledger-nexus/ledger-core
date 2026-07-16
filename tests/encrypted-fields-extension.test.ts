// End-to-end test of the encrypted-fields Prisma extension against
// the live shared DB. Writes a JournalEntry with a memo, reads it
// back, and confirms:
//   1. The memo round-trips through the application surface
//      (plaintext in, plaintext out).
//   2. The on-disk row's memo is ACTUALLY encrypted (raw SQL probe).
// Confidentiality TSC.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { withAuditLogMutable } from "./_helpers/audit-log-cleanup";
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

// vitest REUSES worker processes across test files. Leaving
// FIELD_ENCRYPTION_KEY set after this suite finishes silently
// encrypts every later suite's writes (in this worker) with an
// ephemeral key that dies with the process — audit-row and
// plaintext-roundtrip assertions in unrelated suites then fail on
// ciphertext. Save + restore the prior env state in afterAll.
// (Root-caused from the #10 activation-car CI run, 2026-07-15.)
let priorFieldKey: string | undefined;

beforeAll(async () => {
  // The extension reads FIELD_ENCRYPTION_KEY at use time. Set a known
  // test key so we can verify ciphertext shape. Real production key
  // is provisioned via Vercel env.
  priorFieldKey = process.env.FIELD_ENCRYPTION_KEY;
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
  try {
    // Targeted cleanup of test rows only.
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
    // AuditLog test rows for AuditLog.metadata describe block. Wrap in
    // withAuditLogMutable since the append-only RULE would otherwise
    // silently no-op the delete.
    await withAuditLogMutable(rawPrisma, async () => {
      await rawPrisma.auditLog.deleteMany({
        where: { action: { contains: SUFFIX } },
      });
      // Deleting a User row triggers Postgres's referential-integrity
      // query against audit_log (actorUserId FK) — under the
      // append-only RULEs, that internal query errors with XX000
      // ("rule having rewritten the query"). Any user.deleteMany must
      // therefore run inside this rules-dropped window, after clearing
      // the users' audit rows.
      const testUsers = await rawPrisma.user.findMany({
        where: { email: { contains: SUFFIX } },
        select: { id: true },
      });
      if (testUsers.length > 0) {
        await rawPrisma.auditLog.deleteMany({
          where: { actorUserId: { in: testUsers.map((u) => u.id) } },
        });
      }
      await rawPrisma.user.deleteMany({
        where: { email: { contains: `enc-user-${SUFFIX}` } },
      });
    });
    // Party test rows: identified by the SUFFIX-stamped code.
    await rawPrisma.party.deleteMany({
      where: { code: { contains: SUFFIX } },
    });
    // LegalEntity test rows: SUFFIX-stamped code.
    await rawPrisma.legalEntity.deleteMany({
      where: { code: { contains: `ENC-LE-${SUFFIX}` } },
    });
    // Tenant test rows: identified by the SUFFIX-stamped slug. The new
    // tenant's owner user was a throwaway with SUFFIX-stamped email —
    // delete that too. Tenant has TenantMembership cascading via FK,
    // but the test never adds members, so a direct deleteMany is safe.
    // (Both `enc-tenant-` and `enc-notif-` slugs match.)
    await rawPrisma.notification.deleteMany({
      where: { tenant: { slug: { contains: SUFFIX } } },
    });
    await rawPrisma.tenant.deleteMany({
      where: { slug: { contains: SUFFIX } },
    });
    // Same audit_log-FK hazard as above — user deletes need the
    // rules-dropped window (their audit rows were already cleared in
    // the first window's SUFFIX sweep).
    await withAuditLogMutable(rawPrisma, async () => {
      await rawPrisma.user.deleteMany({
        where: {
          OR: [
            { email: { contains: `enc-tenant-owner-${SUFFIX}` } },
            { email: { contains: `enc-notif-owner-${SUFFIX}` } },
          ],
        },
      });
    });
    await rawPrisma.$disconnect();
  } finally {
    // Restore the pre-suite key state so later suites in this
    // reused worker see the same environment CI's job env defines.
    if (priorFieldKey === undefined) {
      delete process.env.FIELD_ENCRYPTION_KEY;
    } else {
      process.env.FIELD_ENCRYPTION_KEY = priorFieldKey;
    }
    const { _setKeyForTesting } = await import("@/lib/soc2/field-encryption");
    _setKeyForTesting(null);
  }
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
// EmailDelivery block intentionally absent: that model never landed on
// main. Restore the describe from the chain when it ships.


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

// ─────────────────────────────────────────────────────────────────────────────
// Notification — sixth column block (title + body)
// Title and body together render the alert ("Acme paid $5,000 invoice
// 1234"); both are PII-loaded. Category enum stays plaintext for
// filter use.
// ─────────────────────────────────────────────────────────────────────────────

describe("encrypted-fields extension: Notification (Confidentiality TSC)", () => {
  let notificationId: string;
  let recipientUserId: string;
  let notifTenantId: string;
  const plaintextTitle = `Customer Acme paid $5,000 (test ${SUFFIX})`;
  const plaintextBody = `Invoice #1234 from Acme Corp has been paid in full. (test ${SUFFIX})`;

  beforeEach(async () => {
    const { prisma } = await import("@/lib/db");
    // Spin up a throwaway user — Notification.recipientUserId is NOT NULL.
    const perTest = randomBytes(2).toString("hex");
    const owner = await rawPrisma.user.create({
      data: {
        email: `enc-notif-owner-${SUFFIX}-${perTest}@deleted.local`,
        displayName: `Enc Notif Owner ${SUFFIX}`,
      },
    });
    // Need a tenant scope for the notification — use a fresh one per
    // run to keep cleanup simple.
    const tenant = await rawPrisma.tenant.create({
      data: {
        slug: `enc-notif-${SUFFIX}-${perTest}`,
        name: `Enc Notif Tenant ${SUFFIX}`,
        ownerUserId: owner.id,
      },
    });
    notifTenantId = tenant.id;
    recipientUserId = owner.id;
    const created = await prisma.notification.create({
      data: {
        tenantId: tenant.id,
        recipientUserId: owner.id,
        category: "SYSTEM",
        title: plaintextTitle,
        body: plaintextBody,
      },
    });
    notificationId = created.id;
  });

  it("on-disk Notification.title and .body are ciphertext", async () => {
    const raw = await rawPrisma.notification.findUnique({
      where: { id: notificationId },
      select: { title: true, body: true, category: true },
    });
    expect(raw?.title).not.toBe(plaintextTitle);
    expect(looksEncrypted(raw?.title)).toBe(true);
    expect(raw?.body).not.toBe(plaintextBody);
    expect(looksEncrypted(raw?.body)).toBe(true);
    // Category stays plaintext (it's the filter / display-grouping key).
    expect(raw?.category).toBe("SYSTEM");
  });

  it("app surface decrypts title + body on read", async () => {
    const { prisma } = await import("@/lib/db");
    const n = await prisma.notification.findUnique({
      where: { id: notificationId },
      select: { title: true, body: true, category: true },
    });
    expect(n?.title).toBe(plaintextTitle);
    expect(n?.body).toBe(plaintextBody);
    expect(n?.category).toBe("SYSTEM");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LegalEntity.name + User.displayName — seventh column block. Both
// follow the {searchable code, free-text display name} pattern.
// ─────────────────────────────────────────────────────────────────────────────

describe("encrypted-fields extension: LegalEntity (Confidentiality TSC)", () => {
  let entityIdLE: string;
  let entityCode: string;
  const plaintextEntityName = `Acme Corp, Inc. (LE encryption ${SUFFIX})`;

  beforeEach(async () => {
    const { prisma } = await import("@/lib/db");
    const tenantId = await getDefaultTenantId(prisma as PrismaClient);
    const perTest = randomBytes(2).toString("hex");
    entityCode = `ENC-LE-${SUFFIX}-${perTest}`;
    const created = await prisma.legalEntity.create({
      data: {
        tenantId,
        code: entityCode,
        name: plaintextEntityName,
        functionalCurrencyId: "USD",
      },
    });
    entityIdLE = created.id;
  });

  it("on-disk LegalEntity.name is encrypted (raw prisma probe)", async () => {
    const raw = await rawPrisma.legalEntity.findUnique({
      where: { id: entityIdLE },
      select: { name: true, code: true },
    });
    expect(raw?.name).not.toBe(plaintextEntityName);
    expect(looksEncrypted(raw?.name)).toBe(true);
    // code stays plaintext — the lookup key.
    expect(raw?.code).toBe(entityCode);
  });

  it("app surface decrypts LegalEntity.name on read", async () => {
    const { prisma } = await import("@/lib/db");
    const e = await prisma.legalEntity.findUnique({
      where: { id: entityIdLE },
      select: { name: true, code: true },
    });
    expect(e?.name).toBe(plaintextEntityName);
    expect(e?.code).toBe(entityCode);
  });
});

describe("encrypted-fields extension: User.displayName (Confidentiality TSC)", () => {
  let userId: string;
  const plaintextDisplayName = `Alice Q. Public (encryption test ${SUFFIX})`;

  beforeEach(async () => {
    const { prisma } = await import("@/lib/db");
    const perTest = randomBytes(2).toString("hex");
    const created = await prisma.user.create({
      data: {
        // email stays plaintext (auth-keyed) — only displayName
        // is in the registry.
        email: `enc-user-${SUFFIX}-${perTest}@deleted.local`,
        displayName: plaintextDisplayName,
      },
    });
    userId = created.id;
  });

  it("on-disk User.displayName is encrypted (raw prisma probe)", async () => {
    const raw = await rawPrisma.user.findUnique({
      where: { id: userId },
      select: { displayName: true, email: true },
    });
    expect(raw?.displayName).not.toBe(plaintextDisplayName);
    expect(looksEncrypted(raw?.displayName)).toBe(true);
    // email stays plaintext — used as the auth key.
    expect(raw?.email).toContain(`enc-user-${SUFFIX}`);
  });

  it("app surface decrypts User.displayName on read", async () => {
    const { prisma } = await import("@/lib/db");
    const u = await prisma.user.findUnique({
      where: { id: userId },
      select: { displayName: true, email: true },
    });
    expect(u?.displayName).toBe(plaintextDisplayName);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// JournalEntry.sourcePayload — first Json-column rollout. Verifies the
// type:"json" extension mode round-trips a complex JsonValue exactly
// (object structure, primitives, unicode) AND that the on-disk Json
// column holds a string (the ciphertext envelope) — not the original
// nested object.
// ─────────────────────────────────────────────────────────────────────────────

describe("encrypted-fields extension: JournalEntry.sourcePayload (Json mode, Confidentiality TSC)", () => {
  let entryId: string;
  // A representative QBO-shaped payload: nested objects, arrays,
  // primitives, unicode, embedded PII (customer name, dollar amounts,
  // tax IDs). The extension must round-trip this byte-for-byte.
  const plaintextSourcePayload = {
    qboInvoiceId: `INV-${SUFFIX}`,
    customerRef: { value: "1234", name: `Acme Corp ${SUFFIX}` },
    totalAmt: 5000.0,
    txnTaxDetail: { totalTax: 412.5, taxLine: [{ amount: 412.5 }] },
    customField: [
      { name: "po", value: `PO-${SUFFIX}` },
      { name: "notes", value: "Föräljning av tjänster — internal note" },
    ],
    lines: [
      { lineNum: 1, description: "Consulting services", amount: 4587.5 },
      { lineNum: 2, description: "Sales tax", amount: 412.5 },
    ],
  };

  beforeEach(async () => {
    const { prisma } = await import("@/lib/db");
    // Post a JE through the standard path so the extension's write
    // hook fires. postJournalEntry accepts sourcePayload and threads
    // it onto the row.
    const result = await postJournalEntry(prisma as PrismaClient, {
      entityCode: ENTITY,
      bookCode: "US_GAAP",
      documentDate: new Date("2026-01-15"),
      memo: `Json-mode test ${SUFFIX}`,
      source: "MANUAL",
      sourceSystem: "QBO_TEST",
      sourceRecordType: "Invoice",
      sourceRecordId: `qbo-test-${SUFFIX}-${randomBytes(2).toString("hex")}`,
      sourcePayload: plaintextSourcePayload,
      lines: [
        { accountCode: "1000", debit: 5000 },
        { accountCode: "4000", credit: 5000 },
      ],
    });
    entryId = result.id;
  });

  it("on-disk sourcePayload is a STRING (the ciphertext envelope), not the original object", async () => {
    const raw = await rawPrisma.journalEntry.findUnique({
      where: { id: entryId },
      select: { sourcePayload: true },
    });
    // Raw client returns the verbatim Json column value. If the
    // extension worked, that's a quoted-string JsonValue holding the
    // base64 envelope — NOT the original object.
    expect(typeof raw?.sourcePayload).toBe("string");
    expect(looksEncrypted(raw?.sourcePayload as string)).toBe(true);
    // Sanity: the ciphertext is nowhere near a substring of the
    // plaintext's distinctive bits (Acme Corp, SUFFIX, PO-...).
    const rawStr = String(raw?.sourcePayload ?? "");
    expect(rawStr).not.toContain("Acme");
    expect(rawStr).not.toContain(SUFFIX);
    expect(rawStr).not.toContain("Föräljning");
  });

  it("app surface decrypts sourcePayload back into the exact original JsonValue", async () => {
    const { prisma } = await import("@/lib/db");
    const entry = await prisma.journalEntry.findUnique({
      where: { id: entryId },
      select: { sourcePayload: true, memo: true },
    });
    // Round-trip: deep-equal to the original. JSON.stringify round-
    // tripping handles the nested objects, arrays, primitives, and
    // unicode characters identically.
    expect(entry?.sourcePayload).toEqual(plaintextSourcePayload);
  });

  it("findMany decrypts sourcePayload across multiple rows", async () => {
    const { prisma } = await import("@/lib/db");
    const ent = await rawPrisma.legalEntity.findFirstOrThrow({
      where: { code: ENTITY },
      select: { id: true },
    });
    const entries = await prisma.journalEntry.findMany({
      where: { entityId: ent.id, sourceSystem: "QBO_TEST" },
      select: { sourcePayload: true },
    });
    for (const e of entries) {
      // Every QBO_TEST row gets the same shape; verify it's a real
      // parsed object (not a string), and it has the expected top-
      // level keys (proxy for "JSON.parse round-trip happened").
      expect(typeof e.sourcePayload).toBe("object");
      expect(e.sourcePayload).not.toBeNull();
      const sp = e.sourcePayload as Record<string, unknown>;
      expect(sp).toHaveProperty("qboInvoiceId");
      expect(sp).toHaveProperty("customerRef");
      expect(sp).toHaveProperty("lines");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AuditLog.metadata (Json) — write-path encryption only. Read path
// works the same way; legacy rows in production stay plaintext per the
// append-only RULE.
// ─────────────────────────────────────────────────────────────────────────────

describe("encrypted-fields extension: AuditLog.metadata (Json mode, Confidentiality TSC)", () => {
  let auditId: string;
  const plaintextMetadata = {
    action: "reverse-journal-entry",
    reason: `Tested reversal for customer Acme Corp invoice ${SUFFIX}`,
    sourceEntryNumber: `ENT-${SUFFIX}-001`,
    reversalEntryNumber: `REV-${SUFFIX}-001`,
    note: "Föräljning återbetalas",
  };

  beforeEach(async () => {
    const { prisma } = await import("@/lib/db");
    const tenantId = await getDefaultTenantId(prisma as PrismaClient);
    const created = await prisma.auditLog.create({
      data: {
        tenantId,
        eventType: "PRIVILEGED_ACTION",
        action: `test.${SUFFIX}`,
        outcome: "SUCCESS",
        metadata: plaintextMetadata,
      },
    });
    auditId = created.id;
  });

  it("on-disk metadata is a STRING (the ciphertext envelope), not the original object", async () => {
    const raw = await rawPrisma.auditLog.findUnique({
      where: { id: auditId },
      select: { metadata: true, action: true, eventType: true },
    });
    expect(typeof raw?.metadata).toBe("string");
    expect(looksEncrypted(raw?.metadata as string)).toBe(true);
    const rawStr = String(raw?.metadata ?? "");
    expect(rawStr).not.toContain("Acme");
    expect(rawStr).not.toContain(SUFFIX);
    expect(rawStr).not.toContain("Föräljning");
    // action + eventType stay plaintext — they're the filter columns
    // on /admin/audit-log.
    expect(raw?.action).toBe(`test.${SUFFIX}`);
    expect(raw?.eventType).toBe("PRIVILEGED_ACTION");
  });

  it("app surface decrypts metadata back into the exact original object", async () => {
    const { prisma } = await import("@/lib/db");
    const row = await prisma.auditLog.findUnique({
      where: { id: auditId },
      select: { metadata: true, action: true },
    });
    expect(row?.metadata).toEqual(plaintextMetadata);
    expect(row?.action).toBe(`test.${SUFFIX}`);
  });
});
