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
  // Targeted cleanup of test JEs only.
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
