// Tests for getEntryLineage — the correction/reversal lineage resolver.
//
// Fixtures wire two link types directly (the resolver only reads the links,
// so how they were set is irrelevant to what it must return):
//   A ← reversed by B   (B.reversalOfId = A; A.status = REVERSED)
//   C ← corrected by D   (D.correctionOfId = C; C stays POSTED)
//
// Verified:
//   1. Lineage of A: reversedBy = [B]; reverses/corrects/correctedBy empty.
//   2. Lineage of B: reverses = A.
//   3. Lineage of C: correctedBy = [D]; corrects/reverses/reversedBy empty.
//   4. Lineage of D: corrects = C.
//   5. Tenant isolation: a different tenantId resolves to null.
//   6. Unknown id resolves to null.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { postJournalEntry } from "@/lib/accounting/post-journal";
import { getEntryLineage } from "@/lib/accounting/lineage";

const prisma = new PrismaClient();

const SUFFIX = ("LNG" + Date.now().toString(36) + Math.floor(Math.random() * 9999)).toUpperCase();
const ENTITY_CODE = `LNG-${SUFFIX}`;

let tenantId: string;
let entityId: string;
let userId: string;
let aId: string; // reversed by B
let bId: string; // reversal of A
let cId: string; // corrected by D
let dId: string; // correction of C

async function postSimple(memo: string): Promise<string> {
  const r = await postJournalEntry(prisma, {
    tenantId,
    entityCode: ENTITY_CODE,
    bookCode: "US_GAAP",
    documentDate: new Date("2026-05-15"),
    memo,
    source: "MANUAL",
    lines: [
      { accountCode: "EXP", debit: "100" },
      { accountCode: "CASH", credit: "100" },
    ],
  });
  return r.id;
}

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
    data: { email: `lineage-${SUFFIX}@example.test`, displayName: "Lineage tester", isActive: true },
  });
  userId = u.id;

  const tenant = await prisma.tenant.create({
    data: { slug: `lng-${SUFFIX.toLowerCase()}`, name: "Lineage tenant", ownerUserId: u.id },
  });
  tenantId = tenant.id;

  const entity = await prisma.legalEntity.create({
    data: { tenantId, code: ENTITY_CODE, name: "Lineage Co.", functionalCurrencyId: "USD" },
  });
  entityId = entity.id;

  await prisma.account.createMany({
    data: [
      { tenantId, entityId, code: "EXP", name: "Expense", type: "EXPENSE", normalBalance: "DEBIT" },
      { tenantId, entityId, code: "CASH", name: "Cash", type: "ASSET", normalBalance: "DEBIT" },
    ],
  });

  aId = await postSimple("Source A (reversed)");
  bId = await postSimple("Reversal of A");
  cId = await postSimple("Source C (corrected)");
  dId = await postSimple("Correction of C");

  // A ← reversed by B.
  await prisma.journalEntry.update({ where: { id: bId }, data: { reversalOfId: aId } });
  await prisma.journalEntry.update({ where: { id: aId }, data: { status: "REVERSED" } });
  // C ← corrected by D (C stays POSTED).
  await prisma.journalEntry.update({ where: { id: dId }, data: { correctionOfId: cId } });
});

afterAll(async () => {
  await prisma.journalLine.deleteMany({ where: { entry: { entityId } } });
  await prisma.journalEntry.deleteMany({ where: { entityId } });
  await prisma.account.deleteMany({ where: { entityId } });
  await prisma.legalEntity.deleteMany({ where: { id: entityId } });
  await prisma.tenant.delete({ where: { id: tenantId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("getEntryLineage", () => {
  it("reports what reverses an entry (downstream reversedBy)", async () => {
    const l = await getEntryLineage(prisma, { tenantId, entryId: aId });
    expect(l).not.toBeNull();
    expect(l!.reverses).toBeNull();
    expect(l!.corrects).toBeNull();
    expect(l!.correctedBy).toHaveLength(0);
    expect(l!.reversedBy.map((n) => n.id)).toEqual([bId]);
  });

  it("reports the entry a reversal reverses (upstream reverses)", async () => {
    const l = await getEntryLineage(prisma, { tenantId, entryId: bId });
    expect(l!.reverses?.id).toBe(aId);
    expect(l!.reversedBy).toHaveLength(0);
  });

  it("reports what corrects an entry (downstream correctedBy)", async () => {
    const l = await getEntryLineage(prisma, { tenantId, entryId: cId });
    expect(l!.corrects).toBeNull();
    expect(l!.reverses).toBeNull();
    expect(l!.reversedBy).toHaveLength(0);
    expect(l!.correctedBy.map((n) => n.id)).toEqual([dId]);
  });

  it("reports the entry a correction corrects (upstream corrects)", async () => {
    const l = await getEntryLineage(prisma, { tenantId, entryId: dId });
    expect(l!.corrects?.id).toBe(cId);
    expect(l!.correctedBy).toHaveLength(0);
  });

  it("is tenant-scoped — a different tenant resolves to null", async () => {
    const l = await getEntryLineage(prisma, {
      tenantId: "00000000-0000-0000-0000-000000000000",
      entryId: aId,
    });
    expect(l).toBeNull();
  });

  it("returns null for an unknown entry id", async () => {
    const l = await getEntryLineage(prisma, {
      tenantId,
      entryId: "00000000-0000-0000-0000-000000000000",
    });
    expect(l).toBeNull();
  });
});
