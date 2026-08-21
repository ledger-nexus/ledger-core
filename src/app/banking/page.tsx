// Bank feed — the "For Review" inbox.
//
// Imported bank/card lines land here as staging records, not postings. You
// import a CSV, then work the queue to zero: each line gets a category (which
// posts a balanced journal entry) or is excluded. It's the QuickBooks
// bank-feed loop, native to the ledger.

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { getCurrentScope } from "@/lib/scope";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { EmptyState } from "@/components/ui/empty-state";
import { Pagination } from "@/components/ui/pagination";
import { Decimal } from "@/lib/utils/decimal";
import { bestRuleFor, type RuleForMatching } from "@/lib/banking/rules";
import { findMatchCandidates } from "@/lib/banking/match";
import { buildUrl, int, parseUrlState, type RawParams, type SurfaceSpec } from "@/lib/url-state";
import ImportForm from "./import-form";
import ReviewRow from "./review-row";

// ⚠️ THIS BOUNDS A QUERY FAN-OUT, NOT JUST A FETCH. Every row in the review
// queue triggers its own `findMatchCandidates` call (see the enrichment loop
// below), all issued concurrently through one connection pool. Unpaged, a CSV
// import of a year of bank activity turned one page render into one database
// query per imported line. The comment on that loop already said so — "revisit
// with a windowed batch if inboxes grow" — and this is that window.
const PAGE_SIZE = 50;

/** The review queue's only parameter. */
const SPEC = { page: int(1, { min: 1 }) } satisfies SurfaceSpec;

export default async function BankingPage({
  searchParams,
}: {
  searchParams: RawParams;
}) {
  const scope = await getCurrentScope();

  if (!scope) {
    return (
      <div className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold text-ink-900">Bank transactions</h2>
        <EmptyState title="Sign in to review bank transactions" />
      </div>
    );
  }

  // ⚠️ Typed, not `as const` — Prisma's generated filter wants mutable values.
  const reviewWhere: Prisma.BankTransactionWhereInput = {
    tenantId: scope.tenantId,
    status: "FOR_REVIEW",
    entity: { code: scope.entityCode },
    book: { code: scope.bookCode },
  };

  // Counted before the page resolves, so `?page=` past the end clamps to the
  // last real page rather than rendering "Nothing to review" at someone who
  // has plenty to review.
  const reviewCount = await prisma.bankTransaction.count({ where: reviewWhere });
  const totalPages = Math.max(1, Math.ceil(reviewCount / PAGE_SIZE));
  const page = Math.min(parseUrlState(SPEC, searchParams).page, totalPages);

  const [bankAccounts, categoryAccounts, forReview, categorizedCount, rules] = await Promise.all([
    // Import targets — the accounts a feed can belong to. Bank/card accounts
    // first (the usual case), but any account is allowed.
    prisma.account.findMany({
      where: {
        tenantId: scope.tenantId,
        active: true,
        OR: [{ entityId: null }, { entity: { code: scope.entityCode } }],
      },
      orderBy: [{ isBank: "desc" }, { code: "asc" }],
      select: { code: true, name: true, isBank: true },
    }),
    // Category targets — every active account, for coding a line.
    prisma.account.findMany({
      where: {
        tenantId: scope.tenantId,
        active: true,
        OR: [{ entityId: null }, { entity: { code: scope.entityCode } }],
      },
      orderBy: { code: "asc" },
      select: { code: true, name: true, type: true },
    }),
    prisma.bankTransaction.findMany({
      where: reviewWhere,
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      orderBy: [{ postedDate: "desc" }, { importedAt: "desc" }],
      select: {
        id: true,
        postedDate: true,
        description: true,
        amount: true,
        entityId: true,
        bookId: true,
        bankAccountId: true,
        bankAccount: { select: { code: true, name: true, normalBalance: true } },
      },
    }),
    prisma.bankTransaction.count({
      where: {
        tenantId: scope.tenantId,
        status: { in: ["CATEGORIZED", "MATCHED"] },
        entity: { code: scope.entityCode },
        book: { code: scope.bookCode },
      },
    }),
    // Learned rules — decrypted by the client extension; matching happens
    // here in JS, never in SQL over ciphertext.
    prisma.bankRule.findMany({
      where: { tenantId: scope.tenantId },
      select: {
        id: true,
        matchText: true,
        bankAccountId: true,
        categoryAccountId: true,
        timesUsed: true,
        categoryAccount: { select: { code: true } },
      },
    }),
  ]);

  const bankPickList = bankAccounts.map((a) => ({ code: a.code, name: a.name }));
  const categoryList = categoryAccounts.map((a) => ({ code: a.code, name: a.name }));

  // Suggestions + match candidates per line — ONE `findMatchCandidates` query
  // per row, issued concurrently. That fan-out is now bounded by PAGE_SIZE
  // rather than by how much anyone imported, which is the windowed batch the
  // previous version of this comment deferred. Rules match in memory (below),
  // so they cost no query per row.
  const ruleSet: RuleForMatching[] = rules.map((r) => ({
    id: r.id,
    matchText: r.matchText,
    bankAccountId: r.bankAccountId,
    categoryAccountId: r.categoryAccountId,
    timesUsed: r.timesUsed,
  }));
  const codeByAccountId = new Map(rules.map((r) => [r.categoryAccountId, r.categoryAccount.code]));
  const enriched = await Promise.all(
    forReview.map(async (t) => {
      const rule = bestRuleFor(ruleSet, t.description, t.bankAccountId);
      const candidates = await findMatchCandidates(prisma, {
        tenantId: scope.tenantId,
        entityId: t.entityId,
        bookId: t.bookId,
        bankAccountId: t.bankAccountId,
        bankNormalIsDebit: t.bankAccount.normalBalance === "DEBIT",
        postedDate: t.postedDate,
        amount: new Decimal(t.amount.toString()),
      });
      return {
        t,
        suggestedCategory: rule ? codeByAccountId.get(rule.categoryAccountId) ?? null : null,
        candidates: candidates.map((c) => ({
          entryId: c.entryId,
          entryNumber: c.entryNumber,
          date: c.documentDate.toISOString().slice(0, 10),
          memo: c.memo,
        })),
      };
    })
  );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold text-ink-900">Bank transactions</h2>
        <p className="text-sm text-ink-500">
          Import a bank or card CSV, then give each line a category to add it to the
          books. {categorizedCount > 0 && `${categorizedCount} added or matched so far.`}
        </p>
      </div>

      <ImportForm bankAccounts={bankPickList} />

      <Card>
        <CardHeader>
          <div className="flex items-baseline gap-2">
            <CardTitle>For review</CardTitle>
            <span className="text-xs text-ink-500">
              {reviewCount} in {scope.entityCode} / {scope.bookCode}
            </span>
          </div>
        </CardHeader>
        <CardContent>
          {reviewCount === 0 ? (
            <EmptyState
              title="Nothing to review"
              description="Import a CSV above, or you're all caught up — every transaction has been added or excluded."
            />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Date</TH>
                  <TH>Description</TH>
                  <TH>Account</TH>
                  <TH className="text-right">Amount</TH>
                  <TH>Category</TH>
                  <TH />
                </tr>
              </THead>
              <TBody>
                {enriched.map(({ t, suggestedCategory, candidates }) => (
                  <ReviewRow
                    key={t.id}
                    id={t.id}
                    postedDate={t.postedDate.toISOString().slice(0, 10)}
                    description={t.description}
                    bankAccountLabel={`${t.bankAccount.code} — ${t.bankAccount.name}`}
                    amount={new Decimal(t.amount.toString()).toFixed(2)}
                    categories={categoryList}
                    suggestedCategory={suggestedCategory}
                    matchCandidates={candidates}
                  />
                ))}
              </TBody>
            </Table>
          )}
          {reviewCount > 0 && (
            <Pagination
              page={page}
              totalPages={totalPages}
              totalCount={reviewCount}
              pageSize={PAGE_SIZE}
              hrefFor={(p) => buildUrl("/banking", SPEC, { page: p })}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
