// A paged register must show the same balances an unpaged one would.
//
// The register's running balance depends on every row before it, so paging it
// is not `skip`/`take` — the page needs the balance it opens on, which comes
// from an aggregate over everything older. That aggregate is the part that is
// easy to get subtly wrong, and wrong here means **wrong numbers on an
// accounting screen**, not a layout glitch.
//
// The test is a differential one: compute every row's balance the old way
// (fetch all lines, accumulate from zero) and the new way (per page, from an
// aggregate), and require them to agree row for row.
//
// ⚠️ SAME-DATE TIES ARE THE POINT. A register orders by
// `(documentDate, entryNumber, lineNo)`, and an `olderThan` written against
// `documentDate` alone passes every test whose dates are distinct — while
// being wrong for the ordinary case of one invoice posting several lines on
// one day. The fixture below deliberately puts multiple entries on the same
// date and multiple lines in the same entry, and the page size is chosen so a
// page boundary falls INSIDE a same-date group.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient, type Prisma } from "@prisma/client";

import { Decimal } from "@/lib/utils/decimal";
import {
  balanceFromSums,
  olderThan,
  signedMovement,
  withRunningBalance,
} from "@/lib/accounting/register";
import { postJournalEntry } from "@/lib/accounting/post-journal";
import { withAuditLogMutable } from "./_helpers/audit-log-cleanup";

const prisma = new PrismaClient();

const PREFIX = "reg";
const SUFFIX = PREFIX + Date.now().toString(36) + Math.floor(Math.random() * 9999);

let tenantId: string;
let entityId: string;
let bookId: string;
let accountId: string;
const ENTITY_CODE = `${PREFIX}_E_${SUFFIX}`.slice(0, 30);

async function scrubOrphans() {
  const tenants = await prisma.tenant.findMany({
    where: { slug: { startsWith: PREFIX } },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  if (ids.length) {
    await prisma.journalLine.deleteMany({ where: { entry: { tenantId: { in: ids } } } });
    await prisma.journalEntry.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.account.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.period.deleteMany({ where: { calendar: { tenantId: { in: ids } } } });
    await prisma.fiscalCalendar.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.legalEntity.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.tenantMembership.deleteMany({ where: { tenantId: { in: ids } } });
    await withAuditLogMutable(prisma, async () => {
      await prisma.auditLog.deleteMany({ where: { tenantId: { in: ids } } });
    });
    await prisma.recordEvent.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.tenant.deleteMany({ where: { id: { in: ids } } });
  }
  const users = await prisma.user.findMany({
    where: { email: { startsWith: PREFIX } },
    select: { id: true },
  });
  const userIds = users.map((u) => u.id);
  if (userIds.length) {
    await withAuditLogMutable(prisma, async () => {
      await prisma.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    });
  }
}

/**
 * Nine entries across four dates, several sharing a date, several carrying two
 * lines that both hit the register account. That produces 13 register rows
 * with ties in every position of the ordering triple.
 */
const PLAN: { date: string; amounts: number[] }[] = [
  { date: "2026-01-10", amounts: [100, 250] },
  { date: "2026-01-10", amounts: [75] },
  { date: "2026-01-10", amounts: [40, 60] },
  { date: "2026-02-05", amounts: [500] },
  { date: "2026-02-05", amounts: [125, 375] },
  { date: "2026-03-01", amounts: [90] },
  { date: "2026-03-01", amounts: [10, 20] },
  { date: "2026-04-15", amounts: [1000] },
  { date: "2026-04-15", amounts: [15] },
];

beforeAll(async () => {
  await scrubOrphans();

  const owner = await prisma.user.create({
    data: { email: `${PREFIX}-${SUFFIX}@example.test`, displayName: "Reg", isActive: true },
    select: { id: true },
  });
  const tenant = await prisma.tenant.create({
    data: { slug: `${PREFIX}-${SUFFIX}`, name: "Reg", ownerUserId: owner.id },
    select: { id: true },
  });
  tenantId = tenant.id;
  const entity = await prisma.legalEntity.create({
    data: { tenantId, code: ENTITY_CODE, name: "Reg Co", functionalCurrencyId: "USD" },
    select: { id: true },
  });
  entityId = entity.id;
  const book = await prisma.book.findUniqueOrThrow({
    where: { code: "US_GAAP" },
    select: { id: true },
  });
  bookId = book.id;

  const calendar = await prisma.fiscalCalendar.create({
    data: { tenantId, entityId, code: `${PREFIX}CAL${SUFFIX}`.slice(0, 30), name: "Reg cal" },
    select: { id: true },
  });
  for (let m = 1; m <= 5; m++) {
    await prisma.period.create({
      data: {
        tenantId,
        calendarId: calendar.id,
        code: `2026-0${m}`,
        ordinal: m,
        startsOn: new Date(Date.UTC(2026, m - 1, 1)),
        endsOn: new Date(Date.UTC(2026, m, 0)),
      },
    });
  }

  // 1000 is debit-normal; the contra side is a revenue account so every entry
  // balances without touching the register account twice on the same side.
  const cash = await prisma.account.create({
    data: {
      tenantId,
      entityId,
      code: "1000",
      name: "Cash",
      type: "ASSET",
      normalBalance: "DEBIT",
    },
    select: { id: true },
  });
  accountId = cash.id;
  await prisma.account.create({
    data: {
      tenantId,
      entityId,
      code: "4000",
      name: "Revenue",
      type: "REVENUE",
      normalBalance: "CREDIT",
    },
  });

  for (const [i, spec] of PLAN.entries()) {
    await postJournalEntry(prisma, {
      tenantId,
      entityCode: ENTITY_CODE,
      bookCode: "US_GAAP",
      documentDate: new Date(spec.date),
      postingDate: new Date(spec.date),
      currencyCode: "USD",
      memo: `reg ${i}`,
      source: "SEED",
      lines: spec.amounts.flatMap((amt) => [
        { accountCode: "1000", debit: amt.toFixed(2), credit: "0" },
        { accountCode: "4000", debit: "0", credit: amt.toFixed(2) },
      ]),
    });
  }
});

afterAll(async () => {
  await scrubOrphans();
  await prisma.$disconnect();
});

const REGISTER_WHERE = (): Prisma.JournalLineWhereInput => ({
  tenantId,
  accountId,
  entry: { entity: { code: ENTITY_CODE }, book: { code: "US_GAAP" }, status: { in: ["POSTED"] } },
});

const ASC = [
  { entry: { documentDate: "asc" as const } },
  { entry: { entryNumber: "asc" as const } },
  { lineNo: "asc" as const },
];
const DESC = [
  { entry: { documentDate: "desc" as const } },
  { entry: { entryNumber: "desc" as const } },
  { lineNo: "desc" as const },
];
const SELECT = {
  id: true,
  lineNo: true,
  debit: true,
  credit: true,
  entry: { select: { entryNumber: true, documentDate: true } },
};

/** The old implementation: every line, accumulated from zero. */
async function naiveBalances() {
  const lines = await prisma.journalLine.findMany({
    where: REGISTER_WHERE(),
    orderBy: ASC,
    select: SELECT,
  });
  return withRunningBalance(lines, new Decimal(0), true).map((r) => ({
    id: r.line.id,
    balance: r.balance.toFixed(2),
  }));
}

/** The new one: a window plus an aggregate for what precedes it. */
async function pagedBalances(pageSize: number) {
  const total = await prisma.journalLine.count({ where: REGISTER_WHERE() });
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const out: { id: string; balance: string }[] = [];

  // Walk oldest page → newest so the result reads in the same order as naive.
  for (let p = pages; p >= 1; p--) {
    const windowDesc = await prisma.journalLine.findMany({
      where: REGISTER_WHERE(),
      orderBy: DESC,
      skip: (p - 1) * pageSize,
      take: pageSize,
      select: SELECT,
    });
    const oldest = windowDesc[windowDesc.length - 1];
    const opening = oldest
      ? balanceFromSums(
          (
            await prisma.journalLine.aggregate({
              where: {
                AND: [
                  REGISTER_WHERE(),
                  olderThan({
                    documentDate: oldest.entry.documentDate,
                    entryNumber: oldest.entry.entryNumber,
                    lineNo: oldest.lineNo,
                  }),
                ],
              },
              _sum: { debit: true, credit: true },
            })
          )._sum,
          true
        )
      : new Decimal(0);

    for (const r of withRunningBalance([...windowDesc].reverse(), opening, true)) {
      out.push({ id: r.line.id, balance: r.balance.toFixed(2) });
    }
  }
  return out;
}

describe("account register pagination", () => {
  it("seeds a register with ties in every position of the ordering key", async () => {
    // A positive control on the FIXTURE, not the code. If the seed produced
    // one line per date, the differential test below would pass against an
    // `olderThan` that only compares dates.
    const lines = await prisma.journalLine.findMany({
      where: REGISTER_WHERE(),
      orderBy: ASC,
      select: { lineNo: true, entry: { select: { documentDate: true, entryNumber: true } } },
    });
    expect(lines.length).toBe(13);

    const dates = lines.map((l) => l.entry.documentDate.toISOString().slice(0, 10));
    expect(new Set(dates).size).toBeLessThan(dates.length); // same-date ties

    const perEntry = new Map<string, number>();
    for (const l of lines) perEntry.set(l.entry.entryNumber, (perEntry.get(l.entry.entryNumber) ?? 0) + 1);
    expect([...perEntry.values()].some((n) => n > 1)).toBe(true); // multi-line entries
  });

  it("⚠️ pages produce the same balances as one unpaged accumulation", async () => {
    const naive = await naiveBalances();
    // 4 splits 14 rows into pages whose boundaries fall inside same-date
    // groups — which is exactly where a date-only comparison goes wrong.
    for (const size of [1, 3, 4, 5, 14, 100]) {
      const paged = await pagedBalances(size);
      expect(paged, `page size ${size}`).toEqual(naive);
    }
  });

  it("the newest row's balance is the account's whole balance", async () => {
    // The property the old full fetch existed to guarantee, kept.
    const totals = await prisma.journalLine.aggregate({
      where: REGISTER_WHERE(),
      _sum: { debit: true, credit: true },
    });
    const whole = balanceFromSums(totals._sum, true);
    const naive = await naiveBalances();
    expect(naive[naive.length - 1].balance).toBe(whole.toFixed(2));
    expect(whole.toFixed(2)).toBe("2660.00"); // 100+250+75+40+60+500+125+375+90+10+20+1000+15
  });

  it("an empty register opens at zero rather than throwing", async () => {
    // `_sum` is null when no rows match — `new Decimal(null)` throws, so the
    // helper coalesces. An account with no postings is an ordinary state.
    expect(balanceFromSums({ debit: null, credit: null }, true).toFixed(2)).toBe("0.00");
  });

  it("signs movement on the account's normal side", async () => {
    expect(signedMovement("100", "0", true).toFixed(2)).toBe("100.00");
    expect(signedMovement("100", "0", false).toFixed(2)).toBe("-100.00");
    expect(signedMovement("0", "40", false).toFixed(2)).toBe("40.00");
  });
});
