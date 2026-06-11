// BlackLine arc — Phase 3 PR 3: Flux statement list page.
//
// /close/flux lists every FluxStatement the tenant has generated. The
// controller's workflow: generate a statement for (this period vs
// last period), explain or waive every material line, finalize. This
// page surfaces all in-flight statements with their pending counts
// so the controller's eye lands on what still needs work.
//
// Layout (top to bottom):
//   - Header
//   - "Generate new statement" CTA card (form opens a Server Action)
//   - Existing statements table, FINALIZED rows muted at the bottom
//
// URL params: none (tenant-scoped; statement filtering is on the
// detail page).

import Link from "next/link";
import { prisma } from "@/lib/db";
import { getCurrentTenant } from "@/lib/auth/tenant";
import { tenantScopeOrNone } from "@/lib/db-sentinels";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDate } from "@/lib/utils/format";
import type { FluxStatementStatus } from "@prisma/client";
import GenerateForm from "./generate-form";

const STATUS_TONES: Record<
  FluxStatementStatus,
  "neutral" | "positive" | "negative" | "warning" | "info"
> = {
  DRAFT: "warning",
  FINALIZED: "positive",
};

export default async function FluxListPage() {
  const tenant = await getCurrentTenant();
  const tenantFilter = tenantScopeOrNone(tenant?.id);

  if (!tenant) {
    return (
      <EmptyState
        title="No tenant resolved"
        description="Sign in and pick a tenant."
      />
    );
  }

  // Statements + per-statement rollup counts. The rollup walks
  // groupBy(status) per statement; we do one query across all
  // statements and bucket in JS for the badge column.
  const statements = await prisma.fluxStatement.findMany({
    where: { ...tenantFilter },
    orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
    select: {
      id: true,
      status: true,
      absoluteThreshold: true,
      percentThreshold: true,
      finalizedAt: true,
      updatedAt: true,
      entity: { select: { code: true, name: true } },
      book: { select: { code: true, name: true } },
      fromPeriod: { select: { code: true, endsOn: true } },
      toPeriod: { select: { code: true, endsOn: true } },
      finalizer: { select: { displayName: true } },
    },
  });

  // Bucket counts per statement.
  type LineBucket = {
    total: number;
    material: number;
    pending: number;
  };
  const bucketByStatement = new Map<string, LineBucket>();
  if (statements.length > 0) {
    const rows = await prisma.fluxLine.groupBy({
      by: ["statementId", "status"],
      where: {
        tenantId: tenant.id,
        statementId: { in: statements.map((s) => s.id) },
      },
      _count: { _all: true },
    });
    for (const r of rows) {
      const b = bucketByStatement.get(r.statementId) ?? {
        total: 0,
        material: 0,
        pending: 0,
      };
      b.total += r._count._all;
      if (r.status !== "IMMATERIAL") b.material += r._count._all;
      if (r.status === "NEEDS_COMMENT") b.pending += r._count._all;
      bucketByStatement.set(r.statementId, b);
    }
  }

  // Resolve the entity/book/period options for the Generate form.
  // We need the codes (not IDs) since the Server Action takes codes.
  const [entities, books, periods] = await Promise.all([
    prisma.legalEntity.findMany({
      where: { tenantId: tenant.id },
      orderBy: { code: "asc" },
      select: { code: true, name: true },
    }),
    prisma.book.findMany({
      where: { isActive: true },
      orderBy: { code: "asc" },
      select: { code: true, name: true },
    }),
    prisma.period.findMany({
      where: { tenantId: tenant.id },
      orderBy: { startsOn: "desc" },
      take: 24, // last two years monthly
      select: { code: true, startsOn: true, endsOn: true },
    }),
  ]);

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-xl font-semibold text-ink-900">Flux analysis</h1>
        <p className="text-sm text-ink-500">
          Period-over-period variance review. Each statement flags accounts
          whose delta breaches the absolute $ or % threshold; the controller
          explains each before signoff.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Generate new statement</CardTitle>
          <span className="text-xs text-ink-500">
            Compares two periods; material lines need explanation before the
            statement can be finalized.
          </span>
        </CardHeader>
        <CardContent>
          <GenerateForm
            entities={entities}
            books={books}
            periods={periods.map((p) => ({
              code: p.code,
              endsOn: p.endsOn.toISOString().slice(0, 10),
            }))}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            {statements.length} statement{statements.length === 1 ? "" : "s"}
          </CardTitle>
          <span className="text-xs text-ink-500">DRAFT rows first</span>
        </CardHeader>
        <CardContent className={statements.length === 0 ? "" : "p-0"}>
          {statements.length === 0 ? (
            <EmptyState
              title="No statements yet"
              description="Generate one above. Compares two periods' trial balances."
            />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Scope</TH>
                  <TH>From → To</TH>
                  <TH>Threshold</TH>
                  <TH>Lines</TH>
                  <TH>Status</TH>
                  <TH>Signed off</TH>
                </tr>
              </THead>
              <TBody>
                {statements.map((s) => {
                  const bucket = bucketByStatement.get(s.id) ?? {
                    total: 0,
                    material: 0,
                    pending: 0,
                  };
                  return (
                    <TR key={s.id}>
                      <TD>
                        <Link
                          href={`/close/flux/${s.id}`}
                          className="text-ink-900 hover:underline"
                        >
                          <span className="font-mono text-xs">
                            {s.entity.code}
                          </span>{" "}
                          <span className="font-mono text-xs text-ink-500">
                            / {s.book.code}
                          </span>
                        </Link>
                      </TD>
                      <TD className="font-mono text-xs text-ink-700">
                        {s.fromPeriod.code} → {s.toPeriod.code}
                      </TD>
                      <TD className="text-xs text-ink-500">
                        $
                        {s.absoluteThreshold.toString()}{" "}
                        /{" "}
                        {s.percentThreshold.toString()}%
                      </TD>
                      <TD className="text-xs">
                        <span className="text-ink-700">{bucket.total}</span>
                        {bucket.material > 0 && (
                          <Badge
                            tone={bucket.pending > 0 ? "negative" : "info"}
                            className="ml-1.5"
                          >
                            {bucket.material} material
                            {bucket.pending > 0
                              ? ` · ${bucket.pending} pending`
                              : ""}
                          </Badge>
                        )}
                      </TD>
                      <TD>
                        <Badge tone={STATUS_TONES[s.status]}>{s.status}</Badge>
                      </TD>
                      <TD className="text-xs text-ink-500">
                        {s.finalizedAt ? (
                          <>
                            {formatDate(s.finalizedAt)}
                            {s.finalizer?.displayName && (
                              <div className="text-[10px] text-ink-400">
                                {s.finalizer.displayName}
                              </div>
                            )}
                          </>
                        ) : (
                          "—"
                        )}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
