// Approval queue — every PENDING_APPROVAL journal entry in the
// current tenant. The list is the maker-checker workflow's primary
// surface for the approver: see what's waiting + drill into details.
//
// Visible to MEMBER+ (everyone can SEE the queue). Approving + rejecting
// requires ADMIN+ and the Server Actions re-check.

import Link from "next/link";
import { Decimal } from "@/lib/utils/decimal";
import { prisma } from "@/lib/db";
import {
  getCurrentUser,
  NotAuthenticatedError,
} from "@/lib/auth/current-user";
import { getCurrentTenant } from "@/lib/auth/tenant";
import { canApproveJournalEntries } from "@/lib/auth/policy";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDate, formatMoney } from "@/lib/utils/format";

export default async function PendingApprovalPage() {
  const user = await getCurrentUser();
  if (!user) {
    return (
      <Card>
        <CardContent className="px-6 py-10 text-center">
          <h2 className="text-base font-semibold text-ink-900">
            Approval queue
          </h2>
          <p className="mt-1 text-sm text-ink-500">
            {new NotAuthenticatedError().message}
          </p>
        </CardContent>
      </Card>
    );
  }
  const tenant = await getCurrentTenant();
  if (!tenant) {
    return (
      <Card>
        <CardContent className="px-6 py-10 text-center">
          <h2 className="text-base font-semibold text-ink-900">
            Approval queue
          </h2>
          <p className="mt-1 text-sm text-ink-500">
            Pick a workspace first.
          </p>
        </CardContent>
      </Card>
    );
  }

  const isApprover = canApproveJournalEntries(tenant.role);

  const entries = await prisma.journalEntry.findMany({
    where: {
      tenantId: tenant.id,
      status: "PENDING_APPROVAL",
    },
    orderBy: { submittedAt: "asc" }, // oldest first — first-in-first-out
    include: {
      entity: { select: { code: true } },
      book: { select: { code: true } },
      lines: {
        select: {
          debit: true,
          credit: true,
        },
      },
    },
  });

  // Pull submitter emails in a single query. Avoids N+1 user lookups.
  const submitterIds = Array.from(
    new Set(entries.map((e) => e.submittedById).filter((v): v is string => !!v))
  );
  const submitters =
    submitterIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: submitterIds } },
          select: { id: true, email: true, displayName: true },
        })
      : [];
  const submitterById = new Map(submitters.map((u) => [u.id, u]));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold text-ink-900">Approval queue</h2>
        <p className="text-xs text-ink-500">
          Journal entries submitted by MEMBERs awaiting ADMIN approval. Sorted
          oldest first.{" "}
          {isApprover
            ? "Click an entry to review the lines, then approve or reject."
            : "View-only — you don't have approval permission in this workspace."}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            {entries.length} entr{entries.length === 1 ? "y" : "ies"} pending
          </CardTitle>
        </CardHeader>
        <CardContent className={entries.length === 0 ? "" : "p-0"}>
          {entries.length === 0 ? (
            <EmptyState
              title="No entries pending"
              description="The queue is empty — every submitted entry has been approved or rejected."
            />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Entry</TH>
                  <TH>Memo</TH>
                  <TH>Entity</TH>
                  <TH>Book</TH>
                  <TH>Date</TH>
                  <TH>Submitted by</TH>
                  <TH>Submitted</TH>
                  <TH className="text-right">Σ Dr</TH>
                </tr>
              </THead>
              <TBody>
                {entries.map((e) => {
                  const submitter = e.submittedById
                    ? submitterById.get(e.submittedById)
                    : null;
                  const totalDr = e.lines.reduce(
                    (acc, l) => acc.plus(new Decimal(l.debit.toString())),
                    new Decimal(0)
                  );
                  return (
                    <TR key={e.id}>
                      <TD>
                        <Link
                          href={`/journal-entries/${e.id}`}
                          className="font-mono text-xs text-ink-900 hover:underline"
                        >
                          {e.entryNumber}
                        </Link>
                      </TD>
                      <TD className="text-sm text-ink-700 max-w-md truncate" title={e.memo}>
                        {e.memo}
                      </TD>
                      <TD className="font-mono text-xs text-ink-600">{e.entity.code}</TD>
                      <TD className="font-mono text-xs text-ink-600">{e.book.code}</TD>
                      <TD className="text-xs text-ink-500">
                        {formatDate(e.documentDate)}
                      </TD>
                      <TD className="text-xs text-ink-700">
                        {submitter ? (
                          <span title={submitter.email}>{submitter.displayName}</span>
                        ) : (
                          <span className="text-ink-400">—</span>
                        )}
                      </TD>
                      <TD className="text-xs text-ink-500">
                        {e.submittedAt
                          ? `${Math.floor(
                              (Date.now() - e.submittedAt.getTime()) / (60 * 60 * 1000)
                            )}h ago`
                          : "—"}
                      </TD>
                      <TD className="amount-cell text-right">
                        {formatMoney(totalDr)}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {!isApprover && (
        <Card>
          <CardContent className="px-5 py-3">
            <div className="text-xs text-ink-500">
              You&rsquo;re viewing as <span className="font-mono">{tenant.role}</span>.
              Only ADMIN and OWNER can approve or reject entries.
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
