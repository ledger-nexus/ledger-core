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
import { getCurrentUser } from "@/lib/auth/current-user";
import { getCurrentTenant } from "@/lib/auth/tenant";
import {
  canModerateNotes,
  canApproveJournalEntries,
  canPostJournalEntries,
} from "@/lib/auth/policy";
import { ApprovalActions } from "./approval-actions";
import { WithdrawAction } from "./withdraw-action";
import { formatDate, formatMoney } from "@/lib/utils/format";
import { getEntryLineage } from "@/lib/accounting/lineage";
import { resolveApprovalRoute } from "@/lib/accounting/approval-threshold";
import {
  IC_SUBTYPE_PAIR,
  IC_MIRROR_SOURCE_SYSTEM,
  IC_MIRROR_RECORD_TYPE,
  findMirrorOfEntry,
} from "@/lib/accounting/intercompany";
import ReverseButton from "./reverse-button";
import NotesCard from "./notes-card";
import PrepareMirrorButton from "./prepare-mirror-button";

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
      lines: {
        include: {
          account: { select: { code: true, name: true, subtype: true } },
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

  // Correction / reversal lineage — what this entry reverses or corrects, and
  // what reverses or corrects it. Scoped to the entry's own tenant.
  const lineage = await getEntryLineage(prisma, {
    tenantId: entry.tenantId,
    entryId: entry.id,
  });

  const totalDebit = entry.lines.reduce(
    (acc, l) => acc.plus(new Decimal(l.debit.toString())),
    new Decimal(0)
  );
  const totalCredit = entry.lines.reduce(
    (acc, l) => acc.plus(new Decimal(l.credit.toString())),
    new Decimal(0)
  );

  // ---- Intercompany pairing state ---------------------------------------
  // A mirror knows its source via lineage; a source with IC-subtype lines
  // gets the pairing card (link to the mirror if one exists, otherwise
  // the prepare affordance with a mechanical preview of the derivation).
  const isMirror =
    entry.sourceSystem === IC_MIRROR_SOURCE_SYSTEM &&
    entry.sourceRecordType === IC_MIRROR_RECORD_TYPE;
  const mirrorSource =
    isMirror && entry.sourceRecordId
      ? await prisma.journalEntry.findFirst({
          where: { id: entry.sourceRecordId, tenantId: entry.tenantId },
          select: { id: true, entryNumber: true, entity: { select: { code: true } } },
        })
      : null;
  const icLines = entry.lines.filter(
    (l) => l.account.subtype && IC_SUBTYPE_PAIR[l.account.subtype]
  );
  const existingMirror =
    !isMirror && icLines.length > 0
      ? await findMirrorOfEntry(prisma, { tenantId: entry.tenantId, entryId: entry.id })
      : null;
  const showPrepareCard =
    !isMirror && icLines.length > 0 && entry.status === "POSTED" && !existingMirror;
  let counterpartyOptions: { code: string; name: string }[] = [];
  let mirrorPostsDirectly = false;
  if (showPrepareCard && tenant) {
    const siblings = await prisma.legalEntity.findMany({
      where: { tenantId: entry.tenantId, id: { not: entry.entityId } },
      select: { code: true, name: true },
      orderBy: { code: "asc" },
    });
    counterpartyOptions = siblings;
    // Same routing the mirror will actually take, so the button label
    // ("Post" vs "Submit for approval") never lies.
    const tenantConfig = await prisma.tenant.findUnique({
      where: { id: entry.tenantId },
      select: { requireJeApproval: true, jeApprovalMinAmount: true },
    });
    mirrorPostsDirectly =
      resolveApprovalRoute({
        requireJeApproval: tenantConfig?.requireJeApproval ?? false,
        jeApprovalMinAmount: tenantConfig?.jeApprovalMinAmount
          ? new Decimal(tenantConfig.jeApprovalMinAmount.toString())
          : null,
        entryTotal: totalDebit,
        actorIsApprover: canApproveJournalEntries(tenant.role),
      }) === "POSTED";
  }

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
                entry.status === "PENDING_APPROVAL"
                  ? "warning"
                  : entry.status === "VOID"
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
              reversedByEntryNumber={lineage?.reversedBy[0]?.entryNumber}
            />
            <a href={`/api/journal-entries/${entry.id}/csv`} download>
              <Button size="sm" variant="ghost">
                Export CSV
              </Button>
            </a>
          </div>
        </div>
      </div>

      {/* Maker-checker panel. Approvers who are NOT the submitter get the
          approve/reject controls (separation of duties — the server
          re-checks); the submitter gets withdraw; everyone else sees why
          the entry has no ledger effect yet. */}
      {entry.status === "PENDING_APPROVAL" && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <div className="text-sm font-medium text-amber-900">
            Awaiting approval — this entry has no ledger effect until an
            approver posts it.
          </div>
          <div className="mt-3">
            {tenant &&
            canApproveJournalEntries(tenant.role) &&
            entry.submittedById !== currentUser?.id ? (
              <ApprovalActions entryId={entry.id} entryNumber={entry.entryNumber} />
            ) : entry.submittedById === currentUser?.id ? (
              <WithdrawAction entryId={entry.id} entryNumber={entry.entryNumber} />
            ) : (
              <p className="text-xs text-amber-800">
                An ADMIN or OWNER (other than the submitter) can approve or
                reject it.
              </p>
            )}
          </div>
        </div>
      )}
      {entry.status === "VOID" && entry.rejectionReason && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">
          <span className="font-medium">
            {entry.rejectionReason.startsWith("Withdrawn")
              ? "Withdrawn by submitter"
              : "Rejected"}
            :
          </span>{" "}
          {entry.rejectionReason}
        </div>
      )}

      {isMirror && (
        <div className="rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-900">
          <span className="font-medium">Intercompany mirror</span> — the
          counterparty half of{" "}
          {mirrorSource ? (
            <>
              <Link
                href={`/journal-entries/${mirrorSource.id}`}
                className="font-mono text-link hover:underline"
              >
                {mirrorSource.entryNumber}
              </Link>{" "}
              ({mirrorSource.entity.code})
            </>
          ) : (
            <span className="font-mono">{entry.sourceRecordId}</span>
          )}
          . Lines are subtype-paired and side-flipped from the source.
        </div>
      )}

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
        {lineage?.reverses && (
          <LineageField label="Reverses" nodes={[lineage.reverses]} />
        )}
        {lineage && lineage.reversedBy.length > 0 && (
          <LineageField label="Reversed by" nodes={lineage.reversedBy} />
        )}
        {lineage?.corrects && (
          <LineageField label="Corrects" nodes={[lineage.corrects]} />
        )}
        {lineage && lineage.correctedBy.length > 0 && (
          <LineageField label="Corrected by" nodes={lineage.correctedBy} />
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

      {(existingMirror || showPrepareCard) && (
        <Card>
          <CardHeader>
            <CardTitle>Intercompany</CardTitle>
            <span className="text-xs text-ink-500">
              {icLines.length} intercompany line{icLines.length === 1 ? "" : "s"} on this entry
            </span>
          </CardHeader>
          <CardContent>
            {existingMirror ? (
              <p className="text-sm text-ink-700">
                Mirror{" "}
                <Link
                  href={`/journal-entries/${existingMirror.id}`}
                  className="font-mono text-link hover:underline"
                >
                  {existingMirror.entryNumber}
                </Link>{" "}
                in <span className="font-mono">{existingMirror.entityCode}</span>{" "}
                <Badge
                  tone={
                    existingMirror.status === "PENDING_APPROVAL"
                      ? "warning"
                      : existingMirror.status === "VOID"
                        ? "negative"
                        : "positive"
                  }
                >
                  {existingMirror.status}
                </Badge>
                {existingMirror.status === "VOID" && (
                  <span className="ml-2 text-xs text-ink-500">
                    The prepared mirror was rejected — that decision stands; post the
                    counterparty half manually if it is still needed.
                  </span>
                )}
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                {/* Mechanical preview — counterparty-independent: the
                    subtype pairing and side flip are fixed; only the
                    account CODE resolves per counterparty (or refuses). */}
                <ul className="flex flex-col gap-1 text-xs text-ink-600">
                  {entry.lines.map((l) => {
                    const paired = l.account.subtype
                      ? IC_SUBTYPE_PAIR[l.account.subtype]
                      : undefined;
                    const debit = new Decimal(l.debit.toString());
                    const isDebit = debit.greaterThan(0);
                    const amount = isDebit ? l.debit.toString() : l.credit.toString();
                    return (
                      <li key={l.id} className="font-mono">
                        {l.account.code} {isDebit ? "DR" : "CR"} {formatMoney(amount)} →{" "}
                        {paired ? (
                          <>
                            counterparty {paired} {isDebit ? "CR" : "DR"} {formatMoney(amount)}
                          </>
                        ) : (
                          <span className="text-red-600">
                            no intercompany subtype — blocks the mirror
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {tenant && canPostJournalEntries(tenant.role) ? (
                  counterpartyOptions.length > 0 ? (
                    <PrepareMirrorButton
                      sourceEntryId={entry.id}
                      counterpartyOptions={counterpartyOptions}
                      postsDirectly={mirrorPostsDirectly}
                    />
                  ) : (
                    <p className="text-xs text-ink-500">
                      This tenant has no other entity to mirror into.
                    </p>
                  )
                ) : (
                  <p className="text-xs text-ink-500">
                    Preparing the mirror posts a journal entry — a MEMBER or above can
                    do it.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

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
        currentUserIsAdmin={canModerateNotes(tenant?.role)}
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

// Renders one lineage relationship (Reverses / Reversed by / Corrects /
// Corrected by) as a labeled list of links to the related entries.
function LineageField({
  label,
  nodes,
}: {
  label: string;
  nodes: { id: string; entryNumber: string }[];
}) {
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-wider text-ink-500">{label}</div>
      <div className="mt-0.5 flex flex-col gap-0.5 text-sm">
        {nodes.map((n) => (
          <Link
            key={n.id}
            href={`/journal-entries/${n.id}`}
            className="font-mono text-link hover:underline"
          >
            {n.entryNumber}
          </Link>
        ))}
      </div>
    </div>
  );
}
