// Journal entry detail. Header metadata + balanced line table + lineage
// payload (the frozen source-system JSON if it was imported).

import Link from "next/link";
import { notFound } from "next/navigation";
import { Decimal } from "decimal.js";
import { prisma } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getCurrentUser, isAdmin } from "@/lib/auth/current-user";
import { getCurrentTenant } from "@/lib/auth/tenant";
import { canApproveJournalEntries } from "@/lib/auth/policy";
import { formatDate, formatMoney } from "@/lib/utils/format";
import ReverseButton from "./reverse-button";
import NotesCard from "./notes-card";
import { ApprovalActions } from "./approval-actions";
import { WithdrawAction } from "./withdraw-action";

export default async function JournalEntryDetailPage({
  params,
}: {
  params: { id: string };
}) {
  // Tenant-scope the lookup. A forged id from another tenant returns
  // null → 404. Without this gate, a signed-in user from tenant A
  // could load any JE id from tenant B's URLs.
  const tenant = await getCurrentTenant();
  const entry = await prisma.journalEntry.findFirst({
    where: {
      id: params.id,
      ...(tenant ? { tenantId: tenant.id } : {}),
    },
    include: {
      entity: { select: { code: true } },
      book: { select: { code: true } },
      currency: { select: { code: true } },
      reversalOf: { select: { id: true, entryNumber: true } },
      reversedBy: { select: { id: true, entryNumber: true } },
      lines: {
        include: {
          account: { select: { code: true, name: true } },
          party: { select: { code: true, displayName: true } },
        },
        orderBy: { lineNo: "asc" },
      },
      notes: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          body: true,
          authorEmail: true,
          authorUserId: true,
          resolvedAt: true,
          resolvedBy: true,
          createdAt: true,
        },
      },
    },
  });
  const currentUser = await getCurrentUser();

  if (!entry) {
    notFound();
  }

  const totalDebit = entry.lines.reduce(
    (acc, l) => acc.plus(new Decimal(l.debit.toString())),
    new Decimal(0)
  );
  const totalCredit = entry.lines.reduce(
    (acc, l) => acc.plus(new Decimal(l.credit.toString())),
    new Decimal(0)
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link
            href="/journal-entries"
            className="text-xs font-medium text-accent-600 hover:underline"
          >
            ← All entries
          </Link>
          <h2 className="mt-2 font-mono text-xl text-ink-900">{entry.entryNumber}</h2>
          <p className="text-sm text-ink-500">{entry.memo}</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-1.5">
            <Badge
              tone={
                entry.status === "POSTED"
                  ? "positive"
                  : entry.status === "PENDING_APPROVAL"
                    ? "warning"
                    : entry.status === "VOID" || entry.status === "REVERSED"
                      ? "negative"
                      : "info"
              }
            >
              {entry.status}
            </Badge>
            <Badge tone="neutral">{entry.source}</Badge>
            {entry.sourceSystem && (
              <Badge tone="neutral">
                {entry.sourceSystem} · {entry.sourceRecordType}
              </Badge>
            )}
          </div>
          {/* Quick actions. Duplicate links to the new-entry form with
              ?duplicate=<id> so the user lands on a prefilled draft.
              Reverse posts a sign-flipped JE through the substrate.
              Export-CSV is a plain anchor to the CSV route — the route
              writes a DATA_EXPORT audit row server-side. */}
          <div className="flex items-center gap-1.5">
            <Link href={`/journal-entries/new?duplicate=${entry.id}`}>
              <Button size="sm" variant="outline">
                Duplicate
              </Button>
            </Link>
            <ReverseButton
              id={entry.id}
              entryNumber={entry.entryNumber}
              status={entry.status}
              reversedByEntryNumber={entry.reversedBy[0]?.entryNumber}
            />
            <a href={`/api/journal-entries/${entry.id}/csv`} download>
              <Button size="sm" variant="ghost">
                Export CSV
              </Button>
            </a>
          </div>
        </div>
      </div>

      {/* Maker-checker UI surfaces.
          PENDING_APPROVAL surfaces three mutually-compatible cards:
            1. ApprovalActions — for ADMIN+ approvers (separation-of-
               duties blocks the submitter from approving / rejecting
               their own entry).
            2. WithdrawAction — for the submitter (anyone, including an
               admin who happened to be the submitter).
            3. A passive "awaiting approval" hint for the non-admin
               non-submitter case (so they can see why their report is
               missing this entry).
          VOID entries with a rejection reason render below — the
          message label flips between "Rejected" and "Withdrawn"
          based on the reason-text marker. */}
      {entry.status === "PENDING_APPROVAL" &&
        tenant &&
        canApproveJournalEntries(tenant.role) &&
        entry.submittedById !== currentUser?.id && (
          <ApprovalActions entryId={entry.id} entryNumber={entry.entryNumber} />
        )}
      {entry.status === "PENDING_APPROVAL" &&
        currentUser &&
        entry.submittedById === currentUser.id && (
          <WithdrawAction entryId={entry.id} entryNumber={entry.entryNumber} />
        )}
      {entry.status === "PENDING_APPROVAL" &&
        (!tenant || !canApproveJournalEntries(tenant.role)) &&
        entry.submittedById !== currentUser?.id && (
          <Card>
            <CardContent className="px-5 py-3 bg-amber-50">
              <div className="text-sm text-amber-800">
                This entry is awaiting approval from an admin. It will not
                appear in reports until approved.
              </div>
            </CardContent>
          </Card>
        )}
      {entry.status === "VOID" && entry.rejectionReason && (() => {
        // "Withdrawn:" prefix is the marker the withdrawal lifecycle
        // writes (in addition to submittedById === rejectedById). Use it
        // to flip the label + color from rejection-amber to neutral-ink.
        const wasWithdrawn = entry.rejectionReason.startsWith("Withdrawn");
        return (
          <Card>
            <CardContent
              className={`px-5 py-3 ${wasWithdrawn ? "bg-ink-50" : "bg-red-50"}`}
            >
              <div
                className={`text-sm font-medium ${wasWithdrawn ? "text-ink-900" : "text-red-900"}`}
              >
                {wasWithdrawn ? "Withdrawn by submitter" : "Rejected"}
              </div>
              <p
                className={`mt-1 text-xs whitespace-pre-wrap ${wasWithdrawn ? "text-ink-700" : "text-red-700"}`}
              >
                {entry.rejectionReason}
              </p>
              {entry.rejectedAt && (
                <p
                  className={`mt-1 text-[11px] ${wasWithdrawn ? "text-ink-500" : "text-red-600"}`}
                >
                  {wasWithdrawn ? "Withdrawn" : "Rejected"} on{" "}
                  {entry.rejectedAt.toISOString().slice(0, 10)}
                </p>
              )}
            </CardContent>
          </Card>
        );
      })()}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Field label="Entity" value={entry.entity.code} />
        <Field label="Book" value={entry.book.code} />
        <Field label="Document date" value={formatDate(entry.documentDate)} />
        <Field label="Posting date" value={formatDate(entry.postingDate)} />
        <Field label="Currency" value={`${entry.currency.code} (fx ${entry.fxRate.toString()})`} />
        {entry.sourceRecordId && (
          <Field label="Source record ID" value={entry.sourceRecordId} className="font-mono" />
        )}
        {entry.mappingVersion && <Field label="Mapping version" value={entry.mappingVersion} />}
        {entry.reversalOf && (
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wider text-ink-500">
              Reverses
            </div>
            <div className="mt-0.5 text-sm">
              <Link
                href={`/journal-entries/${entry.reversalOf.id}`}
                className="font-mono text-link hover:underline"
              >
                {entry.reversalOf.entryNumber}
              </Link>
            </div>
          </div>
        )}
        {entry.reversedBy.length > 0 && (
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wider text-ink-500">
              Reversed by
            </div>
            <div className="mt-0.5 text-sm">
              <Link
                href={`/journal-entries/${entry.reversedBy[0].id}`}
                className="font-mono text-link hover:underline"
              >
                {entry.reversedBy[0].entryNumber}
              </Link>
            </div>
          </div>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Lines ({entry.lines.length})</CardTitle>
          <div className="flex items-center gap-4 text-xs text-ink-500">
            <span>
              ΣDr <span className="amount-cell ml-1 text-ink-700">{formatMoney(totalDebit)}</span>
            </span>
            <span>
              ΣCr <span className="amount-cell ml-1 text-ink-700">{formatMoney(totalCredit)}</span>
            </span>
            <Badge tone={totalDebit.equals(totalCredit) ? "positive" : "negative"}>
              {totalDebit.equals(totalCredit) ? "balanced" : "unbalanced"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <THead>
              <tr>
                <TH>#</TH>
                <TH>Account</TH>
                <TH>Party</TH>
                <TH>Description</TH>
                <TH className="text-right">Debit</TH>
                <TH className="text-right">Credit</TH>
              </tr>
            </THead>
            <TBody>
              {entry.lines.map((line) => (
                <TR key={line.id}>
                  <TD className="text-ink-400">{line.lineNo}</TD>
                  <TD>
                    <span className="font-mono text-xs text-ink-700">{line.account.code}</span>
                    <span className="ml-2 text-ink-500">{line.account.name}</span>
                  </TD>
                  <TD>
                    {line.party ? (
                      <span className="text-xs">
                        <span className="font-mono text-ink-700">{line.party.code}</span>
                        <span className="ml-1 text-ink-500">— {line.party.displayName}</span>
                      </span>
                    ) : (
                      <span className="text-ink-400">—</span>
                    )}
                  </TD>
                  <TD className="text-ink-700">{line.description ?? "—"}</TD>
                  <TD className="amount-cell text-right">
                    {line.debit.toString() !== "0" ? formatMoney(line.debit.toString()) : ""}
                  </TD>
                  <TD className="amount-cell text-right">
                    {line.credit.toString() !== "0" ? formatMoney(line.credit.toString()) : ""}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </CardContent>
      </Card>

      <NotesCard
        entryId={entry.id}
        notes={entry.notes.map((n) => ({
          id: n.id,
          body: n.body,
          authorEmail: n.authorEmail,
          authorUserId: n.authorUserId,
          // Dates serialized to ISO strings for the client component.
          createdAt: n.createdAt.toISOString(),
          resolvedAt: n.resolvedAt ? n.resolvedAt.toISOString() : null,
          resolvedBy: n.resolvedBy,
        }))}
        currentUserId={currentUser?.id ?? null}
        currentUserIsAdmin={isAdmin(currentUser)}
      />

      {entry.sourcePayload && (
        <Card>
          <CardHeader>
            <CardTitle>Source payload (lineage)</CardTitle>
            <span className="text-xs text-ink-500">
              Frozen verbatim from {entry.sourceSystem ?? "the source"} on import.
            </span>
          </CardHeader>
          <CardContent>
            <pre className="overflow-x-auto rounded-md bg-ink-900 p-4 text-xs leading-relaxed text-ink-100">
              {JSON.stringify(entry.sourcePayload, null, 2)}
            </pre>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Field({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-wider text-ink-500">{label}</div>
      <div className={`mt-0.5 text-sm text-ink-800 ${className ?? ""}`}>{value}</div>
    </div>
  );
}
