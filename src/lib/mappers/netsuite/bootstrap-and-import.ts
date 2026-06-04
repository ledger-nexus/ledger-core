// Composition helper: bootstrap (Subsidiary + AccountingBook +
// AccountingPeriod) THEN the transaction-layer import (Account +
// Party + Item + Invoice + Bill + Payment + JE).
//
// The existing importFromNs assumes the target entity (`entityCode`)
// already exists. For a fresh NetSuite import, bootstrap must run
// first to create the LegalEntity + FiscalCalendar + Periods + Books.
//
// This helper is additive — it doesn't change importFromNs. Callers
// who already have entities/books/periods can keep calling
// importFromNs directly. Callers with a clean slate import the
// whole thing via this composition.

import type { PrismaClient } from "@prisma/client";
import {
  importSubsidiaries,
  importAccountingBooks,
  importAccountingPeriods,
  nsSubsidiaryCode,
  nsBookCode,
  nsCalendarCode,
  type NsSubsidiaryBootstrap,
  type NsAccountingBookBootstrap,
  type NsAccountingPeriodBootstrap,
  type ImportSubsidiariesResult,
  type ImportAccountingBooksResult,
  type ImportAccountingPeriodsResult,
} from "./bootstrap";
import {
  importFromNs,
  type ImportFromNsInput,
  type ImportFromNsResult,
} from "./import";

export interface BootstrapAndImportInput {
  /** The tenant ID — every created row scopes here. */
  tenantId: string;
  /**
   * Bootstrap data — subsidiaries, books, and periods to create
   * BEFORE the transaction import runs. Optional: omit if entities
   * already exist (in which case use importFromNs directly).
   */
  bootstrap: {
    subsidiaries: NsSubsidiaryBootstrap[];
    accountingBooks?: NsAccountingBookBootstrap[];
    accountingPeriods?: NsAccountingPeriodBootstrap[];
  };
  /**
   * The NetSuite subsidiary ID that will own the imported
   * transactions. Resolved to ledger-core's entityCode via the
   * NSSUB-{id} convention.
   */
  primarySubsidiaryId: string;
  /**
   * The NetSuite accounting_book ID that will own the imported
   * transactions. Resolved to NSBOOK-{id} convention. If omitted,
   * importFromNs defaults to US_GAAP.
   */
  primaryBookId?: string;
  /** Pass-through to importFromNs. */
  transactionImport: Omit<ImportFromNsInput, "entityCode" | "bookCode">;
}

export interface BootstrapAndImportResult {
  bootstrap: {
    subsidiaries: ImportSubsidiariesResult;
    accountingBooks: ImportAccountingBooksResult;
    accountingPeriods: ImportAccountingPeriodsResult | null;
  };
  transactions: ImportFromNsResult;
  /**
   * The codes resolved + used for the transaction import. Useful for
   * the caller to verify the bootstrap landed where expected before
   * downstream code references them.
   */
  resolvedCodes: {
    entityCode: string;
    bookCode: string;
    fiscalCalendarCode: string;
  };
}

/**
 * Run the bootstrap (Subsidiary + AccountingBook + AccountingPeriod)
 * then the transaction-layer importFromNs in one call.
 *
 * Idempotent end-to-end: re-running with the same input produces
 * zero new rows across both layers.
 *
 * Order of operations:
 *   1. importSubsidiaries — creates LegalEntity + FiscalCalendar per sub
 *   2. importAccountingBooks — creates Book rows
 *   3. importAccountingPeriods — creates Period rows under the primary
 *      subsidiary's FiscalCalendar
 *   4. importFromNs — runs the existing transaction-layer import
 *      against the now-bootstrapped entity + book
 *
 * The primary subsidiary's FiscalCalendar is used for period import.
 * If you need multi-subsidiary period imports, call
 * importAccountingPeriods per (subsidiary, calendar) directly.
 */
export async function importFromNsWithBootstrap(
  prisma: PrismaClient,
  input: BootstrapAndImportInput
): Promise<BootstrapAndImportResult> {
  // 1. Subsidiaries (+ per-entity FiscalCalendar)
  const subsResult = await importSubsidiaries(
    prisma,
    input.tenantId,
    input.bootstrap.subsidiaries,
    input.transactionImport.mappingVersion
  );

  // 2. Accounting books
  const booksResult = input.bootstrap.accountingBooks
    ? await importAccountingBooks(
        prisma,
        input.bootstrap.accountingBooks,
        input.transactionImport.mappingVersion
      )
    : {
        booksCreated: 0,
        booksSkipped: 0,
        errors: [],
      };

  // Resolve the primary subsidiary's fiscal calendar code from the
  // bootstrap input — we need it to scope the period import.
  const primarySub = input.bootstrap.subsidiaries.find(
    (s) => s.internalid === input.primarySubsidiaryId
  );
  if (!primarySub) {
    throw new Error(
      `primarySubsidiaryId ${input.primarySubsidiaryId} not found in bootstrap.subsidiaries`
    );
  }
  const primaryEntityCode = nsSubsidiaryCode(primarySub.internalid);
  const fiscalCalendarCode = nsCalendarCode(
    primaryEntityCode,
    primarySub.fiscal_calendar
  );

  // 3. Accounting periods (scoped to the primary subsidiary's calendar)
  const periodsResult = input.bootstrap.accountingPeriods
    ? await importAccountingPeriods(
        prisma,
        input.tenantId,
        fiscalCalendarCode,
        input.bootstrap.accountingPeriods,
        input.transactionImport.mappingVersion
      )
    : null;

  // 4. Transaction-layer import
  const bookCode = input.primaryBookId
    ? nsBookCode(input.primaryBookId)
    : "US_GAAP";

  const txResult = await importFromNs(prisma, {
    ...input.transactionImport,
    entityCode: primaryEntityCode,
    bookCode,
  });

  return {
    bootstrap: {
      subsidiaries: subsResult,
      accountingBooks: booksResult,
      accountingPeriods: periodsResult,
    },
    transactions: txResult,
    resolvedCodes: {
      entityCode: primaryEntityCode,
      bookCode,
      fiscalCalendarCode,
    },
  };
}
