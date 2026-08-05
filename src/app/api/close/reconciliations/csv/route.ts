// GET /api/close/reconciliations/csv?period=YYYY-MM[&status=...]
//
// BlackLine arc — Phase 1 PR 3 sibling. Streams the current period's
// reconciliations list as a CSV (formula-injection-safe via `toCsv()`).
//
// Mirrors the columns the `/close/reconciliations` page renders so the
// download is the same shape as what the auditor saw on screen. Sort is
// fixed to abs(diff) DESC — the same default the page uses — so the
// downloaded file lands "worst-disagreement first," which is how a CPA
// hands a recon list to a junior to work through.
//
// Auth: requires a current user + tenant. Cross-tenant rows are never
// returned because the query is anchored by tenantId (defense-in-depth).
// Every download writes a DATA_EXPORT audit row.

import { NextRequest, NextResponse } from "next/server";
import { Decimal } from "@/lib/utils/decimal";
import { prisma } from "@/lib/db";
import { resolveCurrentScope } from "@/lib/scope";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getCurrentTenant } from "@/lib/auth/tenant";
import { tenantScopeOrNone } from "@/lib/db-sentinels";
import { auditDataExport } from "@/lib/audit/log";
import { toCsv, csvFilename, type CsvCell } from "@/lib/utils/csv";
import type { ReconStatus } from "@prisma/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_STATUSES: ReconStatus[] = [
  "OPEN",
  "IN_PROGRESS",
  "PREPARED",
  "RECONCILED",
  "EXCEPTION",
  "WAIVED",
];

export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const periodParam = url.searchParams.get("period");
  const statusParam = url.searchParams.get("status");

  // CC6.3 authorization: scope resolution + tenant binding happen up
  // front. Without a scope we refuse — no anonymous CSV downloads.
  const scope = await resolveCurrentScope(url.searchParams);
  if (!scope) {
    return new NextResponse("No scope available — sign in and select a tenant", {
      status: 403,
    });
  }

  const tenant = await getCurrentTenant();
  const currentUser = await getCurrentUser();
  const tenantFilter = tenantScopeOrNone(tenant?.id);

  // CC6.8 input validation: reject unknown status values rather than
  // silently treating them as "no filter."
  let status: ReconStatus | null = null;
  if (statusParam) {
    if (!(VALID_STATUSES as string[]).includes(statusParam)) {
      return new NextResponse(`Invalid status: ${statusParam}`, { status: 400 });
    }
    status = statusParam as ReconStatus;
  }

  const entity = await prisma.legalEntity.findFirst({
    where: {
      code: scope.entityCode,
      ...(tenant ? { tenantId: tenant.id } : {}),
    },
    select: { id: true, code: true, name: true },
  });
  const book = await prisma.book.findUnique({
    where: { code: scope.bookCode },
    select: { id: true, code: true, name: true },
  });
  if (!entity || !book) {
    return new NextResponse(
      `Scope not found: entity="${scope.entityCode}" book="${scope.bookCode}"`,
      { status: 404 }
    );
  }

  // Resolve the period the same way the page does.
  const allPeriods = await prisma.period.findMany({
    where: { calendar: { entityId: entity.id } },
    orderBy: { startsOn: "desc" },
    select: { id: true, code: true, startsOn: true, endsOn: true },
  });
  if (allPeriods.length === 0) {
    return new NextResponse("No periods seeded for this entity.", { status: 404 });
  }

  let selected = allPeriods[0];
  if (periodParam) {
    const match = allPeriods.find((p) => p.code === periodParam);
    if (!match) {
      return new NextResponse(
        `Unknown period "${periodParam}" for entity ${entity.code}.`,
        { status: 404 }
      );
    }
    selected = match;
  } else {
    // Default: latest OPEN period.
    const closes = await prisma.periodClose.findMany({
      where: { entityId: entity.id, bookId: book.id },
      select: { periodId: true },
    });
    const closedIds = new Set(closes.map((c) => c.periodId));
    const latestOpen = allPeriods.find((p) => !closedIds.has(p.id));
    if (latestOpen) selected = latestOpen;
  }

  const recons = await prisma.reconciliation.findMany({
    where: {
      ...tenantFilter,
      entityId: entity.id,
      bookId: book.id,
      periodId: selected.id,
      ...(status ? { status } : {}),
    },
    select: {
      id: true,
      status: true,
      requiresReview: true,
      glBalance: true,
      supportingBalance: true,
      reconciledDiff: true,
      tolerance: true,
      preparedAt: true,
      reviewedAt: true,
      updatedAt: true,
      account: { select: { code: true, name: true, type: true } },
      preparer: { select: { displayName: true, email: true } },
      reviewer: { select: { displayName: true, email: true } },
      _count: { select: { attachments: true } },
    },
  });

  // Same sort as the list page default (abs(diff) DESC, nulls last).
  const sorted = [...recons].sort((a, b) => {
    const aDiff = a.reconciledDiff
      ? new Decimal(a.reconciledDiff.toString()).abs()
      : null;
    const bDiff = b.reconciledDiff
      ? new Decimal(b.reconciledDiff.toString()).abs()
      : null;
    if (aDiff === null && bDiff === null) return 0;
    if (aDiff === null) return 1;
    if (bDiff === null) return -1;
    return bDiff.comparedTo(aDiff);
  });

  // CC7.2 audit: every download writes a row. The actor (or null for
  // demo-mode sessions), the row count, and the IP/UA all land in
  // audit_logs. Auditors filter by `resource = "ReconciliationList"`
  // for the SOC 2 evidence pull.
  await auditDataExport({
    actor: currentUser
      ? { id: currentUser.id, email: currentUser.email }
      : null,
    format: "csv",
    resource: "ReconciliationList",
    resourceId: `${entity.code}/${book.code}/${selected.code}${
      status ? `/${status}` : ""
    }`,
    rowCount: sorted.length,
    tenantId: tenant?.id ?? null,
    requestHeaders: {
      ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: req.headers.get("user-agent"),
    },
  });

  const rows: CsvCell[][] = [];
  rows.push(["Account Reconciliations"]);
  rows.push(["Entity", entity.code, entity.name]);
  rows.push(["Book", book.code, book.name]);
  rows.push([
    "Period",
    selected.code,
    selected.startsOn.toISOString().slice(0, 10),
    "→",
    selected.endsOn.toISOString().slice(0, 10),
  ]);
  rows.push(["Status filter", status ?? "(all)"]);
  rows.push(["Row count", sorted.length]);
  rows.push([]);
  rows.push([
    "Account code",
    "Account name",
    "Account type",
    "Status",
    "Sign-off mode",
    "GL balance",
    "Supporting balance",
    "Diff (GL − supporting)",
    "Tolerance",
    "Over tolerance?",
    "Preparer",
    "Prepared at",
    "Reviewer",
    "Reviewed at",
    "Attachments",
    "Last updated",
  ]);

  for (const r of sorted) {
    const diff = r.reconciledDiff
      ? new Decimal(r.reconciledDiff.toString())
      : null;
    const tolerance = new Decimal(r.tolerance.toString());
    const overTolerance = diff ? diff.abs().greaterThan(tolerance) : false;
    rows.push([
      r.account.code,
      r.account.name,
      r.account.type,
      r.status,
      r.requiresReview ? "preparer→reviewer" : "single sign-off",
      new Decimal(r.glBalance.toString()).toFixed(2),
      r.supportingBalance
        ? new Decimal(r.supportingBalance.toString()).toFixed(2)
        : "",
      diff ? diff.toFixed(2) : "",
      tolerance.toFixed(2),
      overTolerance ? "YES" : "no",
      // CC1.3 redaction note: we surface displayName (a human label
      // the user picked) — NOT the user's email, which is PII. Auditors
      // who need to pivot to the user record use the audit_log linkage
      // by resourceId.
      r.preparer?.displayName ?? "",
      r.preparedAt ? r.preparedAt.toISOString() : "",
      r.reviewer?.displayName ?? "",
      r.reviewedAt ? r.reviewedAt.toISOString() : "",
      r._count.attachments,
      r.updatedAt.toISOString(),
    ]);
  }

  return new NextResponse(toCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${csvFilename(
        `reconciliations-${entity.code}-${book.code}`,
        selected.code
      )}"`,
    },
  });
}
