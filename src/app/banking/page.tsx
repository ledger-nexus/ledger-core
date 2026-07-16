// Bank feed — the "For Review" inbox.
//
// Imported bank/card lines land here as staging records, not postings. You
// import a CSV, then work the queue to zero: each line gets a category (which
// posts a balanced journal entry) or is excluded. It's the QuickBooks
// bank-feed loop, native to the ledger.

import { prisma } from "@/lib/db";
import { getScope } from "@/lib/scope";
import { getCurrentTenant } from "@/lib/auth/tenant";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { EmptyState } from "@/components/ui/empty-state";
import { Decimal } from "decimal.js";
import ImportForm from "./import-form";
import ReviewRow from "./review-row";

export default async function BankingPage() {
  const tenant = await getCurrentTenant();
  const scope = getScope();

  if (!tenant) {
    return (
      <div className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold text-ink-900">Bank transactions</h2>
        <EmptyState title="Sign in to review bank transactions" />
      </div>
    );
  }

  const [bankAccounts, categoryAccounts, forReview, categorizedCount] = await Promise.all([
    // Import targets — the accounts a feed can belong to. Bank/card accounts
    // first (the usual case), but any account is allowed.
    prisma.account.findMany({
      where: {
        tenantId: tenant.id,
        active: true,
        OR: [{ entityId: null }, { entity: { code: scope.entityCode } }],
      },
      orderBy: [{ isBank: "desc" }, { code: "asc" }],
      select: { code: true, name: true, isBank: true },
    }),
    // Category targets — every active account, for coding a line.
    prisma.account.findMany({
      where: {
        tenantId: tenant.id,
        active: true,
        OR: [{ entityId: null }, { entity: { code: scope.entityCode } }],
      },
      orderBy: { code: "asc" },
      select: { code: true, name: true, type: true },
    }),
    prisma.bankTransaction.findMany({
      where: {
        tenantId: tenant.id,
        status: "FOR_REVIEW",
        entity: { code: scope.entityCode },
        book: { code: scope.bookCode },
      },
      orderBy: [{ postedDate: "desc" }, { importedAt: "desc" }],
      select: {
        id: true,
        postedDate: true,
        description: true,
        amount: true,
        bankAccount: { select: { code: true, name: true } },
      },
    }),
    prisma.bankTransaction.count({
      where: {
        tenantId: tenant.id,
        status: "CATEGORIZED",
        entity: { code: scope.entityCode },
        book: { code: scope.bookCode },
      },
    }),
  ]);

  const bankPickList = bankAccounts.map((a) => ({ code: a.code, name: a.name }));
  const categoryList = categoryAccounts.map((a) => ({ code: a.code, name: a.name }));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold text-ink-900">Bank transactions</h2>
        <p className="text-sm text-ink-500">
          Import a bank or card CSV, then give each line a category to add it to the
          books. {categorizedCount > 0 && `${categorizedCount} added so far.`}
        </p>
      </div>

      <ImportForm bankAccounts={bankPickList} />

      <Card>
        <CardHeader>
          <div className="flex items-baseline gap-2">
            <CardTitle>For review</CardTitle>
            <span className="text-xs text-ink-500">
              {forReview.length} in {scope.entityCode} / {scope.bookCode}
            </span>
          </div>
        </CardHeader>
        <CardContent>
          {forReview.length === 0 ? (
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
                {forReview.map((t) => (
                  <ReviewRow
                    key={t.id}
                    id={t.id}
                    postedDate={t.postedDate.toISOString().slice(0, 10)}
                    description={t.description}
                    bankAccountLabel={`${t.bankAccount.code} — ${t.bankAccount.name}`}
                    amount={new Decimal(t.amount.toString()).toFixed(2)}
                    categories={categoryList}
                  />
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
