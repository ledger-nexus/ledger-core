// v0.9 NS SuiteAnalytics Phase 5 — Consolidated Trial Balance endpoint.
//
// GET /api/external/ns-analytics/consolidated-trial-balance
//   Authorization: Bearer <ledger-core API token>
//   ?rootSubsidiary=1                 (NS internalid — required)
//   &accountingBook=9                 (NS internalid — required)
//   &asOf=2026-04-30                  (required)
//   [&periodStart=2026-04-01]         (optional — enables ASC 830 translation)
//   [&shape=native|ns]                (default native)
//
// Arc capstone — last endpoint in the 5-phase SuiteAnalytics roadmap.
// Walks the LegalEntity.parentEntityId hierarchy from the resolved
// root, eliminates intercompany subtype accounts (DUE_FROM/DUE_TO,
// INTERCOMPANY_REV/EXP), applies v0.8 ASC 830 translation when
// periodStart is provided + mixed currencies, and emits per-entity
// + consolidated columns in NS SubsidiaryElimination-canonical shape.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getConsolidatedTrialBalance } from "@/lib/accounting/reports/consolidation";
import {
  authenticateExternalRequest,
  auditExternalReportAccess,
  fetchAccountSubtypeHints,
} from "@/lib/external/ns-analytics-auth";
import {
  resolveNsSubsidiary,
  resolveNsAccountingBook,
} from "@/lib/external/ns-id-resolver";
import { toNsConsolidatedTrialBalance } from "@/lib/external/ns-report-shapes";
import { toCsv, type CsvCell } from "@/lib/utils/csv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NS_INTERNALID_RX = /^[A-Z0-9_-]{1,16}$/i;
const ISO_DATE_RX = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const ipAddress =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = req.headers.get("user-agent");

  const auth = await authenticateExternalRequest(
    req,
    "ns-analytics/consolidated-trial-balance"
  );
  if (auth instanceof NextResponse) return auth;

  // ---- 1. Parse + validate params ----------------------------------
  const rootSubsidiary = url.searchParams.get("rootSubsidiary") ?? "";
  const accountingBook = url.searchParams.get("accountingBook") ?? "";
  const asOf = url.searchParams.get("asOf") ?? "";
  const periodStart = url.searchParams.get("periodStart");
  const shape = url.searchParams.get("shape") ?? "native";
  const format = url.searchParams.get("format") ?? "json";

  if (!NS_INTERNALID_RX.test(rootSubsidiary)) {
    return NextResponse.json(
      { error: "Invalid or missing rootSubsidiary (NS internalid)." },
      { status: 400 }
    );
  }
  if (!NS_INTERNALID_RX.test(accountingBook)) {
    return NextResponse.json(
      { error: "Invalid or missing accountingBook (NS internalid)." },
      { status: 400 }
    );
  }
  if (!ISO_DATE_RX.test(asOf)) {
    return NextResponse.json(
      { error: "Invalid or missing asOf. Required: ISO YYYY-MM-DD." },
      { status: 400 }
    );
  }
  if (periodStart !== null && !ISO_DATE_RX.test(periodStart)) {
    return NextResponse.json(
      { error: "Invalid periodStart. Required: ISO YYYY-MM-DD." },
      { status: 400 }
    );
  }
  if (format !== "json" && format !== "csv") {
    return NextResponse.json(
      { error: 'Invalid format. Required: "json" or "csv".' },
      { status: 400 }
    );
  }
  if (shape !== "native" && shape !== "ns") {
    return NextResponse.json(
      { error: 'Invalid shape. Required: "native" or "ns".' },
      { status: 400 }
    );
  }

  // ---- 2. Resolve NS internalids → ledger-core codes ---------------
  const ent = await resolveNsSubsidiary(prisma, {
    tenantId: auth.tenantId,
    nsInternalid: rootSubsidiary,
  });
  if (!ent) {
    return NextResponse.json(
      {
        error: "rootSubsidiary not found.",
        nsInternalid: rootSubsidiary,
        hint: "Verify the subsidiary was imported via /import/netsuite for this tenant.",
      },
      { status: 404 }
    );
  }
  const book = await resolveNsAccountingBook(prisma, {
    nsInternalid: accountingBook,
  });
  if (!book) {
    return NextResponse.json(
      {
        error: "accountingBook not found.",
        nsInternalid: accountingBook,
        hint: "Verify the accounting book was imported via multi-book NS import.",
      },
      { status: 404 }
    );
  }

  // ---- 3. Run the consolidation report -----------------------------
  let report: Awaited<ReturnType<typeof getConsolidatedTrialBalance>>;
  try {
    report = await getConsolidatedTrialBalance(prisma, {
      rootEntityCode: ent.entityCode,
      bookCode: book.bookCode,
      asOf: new Date(asOf),
      ...(periodStart ? { periodStart: new Date(periodStart) } : {}),
    });
  } catch (err) {
    console.error(
      "[ns-analytics/consolidated-trial-balance]",
      err instanceof Error ? err.message : String(err)
    );
    return NextResponse.json(
      { error: "Internal error generating consolidated trial balance." },
      { status: 500 }
    );
  }

  // ---- 4. Audit + return -------------------------------------------
  await auditExternalReportAccess({
    auth,
    endpoint: "ns-analytics/consolidated-trial-balance",
    scope: { entityCode: ent.entityCode, bookCode: book.bookCode },
    rowCount: report.rows.length,
    ipAddress,
    userAgent,
  });

  if (shape === "ns") {
    // Build the entityCode → NS subsidiary internalid mapping so the
    // perSubsidiary rows can render NS ids. The mapping queries
    // LegalEntity.extensions.nsInternalid for each included entity.
    // For a hierarchy of N entities this is N queries; in practice N
    // is small (3-10) so the overhead is negligible.
    const entityCodeToNsInternalid: Record<string, string> = {};
    for (const e of report.entitiesIncluded) {
      const row = await prisma.legalEntity.findFirst({
        where: { tenantId: auth.tenantId, code: e.code },
        select: { extensions: true },
      });
      const ext = (row?.extensions ?? {}) as Record<string, unknown>;
      const nsId = typeof ext.nsInternalid === "string" ? ext.nsInternalid : "";
      entityCodeToNsInternalid[e.code] = nsId;
    }

    const hints = await fetchAccountSubtypeHints(
      prisma,
      auth.tenantId,
      report.rows.map((r) => r.accountCode)
    );
    const nsBody = toNsConsolidatedTrialBalance(
      {
        entities: report.entitiesIncluded,
        rows: report.rows,
        preEliminationTotalDebit: report.preEliminationTotalDebit,
        preEliminationTotalCredit: report.preEliminationTotalCredit,
        consolidatedTotalDebit: report.consolidatedTotalDebit,
        consolidatedTotalCredit: report.consolidatedTotalCredit,
        cumulativeTranslationAdjustment: report.cumulativeTranslationAdjustment,
        translationActive: report.translationActive,
        translationRateByEntity: report.translationRateByEntity,
        balances: report.balances,
      },
      asOf,
      {
        subsidiaryInternalid: rootSubsidiary,
        accountingBookInternalid: accountingBook,
        rootEntityName: report.rootEntityName,
        entityCodeToNsInternalid,
      },
      hints
    );
    return NextResponse.json(nsBody);
  }

  // ---- 5. CSV format (operator ETL pipelines) ----------------------
  //
  // Wide format: one CSV row per account with per-entity debit/credit
  // columns AND consolidated/elimination columns. NS's SubsidiaryElim
  // CSV export does the same — column count varies with the entity
  // hierarchy. Format is operator-driven and self-describing via the
  // header row.
  if (format === "csv") {
    const entityCodes = report.entitiesIncluded.map((e) => e.code);
    const header: string[] = [
      "accountCode",
      "accountName",
      "type",
      "subtype",
      ...entityCodes.flatMap((c) => [`${c}_debit`, `${c}_credit`]),
      "preEliminationDebit",
      "preEliminationCredit",
      "eliminatedDebit",
      "eliminatedCredit",
      "consolidatedDebit",
      "consolidatedCredit",
      "isEliminated",
    ];
    const dataRows = report.rows.map((r) => {
      // Index per-entity debit/credit by entityCode for fast lookup.
      const perEntityMap = new Map(
        r.perEntity.map((p) => [p.entityCode, p])
      );
      const perEntityCells = entityCodes.flatMap((c) => {
        const cell = perEntityMap.get(c);
        return [
          cell ? cell.debit.toFixed(4) : "0.0000",
          cell ? cell.credit.toFixed(4) : "0.0000",
        ];
      });
      return [
        r.accountCode,
        r.accountName,
        r.type,
        r.subtype ?? "",
        ...perEntityCells,
        r.totalDebit.toFixed(4),
        r.totalCredit.toFixed(4),
        r.eliminatedDebit.toFixed(4),
        r.eliminatedCredit.toFixed(4),
        r.consolidatedDebit.toFixed(4),
        r.consolidatedCredit.toFixed(4),
        String(r.isEliminated),
      ];
    });
    // Append totals + translation metadata as trailer rows. Operators
    // can grep for the empty accountCode to find the section divider.
    const totalsRow = [
      "",
      "TOTALS",
      "",
      "",
      ...entityCodes.flatMap(() => ["", ""]),
      report.preEliminationTotalDebit.toFixed(4),
      report.preEliminationTotalCredit.toFixed(4),
      "",
      "",
      report.consolidatedTotalDebit.toFixed(4),
      report.consolidatedTotalCredit.toFixed(4),
      "",
    ];
    const ctaRow = [
      "",
      "CTA",
      "",
      "",
      ...entityCodes.flatMap(() => ["", ""]),
      "",
      "",
      "",
      "",
      report.cumulativeTranslationAdjustment.toFixed(4),
      "",
      "",
    ];
    // Use the shared toCsv helper from @/lib/utils/csv. It RFC 4180-quotes
    // cells that contain ",\n + and prepends a single quote to cells whose
    // first char is =, +, -, @, \t, \r (CWE-1236, CSV formula injection).
    // Account names + entity codes flow byref from NS imports, so they're
    // attacker-controllable; the inline `"${String(cell)}"` escaper this
    // file used to carry handled quotes but NOT leaders. See csv.ts for
    // the exploit details.
    const csvRows: CsvCell[][] = [header, ...dataRows, totalsRow, ctaRow];
    const csv = toCsv(csvRows);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="ns-analytics-consolidated-trial-balance-${book.bookCode}-${asOf}.csv"`,
      },
    });
  }

  // Native shape (default).
  return NextResponse.json({
    _meta: {
      report: "consolidated-trial-balance",
      rootEntityCode: ent.entityCode,
      bookCode: book.bookCode,
      asOf,
      periodStart: periodStart ?? null,
      generatedAt: new Date().toISOString(),
      rowCount: report.rows.length,
    },
    entitiesIncluded: report.entitiesIncluded,
    rows: report.rows.map((r) => ({
      accountCode: r.accountCode,
      accountName: r.accountName,
      type: r.type,
      subtype: r.subtype,
      perEntity: r.perEntity.map((p) => ({
        entityCode: p.entityCode,
        debit: p.debit.toFixed(4),
        credit: p.credit.toFixed(4),
      })),
      totalDebit: r.totalDebit.toFixed(4),
      totalCredit: r.totalCredit.toFixed(4),
      eliminatedDebit: r.eliminatedDebit.toFixed(4),
      eliminatedCredit: r.eliminatedCredit.toFixed(4),
      consolidatedDebit: r.consolidatedDebit.toFixed(4),
      consolidatedCredit: r.consolidatedCredit.toFixed(4),
      isEliminated: r.isEliminated,
    })),
    totals: {
      preEliminationDebit: report.preEliminationTotalDebit.toFixed(4),
      preEliminationCredit: report.preEliminationTotalCredit.toFixed(4),
      consolidatedDebit: report.consolidatedTotalDebit.toFixed(4),
      consolidatedCredit: report.consolidatedTotalCredit.toFixed(4),
      netIcImbalance: report.netIcImbalance.toFixed(4),
    },
    translation: {
      active: report.translationActive,
      ratesByEntity: report.translationRateByEntity,
      cta: report.cumulativeTranslationAdjustment.toFixed(4),
    },
    balances: report.balances,
  });
}
