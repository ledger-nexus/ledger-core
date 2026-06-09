// NetSuite SuiteAnalytics / SuiteScript export shape types.
//
// Hand-rolled from the NetSuite REST API documentation and the typical
// SuiteScript record JSON shape. Field naming matches NS conventions:
//   - `internalid` / `externalid` are the NS-side identifiers
//   - `tranid` is the transaction number ("INV-001", "JE-2026-001")
//   - `custbody_*` are custom body fields on transactions
//   - `custcol_*` are custom column fields on transaction lines
//   - `custentity_*` are custom fields on entities (customers / vendors)
//
// The shape diverges from QBO in two important ways:
//   1. Transaction lines carry FIRST-CLASS dimension fields (class,
//      department, location) plus arbitrary custom segments (custcol_*).
//      QBO has Class only on the entire transaction; NetSuite drops down
//      to the line level and adds Department + Location built-in.
//   2. Multi-subsidiary is everywhere — every transaction has a
//      `subsidiary` field. Single-subsidiary deployments still populate it.

export interface NsRef {
  internalid: string;
  name?: string;
}

// ---- Master records --------------------------------------------------

export interface NsSubsidiary {
  internalid: string;
  name: string;
  iselimination: boolean;     // true for intercompany elimination subs
  currency: string;
  country?: string;
  parent?: NsRef;             // for OneWorld hierarchies; null for top-level
}

// v0.8 NS Accounting Books — multi-book parallel posting.
//
// Real OneWorld NS tenants carry multiple books per company
// (US_GAAP, US_TAX, IFRS, MGMT). Each book is an independent GL
// view, optionally with different exchange rates, depreciation
// methods, or revenue recognition treatments. ledger-core's
// Pattern 2 multi-book substrate handles this natively — one JE
// per (entity, book) — but the importer needs to read the NS
// AccountingBook array + per-transaction bookspecific[] to drive
// the per-book posts.
//
// Design: docs/netsuite-accounting-books-design.md
export interface NsAccountingBook {
  internalid: string;
  name: string;                 // "US GAAP" / "US TAX" / "IFRS" / etc.
  /**
   * Adjustment-only books only carry deltas vs a base book (e.g.
   * a US_TAX_ADJ book carries TAX-specific differences from
   * US_GAAP). Phase 1 treats this as metadata only — no special
   * posting logic. Future polish (phase 4+) may add filtering.
   */
  isadjustment?: boolean;
  /**
   * The book's basis. NS doesn't always populate this, but when
   * present it informs the ledger-core Book.basis mapping. Common
   * values: "GAAP", "IFRS", "TAX".
   */
  basis?: string;
  /**
   * The book's functional currency. Phase 1 assumes this equals
   * the subsidiary's functional currency (the typical case).
   * Per-book currency divergence is deferred to a future phase.
   */
  currency?: string;
}

/**
 * Per-book values attached to a transaction. NS exports these
 * inside each transaction's `bookspecific[]` when the books
 * diverge. When absent, all books use the transaction's header
 * values (currency, exchangerate, amounts).
 *
 * Phase 1 reads only the exchangerate (the most common
 * divergence point). Per-book amount overrides arrive in
 * Phase 3+ when the importer wires them through.
 */
export interface NsBookSpecific {
  /** The NS AccountingBook this entry applies to. */
  accountingbook: string;
  /** Per-book transaction rate. Falls back to the txn header. */
  exchangerate?: number | string;
}

export type NsAccountType =
  | "Bank"
  | "AcctRec"
  | "OthCurrAsset"
  | "FixedAsset"
  | "OthAsset"
  | "AcctPay"
  | "CredCard"
  | "OthCurrLiab"
  | "LongTermLiab"
  | "Equity"
  | "Income"
  | "OthIncome"
  | "COGS"
  | "Expense"
  | "OthExpense";

export interface NsAccount {
  internalid: string;
  acctnumber: string;
  acctname: string;
  accttype: NsAccountType;
  issummary: boolean;
  isinactive: boolean;
  parent?: NsRef;
  subsidiary?: string;        // restrict to one subsidiary; usually null
}

export interface NsClassification {
  internalid: string;
  name: string;
  isinactive: boolean;
}

export interface NsDepartment {
  internalid: string;
  name: string;
  isinactive: boolean;
}

export interface NsLocation {
  internalid: string;
  name: string;
  isinactive: boolean;
}

export interface NsCustomSegmentValue {
  internalid: string;
  name: string;
}

export interface NsCustomSegment {
  internalid: string;            // e.g. "custcol_region"
  name: string;
  description?: string;
  values: NsCustomSegmentValue[];
}

export interface NsCustomer {
  internalid: string;
  entityid: string;              // human-readable code, e.g. "C-ACME"
  companyname: string;
  isinactive: boolean;
  subsidiary?: string;
  // Custom entity fields (custentity_*) come through as arbitrary keys.
  [key: string]: unknown;
}

export interface NsVendor {
  internalid: string;
  entityid: string;
  companyname: string;
  isinactive: boolean;
  subsidiary?: string;
  [key: string]: unknown;
}

export interface NsItem {
  internalid: string;
  itemid: string;
  displayname: string;
  itemtype: "Service" | "InvtPart" | "NonInvtPart" | "Group" | "Kit" | "Assembly";
  isinactive: boolean;
  incomeaccount?: string;
  expenseaccount?: string;
  cogsaccount?: string;
}

// ---- Transactions ---------------------------------------------------

// Lines on transactions carry the FIRST-CLASS dimensions (class /
// department / location) plus any number of custom segments (keys
// starting with `custcol_*`).
export interface NsTransactionLine {
  linesequencenumber: number;
  account: string;
  amount?: number;          // for invoice / bill lines
  debit?: number;           // for journal entry lines
  credit?: number;          // for journal entry lines
  memo?: string;
  class?: string | null;
  department?: string | null;
  location?: string | null;
  item?: string;
  // Custom segment refs live as additional keys on the line, e.g.
  // line.custcol_region = "100" (the internalid of the segment value).
  [key: string]: unknown;
}

export interface NsInvoice {
  internalid: string;
  tranid: string;
  trandate: string;
  duedate?: string;
  subsidiary: string;
  entity: string;                // customer internalid
  total: number;
  amountremaining: number;
  currency: string;
  /**
   * NS-supplied transaction-time FX rate (transaction currency →
   * subsidiary's base currency, which in our model = the book's
   * reporting currency in the typical single-book case).
   *
   * When present, the v0.8 importer prefers this rate over the seeded
   * FxRate row — NS's posting-time rate is the authoritative one for
   * each transaction. NS-supplied rates may be a number or a
   * pre-formatted string ("1.27000"); the importer normalizes both.
   */
  exchangerate?: number | string;
  lines: NsTransactionLine[];
  [key: string]: unknown;        // custbody_* custom fields
}

export interface NsVendorBill {
  internalid: string;
  tranid: string;
  trandate: string;
  duedate?: string;
  subsidiary: string;
  entity: string;                // vendor internalid
  total: number;
  amountremaining: number;
  currency: string;
  /** See NsInvoice.exchangerate. */
  exchangerate?: number | string;
  lines: NsTransactionLine[];
  [key: string]: unknown;
}

export interface NsCustomerPayment {
  internalid: string;
  trandate: string;
  subsidiary: string;
  entity: string;
  total: number;
  currency: string;
  /** See NsInvoice.exchangerate. */
  exchangerate?: number | string;
  depositaccount: string;
  apply: { doc: string; amount: number }[];
}

export interface NsVendorPayment {
  internalid: string;
  trandate: string;
  subsidiary: string;
  entity: string;
  total: number;
  currency: string;
  /** See NsInvoice.exchangerate. */
  exchangerate?: number | string;
  account: string;
  apply: { doc: string; amount: number }[];
}

export interface NsJournalEntry {
  internalid: string;
  tranid: string;
  trandate: string;
  subsidiary: string;
  /** See NsInvoice.exchangerate. */
  exchangerate?: number | string;
  memo?: string;
  lines: NsTransactionLine[];
}

// ---- Custom field definitions ---------------------------------------

export interface NsCustomFieldDefinition {
  internalid: string;           // e.g. "custbody_priority"
  label: string;
  fieldtype: "STRING" | "NUMBER" | "BOOLEAN" | "DATE" | "ENUM";
  appliesto: "transaction" | "customer" | "vendor" | "item" | "account";
  options?: string[];           // for ENUM
}

// ---- v0.9 Phase 3.5 multi-book sub-ledger snapshot -------------------
//
// NS itself stores ONE OpenItem per transaction — the book divergence is
// implicit (a single AR balance carries the same number across all the
// declared books). ledger-core's Pattern 2 substrate genuinely opens ONE
// item PER BOOK (per ar_open_item_lineage_uniq), so a $1,000 invoice on
// US_GAAP can carry a different current balance than the same invoice on
// US_TAX after a partial payment lands only on one book.
//
// The reverse exporter preserves that divergence by emitting a per-book
// state snapshot alongside the canonical NS records. This is NOT a
// vanilla NS shape — it's a ledger-core-specific extension. Consumers
// that don't care about per-book state can ignore the OpenItemState
// array; consumers that DO care get the full picture in one place.
//
// Only emitted when `exportToNs` runs in `bookResolution.mode: "multi"`.
// Single-mode exports keep the v0.6 shape (no OpenItemState key).
export type NsOpenItemSide = "Invoice" | "VendorBill";
export type NsOpenItemStatus =
  | "OPEN"
  | "PARTIAL"
  | "APPLIED"
  | "WRITTEN_OFF"
  | "REOPENED"
  | "VOID";

export interface NsOpenItemState {
  /** "Invoice" (AR) or "VendorBill" (AP). */
  sourceRecordType: NsOpenItemSide;
  /** The NS internalid of the originating Invoice / VendorBill. */
  sourceRecordId: string;
  /** The ledger-core book code this snapshot is scoped to. */
  bookCode: string;
  /** The ledger-core entity code this snapshot is scoped to. */
  entityCode: string;
  /** Decimal string — never a JS number (precision). */
  originalAmount: string;
  /** Decimal string — what's still outstanding on this book. */
  currentBalance: string;
  status: NsOpenItemStatus;
}

// ---- Top-level export shape ------------------------------------------

export interface NsExport {
  _meta?: {
    sourceSystem?: string;
    companyName?: string;
    exportedAt?: string;
    books?: string[];
    functionalCurrency?: string;
    fiscalYearStart?: string;
    comment?: string;
  };
  Subsidiary?: NsSubsidiary[];
  /**
   * v0.8 NS Accounting Books — declared books in the export. When
   * present and the importer runs in `bookResolution.mode: "multi"`,
   * each transaction posts to N books in parallel per the mapping.
   * When absent or in single-book mode, the importer uses the
   * legacy `bookCode` parameter.
   */
  AccountingBook?: NsAccountingBook[];
  Account?: NsAccount[];
  Class?: NsClassification[];
  Department?: NsDepartment[];
  Location?: NsLocation[];
  CustomSegment?: NsCustomSegment[];
  CustomFieldDefinition?: NsCustomFieldDefinition[];
  Customer?: NsCustomer[];
  Vendor?: NsVendor[];
  Item?: NsItem[];
  Invoice?: NsInvoice[];
  VendorBill?: NsVendorBill[];
  CustomerPayment?: NsCustomerPayment[];
  VendorPayment?: NsVendorPayment[];
  JournalEntry?: NsJournalEntry[];
  /**
   * v0.9 NS Books Phase 3.5 — per-book AR/AP OpenItem state. Only
   * emitted by `exportToNs` in `bookResolution.mode: "multi"`. See the
   * NsOpenItemState comment above for the rationale.
   */
  OpenItemState?: NsOpenItemState[];
}
