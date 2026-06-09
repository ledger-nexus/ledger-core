// BlackLine arc — Phase 1 PR 4: Reconciliation detail page.
//
// /close/reconciliations/[id] wires the entire state machine from PR 2
// to real UI. A controller lands here from the list page and:
//
//   - sees the GL balance the trial-balance is showing for this account
//   - types the supporting balance from their workpaper / bank statement
//   - adds notes (the "why" — the audit trail demands an explanation
//     when GL ≠ supporting)
//   - signs off as preparer → status advances per the cascade
//   - a different user signs off as reviewer (strict segregation),
//     OR sends it back with a comment for re-prep,
//     OR an admin waives it for the period
//
// The detail page is read-mostly. The interactive forms are tiny client
// components below the page (preparer-form.tsx, reviewer-actions.tsx,
// waive-button.tsx). Each calls one Server Action and lets Next.js's
// revalidatePath refresh the page.
//
// Server-side enforcement matrix lives in the Server Actions; the UI's
// job is to render the right affordances for the current user/state:
//
//   Status         Preparer (user.id != preparedBy)   Reviewer
//   ─────────────────────────────────────────────────────────────
//   OPEN           Form: Supporting + notes →         (waits for prep)
//                  markPrepared
//   IN_PROGRESS    same form (re-prep after           (waits)
//                  send-back)
//   PREPARED       —                                   Approve · Send back ·
//                                                      Mark exception
//   RECONCILED     read-only                          read-only
//   EXCEPTION      same form (re-prep with new         Approve (if now within
//                  numbers can clear the exception)    tolerance) · Mark
//                                                      exception persists
//   WAIVED         read-only                          read-only
//
// The single-sign-off case (requiresReview=false) is handled at the
// Server Action layer — markPrepared with within-tolerance + !requiresReview
// jumps straight to RECONCILED. From the UI's perspective there's no
// "approve" button in that mode because there's no PREPARED state to
// approve from.

import { notFound } from "next/navigation";
import Link from "next/link";
import { Decimal } from "decimal.js";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getCurrentTenant, isTenantAdmin } from "@/lib/auth/tenant";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDate, formatMoney } from "@/lib/utils/format";
import type { ReconStatus } from "@prisma/client";
import { resolveSupportingBalance } from "@/lib/recon/supporting-balance";
import PreparerForm from "./preparer-form";
import ReviewerActions from "./reviewer-actions";
import WaiveButton from "./waive-button";
import UploadForm from "./upload-form";
import AttachmentRow from "./attachment-row";

const STATUS_TONES: Record<
  ReconStatus,
  "neutral" | "positive" | "negative" | "warning" | "info"
> = {
  OPEN: "neutral",
  IN_PROGRESS: "info",
  PREPARED: "warning",
  RECONCILED: "positive",
  EXCEPTION: "negative",
  WAIVED: "neutral",
};

// Statuses where the preparer form is the affordance. EXCEPTION is in
// this list because the resolution path is "re-prep with corrected
// numbers" — re-typing the supporting balance and clicking sign brings
// it back to PREPARED (or RECONCILED if it now ties).
const PREPARER_STATUSES: ReconStatus[] = ["OPEN", "IN_PROGRESS", "EXCEPTION"];
// Statuses where the reviewer actions show. Only PREPARED — that's the
// state machine's contract.
const REVIEWER_STATUSES: ReconStatus[] = ["PREPARED"];
// Terminal statuses — no edits, no actions. Just history.
const TERMINAL_STATUSES: ReconStatus[] = ["RECONCILED", "WAIVED"];

export default async function ReconciliationDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const user = await getCurrentUser();
  const tenant = await getCurrentTenant();
  if (!user || !tenant) {
    return notFound();
  }

  const recon = await prisma.reconciliation.findFirst({
    where: { id: params.id, tenantId: tenant.id },
    select: {
      id: true,
      status: true,
      requiresReview: true,
      glBalance: true,
      supportingBalance: true,
      reconciledDiff: true,
      tolerance: true,
      notes: true,
      preparedBy: true,
      preparedAt: true,
      reviewedBy: true,
      reviewedAt: true,
      createdAt: true,
      updatedAt: true,
      entityId: true,
      bookId: true,
      periodId: true,
      accountId: true,
      account: { select: { code: true, name: true, type: true } },
      entity: { select: { code: true, name: true } },
      book: { select: { code: true, name: true } },
      period: {
        select: { code: true, startsOn: true, endsOn: true },
      },
      preparer: { select: { id: true, displayName: true, email: true } },
      reviewer: { select: { id: true, displayName: true, email: true } },
      attachments: {
        select: {
          id: true,
          filename: true,
          contentType: true,
          sizeBytes: true,
          uploadedAt: true,
          uploadedById: true,
          uploader: { select: { displayName: true } },
        },
        orderBy: { uploadedAt: "desc" },
      },
    },
  });

  if (!recon) return notFound();

  const admin = isTenantAdmin(tenant);
  const isPreparer = recon.preparedBy === user.id;
  const showPreparerForm = PREPARER_STATUSES.includes(recon.status);
  // Reviewer affordances only show for PREPARED, and only when the
  // viewer is NOT the same user as the preparer (mirrors the Server
  // Action's SoD enforcement — render the affordance as enabled or
  // disabled accordingly so the user doesn't get a surprise rejection).
  const showReviewerActions =
    REVIEWER_STATUSES.includes(recon.status) && !isPreparer;
  const isTerminal = TERMINAL_STATUSES.includes(recon.status);

  // Compute diff for display. supportingBalance is nullable (OPEN status
  // hasn't been touched). reconciledDiff is the persisted snapshot from
  // the last markPrepared; we render that for terminal statuses, and
  // compute live for in-progress.
  const gl = new Decimal(recon.glBalance.toString());
  const supporting = recon.supportingBalance
    ? new Decimal(recon.supportingBalance.toString())
    : null;
  const diff = recon.reconciledDiff
    ? new Decimal(recon.reconciledDiff.toString())
    : supporting
      ? gl.minus(supporting)
      : null;
  const tolerance = new Decimal(recon.tolerance.toString());
  const overTolerance = diff ? diff.abs().greaterThan(tolerance) : false;

  // Sub-ledger auto-pull suggestion. Only computed for statuses where
  // the preparer form will show (no point pulling for RECONCILED/WAIVED).
  // The form decides whether to USE the suggestion as the default; we
  // just expose it.
  const suggestion = PREPARER_STATUSES.includes(recon.status)
    ? await resolveSupportingBalance(prisma, {
        tenantId: tenant.id,
        entityId: recon.entityId,
        bookId: recon.bookId,
        accountId: recon.accountId,
        asOf: recon.period.endsOn,
      })
    : null;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <div className="text-xs text-ink-500">
          <Link
            href={`/close/reconciliations?period=${recon.period.code}`}
            className="text-accent-600 hover:underline"
          >
            ← All reconciliations
          </Link>
        </div>
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-ink-900">
            <span className="font-mono text-base">{recon.account.code}</span>{" "}
            {recon.account.name}
          </h1>
          <Badge tone={STATUS_TONES[recon.status]}>{recon.status}</Badge>
          {!recon.requiresReview && (
            <Badge tone="neutral" title="Single sign-off">1-sig</Badge>
          )}
          {overTolerance && !isTerminal && (
            <Badge tone="negative">over tolerance</Badge>
          )}
        </div>
        <p className="text-xs text-ink-500">
          {recon.entity.code} · {recon.book.code} ·{" "}
          <span className="font-mono">{recon.period.code}</span> (
          {formatDate(recon.period.startsOn)} →{" "}
          {formatDate(recon.period.endsOn)})
        </p>
      </header>

      {/* Numbers panel — the CPA reads this first. Side-by-side so the
          eye lands on the diff immediately. */}
      <Card>
        <CardHeader>
          <CardTitle>Tie-out</CardTitle>
          <span className="text-xs text-ink-500">
            Tolerance ${tolerance.toFixed(2)}
            {tolerance.isZero() ? " (strict tie-out)" : ""}
          </span>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-6 text-sm">
            <div>
              <div className="text-xs uppercase tracking-wide text-ink-500">
                GL balance
              </div>
              <div className="amount-cell mt-1 text-lg text-ink-900">
                {formatMoney(gl)}
              </div>
              <div className="mt-1 text-xs text-ink-400">
                from trial balance for {recon.account.code}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-ink-500">
                Supporting balance
              </div>
              <div className="amount-cell mt-1 text-lg text-ink-900">
                {supporting ? (
                  formatMoney(supporting)
                ) : (
                  <span className="text-ink-400">—</span>
                )}
              </div>
              <div className="mt-1 text-xs text-ink-400">
                {supporting
                  ? "preparer's certified number"
                  : "not yet filed"}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-ink-500">
                Diff (GL − supporting)
              </div>
              <div
                className={
                  overTolerance
                    ? "amount-cell mt-1 text-lg font-semibold text-red-700"
                    : "amount-cell mt-1 text-lg text-ink-900"
                }
              >
                {diff ? (
                  formatMoney(diff)
                ) : (
                  <span className="text-ink-400">—</span>
                )}
              </div>
              <div className="mt-1 text-xs text-ink-400">
                {diff
                  ? overTolerance
                    ? "outside tolerance → EXCEPTION on sign"
                    : "within tolerance → eligible to reconcile"
                  : "type a supporting balance to compute"}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Sign-off panel. Branches on status + role. */}
      {showPreparerForm && (
        <Card>
          <CardHeader>
            <CardTitle>
              {recon.status === "OPEN"
                ? "Prepare"
                : recon.status === "IN_PROGRESS"
                  ? "Re-prepare (sent back)"
                  : "Re-prepare (exception)"}
            </CardTitle>
            <span className="text-xs text-ink-500">
              {recon.requiresReview
                ? "Sign as preparer → status PREPARED → reviewer signs"
                : "Sign as preparer → status RECONCILED (single sign-off)"}
            </span>
          </CardHeader>
          <CardContent>
            <PreparerForm
              reconId={recon.id}
              glBalance={gl.toString()}
              defaultSupporting={
                supporting ? supporting.toString() : ""
              }
              defaultNotes={recon.notes ?? ""}
              suggestion={
                suggestion && suggestion.amount
                  ? {
                      amount: suggestion.amount.toFixed(2),
                      label: suggestion.label,
                    }
                  : null
              }
            />
          </CardContent>
        </Card>
      )}

      {showReviewerActions && (
        <Card>
          <CardHeader>
            <CardTitle>Review</CardTitle>
            <span className="text-xs text-ink-500">
              Prepared by{" "}
              <span className="font-medium">
                {recon.preparer?.displayName ?? "—"}
              </span>{" "}
              on {recon.preparedAt ? formatDate(recon.preparedAt) : "—"}
            </span>
          </CardHeader>
          <CardContent>
            <ReviewerActions reconId={recon.id} />
          </CardContent>
        </Card>
      )}

      {/* Same-user-as-preparer cannot review. Spell out why so the user
          isn't confused by the missing Approve button. */}
      {recon.status === "PREPARED" && isPreparer && (
        <Card>
          <CardContent className="text-sm text-ink-500">
            You prepared this reconciliation. A different user must sign as
            reviewer (strict segregation of duties).
          </CardContent>
        </Card>
      )}

      {/* Waive — admin only, any status. The reason is mandatory and
          lands in the audit row. */}
      {admin && !isTerminal && (
        <Card>
          <CardHeader>
            <CardTitle>Admin: waive</CardTitle>
            <span className="text-xs text-ink-500">
              Mark this account as not requiring reconciliation for this
              period. Reason persists to the audit log.
            </span>
          </CardHeader>
          <CardContent>
            <WaiveButton reconId={recon.id} accountCode={recon.account.code} />
          </CardContent>
        </Card>
      )}

      {/* Lifecycle history — read from the row's denormalized fields.
          Comments (send-back, exception) land in audit_log per PR 2's
          design; a dedicated comment panel ships in a later PR. */}
      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-y-2 text-sm">
            <dt className="text-ink-500">Opened</dt>
            <dd className="text-ink-700">{formatDate(recon.createdAt)}</dd>
            {recon.preparedAt && (
              <>
                <dt className="text-ink-500">Prepared</dt>
                <dd className="text-ink-700">
                  {formatDate(recon.preparedAt)} ·{" "}
                  {recon.preparer?.displayName ?? "—"}
                </dd>
              </>
            )}
            {recon.reviewedAt && (
              <>
                <dt className="text-ink-500">Reviewed</dt>
                <dd className="text-ink-700">
                  {formatDate(recon.reviewedAt)} ·{" "}
                  {recon.reviewer?.displayName ?? "—"}
                </dd>
              </>
            )}
            <dt className="text-ink-500">Last updated</dt>
            <dd className="text-ink-700">{formatDate(recon.updatedAt)}</dd>
          </dl>
          {recon.notes && (
            <div className="mt-4 border-t border-ink-100 pt-4">
              <div className="text-xs uppercase tracking-wide text-ink-500">
                Preparer notes
              </div>
              <p className="mt-1 whitespace-pre-wrap text-sm text-ink-700">
                {recon.notes}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Attachments — upload form + per-row download + uploader/admin
          delete. Bytes live in BYTEA, auth-gated download route writes
          a DATA_EXPORT audit row on each pull. */}
      <Card>
        <CardHeader>
          <CardTitle>
            Attachments ({recon.attachments.length})
          </CardTitle>
          <span className="text-xs text-ink-500">
            Bank statement screenshots, sub-ledger reports, anything backing
            the certified number.
          </span>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {recon.attachments.length === 0 ? (
            <p className="text-sm text-ink-500">
              No supporting documents attached yet.
            </p>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {recon.attachments.map((a) => {
                // Delete is allowed for the uploader or for any tenant
                // admin. Server-side `deleteAttachment` re-checks; the
                // page-level gate is presentational — non-deletable
                // rows hide the button rather than tease.
                const canDelete = admin || a.uploadedById === user.id;
                return (
                  <AttachmentRow
                    key={a.id}
                    reconId={recon.id}
                    attachment={a}
                    canDelete={canDelete}
                  />
                );
              })}
            </ul>
          )}
          <div className="border-t border-ink-100 pt-4">
            <UploadForm reconId={recon.id} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
