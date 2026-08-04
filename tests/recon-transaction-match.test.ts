// Reconciliation transaction matching.
//
// The invariants that make an auto-matched reconciliation trustworthy:
//   - amounts match EXACTLY (a 2-cent difference is two unmatched
//     items, never one absorbed match);
//   - one-to-one — a single GL line cannot satisfy two statement lines,
//     which is how duplicate payments hide;
//   - nearest date wins among equal amounts, and anything outside the
//     window is not a match at all;
//   - netUnmatched equals the GL-minus-statement difference, so the
//     itemization ACCOUNTS for the difference rather than merely
//     listing things near it;
//   - the pairing is deterministic — an operator who signs off must be
//     able to reopen the recon and see what they signed.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import Decimal from "decimal.js";

import { postJournalEntry } from "@/lib/accounting/post-journal";
import {
  getReconTransactionMatch,
  matchTransactions,
  type MatchableItem,
} from "@/lib/recon/transaction-match";
import { withAuditLogMutable } from "./_helpers/audit-log-cleanup";

const prisma = new PrismaClient();
const SUFFIX = Date.now().toString(36) + Math.floor(Math.random() * 9999);
const BOOK = "US_GAAP";
const E = `RTMX${SUFFIX}`.toUpperCase().slice(0, 14);
const BANK_CODE = `RT10${SUFFIX}`.slice(0, 12);
const EXP_CODE = `RT60${SUFFIX}`.slice(0, 12);

let tenantId: string;
let entityId: string;
let bookId: string;
let bankAccountId: string;

function item(
  id: string,
  date: string,
  amount: string,
  description = id
): MatchableItem {
  return { id, date: new Date(date), amount: new Decimal(amount), description };
}

async function scrubStale() {
  const stale = await prisma.tenant.findMany({
    where: { slug: { startsWith: "rtmx" } },
    select: { id: true },
  });
  const ids = stale.map((t) => t.id);
  if (ids.length > 0) {
    await prisma.bankTransaction.deleteMany({ where: { tenantId: { in: ids } } });
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
    where: { displayName: { startsWith: "RTMX Fixture" } },
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
    data: { email: `rtmx-${SUFFIX}@example.test`, displayName: "RTMX Fixture owner" },
    select: { id: true },
  });
  const tenant = await prisma.tenant.create({
    data: { slug: `rtmx-${SUFFIX}`, name: "RTMX Co", ownerUserId: owner.id },
    select: { id: true },
  });
  tenantId = tenant.id;

  const ent = await prisma.legalEntity.create({
    data: { tenantId, code: E, name: E, functionalCurrencyId: "USD" },
    select: { id: true },
  });
  entityId = ent.id;
  const cal = await prisma.fiscalCalendar.create({
    data: {
      tenantId,
      entityId,
      code: "RTMX_CAL",
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
  const book = await prisma.book.findUniqueOrThrow({
    where: { code: BOOK },
    select: { id: true },
  });
  bookId = book.id;

  const bank = await prisma.account.create({
    data: {
      tenantId,
      entityId,
      code: BANK_CODE,
      name: "Operating checking",
      type: "ASSET",
      normalBalance: "DEBIT",
      isBank: true,
    },
    select: { id: true },
  });
  bankAccountId = bank.id;
  await prisma.account.create({
    data: {
      tenantId,
      entityId,
      code: EXP_CODE,
      name: "Operating expense",
      type: "EXPENSE",
      normalBalance: "DEBIT",
    },
  });

  // Three cash movements in the books.
  const book_ = [
    ["2026-05-05", "1200", "Customer deposit", true],
    ["2026-05-12", "450", "Supplier payment", false],
    ["2026-05-28", "875", "Cheque to landlord — still outstanding", false],
  ] as const;
  for (const [date, amt, memo, isReceipt] of book_) {
    await postJournalEntry(prisma, {
      tenantId,
      entityCode: E,
      bookCode: BOOK,
      documentDate: new Date(date),
      memo,
      source: "MANUAL",
      lines: isReceipt
        ? [
            { accountCode: BANK_CODE, debit: amt },
            { accountCode: EXP_CODE, credit: amt },
          ]
        : [
            { accountCode: EXP_CODE, debit: amt },
            { accountCode: BANK_CODE, credit: amt },
          ],
    });
  }

  // The statement: the deposit (2 days later), the supplier payment
  // (same day), a bank fee never booked, and an EXCLUDED line that must
  // not become a reconciling item. The outstanding cheque is absent.
  const stmt = [
    ["2026-05-07", "1200", "DEPOSIT 4471", "FOR_REVIEW"],
    ["2026-05-12", "-450", "ACH SUPPLIER", "FOR_REVIEW"],
    ["2026-05-31", "-35", "MONTHLY SERVICE FEE", "FOR_REVIEW"],
    ["2026-05-20", "-9999", "TRANSFER — not ours", "EXCLUDED"],
  ] as const;
  for (const [date, amt, description, status] of stmt) {
    await prisma.bankTransaction.create({
      data: {
        tenantId,
        entityId,
        bookId,
        bankAccountId,
        postedDate: new Date(date),
        description,
        amount: amt,
        dedupeHash: `${SUFFIX}-${description}`,
        status: status as "FOR_REVIEW" | "EXCLUDED",
      },
    });
  }
});

afterAll(async () => {
  await scrubStale();
  await prisma.$disconnect();
});

describe("matchTransactions (pure)", () => {
  it("matches exact amounts inside the window and leaves the rest itemized", () => {
    const r = matchTransactions({
      glItems: [item("g1", "2026-05-05", "1200"), item("g2", "2026-05-28", "-875")],
      supportItems: [item("s1", "2026-05-07", "1200"), item("s2", "2026-05-31", "-35")],
    });
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0].gl.id).toBe("g1");
    expect(r.matched[0].dayGap).toBe(2);
    expect(r.unmatchedGl.map((i) => i.id)).toEqual(["g2"]);
    expect(r.unmatchedSupport.map((i) => i.id)).toEqual(["s2"]);
    // −875 in the books, −35 on the statement → the books are 840 lower.
    expect(r.netUnmatched.toString()).toBe("-840");
  });

  it("a near-miss amount is two unmatched items, never one match", () => {
    const r = matchTransactions({
      glItems: [item("g1", "2026-05-05", "100.00")],
      supportItems: [item("s1", "2026-05-05", "100.02")],
    });
    expect(r.matched).toHaveLength(0);
    expect(r.unmatchedGl).toHaveLength(1);
    expect(r.unmatchedSupport).toHaveLength(1);
    expect(r.netUnmatched.toString()).toBe("-0.02");
  });

  it("one-to-one: a single GL line cannot satisfy two statement lines", () => {
    // The shape of a duplicate payment. The second statement line must
    // stay unmatched so the operator sees it.
    const r = matchTransactions({
      glItems: [item("g1", "2026-05-10", "-500")],
      supportItems: [item("s1", "2026-05-10", "-500"), item("s2", "2026-05-11", "-500")],
    });
    expect(r.matched).toHaveLength(1);
    expect(r.unmatchedSupport.map((i) => i.id)).toEqual(["s2"]);
  });

  it("nearest date wins, and outside the window is no match at all", () => {
    const near = matchTransactions({
      glItems: [item("far", "2026-05-01", "-500"), item("near", "2026-05-09", "-500")],
      supportItems: [item("s1", "2026-05-10", "-500")],
    });
    expect(near.matched[0].gl.id).toBe("near");

    const outside = matchTransactions({
      glItems: [item("g1", "2026-05-01", "-500")],
      supportItems: [item("s1", "2026-06-30", "-500")],
      windowDays: 10,
    });
    expect(outside.matched).toHaveLength(0);
  });

  it("is deterministic — the same inputs in any order pair the same way", () => {
    const gl = [item("a", "2026-05-04", "100"), item("b", "2026-05-04", "100")];
    const support = [item("s", "2026-05-04", "100")];
    const forward = matchTransactions({ glItems: gl, supportItems: support });
    const reversed = matchTransactions({
      glItems: [...gl].reverse(),
      supportItems: support,
    });
    expect(forward.matched[0].gl.id).toBe(reversed.matched[0].gl.id);
  });
});

describe("getReconTransactionMatch (DB)", () => {
  it("splits a real bank month into matched, outstanding, and unrecorded", async () => {
    const view = await getReconTransactionMatch(prisma, {
      tenantId,
      entityId,
      bookId,
      accountId: bankAccountId,
      periodStart: new Date("2026-05-01"),
      periodEnd: new Date("2026-05-31"),
    });
    expect(view.available).toBe(true);

    // Deposit (2 days apart) and supplier payment (same day) match.
    expect(view.matched).toHaveLength(2);
    expect(view.matched.map((m) => m.gl.amount.toString()).sort()).toEqual(
      ["-450", "1200"].sort()
    );

    // The cheque is in the books but not on the statement.
    expect(view.unmatchedGl).toHaveLength(1);
    expect(view.unmatchedGl[0].amount.toString()).toBe("-875");
    expect(view.unmatchedGl[0].reference).toMatch(/-US_GAAP-/);

    // The service fee is on the statement but not in the books; the
    // EXCLUDED transfer is not a reconciling item at all.
    expect(view.unmatchedSupport).toHaveLength(1);
    expect(view.unmatchedSupport[0].amount.toString()).toBe("-35");

    // −875 outstanding vs −35 unrecorded: the books sit 840 below the
    // statement, and that is the whole of the difference.
    expect(view.netUnmatched.toString()).toBe("-840");
  });

  it("netUnmatched EQUALS the GL-minus-statement difference", async () => {
    const view = await getReconTransactionMatch(prisma, {
      tenantId,
      entityId,
      bookId,
      accountId: bankAccountId,
      periodStart: new Date("2026-05-01"),
      periodEnd: new Date("2026-05-31"),
    });
    const sums = await prisma.journalLine.aggregate({
      where: {
        tenantId,
        accountId: bankAccountId,
        entry: { status: { in: ["POSTED", "REVERSED"] } },
      },
      _sum: { debit: true, credit: true },
    });
    const glBalance = new Decimal(sums._sum.debit!.toString()).minus(
      sums._sum.credit!.toString()
    );
    const stmtRows = await prisma.bankTransaction.findMany({
      where: { tenantId, bankAccountId, status: { not: "EXCLUDED" } },
      select: { amount: true },
    });
    const stmtTotal = stmtRows.reduce(
      (a, r) => a.plus(new Decimal(r.amount.toString())),
      new Decimal(0)
    );
    // This is the property that makes the itemization trustworthy: the
    // unmatched items don't just sit near the difference, they ARE it.
    expect(view.netUnmatched.toString()).toBe(glBalance.minus(stmtTotal).toString());
  });

  it("a non-bank account reports unavailable rather than an empty match table", async () => {
    const expense = await prisma.account.findFirstOrThrow({
      where: { tenantId, code: EXP_CODE },
      select: { id: true },
    });
    const view = await getReconTransactionMatch(prisma, {
      tenantId,
      entityId,
      bookId,
      accountId: expense.id,
      periodStart: new Date("2026-05-01"),
      periodEnd: new Date("2026-05-31"),
    });
    expect(view.available).toBe(false);
    expect(view.matched).toHaveLength(0);
  });
});
