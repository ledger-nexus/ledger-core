// Concurrent posts to the same (entity, book) must all succeed with
// distinct, gap-free entry numbers.
//
// entryNumber is allocated as count() + 1 inside the write transaction.
// That read is not atomic: two posters that read the count before
// either commits compute the same next number, and the loser hits the
// @@unique([tenantId, entryNumber]) index. It used to surface to
// whoever lost as a failed post.
//
// It stopped being hypothetical once the nightly recurring runner, the
// UI, and intercompany mirrors all began posting to the same
// (entity, book) — a mirror in particular posts while its source is
// still in flight.
//
// This asserts the PROPERTY — every post lands, numbering stays
// sequential — not a timing outcome. Whether a given machine actually
// interleaves the reads is not something one laptop can settle, so the
// test is written to be meaningful either way: it is a correctness
// assertion about the numbering contract that also happens to exercise
// the retry when the race does occur.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { postJournalEntry } from "@/lib/accounting/post-journal";
import { withAuditLogMutable } from "./_helpers/audit-log-cleanup";

const prisma = new PrismaClient();
const SUFFIX = Date.now().toString(36) + Math.floor(Math.random() * 9999);
const BOOK = "US_GAAP";
const E = `ENUM${SUFFIX}`.toUpperCase().slice(0, 14);
const CASH = `EN10${SUFFIX}`.slice(0, 12);
const EXP = `EN60${SUFFIX}`.slice(0, 12);

const CONCURRENT_POSTS = 12;

let tenantId: string;

async function scrubStale() {
  const stale = await prisma.tenant.findMany({
    where: { slug: { startsWith: "enum-race" } },
    select: { id: true },
  });
  const ids = stale.map((t) => t.id);
  if (ids.length > 0) {
    await prisma.journalLine.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.journalEntry.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.recordEvent.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.account.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.period.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.fiscalCalendar.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.legalEntity.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.tenant.deleteMany({ where: { id: { in: ids } } });
  }
  const users = await prisma.user.findMany({
    where: { displayName: { startsWith: "ENUM Fixture" } },
    select: { id: true },
  });
  if (users.length > 0) {
    await withAuditLogMutable(prisma, async () => {
      await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
    });
  }
}

beforeAll(async () => {
  await scrubStale();
  const owner = await prisma.user.create({
    data: { email: `enum-${SUFFIX}@example.test`, displayName: "ENUM Fixture owner" },
    select: { id: true },
  });
  const tenant = await prisma.tenant.create({
    data: { slug: `enum-race-${SUFFIX}`, name: "ENUM Co", ownerUserId: owner.id },
    select: { id: true },
  });
  tenantId = tenant.id;
  const ent = await prisma.legalEntity.create({
    data: { tenantId, code: E, name: E, functionalCurrencyId: "USD" },
    select: { id: true },
  });
  const cal = await prisma.fiscalCalendar.create({
    data: {
      tenantId,
      entityId: ent.id,
      code: "ENUM_CAL",
      name: "2026",
      periodFrequency: "MONTHLY",
    },
    select: { id: true },
  });
  await prisma.period.create({
    data: {
      tenantId,
      calendarId: cal.id,
      code: "2026-05",
      ordinal: 5,
      startsOn: new Date("2026-05-01"),
      endsOn: new Date("2026-05-31"),
    },
  });
  for (const [code, type] of [
    [CASH, "ASSET"],
    [EXP, "EXPENSE"],
  ] as const) {
    await prisma.account.create({
      data: {
        tenantId,
        entityId: ent.id,
        code,
        name: code,
        type,
        normalBalance: "DEBIT",
      },
    });
  }
}, 60_000);

afterAll(async () => {
  await scrubStale();
  await prisma.$disconnect();
});

describe("entry numbering under concurrency", () => {
  it(
    "every concurrent post lands, with distinct sequential numbers",
    async () => {
      const results = await Promise.allSettled(
        Array.from({ length: CONCURRENT_POSTS }, (_, i) =>
          postJournalEntry(prisma, {
            tenantId,
            entityCode: E,
            bookCode: BOOK,
            documentDate: new Date("2026-05-15"),
            memo: `Concurrent post ${i + 1}`,
            source: "MANUAL",
            lines: [
              { accountCode: EXP, debit: 100 },
              { accountCode: CASH, credit: 100 },
            ],
          })
        )
      );

      // No poster may be told its entry failed because someone else was
      // writing at the same moment.
      const rejected = results.filter((r) => r.status === "rejected");
      expect(
        rejected.map((r) => (r as PromiseRejectedResult).reason?.message ?? ""),
        "no post should lose the entry-number race"
      ).toEqual([]);

      const numbers = results
        .filter((r) => r.status === "fulfilled")
        .map((r) => (r as PromiseFulfilledResult<{ entryNumber: string }>).value.entryNumber);

      // Distinct, and the numbering contract holds: 00001..00012 with
      // no gaps and no repeats.
      expect(new Set(numbers).size).toBe(CONCURRENT_POSTS);
      const sequence = numbers
        .map((n) => Number(n.slice(n.lastIndexOf("-") + 1)))
        .sort((a, b) => a - b);
      expect(sequence).toEqual(
        Array.from({ length: CONCURRENT_POSTS }, (_, i) => i + 1)
      );

      // And the ledger agrees with what the callers were told.
      const persisted = await prisma.journalEntry.count({ where: { tenantId } });
      expect(persisted).toBe(CONCURRENT_POSTS);
    },
    // Generous: this is a correctness assertion, not a latency budget,
    // and it runs against a network Postgres.
    180_000
  );
});
