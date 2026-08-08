// The teardown edge that entity-scoped cleanup misses.
//
// `ArOpenItem` has TWO foreign keys that matter to a ledger teardown: its own
// `entityId`, and `openedByEntryId` — a NON-NULL reference to the JournalEntry
// that opened it (relation "ArOpenedBy", schema.prisma:1507). `ApOpenItem` has
// the symmetric "ApOpenedBy".
//
// Those two do not have to agree. An open item can belong to entity B while
// being opened by an entry in entity A — intercompany parcels are exactly
// that shape. A teardown that clears open items `where entityId = A` and then
// deletes entries `where entityId = A` therefore leaves B's open item holding
// a reference to A's entry, and Postgres refuses:
//
//     Foreign key constraint violated: ar_open_item_openedByEntryId_fkey
//
// Both property suites shipped that teardown. It passes on a clean database
// and fails the moment such a row exists, which is the worst version of this
// bug: green until it isn't, and then failing in cleanup rather than in an
// assertion, so the error points at the wrong place.
//
// This test builds that row deliberately and pins BOTH halves — that the
// naive order really does fail, and that the helper really does handle it.
// Without the first half the second proves nothing.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";

import { clearEntityLedger, deleteEntries } from "./helpers/ledger-cleanup";
import { postJournalEntry } from "@/lib/accounting/post-journal";
import { getDefaultTenantId } from "@/lib/seed/default-tenant";

const prisma = new PrismaClient();
const SUFFIX = "clnp" + Date.now().toString(36) + Math.floor(Math.random() * 9999);
const ENTITY_A = `${SUFFIX}_A`.slice(0, 24);
const ENTITY_B = `${SUFFIX}_B`.slice(0, 24);

let tenantId: string;
let entityAId: string;
let entityBId: string;
let bookId: string;
let partyId: string;
const accountCodes = { cash: `${SUFFIX}C`.slice(0, 20), rev: `${SUFFIX}R`.slice(0, 20) };

beforeAll(async () => {
  tenantId = await getDefaultTenantId(prisma);

  // Self-heal: a killed run leaves these behind and the codes are stable
  // within a run only, so scrub by prefix before seeding.
  const stale = await prisma.legalEntity.findMany({
    where: { tenantId, code: { startsWith: "clnp" } },
    select: { id: true },
  });
  for (const e of stale) {
    await clearEntityLedger(prisma, e.id);
    await prisma.legalEntity.deleteMany({ where: { id: e.id } });
  }
  await prisma.account.deleteMany({ where: { tenantId, code: { startsWith: "clnp" } } });

  const book = await prisma.book.findFirstOrThrow({ where: { code: "US_GAAP" }, select: { id: true } });
  bookId = book.id;

  const [a, b] = await Promise.all([
    prisma.legalEntity.create({
      data: { tenantId, code: ENTITY_A, name: "Cleanup A", functionalCurrencyId: "USD" },
      select: { id: true },
    }),
    prisma.legalEntity.create({
      data: { tenantId, code: ENTITY_B, name: "Cleanup B", functionalCurrencyId: "USD" },
      select: { id: true },
    }),
  ]);
  entityAId = a.id;
  entityBId = b.id;

  await prisma.account.createMany({
    data: [
      { tenantId, entityId: entityAId, code: accountCodes.cash, name: "Cash", type: "ASSET", normalBalance: "DEBIT" },
      { tenantId, entityId: entityAId, code: accountCodes.rev, name: "Revenue", type: "REVENUE", normalBalance: "CREDIT" },
    ],
  });

  const party = await prisma.party.create({
    data: { tenantId, entityId: entityBId, code: `${SUFFIX}P`.slice(0, 20), displayName: "Cleanup Co" },
    select: { id: true },
  });
  partyId = party.id;
});

afterAll(async () => {
  await clearEntityLedger(prisma, entityAId).catch(() => {});
  await clearEntityLedger(prisma, entityBId).catch(() => {});
  await prisma.party.deleteMany({ where: { tenantId, code: { startsWith: SUFFIX } } });
  await prisma.account.deleteMany({ where: { tenantId, code: { startsWith: SUFFIX } } });
  await prisma.legalEntity.deleteMany({ where: { id: { in: [entityAId, entityBId] } } });
  await prisma.$disconnect();
});

/** An entry in A, with an open item in B pointing at it. */
async function buildCrossEntityParcel(): Promise<string> {
  const entry = await postJournalEntry(prisma, {
    tenantId,
    entityCode: ENTITY_A,
    bookCode: "US_GAAP",
    currencyCode: "USD",
    documentDate: new Date("2026-03-31"),
    memo: "cleanup fixture",
    source: "MANUAL",
    createdBy: "test",
    lines: [
      { accountCode: accountCodes.cash, debit: "100.00" },
      { accountCode: accountCodes.rev, credit: "100.00" },
    ],
  });

  await prisma.arOpenItem.create({
    data: {
      tenantId,
      entityId: entityBId, // <- belongs to B
      bookId,
      partyId,
      openedByEntryId: entry.id, // <- but opened by A's entry
      openedDate: new Date("2026-03-31"),
      originalAmount: "100.0000",
      currentBalance: "100.0000",
      currencyId: "USD",
      controlAccountCode: accountCodes.cash,
    },
  });

  return entry.id;
}

describe("ledger teardown across the openedByEntryId edge", () => {
  it("the entity-scoped delete order the property suites used really does fail", async () => {
    const entryId = await buildCrossEntityParcel();

    // Verbatim shape of the old clearLedger: scope everything on entityId.
    const naive = async () => {
      await prisma.arApplication.deleteMany({ where: { openItem: { entityId: entityAId } } });
      await prisma.arOpenItem.deleteMany({ where: { entityId: entityAId } });
      await prisma.journalLine.deleteMany({ where: { entry: { entityId: entityAId } } });
      await prisma.journalEntry.deleteMany({ where: { entityId: entityAId } });
    };

    await expect(naive()).rejects.toThrow(/openedByEntryId|[Ff]oreign key/);

    // ...and the entry is still there, so the teardown silently did not run.
    const survivor = await prisma.journalEntry.count({ where: { id: entryId } });
    expect(survivor).toBe(1);
  });

  it("clearEntityLedger clears the same state, reference row included", async () => {
    // The parcel from the previous test is still in place; that IS the state
    // the helper has to cope with.
    await clearEntityLedger(prisma, entityAId);

    expect(await prisma.journalEntry.count({ where: { entityId: entityAId } })).toBe(0);
    expect(
      await prisma.arOpenItem.count({ where: { entityId: entityBId } })
    ).toBe(0);
  });

  it("deleteEntries is idempotent and safe on an empty list", async () => {
    // Teardown runs in afterAll where a prior failure may already have cleaned
    // up; it must converge rather than throw.
    await expect(deleteEntries(prisma, [])).resolves.toBeUndefined();
    const entryId = await buildCrossEntityParcel();
    await deleteEntries(prisma, [entryId]);
    await expect(deleteEntries(prisma, [entryId])).resolves.toBeUndefined();
    expect(await prisma.journalEntry.count({ where: { id: entryId } })).toBe(0);
  });
});
