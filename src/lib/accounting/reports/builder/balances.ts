// Layer 1: Math primitive.
//
// Extracted from getTrialBalance's account-balance aggregation, but
// returns a Map<accountCode, AccountBalance> instead of an array. The
// row engine consumes the map — O(1) lookups by code beat repeated
// array filtering.
//
// Two query modes:
//
//   Point-in-time (BS, Equity ending):
//     getAccountBalances({ entityCode, bookCode, asOf })
//     → sums all lines through asOf (since inception)
//
//   Period activity (IS, Cash Flow):
//     getAccountBalances({ entityCode, bookCode, fromDate, toDate })
//     → sums lines whose entry.documentDate ∈ [fromDate, toDate]
//
// Note: this primitive does NOT apply ASC 830 translation, NOT compute
// consolidation, NOT do sign-flips. Those are presentation concerns.
// The math layer just returns raw Decimal balances per Account.

import { Decimal } from "decimal.js";
import type { PrismaClient, Prisma, AccountType } from "@prisma/client";

import { LEDGER_EFFECTIVE_STATUSES } from "@/lib/accounting/types";
import type { AccountFilter } from "./types";

type DbClient = PrismaClient | Prisma.TransactionClient;

export interface AccountBalance {
  code: string;
  name: string;
  type: AccountType;
  subtype: string | null;
  debit: Decimal;
  credit: Decimal;
  /** Signed balance: debit-positive for ASSET/EXPENSE, credit-positive for LIABILITY/EQUITY/REVENUE. */
  balance: Decimal;
  isContra: boolean;
  parentCode: string | null;
}

export type AccountBalances = Map<string, AccountBalance>;

export interface BalanceQueryScope {
  entityCode: string;
  bookCode: string;
  tenantId?: string;
  /** Point-in-time query — sums all activity through asOf. */
  asOf?: Date;
  /** Period activity query — sums activity in [fromDate, toDate]. */
  fromDate?: Date;
  toDate?: Date;
}

/**
 * Fetch balances for a scope. Returns Map keyed by account code.
 *
 * Multi-tenant: callers must provide tenantId. When RLS Phase 3 lands
 * (deficiency #12), the GUC handles scoping; for now, every query
 * adds the tenant filter at the application layer.
 */
export async function getAccountBalances(
  prisma: DbClient,
  scope: BalanceQueryScope,
  filter?: AccountFilter
): Promise<AccountBalances> {
  // Resolve entity + book to ids. (Same pattern as reports.ts —
  // duplicated here intentionally so the builder can be moved to its
  // own module later without dragging the legacy reports.ts.)
  const entity = await prisma.legalEntity.findFirst({
    where: {
      code: scope.entityCode,
      ...(scope.tenantId ? { tenantId: scope.tenantId } : {}),
    },
    select: { id: true, tenantId: true },
  });
  if (!entity) {
    throw new Error(`Entity not found: ${scope.entityCode}`);
  }

  const book = await prisma.book.findFirst({
    where: { code: scope.bookCode },
    select: { id: true },
  });
  if (!book) {
    throw new Error(`Book not found: ${scope.bookCode}`);
  }

  // Build the JE.documentDate filter from query mode.
  let entryDateFilter: Prisma.JournalEntryWhereInput["documentDate"];
  if (scope.asOf) {
    entryDateFilter = { lte: scope.asOf };
  } else if (scope.fromDate && scope.toDate) {
    entryDateFilter = { gte: scope.fromDate, lte: scope.toDate };
  } else {
    throw new Error("getAccountBalances: need asOf OR (fromDate + toDate)");
  }

  // Query accounts + their lines for this (entity, book) in scope.
  const accounts = await prisma.account.findMany({
    where: {
      active: true,
      // Multi-tenancy guard: only this tenant's accounts.
      ...(entity.tenantId ? { tenantId: entity.tenantId } : {}),
      // Account can be entity-scoped or global (entityId: null).
      OR: [{ entityId: null }, { entityId: entity.id }],
      // Apply filter at the query layer where possible (cheaper than
      // post-filtering). includeCodes wins absolutely.
      ...(filter?.includeCodes && filter.includeCodes.length > 0
        ? { code: { in: filter.includeCodes } }
        : {
            ...(filter?.types && filter.types.length > 0 ? { type: { in: filter.types } } : {}),
            ...(filter?.subtypes && filter.subtypes.length > 0
              ? { subtype: { in: filter.subtypes } }
              : {}),
            ...(filter?.parentCodes && filter.parentCodes.length > 0
              ? { parent: { code: { in: filter.parentCodes } } }
              : {}),
            ...(filter?.excludeCodes && filter.excludeCodes.length > 0
              ? { code: { notIn: filter.excludeCodes } }
              : {}),
            ...(filter?.excludeSubtypes && filter.excludeSubtypes.length > 0
              ? { subtype: { notIn: filter.excludeSubtypes } }
              : {}),
          }),
    },
    include: {
      lines: {
        where: {
          entry: {
            entityId: entity.id,
            bookId: book.id,
            documentDate: entryDateFilter,
            // Maker-checker: only ledger-effective entries reach a report.
            // A DRAFT or PENDING_APPROVAL entry is not yet part of the
            // ledger; VOID never is. Same filter as reports.ts.
            status: { in: [...LEDGER_EFFECTIVE_STATUSES] },
          },
        },
        select: { debit: true, credit: true },
      },
      parent: { select: { code: true } },
    },
    orderBy: { code: "asc" },
  });

  // Dedup: entity-specific overrides global (same as getTrialBalance).
  const byCode = new Map<string, (typeof accounts)[number]>();
  for (const a of accounts) {
    const existing = byCode.get(a.code);
    if (!existing || (a.entityId !== null && existing.entityId === null)) {
      byCode.set(a.code, a);
    }
  }

  // Build the balance map.
  const balances: AccountBalances = new Map();
  for (const acct of byCode.values()) {
    let debit = new Decimal(0);
    let credit = new Decimal(0);
    for (const line of acct.lines) {
      debit = debit.plus(new Decimal(line.debit.toString()));
      credit = credit.plus(new Decimal(line.credit.toString()));
    }

    // Signed balance: ALWAYS `debit − credit`. Positive = net debit,
    // negative = net credit. This is the GL-natural signed math.
    // Presentation flips (e.g. revenue presented positive even though
    // credit-normal) are handled by RowDef.signFlip in the template,
    // not by the math primitive. Consistent shape across all rows
    // keeps the row engine arithmetic predictable: SUM, FORMULA, and
    // SUBTOTAL all operate on signed numbers without per-row sign
    // bookkeeping.
    const balance = debit.minus(credit);

    balances.set(acct.code, {
      code: acct.code,
      name: acct.name,
      type: acct.type,
      subtype: acct.subtype,
      debit,
      credit,
      balance,
      isContra: acct.isContra,
      parentCode: acct.parent?.code ?? null,
    });
  }

  return balances;
}

/**
 * Apply a filter to an already-fetched balance map. Used by row engine
 * when one balance map is reused across multiple rows with different
 * filters — avoids re-querying.
 */
export function filterBalances(balances: AccountBalances, filter: AccountFilter): AccountBalance[] {
  // includeCodes wins absolutely. Semantics:
  //   - undefined  → not present, no filter constraint, fall through to others
  //   - []         → explicitly empty, match NOTHING (returns [])
  //   - non-empty  → match only these codes
  if (filter.includeCodes !== undefined) {
    const out: AccountBalance[] = [];
    for (const b of balances.values()) {
      if (filter.includeCodes.includes(b.code)) out.push(b);
    }
    return out;
  }

  const out: AccountBalance[] = [];
  for (const b of balances.values()) {
    let matches = true;
    if (filter.types && filter.types.length > 0 && !filter.types.includes(b.type)) {
      matches = false;
    }
    if (matches && filter.subtypes && filter.subtypes.length > 0) {
      if (!b.subtype || !filter.subtypes.includes(b.subtype)) matches = false;
    }
    if (matches && filter.parentCodes && filter.parentCodes.length > 0) {
      if (!b.parentCode || !filter.parentCodes.includes(b.parentCode)) matches = false;
    }
    if (matches && filter.excludeCodes && filter.excludeCodes.includes(b.code)) {
      matches = false;
    }
    if (
      matches &&
      filter.excludeSubtypes &&
      filter.excludeSubtypes.length > 0 &&
      b.subtype &&
      filter.excludeSubtypes.includes(b.subtype)
    ) {
      matches = false;
    }

    if (matches) out.push(b);
  }
  return out;
}
