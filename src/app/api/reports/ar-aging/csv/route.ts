import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { arAging, openArBalance } from "@/lib/accounting/sub-ledgers/ar";
import { getCurrentScope } from "@/lib/scope";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getCurrentTenant } from "@/lib/auth/tenant";
import { auditDataExport } from "@/lib/audit/log";
import { toCsv, csvFilename } from "@/lib/utils/csv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const asOf = url.searchParams.get("asOf") ?? new Date().toISOString().slice(0, 10);
  const scope = await getCurrentScope();
  if (!scope) {
    return new NextResponse("No scope available — sign in and select a tenant", { status: 403 });
  }

  const [buckets, total, items] = await Promise.all([
    arAging(prisma, scope.entityCode, scope.bookCode, new Date(asOf), scope.tenantId),
    openArBalance(prisma, scope.entityCode, scope.bookCode, scope.tenantId),
    prisma.arOpenItem.findMany({
      where: {
        tenantId: scope.tenantId,
        entity: { code: scope.entityCode },
        book: { code: scope.bookCode },
        status: { in: ["OPEN", "PARTIAL", "REOPENED"] },
      },
      orderBy: [{ dueDate: "asc" }, { openedDate: "asc" }],
      select: {
        referenceNumber: true,
        openedDate: true,
        dueDate: true,
        originalAmount: true,
        currentBalance: true,
        status: true,
        party: { select: { code: true, displayName: true } },
      },
    }),
  ]);

  const tenant = await getCurrentTenant();
  const currentUser = await getCurrentUser();
  await auditDataExport({
    actor: currentUser ? { id: currentUser.id, email: currentUser.email } : null,
    format: "csv",
    resource: "ArAging",
    rowCount: items.length,
    tenantId: tenant?.id ?? null,
    requestHeaders: {
      ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: req.headers.get("user-agent"),
    },
  });

  const rows = [
    ["AR Aging", scope.entityCode, scope.bookCode, `as of ${asOf}`],
    [],
    ["Bucket", "Items", "Total"],
    ...buckets.map((b) => [b.bucket, b.itemCount, b.totalBalance.toFixed(2)]),
    ["TOTAL", buckets.reduce((acc, b) => acc + b.itemCount, 0), total.toFixed(2)],
    [],
    ["Detail", "Reference", "Customer", "Code", "Opened", "Due", "Status", "Original", "Balance"],
    ...items.map((i) => [
      "",
      i.referenceNumber ?? "",
      i.party.displayName,
      i.party.code,
      i.openedDate.toISOString().slice(0, 10),
      i.dueDate ? i.dueDate.toISOString().slice(0, 10) : "",
      i.status,
      i.originalAmount.toFixed(2),
      i.currentBalance.toFixed(2),
    ]),
  ];

  return new NextResponse(toCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      // v0.9 NS Books Phase 3.5.C — include the book code in the
      // filename so multi-book operators downloading two CSVs (one per
      // book) don't have them collide on disk. Books like "US_GAAP"
      // and "US_TAX" are operator-controlled and shape-validated, so
      // safe to embed in the filename.
      "Content-Disposition": `attachment; filename="${csvFilename("ar-aging", `${scope.bookCode}-${asOf}`)}"`,
    },
  });
}
