// v0.9 NS SuiteAnalytics Phase 4 — Saved-Search-style query engine.
//
// NS SuiteAnalytics lets operators run saved searches: per-record-type
// queries with filter sets, column projections, and paging. The wire
// shape is a JSON spec the BI tool POSTs to /restlets/saved-search;
// the response is paged rows with NS-shape field names.
//
// This module is the translation layer: it takes the JSON spec, maps
// to a per-searchType template, runs against ledger-core data via
// Prisma, and emits NS-canonical rows.
//
// Phase 4 ships two searchTypes — Account and Transaction. These
// demonstrate the pattern across the simple-string + complex-number+
// date case. Customer/Vendor/Item are simple-string-only follow-ups
// in Phase 4.5 (each follows the established whitelist + adapter
// pattern; no new architecture).
//
// SECURITY
//
// Every public surface (searchType, field, operator, values, page,
// pageSize) is validated against an explicit whitelist BEFORE any
// Prisma query runs. No filter operator passes through to the DB
// without being translated to a typed Prisma operator first — defeats
// SQL/NoSQL injection through the filter spec.

import type { PrismaClient } from "@prisma/client";

// ─── Public types ─────────────────────────────────────────────────────

export type SearchType =
  | "Account"
  | "Transaction"
  | "Customer"
  | "Vendor"
  | "Item";

export type FilterOperator =
  | "EQUALS"
  | "ANYOF"
  | "WITHIN"
  | "GREATER_THAN"
  | "LESS_THAN";

export interface SavedSearchFilter {
  field: string;
  operator: FilterOperator;
  values: Array<string | number>;
}

export interface SavedSearchColumn {
  field: string;
}

export interface SavedSearchRequest {
  searchType: SearchType;
  filters?: SavedSearchFilter[];
  columns?: SavedSearchColumn[];
  page?: number; // 1-based
  pageSize?: number; // ≤ MAX_PAGE_SIZE
}

export interface SavedSearchResult {
  rows: Array<Record<string, unknown>>;
  total: number;
  page: number;
  pageSize: number;
}

// ─── Limits ─────────────────────────────────────────────────────────

export const MAX_PAGE_SIZE = 1000; // NS cap
export const DEFAULT_PAGE_SIZE = 100;
export const MAX_FILTERS = 10; // DoS guard
export const MAX_VALUES_PER_FILTER = 100; // DoS guard on ANYOF / WITHIN

// ─── Field whitelist per searchType ─────────────────────────────────

interface FieldDef {
  /** The NS-shape field name in the response. */
  name: string;
  /** Operand type. Drives operator whitelist. */
  type: "string" | "number" | "date";
}

const FIELDS_BY_SEARCH_TYPE: Record<SearchType, FieldDef[]> = {
  Account: [
    { name: "internalid", type: "string" },
    { name: "acctnumber", type: "string" },
    { name: "acctname", type: "string" },
    { name: "accttype", type: "string" },
    { name: "isinactive", type: "string" }, // NS encodes as "T"/"F"
  ],
  Transaction: [
    { name: "internalid", type: "string" },
    { name: "type", type: "string" },
    { name: "tranid", type: "string" },
    { name: "trandate", type: "date" },
    { name: "memo", type: "string" },
    { name: "amount", type: "number" },
  ],
  // Customer + Vendor map to Party with role discriminator. NS uses
  // entityid for the operator-facing code and companyname for the
  // display. Same shape per record type — only the role filter
  // differs at adapter time.
  Customer: [
    { name: "internalid", type: "string" },
    { name: "entityid", type: "string" },
    { name: "companyname", type: "string" },
  ],
  Vendor: [
    { name: "internalid", type: "string" },
    { name: "entityid", type: "string" },
    { name: "companyname", type: "string" },
  ],
  Item: [
    { name: "internalid", type: "string" },
    { name: "itemid", type: "string" },      // NS's itemid = ledger-core code
    { name: "displayname", type: "string" }, // = ledger-core name
    { name: "itemtype", type: "string" },    // NS uses InvtPart/Service/etc.
  ],
};

const OPS_BY_TYPE: Record<FieldDef["type"], FilterOperator[]> = {
  string: ["EQUALS", "ANYOF"],
  number: ["EQUALS", "ANYOF", "GREATER_THAN", "LESS_THAN"],
  date: ["EQUALS", "WITHIN", "GREATER_THAN", "LESS_THAN"],
};

// ─── Validation ─────────────────────────────────────────────────────

/**
 * Typed-error class so callers can map to 400 with a structured body.
 */
export class SavedSearchValidationError extends Error {
  constructor(message: string, public field?: string) {
    super(message);
    this.name = "SavedSearchValidationError";
  }
}

export function validateRequest(input: unknown): SavedSearchRequest {
  if (!input || typeof input !== "object") {
    throw new SavedSearchValidationError("Request body must be a JSON object.");
  }
  const r = input as Partial<SavedSearchRequest>;

  // searchType (whitelisted). Explicit narrowing predicate so r.searchType
  // is typed as SearchType in subsequent uses.
  const VALID_SEARCH_TYPES = [
    "Account",
    "Transaction",
    "Customer",
    "Vendor",
    "Item",
  ] as const;
  const isValidSearchType = (s: unknown): s is SearchType =>
    typeof s === "string" &&
    (VALID_SEARCH_TYPES as readonly string[]).includes(s);
  if (!isValidSearchType(r.searchType)) {
    throw new SavedSearchValidationError(
      `Invalid searchType. Required: one of ${VALID_SEARCH_TYPES.join(", ")}.`
    );
  }
  const searchType: SearchType = r.searchType;
  const knownFields = FIELDS_BY_SEARCH_TYPE[searchType];
  const fieldsByName = new Map(knownFields.map((f) => [f.name, f]));

  // filters
  const filters = r.filters ?? [];
  if (!Array.isArray(filters)) {
    throw new SavedSearchValidationError("filters must be an array.");
  }
  if (filters.length > MAX_FILTERS) {
    throw new SavedSearchValidationError(
      `Too many filters (${filters.length} > ${MAX_FILTERS}).`
    );
  }
  for (const f of filters) {
    if (!f || typeof f !== "object") {
      throw new SavedSearchValidationError("Each filter must be an object.");
    }
    if (typeof f.field !== "string" || !fieldsByName.has(f.field)) {
      throw new SavedSearchValidationError(
        `Unknown field "${String(f.field).slice(0, 32)}" for searchType ${r.searchType}.`,
        f.field
      );
    }
    const fieldDef = fieldsByName.get(f.field)!;
    if (
      typeof f.operator !== "string" ||
      !OPS_BY_TYPE[fieldDef.type].includes(f.operator as FilterOperator)
    ) {
      throw new SavedSearchValidationError(
        `Invalid operator "${String(f.operator).slice(0, 32)}" for ${fieldDef.type} field "${f.field}".`,
        f.field
      );
    }
    if (!Array.isArray(f.values)) {
      throw new SavedSearchValidationError(
        `filter.values must be an array for field "${f.field}".`,
        f.field
      );
    }
    if (f.values.length === 0) {
      throw new SavedSearchValidationError(
        `filter.values must be non-empty for field "${f.field}".`,
        f.field
      );
    }
    if (f.values.length > MAX_VALUES_PER_FILTER) {
      throw new SavedSearchValidationError(
        `Too many values for field "${f.field}" (${f.values.length} > ${MAX_VALUES_PER_FILTER}).`,
        f.field
      );
    }
    for (const v of f.values) {
      if (typeof v !== "string" && typeof v !== "number") {
        throw new SavedSearchValidationError(
          `filter.values must contain only strings or numbers for field "${f.field}".`,
          f.field
        );
      }
    }
    // WITHIN requires exactly 2 values (range start, range end).
    if (f.operator === "WITHIN" && f.values.length !== 2) {
      throw new SavedSearchValidationError(
        `WITHIN requires exactly 2 values for field "${f.field}".`,
        f.field
      );
    }
  }

  // columns
  const columns = r.columns ?? [];
  if (!Array.isArray(columns)) {
    throw new SavedSearchValidationError("columns must be an array.");
  }
  for (const c of columns) {
    if (!c || typeof c.field !== "string" || !fieldsByName.has(c.field)) {
      throw new SavedSearchValidationError(
        `Unknown column "${String((c as { field?: string })?.field).slice(0, 32)}" for searchType ${r.searchType}.`
      );
    }
  }

  // page + pageSize
  const page = r.page ?? 1;
  const pageSize = r.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(page) || page < 1) {
    throw new SavedSearchValidationError("page must be a positive integer.");
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new SavedSearchValidationError(
      `pageSize must be a positive integer ≤ ${MAX_PAGE_SIZE}.`
    );
  }

  return {
    searchType,
    filters,
    columns,
    page,
    pageSize,
  };
}

// ─── Adapter: filter spec → Prisma where ────────────────────────────

function buildAccountWhere(
  filters: SavedSearchFilter[]
): Record<string, unknown> {
  const where: Record<string, unknown> = {
    sourceSystem: "NETSUITE", // saved search returns NS-imported accounts only
  };
  for (const f of filters) {
    const prismaField = {
      internalid: "sourceRecordId",
      acctnumber: "code",
      acctname: "name",
      accttype: "type",
      isinactive: "active",
    }[f.field];
    if (!prismaField) continue; // validateRequest guarantees this never happens
    if (f.operator === "EQUALS") {
      where[prismaField] =
        f.field === "isinactive" ? f.values[0] !== "T" : f.values[0];
    } else if (f.operator === "ANYOF") {
      where[prismaField] = { in: f.values };
    }
  }
  return where;
}

/**
 * Customer + Vendor map to Party with a role discriminator. Same
 * adapter, parameterized by the NS-side `searchType` (which is also
 * the prefix on the NS source-record-type for lineage matching).
 */
function buildPartyWhere(
  filters: SavedSearchFilter[],
  nsRoleKind: "CUSTOMER" | "VENDOR"
): Record<string, unknown> {
  // Party uses sourceSystem="NETSUITE" + sourceRecordType="Customer"|"Vendor"
  // — the NS importer sets that at v0.6.
  const where: Record<string, unknown> = {
    sourceSystem: "NETSUITE",
    sourceRecordType: nsRoleKind === "CUSTOMER" ? "Customer" : "Vendor",
    // The party-role table backs the role discriminator at ledger-core
    // model time. The NS importer registers a PartyRole row for each
    // Customer/Vendor; we filter by it for defense in depth (catches
    // any party that has lineage but lost the role row).
    roles: {
      some: { role: nsRoleKind },
    },
  };
  for (const f of filters) {
    if (f.field === "internalid") {
      if (f.operator === "EQUALS") where.sourceRecordId = f.values[0];
      else if (f.operator === "ANYOF") where.sourceRecordId = { in: f.values };
    } else if (f.field === "entityid") {
      if (f.operator === "EQUALS") where.code = f.values[0];
      else if (f.operator === "ANYOF") where.code = { in: f.values };
    } else if (f.field === "companyname") {
      if (f.operator === "EQUALS") where.displayName = f.values[0];
      else if (f.operator === "ANYOF") where.displayName = { in: f.values };
    }
  }
  return where;
}

function buildItemWhere(
  filters: SavedSearchFilter[]
): Record<string, unknown> {
  const where: Record<string, unknown> = {
    sourceSystem: "NETSUITE",
    sourceRecordType: "Item",
  };
  for (const f of filters) {
    if (f.field === "internalid") {
      if (f.operator === "EQUALS") where.sourceRecordId = f.values[0];
      else if (f.operator === "ANYOF") where.sourceRecordId = { in: f.values };
    } else if (f.field === "itemid") {
      if (f.operator === "EQUALS") where.code = f.values[0];
      else if (f.operator === "ANYOF") where.code = { in: f.values };
    } else if (f.field === "displayname") {
      if (f.operator === "EQUALS") where.name = f.values[0];
      else if (f.operator === "ANYOF") where.name = { in: f.values };
    } else if (f.field === "itemtype") {
      // ledger-core's ItemType enum is INVENTORY / SERVICE / etc.
      // NS uses InvtPart / Service / NonInvtPart / etc. The mapping
      // is one-shot per import (v0.6) — the saved-search filter
      // matches by ledger-core's enum value, not NS's. Operators
      // wanting NS-side values run a follow-up enum-translation step.
      if (f.operator === "EQUALS") where.itemType = f.values[0];
      else if (f.operator === "ANYOF") where.itemType = { in: f.values };
    }
  }
  return where;
}

function buildTransactionWhere(
  filters: SavedSearchFilter[]
): Record<string, unknown> {
  const where: Record<string, unknown> = {
    sourceSystem: "NETSUITE", // saved search returns NS-imported JEs only
  };
  for (const f of filters) {
    if (f.field === "internalid") {
      if (f.operator === "EQUALS") where.sourceRecordId = f.values[0];
      else if (f.operator === "ANYOF") where.sourceRecordId = { in: f.values };
    } else if (f.field === "type") {
      if (f.operator === "EQUALS") where.sourceRecordType = f.values[0];
      else if (f.operator === "ANYOF") where.sourceRecordType = { in: f.values };
    } else if (f.field === "tranid") {
      if (f.operator === "EQUALS") where.entryNumber = f.values[0];
      else if (f.operator === "ANYOF") where.entryNumber = { in: f.values };
    } else if (f.field === "memo") {
      if (f.operator === "EQUALS") where.memo = f.values[0];
      else if (f.operator === "ANYOF") where.memo = { in: f.values };
    } else if (f.field === "trandate") {
      const dateField = "documentDate";
      if (f.operator === "EQUALS") {
        where[dateField] = new Date(String(f.values[0]));
      } else if (f.operator === "WITHIN") {
        where[dateField] = {
          gte: new Date(String(f.values[0])),
          lte: new Date(String(f.values[1])),
        };
      } else if (f.operator === "GREATER_THAN") {
        where[dateField] = { gt: new Date(String(f.values[0])) };
      } else if (f.operator === "LESS_THAN") {
        where[dateField] = { lt: new Date(String(f.values[0])) };
      }
    } else if (f.field === "amount") {
      // amount comparisons run against JournalLine.debit/credit; we
      // approximate by aggregating per-JE in a follow-up. Phase 4
      // accepts the filter shape but documents that amount filter is
      // a no-op until the aggregation lands.
      // Deliberately do nothing for now.
    }
  }
  return where;
}

// ─── Run the query ──────────────────────────────────────────────────

export async function runSavedSearch(
  prisma: PrismaClient,
  input: { tenantId: string; request: SavedSearchRequest }
): Promise<SavedSearchResult> {
  const { request } = input;
  const skip = (request.page! - 1) * request.pageSize!;
  const take = request.pageSize!;

  if (request.searchType === "Account") {
    const where = {
      ...buildAccountWhere(request.filters ?? []),
      tenantId: input.tenantId,
    };
    const [total, accounts] = await Promise.all([
      prisma.account.count({ where }),
      prisma.account.findMany({
        where,
        select: {
          sourceRecordId: true,
          code: true,
          name: true,
          type: true,
          active: true,
        },
        orderBy: { code: "asc" },
        skip,
        take,
      }),
    ]);
    const cols = (request.columns ?? []).map((c) => c.field);
    const includeAll = cols.length === 0;
    return {
      rows: accounts.map((a) => {
        const full: Record<string, unknown> = {
          internalid: a.sourceRecordId ?? "",
          acctnumber: a.code,
          acctname: a.name,
          accttype: a.type,
          isinactive: a.active ? "F" : "T",
        };
        if (includeAll) return full;
        const projected: Record<string, unknown> = {};
        for (const c of cols) projected[c] = full[c];
        return projected;
      }),
      total,
      page: request.page!,
      pageSize: request.pageSize!,
    };
  }

  if (request.searchType === "Customer" || request.searchType === "Vendor") {
    const where = {
      ...buildPartyWhere(
        request.filters ?? [],
        request.searchType === "Customer" ? "CUSTOMER" : "VENDOR"
      ),
      tenantId: input.tenantId,
    };
    const [total, parties] = await Promise.all([
      prisma.party.count({ where }),
      prisma.party.findMany({
        where,
        select: {
          sourceRecordId: true,
          code: true,
          displayName: true,
        },
        orderBy: { code: "asc" },
        skip,
        take,
      }),
    ]);
    const cols = (request.columns ?? []).map((c) => c.field);
    const includeAll = cols.length === 0;
    return {
      rows: parties.map((p) => {
        const full: Record<string, unknown> = {
          internalid: p.sourceRecordId ?? "",
          entityid: p.code,
          companyname: p.displayName,
        };
        if (includeAll) return full;
        const projected: Record<string, unknown> = {};
        for (const c of cols) projected[c] = full[c];
        return projected;
      }),
      total,
      page: request.page!,
      pageSize: request.pageSize!,
    };
  }

  if (request.searchType === "Item") {
    const where = {
      ...buildItemWhere(request.filters ?? []),
      tenantId: input.tenantId,
    };
    const [total, items] = await Promise.all([
      prisma.item.count({ where }),
      prisma.item.findMany({
        where,
        select: {
          sourceRecordId: true,
          code: true,
          name: true,
          itemType: true,
        },
        orderBy: { code: "asc" },
        skip,
        take,
      }),
    ]);
    const cols = (request.columns ?? []).map((c) => c.field);
    const includeAll = cols.length === 0;
    return {
      rows: items.map((i) => {
        const full: Record<string, unknown> = {
          internalid: i.sourceRecordId ?? "",
          itemid: i.code,
          displayname: i.name,
          itemtype: i.itemType,
        };
        if (includeAll) return full;
        const projected: Record<string, unknown> = {};
        for (const c of cols) projected[c] = full[c];
        return projected;
      }),
      total,
      page: request.page!,
      pageSize: request.pageSize!,
    };
  }

  // searchType === "Transaction"
  const where = {
    ...buildTransactionWhere(request.filters ?? []),
    tenantId: input.tenantId,
  };
  const [total, entries] = await Promise.all([
    prisma.journalEntry.count({ where }),
    prisma.journalEntry.findMany({
      where,
      select: {
        sourceRecordId: true,
        sourceRecordType: true,
        entryNumber: true,
        documentDate: true,
        memo: true,
      },
      orderBy: { documentDate: "desc" },
      skip,
      take,
    }),
  ]);
  const cols = (request.columns ?? []).map((c) => c.field);
  const includeAll = cols.length === 0;
  return {
    rows: entries.map((e) => {
      const full: Record<string, unknown> = {
        internalid: e.sourceRecordId ?? "",
        type: e.sourceRecordType ?? "",
        tranid: e.entryNumber,
        trandate: e.documentDate.toISOString().slice(0, 10),
        memo: e.memo,
        amount: null, // Phase 4 placeholder — aggregation in follow-up
      };
      if (includeAll) return full;
      const projected: Record<string, unknown> = {};
      for (const c of cols) projected[c] = full[c];
      return projected;
    }),
    total,
    page: request.page!,
    pageSize: request.pageSize!,
  };
}
