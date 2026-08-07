// FX revaluation report (ASC 830 / IAS 21).
//
// Read-only preview of the unrealized FX gain/loss on the scope's
// foreign-currency monetary balances at a period-end CLOSE rate, plus a
// tenant-admin "Post revaluation" action. The preview uses
// computeRevaluation (pure); posting goes through the human-gated
// Server Action → postRevaluation (source=AI_APPROVED). Once posted, the
// page shows the adjustment entry number and disables the button — the
// post is idempotent, so a re-click is a safe no-op regardless.

import Link from "next/link";
import { prisma } from "@/lib/db";
import { getCurrentScope } from "@/lib/scope";
import { getCurrentTenant, isTenantAdmin } from "@/lib/auth/tenant";
import { computeRevaluation } from "@/lib/accounting/revaluation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatMoney } from "@/lib/utils/format";
import PostRevaluationButton from "./post-revaluation-button";

export default async function FxRevaluationPage({
  searchParams,
}: {
  searchParams: { period?: string };
}) {
  const scope = await getCurrentScope();
  if (!scope) {
    return (
      <EmptyState
        title="No scope available"
        description="Sign in and select a tenant with at least one entity before viewing FX revaluation."
      />
    );
  }

  const tenant = await getCurrentTenant();
  const admin = tenant ? isTenantAdmin(tenant) : false;

  // Periods for this entity's calendar, newest first.
  const periods = await prisma.period.findMany({
    where: { tenantId: scope.tenantId, calendar: { entityId: scope.entityId } },
    orderBy: [{ startsOn: "desc" }],
    select: { code: true },
  });
  const periodCode =
    searchParams.period && periods.some((p) => p.code === searchParams.period)
      ? searchParams.period
      : periods[0]?.code;

  if (!periodCode) {
    return (
      <EmptyState
        title="No periods"
        description="This entity has no fiscal periods yet. Seed a calendar before running FX revaluation."
      />
    );
  }

  // Compute the preview. computeRevaluation throws FxRateNotFoundError if
  // a CLOSE rate is missing for a held currency — surface that cleanly
  // rather than 500'ing the page.
  let computed;
  let computeError: string | null = null;
  try {
    computed = await computeRevaluation(prisma, {
      tenantId: scope.tenantId,
      entityCode: scope.entityCode,
      bookCode: scope.bookCode,
      periodCode,
    });
  } catch (e) {
    computeError = e instanceof Error ? e.message : "Could not compute revaluation";
  }

  // Already-posted probe: the lineage triple from postRevaluation.
  const lineageId = `${scope.entityCode}-${scope.bookCode}-${periodCode}`;
  const existing = await prisma.journalEntry.findFirst({
    where: {
      tenantId: scope.tenantId,
      sourceSystem: "FX_REVAL",
      sourceRecordType: "MonetaryRevaluation",
      sourceRecordId: lineageId,
    },
    select: { entryNumber: true },
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-semibold text-ink-900">FX revaluation</h2>
          <p className="text-sm text-ink-500">
            {scope.entityCode} / {scope.bookCode} · period{" "}
            <span className="font-mono">{periodCode}</span> · ASC 830 / IAS 21
            monetary-item remeasurement at the period-end CLOSE rate
          </p>
        </div>
        <form method="GET" className="flex items-end gap-2 flex-wrap">
          <div className="flex flex-col gap-1">
            <label htmlFor="period" className="text-xs font-medium text-ink-600">
              Period
            </label>
            <select
              name="period"
              id="period"
              defaultValue={periodCode}
              className="h-9 rounded-md border border-ink-200 bg-white px-2 text-sm"
            >
              {periods.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.code}
                </option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            className="h-9 rounded-md bg-ink-900 px-4 text-sm font-medium text-white hover:bg-ink-800"
          >
            Run
          </button>
        </form>
      </div>

      {computeError ? (
        <Card>
          <CardContent className="px-4 py-3">
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              {computeError}
            </div>
            <p className="mt-2 text-xs text-ink-500">
              Seed a CLOSE rate for the held currency (admin → FX rates) and
              re-run. Revaluation refuses to run at a stale or assumed rate.
            </p>
          </CardContent>
        </Card>
      ) : computed && computed.lines.length === 0 ? (
        <EmptyState
          title="No foreign-currency monetary balances"
          description={`Every monetary balance for ${scope.entityCode} / ${scope.bookCode} as of ${computed.asOf.toISOString().slice(0, 10)} is already in ${computed.reportingCurrency}. Nothing to revalue.`}
        />
      ) : computed ? (
        <>
          {/* Summary + post action */}
          <Card>
            <CardHeader>
              <CardTitle>
                Net unrealized FX gain/(loss):{" "}
                <span
                  className={
                    computed.totalUnrealizedGainLoss.isNegative()
                      ? "text-negative"
                      : "text-positive"
                  }
                >
                  {formatMoney(computed.totalUnrealizedGainLoss.toString())}{" "}
                  {computed.reportingCurrency}
                </span>
              </CardTitle>
              <span className="text-xs text-ink-500">
                as of {computed.asOf.toISOString().slice(0, 10)}
              </span>
            </CardHeader>
            <CardContent>
              {existing ? (
                <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                  Posted as{" "}
                  <Link
                    href="/journal-entries"
                    className="font-mono font-medium underline"
                  >
                    {existing.entryNumber}
                  </Link>{" "}
                  (with an auto-reversal dated the first day of next period).
                  Re-posting is a safe no-op.
                </div>
              ) : admin ? (
                <PostRevaluationButton periodCode={periodCode} />
              ) : (
                <p className="text-xs text-ink-500">
                  Only a tenant admin can post the revaluation entry.
                </p>
              )}
            </CardContent>
          </Card>

          {/* Per-account detail */}
          <Card>
            <CardHeader>
              <CardTitle>Revalued monetary balances</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <THead>
                  <tr>
                    <TH>Account</TH>
                    <TH>Source</TH>
                    <TH>Ccy</TH>
                    <TH className="text-right">Foreign balance</TH>
                    <TH className="text-right">Carrying ({computed.reportingCurrency})</TH>
                    <TH className="text-right">CLOSE rate</TH>
                    <TH className="text-right">Revalued</TH>
                    <TH className="text-right">Gain/(loss)</TH>
                  </tr>
                </THead>
                <TBody>
                  {computed.lines.map((l) => (
                    <TR key={`${l.accountCode}-${l.currency}`}>
                      <TD>
                        <div className="text-ink-900">{l.accountName}</div>
                        <div className="font-mono text-[11px] text-ink-500">
                          {l.accountCode}
                        </div>
                      </TD>
                      <TD>
                        <Badge tone={l.source === "GL" ? "neutral" : "info"}>
                          {l.source === "GL"
                            ? "GL"
                            : l.source === "AR_SUBLEDGER"
                              ? "AR"
                              : "AP"}
                        </Badge>
                      </TD>
                      <TD className="font-mono text-xs">{l.currency}</TD>
                      <TD className="amount-cell text-right text-ink-700">
                        {formatMoney(l.foreignBalance.toString())}
                      </TD>
                      <TD className="amount-cell text-right text-ink-500">
                        {formatMoney(l.carryingReportingBalance.toString())}
                      </TD>
                      <TD className="amount-cell text-right font-mono text-xs text-ink-500">
                        {l.closeRate.toFixed(4)}
                        {l.closeRateInverted ? " ⁻¹" : ""}
                      </TD>
                      <TD className="amount-cell text-right text-ink-700">
                        {formatMoney(l.revaluedReportingBalance.toString())}
                      </TD>
                      <TD
                        className={
                          "amount-cell text-right font-semibold " +
                          (l.unrealizedGainLoss.isNegative()
                            ? "text-negative"
                            : "text-positive")
                        }
                      >
                        {formatMoney(l.unrealizedGainLoss.toString())}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
              <p className="mt-3 text-[11px] text-ink-500">
                AR/AP rows revalue from the GL at the period-end CLOSE rate;
                open-item detail (per invoice) backs the figure. Cash and
                intercompany revalue from the GL balance directly. The
                adjustment posts in {computed.reportingCurrency} and reverses
                on the first day of next period.
              </p>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
