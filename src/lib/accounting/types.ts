// Domain types for the ledger.
//
// We use Decimal.js for all monetary math. NEVER use JavaScript numbers
// for money — 0.1 + 0.2 !== 0.3 will eventually cost you a balance sheet.

import { Decimal } from "decimal.js";

export type AccountType = "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
export type NormalBalance = "DEBIT" | "CREDIT";

// The normal-balance side for each account type.
// Contra accounts flip this — handled explicitly via the `isContra` flag.
export const NORMAL_BALANCE_BY_TYPE: Record<AccountType, NormalBalance> = {
  ASSET: "DEBIT",
  LIABILITY: "CREDIT",
  EQUITY: "CREDIT",
  REVENUE: "CREDIT",
  EXPENSE: "DEBIT",
};

// What sign to apply when summing into a balance-sheet or P&L total.
// For an Asset account with a debit balance, debits add, credits subtract.
// For a Liability, the opposite.
export function signFor(type: AccountType, isContra: boolean): 1 | -1 {
  const normal = NORMAL_BALANCE_BY_TYPE[type];
  const effective: NormalBalance = isContra
    ? normal === "DEBIT" ? "CREDIT" : "DEBIT"
    : normal;
  return effective === "DEBIT" ? 1 : -1;
}

// A line as it's passed INTO the posting function.
// `accountCode` is resolved against the (entity, code) unique pair, falling
// back to the shared chart (entityId = null) if no entity-specific account.
//
// Sub-ledger keys (partyCode, itemCode) and dimension data are nullable;
// the schema slots are present, but v1 callers don't need to populate them.
export interface JournalLineInput {
  accountCode: string;
  debit?: Decimal | string | number;
  credit?: Decimal | string | number;
  description?: string;

  // Sub-ledger keys — when set, the line contributes to a sub-ledger
  // lifecycle (open-item tracking arrives in the next batch).
  partyCode?: string;
  itemCode?: string;

  // Three-currency view. v1 callers can omit; the posting function fills in
  // transactionAmount/reportingAmount = (debit - credit) and the line's
  // currency = the header currency.
  transactionAmount?: Decimal | string | number;
  reportingAmount?: Decimal | string | number;

  extensions?: Record<string, unknown>;
}

// Input shape for postJournalEntry.
//
// Required keys (entityCode, bookCode, currencyCode) are LOAD-BEARING.
// The schema cannot have a balanced trial balance without knowing which
// (entity, book) the lines belong to.
export interface JournalEntryInput {
  entityCode: string;
  bookCode?: string;                // default "US_GAAP"
  currencyCode?: string;            // default = entity's functional currency
  fxRate?: Decimal | string | number; // default 1
  documentDate: Date;
  postingDate?: Date;               // default = documentDate
  memo: string;
  source?: "MANUAL" | "SEED" | "SYSTEM" | "AI_APPROVED" | "IMPORT";

  lines: JournalLineInput[];

  // Lineage — populated on ERP import. v1 native callers leave null.
  sourceSystem?: string;
  sourceRecordType?: string;
  sourceRecordId?: string;
  sourcePayload?: unknown;
  mappingVersion?: string;
  extensions?: Record<string, unknown>;
}

// Custom error types so the API layer can produce useful messages.
export class UnbalancedEntryError extends Error {
  constructor(public debitTotal: Decimal, public creditTotal: Decimal) {
    super(
      `Entry is unbalanced: debits ${debitTotal.toFixed(2)} ≠ credits ${creditTotal.toFixed(2)}`
    );
    this.name = "UnbalancedEntryError";
  }
}

export class InvalidLineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidLineError";
  }
}

export class UnknownAccountError extends Error {
  constructor(public accountCode: string) {
    super(`No active account found with code "${accountCode}"`);
    this.name = "UnknownAccountError";
  }
}

export class UnknownEntityError extends Error {
  constructor(public entityCode: string) {
    super(`No entity found with code "${entityCode}"`);
    this.name = "UnknownEntityError";
  }
}

export class UnknownBookError extends Error {
  constructor(public bookCode: string) {
    super(`No active book found with code "${bookCode}"`);
    this.name = "UnknownBookError";
  }
}

export class PeriodClosedError extends Error {
  constructor(public entityCode: string, public bookCode: string, public periodCode: string) {
    super(`Period ${periodCode} is closed for (${entityCode}, ${bookCode})`);
    this.name = "PeriodClosedError";
  }
}

export class AccountBookScopeError extends Error {
  constructor(public accountCode: string, public bookCode: string) {
    super(`Account ${accountCode} is not in scope for book ${bookCode}`);
    this.name = "AccountBookScopeError";
  }
}
