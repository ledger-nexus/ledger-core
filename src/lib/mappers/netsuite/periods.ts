// NetSuite AccountingPeriod bootstrap — maps NS accounting periods
// into a named FiscalCalendar's Period rows.
//
// Extracted from the chain's bootstrap.ts (PR #43): the Subsidiary and
// AccountingBook bootstrap halves were superseded by the landed
// setupSubsidiaries (v1.26) / setupBooks (v1.28) orchestrators; the
// AccountingPeriod half is the only part main lacked.

import { PrismaClient } from "@prisma/client";

export interface NsAccountingPeriodBootstrap {
  internalid: string;
  name: string;
  start_date: string;
  end_date: string;
  fiscal_year: number;
  quarter?: number;
  month?: number;
  status: "open" | "closed";
  parent_period_id?: string;
  is_year?: boolean;
  is_quarter?: boolean;
}

export interface MappedPeriod {
  fiscalCalendarCode: string;
  code: string;
  ordinal: number;
  startsOn: string;
  endsOn: string;
  status: "OPEN" | "CLOSED";
  sourceSystem: "NETSUITE";
  sourceRecordType: "AccountingPeriod";
  sourceRecordId: string;
  sourcePayload: NsAccountingPeriodBootstrap;
  mappingVersion: string;
}

export function nsCalendarCode(
  entityCode: string,
  fiscalCalendar?: string
): string {
  // One FiscalCalendar per entity per distinct fiscal_calendar value.
  // Entity prefix ensures uniqueness given the per-entity FK from
  // FiscalCalendar.entityId.
  const suffix = fiscalCalendar
    ? fiscalCalendar.replace(/\s+/g, "_").toUpperCase()
    : "DEFAULT";
  return `${entityCode}-CAL-${suffix}`;
}

export function nsPeriodCode(ns: NsAccountingPeriodBootstrap): string {
  if (ns.is_year) return `${ns.fiscal_year}`;
  if (ns.is_quarter && ns.quarter) return `${ns.fiscal_year}-Q${ns.quarter}`;
  if (ns.month) {
    return `${ns.fiscal_year}-${String(ns.month).padStart(2, "0")}`;
  }
  return ns.name;
}

export function mapNsAccountingPeriod(
  ns: NsAccountingPeriodBootstrap,
  fiscalCalendarCode: string,
  mappingVersion = "ns-v1"
): MappedPeriod {
  const ordinal = ns.is_year
    ? 0
    : ns.is_quarter && ns.quarter
      ? ns.quarter
      : ns.month || 1;

  return {
    fiscalCalendarCode,
    code: nsPeriodCode(ns),
    ordinal,
    startsOn: ns.start_date,
    endsOn: ns.end_date,
    status: ns.status === "closed" ? "CLOSED" : "OPEN",
    sourceSystem: "NETSUITE",
    sourceRecordType: "AccountingPeriod",
    sourceRecordId: ns.internalid,
    sourcePayload: ns,
    mappingVersion,
  };
}

export interface ImportAccountingPeriodsResult {
  periodsCreated: number;
  periodsSkipped: number;
  errors: string[];
}

/**
 * Import NetSuite accounting_periods as ledger-core Period rows.
 *
 * Idempotent. Pre-condition: the FiscalCalendar identified by
 * `fiscalCalendarCode` must already exist (created during
 * `importSubsidiaries`).
 *
 * Filters to monthly (leaf) periods only — NetSuite ships year +
 * quarter + month rows; ledger-core's Period is leaf-level.
 */

export async function importAccountingPeriods(
  prisma: PrismaClient,
  tenantId: string,
  fiscalCalendarCode: string,
  periods: NsAccountingPeriodBootstrap[],
  mappingVersion = "ns-v1"
): Promise<ImportAccountingPeriodsResult> {
  const result: ImportAccountingPeriodsResult = {
    periodsCreated: 0,
    periodsSkipped: 0,
    errors: [],
  };

  const calendar = await prisma.fiscalCalendar.findFirst({
    where: { tenantId, code: fiscalCalendarCode },
    select: { id: true },
  });

  if (!calendar) {
    result.errors.push(
      `FiscalCalendar ${fiscalCalendarCode} not found — run importSubsidiaries first`
    );
    return result;
  }

  const monthlyPeriods = periods.filter((p) => !p.is_year && !p.is_quarter);

  for (const ns of monthlyPeriods) {
    const mapped = mapNsAccountingPeriod(
      ns,
      fiscalCalendarCode,
      mappingVersion
    );
    const existing = await prisma.period.findFirst({
      where: { tenantId, calendarId: calendar.id, code: mapped.code },
      select: { id: true },
    });

    if (existing) {
      result.periodsSkipped += 1;
      continue;
    }

    try {
      await prisma.period.create({
        data: {
          tenantId,
          calendarId: calendar.id,
          code: mapped.code,
          ordinal: mapped.ordinal,
          startsOn: new Date(mapped.startsOn),
          endsOn: new Date(mapped.endsOn),
        },
      });
      result.periodsCreated += 1;
    } catch (e) {
      result.errors.push(
        `Failed to create Period for ${ns.internalid}: ${
          e instanceof Error ? e.message : String(e)
        }`
      );
    }
  }

  return result;
}
