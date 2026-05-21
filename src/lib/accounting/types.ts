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

// A line as it's passed INTO the posting function — accountCode + debit/credit.
// We accept Decimal | string | number; the posting function normalizes them.
export interface JournalLineInput {
  accountCode: string;
  debit?: Decimal | string | number;
  credit?: Decimal | string | number;
  description?: string;
}

export interface JournalEntryInput {
  date: Date;
  memo: string;
  source?: "MANUAL" | "SEED" | "SYSTEM" | "AI_APPROVED";
  lines: JournalLineInput[];
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
