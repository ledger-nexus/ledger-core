// CSV export for a single journal entry. One row per line, with header
// metadata in the leading rows so the file is self-contained when shared
// with an auditor or pasted into another system.
//
// Audit: writes a DATA_EXPORT row via auditDataExport — same pattern as
// the report CSV routes. Closes the SOC 2 CC4 lineage for JE-level
// egress.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getCurrentTenant } from "@/lib/auth/tenant";
import { auditDataExport } from "@/lib/audit/log";
import { toCsv } from "@/lib/utils/csv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  const tenant = await getCurrentTenant();
  // Tenant-scope the lookup so a forged id from another tenant returns
  // 404, not a cross-tenant leak. Falls back to the global lookup when
  // tenant is null (e.g. dev / internal scripts).
  const entry = await prisma.journalEntry.findFirst({
    where: {
      id: params.id,
      ...(tenant ? { tenantId: tenant.id } : {}),
    },
    include: {
      entity: { select: { code: true, name: true } },
      book: { select: { code: true, name: true } },
      currency: { select: { code: true } },
      lines: {
        include: {
          account: { select: { code: true, name: true } },
          party: { select: { code: true, displayName: true } },
        },
        orderBy: { lineNo: "asc" },
      },
    },
  });
  if (!entry) {
    return new NextResponse("Journal entry not found", { status: 404 });
  }

  const currentUser = await getCurrentUser();
  await auditDataExport({
    actor: currentUser ? { id: currentUser.id, email: currentUser.email } : null,
    format: "csv",
    resource: "JournalEntry",
    rowCount: entry.lines.length,
    tenantId: tenant?.id ?? null,
    requestHeaders: {
      ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: req.headers.get("user-agent"),
    },
  });

  // Self-describing block: entry header at the top, then a blank, then
  // the line table with column headers. The blank row helps Excel
  // recognize the structure when the file is opened.
  const rows = [
    ["Journal Entry", entry.entryNumber],
    ["Entity", `${entry.entity.code} (${entry.entity.name})`],
    ["Book", `${entry.book.code} (${entry.book.name})`],
    ["Document date", entry.documentDate.toISOString().slice(0, 10)],
    ["Posting date", entry.postingDate.toISOString().slice(0, 10)],
    ["Memo", entry.memo],
    ["Currency", entry.currency.code],
    ["FX rate", entry.fxRate.toString()],
    ["Status", entry.status],
    ["Source", entry.source],
    ...(entry.sourceSystem
      ? [["Lineage", `${entry.sourceSystem} / ${entry.sourceRecordType} / ${entry.sourceRecordId}`]]
      : []),
    [],
    ["Line", "Account code", "Account name", "Party", "Description", "Debit", "Credit"],
    ...entry.lines.map((l) => [
      l.lineNo,
      l.account.code,
      l.account.name,
      l.party ? `${l.party.code} (${l.party.displayName})` : "",
      l.description ?? "",
      l.debit.toString(),
      l.credit.toString(),
    ]),
  ];

  return new NextResponse(toCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="je-${entry.entryNumber}.csv"`,
    },
  });
}
