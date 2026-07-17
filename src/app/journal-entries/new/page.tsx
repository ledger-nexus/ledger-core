// New journal entry — Server Component fetches the account + party
// dropdowns; the interactive form is the client component
// new-entry-form.tsx.
//
// `?duplicate=<id>` prefills the line shape from an existing JE. Today's
// date is used (not the source's), and the memo is copied verbatim so
// the user can edit it. The duplicate JE is a fresh entry — it does NOT
// link back to the source via reversalOfId; that's reserved for actual
// reversals.

import { notFound } from "next/navigation";
import { Decimal } from "decimal.js";
import { prisma } from "@/lib/db";
import { getCurrentScope } from "@/lib/scope";
import { EmptyState } from "@/components/ui/empty-state";
import { NewEntryForm } from "./new-entry-form";

export default async function NewEntryPage({
  searchParams,
}: {
  searchParams: { duplicate?: string };
}) {
  // Tenant-verified scope — the account/party dropdowns and the duplicate
  // source below must be scoped to the caller's tenant, never a raw cookie.
  const scope = await getCurrentScope();
  if (!scope) {
    return (
      <EmptyState
        title="No scope available"
        description="Sign in and select a tenant with at least one entity before posting an entry."
      />
    );
  }
  const [accounts, parties] = await Promise.all([
    prisma.account.findMany({
      where: {
        tenantId: scope.tenantId,
        active: true,
        OR: [{ entityId: null }, { entity: { code: scope.entityCode } }],
      },
      orderBy: { code: "asc" },
      select: { code: true, name: true, type: true },
    }),
    prisma.party.findMany({
      where: {
        tenantId: scope.tenantId,
        OR: [{ entityId: null }, { entity: { code: scope.entityCode } }],
      },
      orderBy: { code: "asc" },
      select: { code: true, displayName: true },
    }),
  ]);

  // Resolve the duplicate-source JE, if any. It MUST belong to the
  // caller's tenant — findUnique by id alone let `?duplicate=<any JE id>`
  // read another tenant's entry (memo, lines, account/party codes). We
  // don't force an (entity, book) match within the tenant (the user may
  // duplicate across their own books), but the tenant boundary is hard.
  let initialLines: Array<{
    accountCode: string;
    side: "DEBIT" | "CREDIT";
    amount: string;
    partyCode?: string;
    description?: string;
  }> | undefined;
  let initialMemo: string | undefined;
  if (searchParams.duplicate) {
    const source = await prisma.journalEntry.findFirst({
      where: { id: searchParams.duplicate, tenantId: scope.tenantId },
      include: {
        lines: {
          include: {
            account: { select: { code: true } },
            party: { select: { code: true } },
          },
          orderBy: { lineNo: "asc" },
        },
      },
    });
    if (!source) notFound();
    initialMemo = source.memo;
    initialLines = source.lines.map((l) => {
      const debit = new Decimal(l.debit.toString());
      const credit = new Decimal(l.credit.toString());
      const isDebit = debit.greaterThan(0);
      return {
        accountCode: l.account.code,
        side: isDebit ? "DEBIT" : "CREDIT",
        amount: (isDebit ? debit : credit).toString(),
        partyCode: l.party?.code,
        description: l.description ?? undefined,
      };
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold text-ink-900">New journal entry</h2>
        <p className="text-sm text-ink-500">
          {searchParams.duplicate ? (
            <>
              Prefilled from an existing entry — review and edit before posting.
              Today&apos;s date is used; memo is copied verbatim.
            </>
          ) : (
            <>
              Record a transaction by hand. Debits and credits must balance
              before it can post.
            </>
          )}
        </p>
      </div>
      <NewEntryForm
        accounts={accounts}
        parties={parties}
        scopeLabel={`${scope.entityCode} / ${scope.bookCode}`}
        initialLines={initialLines}
        initialMemo={initialMemo}
      />
    </div>
  );
}
