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
import { getScope } from "@/lib/scope";
import { NewEntryForm } from "./new-entry-form";

export default async function NewEntryPage({
  searchParams,
}: {
  searchParams: { duplicate?: string };
}) {
  const scope = getScope();
  const [accounts, parties] = await Promise.all([
    prisma.account.findMany({
      where: {
        active: true,
        OR: [{ entityId: null }, { entity: { code: scope.entityCode } }],
      },
      orderBy: { code: "asc" },
      select: { code: true, name: true, type: true },
    }),
    prisma.party.findMany({
      where: {
        OR: [{ entityId: null }, { entity: { code: scope.entityCode } }],
      },
      orderBy: { code: "asc" },
      select: { code: true, displayName: true },
    }),
  ]);

  // Resolve the duplicate-source JE, if any. We don't enforce that the
  // duplicate source belongs to the active scope — the user may have
  // landed here from a JE in a different (entity, book) view, and forcing
  // a scope match would lose information. The form still POSTs to the
  // CURRENT scope.
  let initialLines: Array<{
    accountCode: string;
    side: "DEBIT" | "CREDIT";
    amount: string;
    partyCode?: string;
    description?: string;
  }> | undefined;
  let initialMemo: string | undefined;
  if (searchParams.duplicate) {
    const source = await prisma.journalEntry.findUnique({
      where: { id: searchParams.duplicate },
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
