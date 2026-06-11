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
}
