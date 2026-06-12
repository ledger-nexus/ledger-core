// v0.9 NS SuiteAnalytics Phase 2 — NS internalid resolver test.
//
// Proves the three resolvers map NS internalids to ledger-core codes
// via lineage tables (no NS import re-run needed). Hits + misses + the
// tenant-scope guard.
//
// Setup: seed a LegalEntity with extensions.nsInternalid + a Book with
// extensions.nsAccountingBookSourcePayloads + an Account with the NS
// lineage triple. Then call each resolver: expect hits to return
// { code, id }, expect misses to return null.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import {
  resolveNsSubsidiary,
  resolveNsAccountingBook,
  resolveNsAccount,
} from "@/lib/external/ns-id-resolver";

const prisma = new PrismaClient();
const SUFFIX = "P2RES";

let tenantAId: string;
let tenantBId: string;
let ownerUserId: string;
let entityAId: string;
let bookId: string;
let accountId: string;

async function ensureFundamentals(): Promise<void> {
  await prisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    update: {},
  });
}

beforeAll(async () => {
  await ensureFundamentals();

  // Rerun-safe: the afterAll user delete is .catch(()=>{}) (FK'd audit
  // rows can keep it alive), so create-by-natural-key must be upserts.
  const owner = await prisma.user.upsert({
    where: { email: `nsres-${SUFFIX}@example.test` },
    create: {
      email: `nsres-${SUFFIX}@example.test`,
      displayName: "NS Resolver test owner",
      isActive: true,
    },
    update: { isActive: true },
  });
  ownerUserId = owner.id;
  const tenantA = await prisma.tenant.upsert({
    where: { slug: `nsres-${SUFFIX}-a` },
    create: { slug: `nsres-${SUFFIX}-a`, name: "Resolver A", ownerUserId: owner.id },
    update: {},
  });
  const tenantB = await prisma.tenant.upsert({
    where: { slug: `nsres-${SUFFIX}-b` },
    create: { slug: `nsres-${SUFFIX}-b`, name: "Resolver B", ownerUserId: owner.id },
    update: {},
  });
  // Stale fixture rows from a prior crashed run — delete by natural
  // key before re-creating (account/entity creates below are plain
  // creates; entityId-null composites can't be upserted).
  await prisma.account.deleteMany({
    where: { tenantId: { in: [tenantA.id, tenantB.id] }, code: `${SUFFIX}_NS100` },
  });
  await prisma.legalEntity.deleteMany({
    where: { tenantId: { in: [tenantA.id, tenantB.id] } },
  });
  tenantAId = tenantA.id;
  tenantBId = tenantB.id;

  // Tenant A: a LegalEntity with extensions.nsInternalid="42".
  const entityA = await prisma.legalEntity.create({
    data: {
      tenantId: tenantAId,
      code: `${SUFFIX}_A_NS42`,
      name: "Resolver test entity A",
      functionalCurrencyId: "USD",
      extensions: {
        nsIsImported: true,
        nsInternalid: "42",
      },
    },
  });
  entityAId = entityA.id;

  // A Book with nsAccountingBookSourcePayloads dictionary stashing
  // internalid="9" (the v0.9 Phase 4.5 shape).
  const book = await prisma.book.upsert({
    where: { code: `${SUFFIX}_BOOK` },
    create: {
      code: `${SUFFIX}_BOOK`,
      name: "Resolver test book",
      basis: "US_GAAP",
      reportingCurrencyId: "USD",
      extensions: {
        nsAccountingBookSourcePayloads: {
          "9": { internalid: "9", name: "Resolver Test GAAP" },
        },
      },
    },
    update: {
      extensions: {
        nsAccountingBookSourcePayloads: {
          "9": { internalid: "9", name: "Resolver Test GAAP" },
        },
      },
    },
  });
  bookId = book.id;

  // An NS-imported Account with sourceRecordId="100" — global chart
  // (entityId: null) per the v0.7 chart-of-accounts decision.
  const account = await prisma.account.create({
    data: {
      tenantId: tenantAId,
      code: `${SUFFIX}_NS100`,
      name: "Resolver test account",
      type: "ASSET",
      normalBalance: "DEBIT",
      sourceSystem: "NETSUITE",
      sourceRecordType: "Account",
      sourceRecordId: "100",
    },
  });
  accountId = account.id;
});

afterAll(async () => {
  await prisma.account.deleteMany({
    where: {
      code: { in: [`${SUFFIX}_NS100`] },
    },
  });
  await prisma.legalEntity.deleteMany({
    where: { tenantId: { in: [tenantAId, tenantBId] } },
  });
  await prisma.book.deleteMany({ where: { code: `${SUFFIX}_BOOK` } });
  await prisma.tenant.deleteMany({
    where: { id: { in: [tenantAId, tenantBId] } },
  });
  await prisma.user.delete({ where: { id: ownerUserId } }).catch(() => {});
  await prisma.$disconnect();
});

describe("v0.9 NS SuiteAnalytics Phase 2: resolveNsSubsidiary", () => {
  it("returns { entityCode, entityId } for a seeded NS subsidiary internalid", async () => {
    const result = await resolveNsSubsidiary(prisma, {
      tenantId: tenantAId,
      nsInternalid: "42",
    });
    expect(result).not.toBeNull();
    expect(result!.entityCode).toBe(`${SUFFIX}_A_NS42`);
    expect(result!.entityId).toBe(entityAId);
  });

  it("returns null for an unknown NS subsidiary internalid", async () => {
    const result = await resolveNsSubsidiary(prisma, {
      tenantId: tenantAId,
      nsInternalid: "999",
    });
    expect(result).toBeNull();
  });

  it("returns null when the NS internalid exists for a DIFFERENT tenant", async () => {
    // Tenant B never had a subsidiary 42 imported. Even though tenant
    // A's entity has nsInternalid=42, scoping by tenantId=B must
    // return null — defeats cross-tenant probes.
    const result = await resolveNsSubsidiary(prisma, {
      tenantId: tenantBId,
      nsInternalid: "42",
    });
    expect(result).toBeNull();
  });
});

describe("v0.9 NS SuiteAnalytics Phase 2: resolveNsAccountingBook", () => {
  it("returns { bookCode, bookId } for a stashed NS accounting-book internalid", async () => {
    const result = await resolveNsAccountingBook(prisma, {
      nsInternalid: "9",
    });
    expect(result).not.toBeNull();
    expect(result!.bookCode).toBe(`${SUFFIX}_BOOK`);
    expect(result!.bookId).toBe(bookId);
  });

  it("returns null for an unknown NS accounting-book internalid", async () => {
    const result = await resolveNsAccountingBook(prisma, {
      nsInternalid: "999",
    });
    expect(result).toBeNull();
  });
});

describe("v0.9 NS SuiteAnalytics Phase 2: resolveNsAccount", () => {
  it("returns { accountCode, accountId } for a seeded NS account internalid", async () => {
    const result = await resolveNsAccount(prisma, { tenantId: tenantAId, nsInternalid: "100" });
    expect(result).not.toBeNull();
    expect(result!.accountCode).toBe(`${SUFFIX}_NS100`);
    expect(result!.accountId).toBe(accountId);
  });

  it("returns null for an unknown NS account internalid", async () => {
    const result = await resolveNsAccount(prisma, { tenantId: tenantAId, nsInternalid: "999" });
    expect(result).toBeNull();
  });

  it("does NOT resolve another tenant's account internalid (cross-tenant oracle)", async () => {
    // Tenant A's account 100 exists; a tenant-B-scoped probe must miss.
    const result = await resolveNsAccount(prisma, {
      tenantId: tenantBId,
      nsInternalid: "100",
    });
    expect(result).toBeNull();
  });
});
