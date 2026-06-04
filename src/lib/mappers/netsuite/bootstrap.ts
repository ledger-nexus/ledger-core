// NetSuite bootstrap mappers — Subsidiary + AccountingBook +
// AccountingPeriod.
//
// The existing src/lib/mappers/netsuite/{types,mappers,import}.ts
// covers Account + Party + Item + Invoice + Bill + Payment + JE — the
// transaction layer. But every transaction references entities + books
// + periods that must EXIST in ledger-core BEFORE the transaction
// import runs.
//
// This module fills that gap. Surfaced by the GL validation pass
// (docs/reference/netsuite-gl-validation.md PR #41) which showed
// 100% per-table translatability but flagged the missing bootstrap.
//
// Pattern matches the existing mappers in this directory:
//   - Pure mapper functions (no I/O)
//   - Idempotent import orchestrators
//   - Lineage triple populated on every created row

import type { PrismaClient } from "@prisma/client";

// ─── NetSuite source-side types ──────────────────────────────────────

export interface NsSubsidiaryBootstrap {
  internalid: string;
  name: string;
  legal_name?: string;
  country?: string;
  state?: string;
  base_currency: string;
  functional_currency?: string;
  fiscal_calendar?: string;
  parent_subsidiary_id?: string | null;
  is_elimination: boolean;
  is_inactive: boolean;
  consolidation_method?: "full" | "equity" | "cost";
  accounting_standard?: string;
  federal_tax_id?: string;
  ownership_percent_parent?: number;
  incorporation_date?: string;
  acquisition_date?: string;
}

export interface NsAccountingBookBootstrap {
  internalid: string;
  name: string;
  base_currency: string;
  accounting_standard?: string;
  subsidiary_id?: string;
  is_inactive: boolean;
}

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

// ─── Mapped target shapes ────────────────────────────────────────────

/**
 * Notes on what ledger-core's LegalEntity doesn't model that NetSuite
 * tracks: `is_elimination`, `consolidation_method`, `country`,
 * `state`, `federal_tax_id`, `ownership_percent_parent`. All preserved
 * in `extensions` Json + `sourcePayload`. The substrate handles
 * intercompany via account subtypes (DUE_FROM_AFFILIATE etc.), not an
 * entity flag — see docs/SOC2_CONTROL_MATRIX.md.
 */
export interface MappedLegalEntity {
  code: string;
  name: string;
  parentEntityCode: string | null;
  functionalCurrencyCode: string;
  fiscalCalendarCode: string;
  // NetSuite-specific metadata preserved in extensions Json.
  extensions: {
    isElimination: boolean;
    consolidationMethod: "FULL" | "EQUITY" | "COST";
    country?: string;
    state?: string;
    federalTaxId?: string;
    accountingStandard?: string;
    incorporationDate?: string;
    acquisitionDate?: string;
  };
  sourceSystem: "NETSUITE";
  sourceRecordType: "Subsidiary";
  sourceRecordId: string;
  sourcePayload: NsSubsidiaryBootstrap;
  mappingVersion: string;
}

export interface MappedBook {
  code: string;
  name: string;
  basis: "US_GAAP" | "US_TAX" | "IFRS" | "MGMT" | "STATUTORY";
  reportingCurrencyCode: string;
  active: boolean;
  sourceSystem: "NETSUITE";
  sourceRecordType: "AccountingBook";
  sourceRecordId: string;
  sourcePayload: NsAccountingBookBootstrap;
  mappingVersion: string;
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

// ─── Code conventions ───────────────────────────────────────────────

export function nsSubsidiaryCode(internalid: string): string {
  return `NSSUB-${internalid}`;
}

export function nsBookCode(internalid: string): string {
  return `NSBOOK-${internalid}`;
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

// ─── Mapper functions (pure) ────────────────────────────────────────

const CONSOLIDATION_METHOD: Record<
  NonNullable<NsSubsidiaryBootstrap["consolidation_method"]>,
  "FULL" | "EQUITY" | "COST"
> = {
  full: "FULL",
  equity: "EQUITY",
  cost: "COST",
};

const ACCOUNTING_STANDARD_TO_BASIS: Record<string, MappedBook["basis"]> = {
  US_GAAP: "US_GAAP",
  "US GAAP": "US_GAAP",
  GAAP: "US_GAAP",
  IFRS: "IFRS",
  IFRS_15: "IFRS",
  US_TAX: "US_TAX",
  TAX: "US_TAX",
  MGMT: "MGMT",
  MANAGEMENT: "MGMT",
};

export function mapNsSubsidiary(
  ns: NsSubsidiaryBootstrap,
  mappingVersion = "ns-v1"
): MappedLegalEntity {
  const code = nsSubsidiaryCode(ns.internalid);
  return {
    code,
    name: ns.legal_name || ns.name,
    parentEntityCode: ns.parent_subsidiary_id
      ? nsSubsidiaryCode(ns.parent_subsidiary_id)
      : null,
    functionalCurrencyCode: ns.functional_currency || ns.base_currency,
    fiscalCalendarCode: nsCalendarCode(code, ns.fiscal_calendar),
    extensions: {
      isElimination: ns.is_elimination,
      consolidationMethod: ns.consolidation_method
        ? CONSOLIDATION_METHOD[ns.consolidation_method]
        : "FULL",
      country: ns.country,
      state: ns.state,
      federalTaxId: ns.federal_tax_id,
      accountingStandard: ns.accounting_standard,
      incorporationDate: ns.incorporation_date,
      acquisitionDate: ns.acquisition_date,
    },
    sourceSystem: "NETSUITE",
    sourceRecordType: "Subsidiary",
    sourceRecordId: ns.internalid,
    sourcePayload: ns,
    mappingVersion,
  };
}

export function mapNsAccountingBook(
  ns: NsAccountingBookBootstrap,
  mappingVersion = "ns-v1"
): MappedBook {
  const basis: MappedBook["basis"] =
    (ns.accounting_standard &&
      ACCOUNTING_STANDARD_TO_BASIS[ns.accounting_standard]) ||
    "STATUTORY";

  return {
    code: nsBookCode(ns.internalid),
    name: ns.name,
    basis,
    reportingCurrencyCode: ns.base_currency,
    active: !ns.is_inactive,
    sourceSystem: "NETSUITE",
    sourceRecordType: "AccountingBook",
    sourceRecordId: ns.internalid,
    sourcePayload: ns,
    mappingVersion,
  };
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

// ─── Idempotent import orchestrators ────────────────────────────────

export interface ImportSubsidiariesResult {
  subsidiariesCreated: number;
  subsidiariesSkipped: number;
  fiscalCalendarsCreated: number;
  errors: string[];
}

/**
 * Import NetSuite subsidiaries as ledger-core LegalEntity rows + their
 * per-entity FiscalCalendar.
 *
 * Idempotent: checks (sourceSystem, sourceRecordType, sourceRecordId)
 * before insert. Re-runs produce zero new rows.
 *
 * MUST run BEFORE the JE / Invoice / Bill / Payment / Fixed Asset
 * import — every transaction references an entity by code.
 */
export async function importSubsidiaries(
  prisma: PrismaClient,
  tenantId: string,
  subsidiaries: NsSubsidiaryBootstrap[],
  mappingVersion = "ns-v1"
): Promise<ImportSubsidiariesResult> {
  const result: ImportSubsidiariesResult = {
    subsidiariesCreated: 0,
    subsidiariesSkipped: 0,
    fiscalCalendarsCreated: 0,
    errors: [],
  };

  // Pass 1: create entities (without parent links yet).
  for (const ns of subsidiaries) {
    const mapped = mapNsSubsidiary(ns, mappingVersion);

    const existing = await prisma.legalEntity.findFirst({
      where: {
        tenantId,
        sourceSystem: "NETSUITE",
        sourceRecordType: "Subsidiary",
        sourceRecordId: ns.internalid,
      },
      select: { id: true },
    });

    if (existing) {
      result.subsidiariesSkipped += 1;
      continue;
    }

    try {
      const entity = await prisma.legalEntity.create({
        data: {
          tenantId,
          code: mapped.code,
          name: mapped.name,
          functionalCurrencyId: mapped.functionalCurrencyCode,
          sourceSystem: mapped.sourceSystem,
          sourceRecordType: mapped.sourceRecordType,
          sourceRecordId: mapped.sourceRecordId,
          sourcePayload: mapped.sourcePayload as unknown as object,
          mappingVersion: mapped.mappingVersion,
          extensions: mapped.extensions as unknown as object,
        },
      });
      result.subsidiariesCreated += 1;

      // Pass 1b: create the per-entity FiscalCalendar.
      const calExists = await prisma.fiscalCalendar.findFirst({
        where: {
          tenantId,
          entityId: entity.id,
          code: mapped.fiscalCalendarCode,
        },
        select: { id: true },
      });
      if (!calExists) {
        await prisma.fiscalCalendar.create({
          data: {
            tenantId,
            entityId: entity.id,
            code: mapped.fiscalCalendarCode,
            name: `NetSuite calendar ${mapped.fiscalCalendarCode}`,
            periodFrequency: "MONTHLY",
          },
        });
        result.fiscalCalendarsCreated += 1;
      }
    } catch (e) {
      result.errors.push(
        `Failed to create LegalEntity for ${ns.internalid}: ${
          e instanceof Error ? e.message : String(e)
        }`
      );
    }
  }

  // Pass 2: wire parent_subsidiary_id links now that all entities exist.
  for (const ns of subsidiaries) {
    if (!ns.parent_subsidiary_id) continue;

    const child = await prisma.legalEntity.findFirst({
      where: {
        tenantId,
        sourceSystem: "NETSUITE",
        sourceRecordType: "Subsidiary",
        sourceRecordId: ns.internalid,
      },
      select: { id: true, parentEntityId: true },
    });
    const parent = await prisma.legalEntity.findFirst({
      where: {
        tenantId,
        sourceSystem: "NETSUITE",
        sourceRecordType: "Subsidiary",
        sourceRecordId: ns.parent_subsidiary_id,
      },
      select: { id: true },
    });

    if (child && parent && child.parentEntityId !== parent.id) {
      await prisma.legalEntity.update({
        where: { id: child.id },
        data: { parentEntityId: parent.id },
      });
    }
  }

  return result;
}

export interface ImportAccountingBooksResult {
  booksCreated: number;
  booksSkipped: number;
  errors: string[];
}

/**
 * Import NetSuite accounting_books as ledger-core Book rows.
 *
 * Idempotent. Must run BEFORE JE import.
 */
export async function importAccountingBooks(
  prisma: PrismaClient,
  books: NsAccountingBookBootstrap[],
  mappingVersion = "ns-v1"
): Promise<ImportAccountingBooksResult> {
  const result: ImportAccountingBooksResult = {
    booksCreated: 0,
    booksSkipped: 0,
    errors: [],
  };

  for (const ns of books) {
    const mapped = mapNsAccountingBook(ns, mappingVersion);
    const existing = await prisma.book.findFirst({
      where: { code: mapped.code },
      select: { id: true },
    });

    if (existing) {
      result.booksSkipped += 1;
      continue;
    }

    try {
      await prisma.book.create({
        data: {
          code: mapped.code,
          name: mapped.name,
          basis: mapped.basis,
          reportingCurrencyId: mapped.reportingCurrencyCode,
          isActive: mapped.active,
          extensions: {
            sourceSystem: mapped.sourceSystem,
            sourceRecordType: mapped.sourceRecordType,
            sourceRecordId: mapped.sourceRecordId,
            mappingVersion: mapped.mappingVersion,
          },
        },
      });
      result.booksCreated += 1;
    } catch (e) {
      result.errors.push(
        `Failed to create Book for ${ns.internalid}: ${
          e instanceof Error ? e.message : String(e)
        }`
      );
    }
  }

  return result;
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
