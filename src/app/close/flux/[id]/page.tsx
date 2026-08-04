// BlackLine arc — Phase 3 PR 3: flux statement detail page.
//
// /close/flux/[id] is where the controller works a single statement:
// review each material line, type commentary or click waive (admin),
// finalize when all material lines clear.
//
// Layout:
//   - Header (status + finalize button for admin)
//   - Statement meta (entity / book / period range / thresholds /
//     finalizer audit)
//   - Material lines section, urgency-descending:
//       NEEDS_COMMENT → EXPLAINED → WAIVED
//   - Immaterial lines disclosure (collapsed; "Show N immaterial lines")
//
// Per-row affordances:
//   IMMATERIAL  read-only — no commentary needed
//   NEEDS_COMMENT  inline CommentaryForm to record EXPLAINED
//                  + admin-only Waive button
//   EXPLAINED  shows commentary + author/timestamp; commentary can
//              be re-typed (calls the same action; latest wins)
//   WAIVED  shows the reason prefixed "WAIVED:"; admin can re-set
//           commentary if signoff status changes (rare)
//
// Statement FINALIZED → entire page read-only. The actions refuse
// at the Server layer too.

import { notFound } from "next/navigation";
import Link from "next/link";
import { Decimal } from "decimal.js";
import { prisma } from "@/lib/db";
import { getCurrentTenant, isTenantAdmin } from "@/lib/auth/tenant";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { formatDate, formatMoney } from "@/lib/utils/format";
import type { FluxLineStatus } from "@prisma/client";
import CommentaryForm from "./commentary-form";
import WaiveButton from "./waive-button";
import FinalizeButton from "./finalize-button";

const LINE_TONES: Record<
  FluxLineStatus,
  "neutral" | "positive" | "negative" | "warning" | "info"
> = {
  IMMATERIAL: "neutral",
  NEEDS_COMMENT: "negative",
  EXPLAINED: "positive",
  WAIVED: "neutral",
};

// Material section render order — urgency-descending so the controller
// lands on the gaps first.
const MATERIAL_ORDER: FluxLineStatus[] = [
  "NEEDS_COMMENT",
  "EXPLAINED",
  "WAIVED",
];

export default async function FluxDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const tenant = await getCurrentTenant();
  if (!tenant) return notFound();

  const stmt = await prisma.fluxStatement.findFirst({
    where: { id: params.id, tenantId: tenant.id },
    select: {
      id: true,
      status: true,
      absoluteThreshold: true,
      percentThreshold: true,
      finalizedAt: true,
      createdAt: true,
      updatedAt: true,
      entity: { select: { code: true, name: true } },
      book: { select: { code: true, name: true } },
      fromPeriod: { select: { code: true, endsOn: true } },
      toPeriod: { select: { code: true, endsOn: true } },
      finalizer: { select: { displayName: true, email: true } },
      lines: {
        select: {
          id: true,
          status: true,
          priorAmount: true,
          currentAmount: true,
          deltaAmount: true,
          deltaPercent: true,
          commentary: true,
          commentaryAt: true,
          account: { select: { code: true, name: true, type: true } },
          commenter: { select: { displayName: true } },
        },
        orderBy: { deltaAmount: "desc" },
      },
    },
  });
  if (!stmt) return notFound();

  const admin = isTenantAdmin(tenant);
  const finalized = stmt.status === "FINALIZED";

  // Hoist the line type once so the renderLineRow signature below
  // doesn't reference possibly-null `stmt` through `typeof`.
  type LineRow = (typeof stmt.lines)[number];
  const lines: LineRow[] = stmt.lines;

  // Group lines by status. We render material sections in
  // MATERIAL_ORDER so NEEDS_COMMENT is at the top.
  const byStatus: Record<FluxLineStatus, LineRow[]> = {
    IMMATERIAL: [],
    NEEDS_COMMENT: [],
    EXPLAINED: [],
    WAIVED: [],
  };
  for (const l of lines) byStatus[l.status].push(l);

  // Within each bucket, sort by abs(delta) DESC.
  for (const s of Object.keys(byStatus) as FluxLineStatus[]) {
    byStatus[s].sort((a, b) => {
      const ad = new Decimal(a.deltaAmount.toString()).abs();
      const bd = new Decimal(b.deltaAmount.toString()).abs();
      return bd.comparedTo(ad);
    });
  }

  const totalLines = lines.length;
  const materialLines =
    byStatus.NEEDS_COMMENT.length +
    byStatus.EXPLAINED.length +
    byStatus.WAIVED.length;
  const pendingCount = byStatus.NEEDS_COMMENT.length;

  function renderLineRow(line: LineRow) {
    const delta = new Decimal(line.deltaAmount.toString());
    const isOpen = line.status === "NEEDS_COMMENT" && !finalized;
    const isWaivable =
      admin &&
      !finalized &&
      (line.status === "NEEDS_COMMENT" || line.status === "EXPLAINED");
    return (
      <TR key={line.id}>
        <TD>
          <span className="font-mono text-xs">{line.account.code}</span>{" "}
          <span className="text-ink-700">{line.account.name}</span>
        </TD>
        <TD className="amount-cell text-right text-xs text-ink-700">
          {formatMoney(new Decimal(line.priorAmount.toString()))}
        </TD>
        <TD className="amount-cell text-right text-xs text-ink-700">
          {formatMoney(new Decimal(line.currentAmount.toString()))}
        </TD>
        <TD
          className={
            delta.abs().isZero()
              ? "amount-cell text-right text-xs text-ink-400"
              : "amount-cell text-right text-xs font-medium text-ink-900"
          }
        >
          {formatMoney(delta)}
        </TD>
        <TD className="text-right text-xs text-ink-500">
          {line.deltaPercent ? (
            `${new Decimal(line.deltaPercent.toString()).toFixed(1)}%`
          ) : (
            <span className="text-ink-400" title="Prior balance was zero">
              new
            </span>
          )}
        </TD>
        <TD>
          <Badge tone={LINE_TONES[line.status]}>{line.status}</Badge>
        </TD>
        <TD className="min-w-[260px] max-w-[360px]">
          {line.commentary ? (
            <div className="text-xs">
              <p className="whitespace-pre-wrap text-ink-800">
                {line.commentary}
              </p>
              {line.commenter?.displayName && (
                <div className="mt-0.5 text-[10px] text-ink-400">
                  {line.commenter.displayName}
                  {line.commentaryAt && ` · ${formatDate(line.commentaryAt)}`}
                </div>
              )}
              {isOpen && !finalized && (
                <div className="mt-2">
                  <CommentaryForm
                    lineId={line.id}
                    initialValue=""
                    placeholder="Replace with updated explanation..."
                  />
                </div>
              )}
            </div>
          ) : isOpen ? (
            <CommentaryForm lineId={line.id} initialValue="" />
          ) : line.status === "IMMATERIAL" ? (
            <span className="text-xs text-ink-400">
              below threshold — no commentary needed
            </span>
          ) : (
            <span className="text-xs text-ink-400">—</span>
          )}
        </TD>
        <TD>
          {isWaivable && (
            <WaiveButton
              lineId={line.id}
              accountName={line.account.name}
            />
          )}
        </TD>
      </TR>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <div className="text-xs text-ink-500">
          <Link
            href="/close/flux"
            className="text-accent-600 hover:underline"
          >
            ← All flux statements
          </Link>
        </div>
        <div className="flex items-center gap-3">
          <h1 className="font-display text-2xl font-bold tracking-tight text-ink-900">
            Flux: {stmt.entity.code} / {stmt.book.code}
          </h1>
          <Badge tone={finalized ? "positive" : "warning"}>
            {stmt.status}
          </Badge>
        </div>
        <p className="text-xs text-ink-500">
          <span className="font-mono">{stmt.fromPeriod.code}</span> (
          {formatDate(stmt.fromPeriod.endsOn)}) →{" "}
          <span className="font-mono">{stmt.toPeriod.code}</span> (
          {formatDate(stmt.toPeriod.endsOn)}) · Thresholds: $
          {stmt.absoluteThreshold.toString()} or{" "}
          {stmt.percentThreshold.toString()}%
        </p>
        {finalized && stmt.finalizer && (
          <p className="text-xs text-ink-500">
            Finalized by {stmt.finalizer.displayName}
            {stmt.finalizedAt && ` on ${formatDate(stmt.finalizedAt)}`}
          </p>
        )}
      </header>

      {/* Header summary card with finalize affordance */}
      <Card>
        <CardHeader>
          <CardTitle>
            {materialLines} material · {pendingCount} pending ·{" "}
            {totalLines - materialLines} immaterial
          </CardTitle>
          <span className="text-xs text-ink-500">
            {finalized
              ? "Statement is finalized — read-only"
              : pendingCount > 0
                ? "Explain or waive the material lines below before finalizing"
                : "All material lines cleared — admin can finalize"}
          </span>
        </CardHeader>
        {!finalized && admin && (
          <CardContent>
            <FinalizeButton
              statementId={stmt.id}
              disabled={pendingCount > 0}
              pendingHint={
                pendingCount > 0
                  ? `${pendingCount} line${pendingCount === 1 ? "" : "s"} still need commentary`
                  : undefined
              }
            />
          </CardContent>
        )}
      </Card>

      {/* Material sections */}
      {MATERIAL_ORDER.map((sectionStatus) => {
        const rows = byStatus[sectionStatus];
        if (rows.length === 0) return null;
        return (
          <Card key={sectionStatus}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Badge tone={LINE_TONES[sectionStatus]}>
                  {sectionStatus}
                </Badge>
                <span className="text-sm font-normal text-ink-700">
                  {rows.length} line{rows.length === 1 ? "" : "s"}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <THead>
                  <tr>
                    <TH>Account</TH>
                    <TH className="text-right">Prior</TH>
                    <TH className="text-right">Current</TH>
                    <TH className="text-right">Delta</TH>
                    <TH className="text-right">%</TH>
                    <TH>Status</TH>
                    <TH>Commentary</TH>
                    <TH></TH>
                  </tr>
                </THead>
                <TBody>{rows.map(renderLineRow)}</TBody>
              </Table>
            </CardContent>
          </Card>
        );
      })}

      {/* Immaterial disclosure */}
      {byStatus.IMMATERIAL.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>
              <Badge tone="neutral">IMMATERIAL</Badge>
              <span className="ml-2 text-sm font-normal text-ink-700">
                {byStatus.IMMATERIAL.length} line
                {byStatus.IMMATERIAL.length === 1 ? "" : "s"} below threshold
              </span>
            </CardTitle>
            <span className="text-xs text-ink-500">
              Click to show the full list — these don't require commentary
            </span>
          </CardHeader>
          <CardContent className="p-0">
            <details>
              <summary className="cursor-pointer px-4 py-2 text-sm text-accent-600 hover:underline">
                Show {byStatus.IMMATERIAL.length} immaterial lines
              </summary>
              <Table>
                <THead>
                  <tr>
                    <TH>Account</TH>
                    <TH className="text-right">Prior</TH>
                    <TH className="text-right">Current</TH>
                    <TH className="text-right">Delta</TH>
                    <TH className="text-right">%</TH>
                    <TH>Status</TH>
                    <TH>Commentary</TH>
                    <TH></TH>
                  </tr>
                </THead>
                <TBody>{byStatus.IMMATERIAL.map(renderLineRow)}</TBody>
              </Table>
            </details>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
