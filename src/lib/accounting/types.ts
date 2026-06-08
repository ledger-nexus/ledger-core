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
  // Multi-tenancy scope assertion. When provided, postJournalEntry rejects
  // the write if the resolved entity belongs to a different tenant —
  // catches a Server Action holding tenant A's session that tries to
  // post to an entity owned by tenant B. When omitted (legacy callers),
  // the engine resolves tenantId from the entity and tags the JE
  // automatically. New callers should ALWAYS pass this so cross-tenant
  // attempts are caught at the write layer.
  tenantId?: string;
  entityCode: string;
  bookCode?: string;                // default "US_GAAP"
  currencyCode?: string;            // default = entity's functional currency
  fxRate?: Decimal | string | number; // default 1
  documentDate: Date;
  postingDate?: Date;               // default = documentDate
  memo: string;
  source?: "MANUAL" | "SEED" | "SYSTEM" | "AI_APPROVED" | "IMPORT";

  lines: JournalLineInput[];

  // Acting user — audit string. Threaded into JournalEntry.createdBy.
  // Free-form (UUID, email, "SEED", "QBO_IMPORT", etc.) used for
  // human-readable audit display. NOT used to derive ownership.
  createdBy?: string;

  // Explicit owner. When set to a User UUID, the JE's ownerId is
  // populated and ON_INSERT rules fire after the entry posts. When
  // null (the default), the JE is left ownerless and ON_INSERT rules
  // do NOT fire — appropriate for seed paths and system-generated
  // entries. Server Action callers pass currentUser.id here.
  ownerUserId?: string;

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

// Raised when input.tenantId is supplied but doesn't match the tenant
// that owns the resolved LegalEntity. Indicates a cross-tenant attempt —
// e.g. a Server Action running as tenant A trying to write to an entity
// owned by tenant B. Caller's session is the source of truth; the
// engine refuses to silently switch tenants.
export class TenantScopeMismatchError extends Error {
  constructor(
    public claimedTenantId: string,
    public entityTenantId: string,
    public entityCode: string
  ) {
    super(
      `Tenant scope mismatch: caller claims tenant ${claimedTenantId} ` +
        `but entity ${entityCode} belongs to tenant ${entityTenantId}`
    );
    this.name = "TenantScopeMismatchError";
  }
}

// Raised when the resolved entity has no tenantId. Should not happen in
// v1+ (the Phase 1 multi-tenancy migration backfilled every row). If it
// does, it's a data-integrity bug — refusing to silently default to a
// global namespace.
export class EntityMissingTenantError extends Error {
  constructor(public entityCode: string) {
    super(
      `Entity ${entityCode} has no tenantId — data integrity error. ` +
        `Every entity must belong to a tenant (Phase 1 migration).`
    );
    this.name = "EntityMissingTenantError";
  }
}

// v0.9 NS Books Phase 3.5.D — raised when an AR/AP application attempts
// to bind a payment-side JE on one book to an OpenItem on a different
// book. In Pattern 2 multi-book ledger semantics, each book is its own
// independent GL — an application must stay within a single book or the
// per-book trial balance gets corrupted.
//
// Typical trigger: hand-built or AI-suggested apply that picked the
// wrong OpenItem from a multi-book set. The NS importer's Phase 3.5.B
// path matches book correctly via the per-book lookup map, but Server
// Actions / API endpoints calling applyArPayment / applyApPayment
// directly need this guard.
export class CrossBookApplicationError extends Error {
  constructor(
    public openItemId: string,
    public openItemBookCode: string,
    public appliedByEntryId: string,
    public appliedByEntryBookCode: string
  ) {
    super(
      `Cross-book application refused: payment JE ${appliedByEntryId} ` +
        `posted on book ${appliedByEntryBookCode} cannot apply to ` +
        `open item ${openItemId} on book ${openItemBookCode}. ` +
        `Apply on the matching-book payment JE instead.`
    );
    this.name = "CrossBookApplicationError";
  }
}
