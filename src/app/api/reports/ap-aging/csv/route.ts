import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { apAging, openApBalance } from "@/lib/accounting/sub-ledgers/ap";
import { getScope } from "@/lib/scope";
import { toCsv, csvFilename } from "@/lib/utils/csv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const asOf = url.searchParams.get("asOf") ?? new Date().toISOString().slice(0, 10);
  const scope = getScope();

  const [buckets, total, items] = await Promise.all([
    apAging(prisma, scope.entityCode, scope.bookCode, new Date(asOf)),
    openApBalance(prisma, scope.entityCode, scope.bookCode),
    prisma.apOpenItem.findMany({
      where: {
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

  const rows = [
    ["AP Aging", scope.entityCode, scope.bookCode, `as of ${asOf}`],
    [],
    ["Bucket", "Items", "Total"],
    ...buckets.map((b) => [b.bucket, b.itemCount, b.totalBalance.toFixed(2)]),
    ["TOTAL", buckets.reduce((acc, b) => acc + b.itemCount, 0), total.toFixed(2)],
    [],
    ["Detail", "Reference", "Vendor", "Code", "Opened", "Due", "Status", "Original", "Balance"],
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
      "Content-Disposition": `attachment; filename="${csvFilename("ap-aging", asOf)}"`,
    },
  });
}
