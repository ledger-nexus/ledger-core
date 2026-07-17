// Dashboard data boundary.
//
// One function owns EVERY tenant-scoped read the dashboard renders, so the
// page component is presentation-only. This is the "one auditable tenant
// boundary" the architecture review asked for: instead of ~15 queries
// interleaved with JSX, the tenant pin lives in exactly one place and takes
// an `AuthorizedLedgerScope` — the type-level proof the caller resolved a
// verified scope, not a raw cookie. Every query below filters by
// `scope.tenantId` (+ `scope.entityId` where the model carries it).

import { Decimal } from "decimal.js";
import type { PrismaClient } from "@prisma/client";
import type { AuthorizedLedgerScope } from "@/lib/scope";
import { getBalanceSheet, getIncomeStatement } from "@/lib/accounting/reports";
import { openArBalance } from "@/lib/accounting/sub-ledgers/ar";
import { openApBalance } from "@/lib/accounting/sub-ledgers/ap";
import { netBookValue } from "@/lib/accounting/sub-ledgers/fixed-assets";
import { getBookTaxDifference } from "@/lib/accounting/reports/book-tax-difference";
import { enumerateDueDates } from "@/lib/accounting/recurring";
import { checkSubledgerTies } from "@/lib/accounting/subledger-ties";

/**
 * Everything the dashboard renders, resolved for one authorized scope as of
 * `now`. All figures are already tenant/entity/book-scoped — the page never
 * queries directly.
 */
export async function getDashboardSnapshot(
  prisma: PrismaClient,
  scope: AuthorizedLedgerScope,
  now: Date
) {
  const asOf = now;
  const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  // Midnight today (UTC) — the boundary for "this period has ended".
  const todayUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );

  // Parallel data fetches: KPIs + activity-surfaces ("what needs my
  // attention") for the dashboard's secondary panels.
  const [
    bs,
    pnl,
    arOpen,
    apOpen,
    nbv,
    recent,
    openNoteCount,
    recurringTemplates,
    lastClose,
    openPeriodCount,
    subledgerTies,
    arItemCount,
    apItemCount,
    fixedAssetCount,
  ] = await Promise.all([
    // scope carries tenantId, so the report resolvers pin the entity to
    // this tenant (resolveEntityBook uses scope.tenantId).
    getBalanceSheet(prisma, scope, asOf),
    getIncomeStatement(prisma, scope, yearStart, asOf),
    openArBalance(prisma, scope.entityCode, scope.bookCode, scope.tenantId),
    openApBalance(prisma, scope.entityCode, scope.bookCode, scope.tenantId),
    netBookValue(prisma, scope.entityCode, scope.bookCode, scope.tenantId),
    prisma.journalEntry.findMany({
      where: {
        tenantId: scope.tenantId,
        entityId: scope.entityId,
        book: { code: scope.bookCode },
      },
      orderBy: [{ documentDate: "desc" }, { createdAt: "desc" }],
      take: 10,
      select: {
        id: true,
        entryNumber: true,
        documentDate: true,
        memo: true,
        source: true,
        sourceSystem: true,
        sourceRecordType: true,
        lines: { select: { debit: true } },
      },
    }),
    // Open review notes attached to JEs in the active scope. A pure
    // count is enough for the badge; the user clicks through to find
    // them in /journal-entries (filtered list shows the "N open" badge).
    prisma.journalEntryNote.count({
      where: {
        tenantId: scope.tenantId,
        resolvedAt: null,
        entry: {
          entityId: scope.entityId,
          book: { code: scope.bookCode },
        },
      },
    }),
    // Active recurring templates for this (entity, book). We compute
    // "due today" client-side via enumerateDueDates so the cadence
    // math stays in one place.
    prisma.recurringEntry.findMany({
      where: {
        isActive: true,
        tenantId: scope.tenantId,
        entityId: scope.entityId,
        book: { code: scope.bookCode },
      },
      select: {
        cadence: true,
        startDate: true,
        endDate: true,
        lastPostedDate: true,
      },
    }),
    // Most recent period close for this (entity, book). Lets the
    // dashboard show "May 2026 closed 4 days ago by …".
    prisma.periodClose.findFirst({
      where: {
        tenantId: scope.tenantId,
        entityId: scope.entityId,
        book: { code: scope.bookCode },
      },
      orderBy: { closedAt: "desc" },
      select: {
        closedAt: true,
        closedBy: true,
        period: { select: { code: true } },
      },
    }),
    // Periods that have ENDED but still have no close row for this book —
    // i.e. genuinely behind. Only elapsed periods count; a future month you
    // haven't reached yet isn't a backlog.
    prisma.period.count({
      where: {
        tenantId: scope.tenantId,
        calendar: { entity: { id: scope.entityId } },
        endsOn: { lt: todayUtc },
        // No close row for THIS book.
        NOT: {
          closes: {
            some: {
              book: { code: scope.bookCode },
            },
          },
        },
      },
    }),
    // Sub-ledger ties: AR control vs sum-of-open-AR, AP control vs
    // sum-of-open-AP. Broken ties point at a real bug — either a JE
    // posted to a control account without flowing through the sub-
    // ledger, or a sub-ledger write that drifted from the JE total.
    checkSubledgerTies(prisma, {
      tenantId: scope.tenantId,
      entityCode: scope.entityCode,
      bookCode: scope.bookCode,
      asOf,
    }),
    // Relevance probes for the sub-ledger KPI tiles. We gate on "has this
    // sub-ledger ever been used here", not on "is the balance non-zero",
    // so a book that runs AR still sees AR when it nets to nil.
    prisma.arOpenItem.count({
      where: {
        tenantId: scope.tenantId,
        entityId: scope.entityId,
        book: { code: scope.bookCode },
      },
    }),
    prisma.apOpenItem.count({
      where: {
        tenantId: scope.tenantId,
        entityId: scope.entityId,
        book: { code: scope.bookCode },
      },
    }),
    prisma.fixedAsset.count({
      where: { tenantId: scope.tenantId, entityId: scope.entityId },
    }),
  ]);

  // Count of broken ties for the dashboard badge.
  const brokenTies = subledgerTies.filter((t) => t.status === "broken").length;

  // Bank lines waiting for review — the daily reconciliation loop.
  const forReviewCount = await prisma.bankTransaction.count({
    where: {
      tenantId: scope.tenantId,
      entityId: scope.entityId,
      book: { code: scope.bookCode },
      status: "FOR_REVIEW",
    },
  });

  // Close progress ("zero-day close" progress bar). Tenant pin is REQUIRED:
  // close tasks may be entity-null (tenant-wide), so without it another
  // tenant's admin tasks would blend into the count.
  let closeProgress: { periodCode: string; done: number; total: number } | null =
    null;
  {
    const scopedTask = {
      tenantId: scope.tenantId,
      AND: [
        { OR: [{ entity: { code: scope.entityCode } }, { entityId: null }] },
        { OR: [{ book: { code: scope.bookCode } }, { bookId: null }] },
      ],
    };
    const latestTask = await prisma.closeTask.findFirst({
      where: scopedTask,
      orderBy: { period: { startsOn: "desc" } },
      select: { periodId: true, period: { select: { code: true } } },
    });
    if (latestTask) {
      const [total, done] = await Promise.all([
        prisma.closeTask.count({
          where: { ...scopedTask, periodId: latestTask.periodId },
        }),
        prisma.closeTask.count({
          where: {
            ...scopedTask,
            periodId: latestTask.periodId,
            // WAIVED is a conscious "not this month" — complete for
            // progress purposes, same as the close calendar treats it.
            status: { in: ["DONE", "WAIVED"] },
          },
        }),
      ]);
      if (total > 0)
        closeProgress = { periodCode: latestTask.period.code, done, total };
    }
  }

  // "Due today" count from the active recurring templates (pure math).
  const today = new Date(now);
  today.setUTCHours(0, 0, 0, 0);
  const recurringDueCount = recurringTemplates.reduce((sum, t) => {
    const due = enumerateDueDates({
      cadence: t.cadence,
      startDate: t.startDate,
      lastPostedDate: t.lastPostedDate,
      endDate: t.endDate,
      throughDate: today,
    });
    return sum + due.length;
  }, 0);

  // Days since last close (for the "closed N days ago" tooltip).
  const daysSinceClose =
    lastClose != null
      ? Math.floor(
          (now.getTime() - lastClose.closedAt.getTime()) / (1000 * 60 * 60 * 24)
        )
      : null;

  // Cash from bank-flagged accounts on the BS (Account.isBank, not a code regex).
  const cash = bs.assets
    .filter((a) => a.isBank)
    .reduce((acc, a) => acc.plus(a.amount), new Decimal(0));

  // Net assets = what's owned less what's owed (the BS bottom line).
  const netAssets = bs.totalAssets.minus(bs.totalLiabilities);

  // Cross-book BTD vs US_TAX, only if scope is US_GAAP (the obvious pairing).
  // Every lookup here is tenant-pinned — the entry probe and the difference
  // both scope to scope.tenantId so a colliding entity code in another tenant
  // can't leak its tax-book activity onto this dashboard.
  let btdSummary: { delta: Decimal; otherBook: string } | null = null;
  if (scope.bookCode === "US_GAAP") {
    const otherBook = "US_TAX";
    const hasTaxBook = await prisma.book.findUnique({
      where: { code: otherBook },
      select: { id: true },
    });
    const taxEntries = hasTaxBook
      ? await prisma.journalEntry.count({
          where: {
            tenantId: scope.tenantId,
            entityId: scope.entityId,
            book: { code: otherBook },
          },
        })
      : 0;
    if (taxEntries > 0) {
      const btd = await getBookTaxDifference(prisma, {
        entityCode: scope.entityCode,
        fromBookCode: scope.bookCode,
        toBookCode: otherBook,
        periodStart: yearStart,
        periodEnd: asOf,
        tenantId: scope.tenantId,
      });
      btdSummary = { delta: btd.totalDelta, otherBook };
    }
  }

  return {
    asOf,
    pnl,
    arOpen,
    apOpen,
    nbv,
    recent,
    openNoteCount,
    lastClose,
    openPeriodCount,
    subledgerTies,
    brokenTies,
    arItemCount,
    apItemCount,
    fixedAssetCount,
    forReviewCount,
    closeProgress,
    recurringDueCount,
    daysSinceClose,
    cash,
    netAssets,
    btdSummary,
  };
}

/** The shape the dashboard page renders. Derived so it can't drift from the source. */
export type DashboardSnapshot = Awaited<ReturnType<typeof getDashboardSnapshot>>;
