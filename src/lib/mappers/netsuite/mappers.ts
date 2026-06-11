// Pure mapping functions: NetSuite shape → ledger-core shape.
//
// Same architecture as the QBO mapper: no Prisma calls here, just
// deterministic data transformations. The orchestrator (import.ts) handles
// the DB writes and the dimension-set lookups.

import { Decimal } from "decimal.js";
import type {
  NsAccount,
  NsAccountType,
  NsCustomer,
  NsVendor,
  NsItem,
  NsInvoice,
  NsVendorBill,
  NsCustomerPayment,
  NsVendorPayment,
  NsJournalEntry,
  NsTransactionLine,
  NsSubsidiary,
  NsCustomSegment,
} from "./types";

// ---- Account type mapping ----------------------------------------

const NS_ACCOUNT_TYPE_TO_LEDGER: Record<
  NsAccountType,
  { type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE"; normalBalance: "DEBIT" | "CREDIT" }
> = {
  "Bank": { type: "ASSET", normalBalance: "DEBIT" },
  "AcctRec": { type: "ASSET", normalBalance: "DEBIT" },
  "OthCurrAsset": { type: "ASSET", normalBalance: "DEBIT" },
  "FixedAsset": { type: "ASSET", normalBalance: "DEBIT" },
  "OthAsset": { type: "ASSET", normalBalance: "DEBIT" },
  "AcctPay": { type: "LIABILITY", normalBalance: "CREDIT" },
  "CredCard": { type: "LIABILITY", normalBalance: "CREDIT" },
  "OthCurrLiab": { type: "LIABILITY", normalBalance: "CREDIT" },
  "LongTermLiab": { type: "LIABILITY", normalBalance: "CREDIT" },
  "Equity": { type: "EQUITY", normalBalance: "CREDIT" },
  "Income": { type: "REVENUE", normalBalance: "CREDIT" },
  "OthIncome": { type: "REVENUE", normalBalance: "CREDIT" },
  "COGS": { type: "EXPENSE", normalBalance: "DEBIT" },
  "Expense": { type: "EXPENSE", normalBalance: "DEBIT" },
  "OthExpense": { type: "EXPENSE", normalBalance: "DEBIT" },
};

// Prefix NS internal Ids in the ledger-core code field to avoid colliding
// with the native chart or with QBO-imported accounts.
export function nsAccountCode(internalId: string): string {
  return `NS${internalId}`;
}
export function nsCustomerCode(internalId: string): string {
  return `NSCUST-${internalId}`;
}
export function nsVendorCode(internalId: string): string {
  return `NSVEND-${internalId}`;
}
export function nsItemCode(internalId: string): string {
  return `NSITEM-${internalId}`;
}

// Dimension codes — NetSuite ships these three; customer-segment codes
// (custcol_*) are used verbatim as the dimension code.
export const NS_BUILTIN_DIMENSIONS = ["CLASS", "DEPARTMENT", "LOCATION"] as const;

export interface MappedAccount {
  code: string;
  name: string;
  type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
  normalBalance: "DEBIT" | "CREDIT";
  isContra: boolean;
  isControlAccount: boolean;
  isBank: boolean;
  active: boolean;
  sourceSystem: "NETSUITE";
  sourceRecordType: "Account";
  sourceRecordId: string;
  sourcePayload: NsAccount;
  mappingVersion: string;
}

export function mapNsAccount(ns: NsAccount, mappingVersion = "ns-v1"): MappedAccount {
  const lg = NS_ACCOUNT_TYPE_TO_LEDGER[ns.accttype];
  if (!lg) throw new Error(`Unmapped NS account type: ${ns.accttype}`);
  return {
    code: nsAccountCode(ns.internalid),
    name: ns.acctname,
    type: lg.type,
    normalBalance: lg.normalBalance,
    isContra: false,
    isControlAccount: ns.accttype === "AcctRec" || ns.accttype === "AcctPay",
    isBank: ns.accttype === "Bank",
    active: !ns.isinactive,
    sourceSystem: "NETSUITE",
    sourceRecordType: "Account",
    sourceRecordId: ns.internalid,
    sourcePayload: ns,
    mappingVersion,
  };
}

// ---- Party / Item mappers ---------------------------------------

export interface MappedParty {
  code: string;
  displayName: string;
  role: "CUSTOMER" | "VENDOR";
  customFields: Record<string, unknown>;
  sourceSystem: "NETSUITE";
  sourceRecordType: "Customer" | "Vendor";
  sourceRecordId: string;
  sourcePayload: NsCustomer | NsVendor;
  mappingVersion: string;
}

function extractCustomFields(record: Record<string, unknown>, prefix: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (k.startsWith(prefix)) out[k] = v;
  }
  return out;
}

export function mapNsCustomer(ns: NsCustomer, mappingVersion = "ns-v1"): MappedParty {
  return {
    code: nsCustomerCode(ns.internalid),
    displayName: ns.companyname,
    role: "CUSTOMER",
    customFields: extractCustomFields(ns as unknown as Record<string, unknown>, "custentity_"),
    sourceSystem: "NETSUITE",
    sourceRecordType: "Customer",
    sourceRecordId: ns.internalid,
    sourcePayload: ns,
    mappingVersion,
  };
}

export function mapNsVendor(ns: NsVendor, mappingVersion = "ns-v1"): MappedParty {
  return {
    code: nsVendorCode(ns.internalid),
    displayName: ns.companyname,
    role: "VENDOR",
    customFields: extractCustomFields(ns as unknown as Record<string, unknown>, "custentity_"),
    sourceSystem: "NETSUITE",
    sourceRecordType: "Vendor",
    sourceRecordId: ns.internalid,
    sourcePayload: ns,
    mappingVersion,
  };
}

export interface MappedItem {
  code: string;
  name: string;
  itemType: "INVENTORY" | "NON_INVENTORY" | "SERVICE" | "KIT" | "ASSEMBLY" | "FIXED_ASSET";
  defaultIncomeAccountCode?: string;
  defaultExpenseAccountCode?: string;
  sourceSystem: "NETSUITE";
  sourceRecordType: "Item";
  sourceRecordId: string;
  sourcePayload: NsItem;
  mappingVersion: string;
}

const NS_ITEM_TYPE_TO_LEDGER: Record<NsItem["itemtype"], MappedItem["itemType"]> = {
  "Service": "SERVICE",
  "InvtPart": "INVENTORY",
  "NonInvtPart": "NON_INVENTORY",
  "Group": "KIT",
  "Kit": "KIT",
  "Assembly": "ASSEMBLY",
};

export function mapNsItem(ns: NsItem, mappingVersion = "ns-v1"): MappedItem {
  return {
    code: nsItemCode(ns.internalid),
    name: ns.displayname,
    itemType: NS_ITEM_TYPE_TO_LEDGER[ns.itemtype] ?? "SERVICE",
    defaultIncomeAccountCode: ns.incomeaccount ? nsAccountCode(ns.incomeaccount) : undefined,
    defaultExpenseAccountCode: ns.expenseaccount ? nsAccountCode(ns.expenseaccount) : undefined,
    sourceSystem: "NETSUITE",
    sourceRecordType: "Item",
    sourceRecordId: ns.internalid,
    sourcePayload: ns,
    mappingVersion,
  };
}

// ---- Transaction line dimension extraction -----------------------

// Pulls dimension assignments off a transaction line. Returns the list
// of (dimensionCode, valueCode) pairs ready to feed into
// getOrCreateDimensionSet. Skips nulls and undefineds.
export interface DimensionAssignment {
  dimensionCode: string;
  valueCode: string;
}

export function extractDimensionAssignments(
  line: NsTransactionLine,
  customSegmentCodes: string[]
): DimensionAssignment[] {
  const out: DimensionAssignment[] = [];
  if (line.class) out.push({ dimensionCode: "CLASS", valueCode: line.class });
  if (line.department) out.push({ dimensionCode: "DEPARTMENT", valueCode: line.department });
  if (line.location) out.push({ dimensionCode: "LOCATION", valueCode: line.location });
  for (const seg of customSegmentCodes) {
    const v = (line as Record<string, unknown>)[seg];
    if (typeof v === "string" && v) {
      out.push({ dimensionCode: seg.toUpperCase(), valueCode: v });
    }
  }
  return out;
}

// ---- Transactions ------------------------------------------------

function fmt(n: number | string): string {
  return new Decimal(n).toFixed(4);
}

export interface MappedNsLine {
  accountCode: string;
  debit?: string;
  credit?: string;
  description?: string;
  partyCode?: string;
  itemCode?: string;
  dimensionAssignments: DimensionAssignment[];
}

export interface MappedNsJournalEntry {
  documentDate: Date;
  memo: string;
  currencyCode: string;
  lines: MappedNsLine[];
  customFields: Record<string, unknown>;
  sourceSystem: "NETSUITE";
  sourceRecordType: string;
  sourceRecordId: string;
  sourcePayload: unknown;
  mappingVersion: string;
}

export interface MappedNsArOpening {
  amount: string;
  customerCode: string;
  controlAccountCode: string;
  referenceNumber: string;
  openedDate: Date;
  dueDate: Date | null;
  currencyCode: string;
  sourceRecordType: "Invoice";
  sourceRecordId: string;
  sourcePayload: NsInvoice;
}
export interface MappedNsApOpening {
  amount: string;
  vendorCode: string;
  controlAccountCode: string;
  referenceNumber: string;
  openedDate: Date;
  dueDate: Date | null;
  currencyCode: string;
  sourceRecordType: "VendorBill";
  sourceRecordId: string;
  sourcePayload: NsVendorBill;
}
export interface MappedNsArApplication {
  appliedDate: Date;
  applications: { linkedInvoiceId: string; amount: string }[];
}
export interface MappedNsApApplication {
  appliedDate: Date;
  applications: { linkedBillId: string; amount: string }[];
}

export interface MappedNsInvoiceResult {
  entry: MappedNsJournalEntry;
  arOpening: MappedNsArOpening;
}
export interface MappedNsBillResult {
  entry: MappedNsJournalEntry;
  apOpening: MappedNsApOpening;
}
export interface MappedNsCustomerPaymentResult {
  entry: MappedNsJournalEntry;
  application: MappedNsArApplication;
}
export interface MappedNsVendorPaymentResult {
  entry: MappedNsJournalEntry;
  application: MappedNsApApplication;
}

function findArAccountCode(ns: NsInvoice): string {
  // NS doesn't carry AR account on the invoice header — it's determined
  // by subsidiary settings. For v0.6 we hardcode the default "1200"
  // (Accounts Receivable). An override is straightforward to add when a
  // real engagement carries non-default AR accounts.
  return nsAccountCode("1200");
}

function findApAccountCode(ns: NsVendorBill): string {
  return nsAccountCode("2000");
}

export function mapNsInvoice(
  ns: NsInvoice,
  customSegmentCodes: string[],
  mappingVersion = "ns-v1"
): MappedNsInvoiceResult {
  // NS invoice exports always carry a header total; a missing one means
  // a malformed export. Reject with a named error rather than letting
  // decimal.js throw "[DecimalError] Invalid argument: undefined".
  if (ns.total === undefined || ns.total === null) {
    throw new Error(
      `Invoice ${ns.tranid} (${ns.internalid}): missing required 'total' field`
    );
  }
  const total = new Decimal(ns.total);
  const arCode = findArAccountCode(ns);
  const customerCode = nsCustomerCode(ns.entity);
  const docDate = new Date(ns.trandate);
  const dueDate = ns.duedate ? new Date(ns.duedate) : null;

  const creditLines: MappedNsLine[] = ns.lines.map((line, idx) => ({
    accountCode: nsAccountCode(line.account),
    credit: fmt(line.amount ?? 0),
    description: line.memo ?? `Invoice line ${idx + 1}`,
    itemCode: line.item ? nsItemCode(line.item) : undefined,
    dimensionAssignments: extractDimensionAssignments(line, customSegmentCodes),
  }));

  const lines: MappedNsLine[] = [
    {
      accountCode: arCode,
      debit: total.toFixed(4),
      description: `AR — ${ns.tranid}`,
      partyCode: customerCode,
      dimensionAssignments: [],
    },
    ...creditLines,
  ];

  return {
    entry: {
      documentDate: docDate,
      memo: `Invoice ${ns.tranid}`,
      currencyCode: ns.currency,
      lines,
      customFields: extractCustomFields(ns as Record<string, unknown>, "custbody_"),
      sourceSystem: "NETSUITE",
      sourceRecordType: "Invoice",
      sourceRecordId: ns.internalid,
      sourcePayload: ns,
      mappingVersion,
    },
    arOpening: {
      amount: total.toFixed(4),
      customerCode,
      controlAccountCode: arCode,
      referenceNumber: ns.tranid,
      openedDate: docDate,
      dueDate,
      currencyCode: ns.currency,
      sourceRecordType: "Invoice",
      sourceRecordId: ns.internalid,
      sourcePayload: ns,
    },
  };
}

export function mapNsVendorBill(
  ns: NsVendorBill,
  customSegmentCodes: string[],
  mappingVersion = "ns-v1"
): MappedNsBillResult {
  const total = new Decimal(ns.total);
  const apCode = findApAccountCode(ns);
  const vendorCode = nsVendorCode(ns.entity);
  const docDate = new Date(ns.trandate);
  const dueDate = ns.duedate ? new Date(ns.duedate) : null;

  const debitLines: MappedNsLine[] = ns.lines.map((line, idx) => ({
    accountCode: nsAccountCode(line.account),
    debit: fmt(line.amount ?? 0),
    description: line.memo ?? `Bill line ${idx + 1}`,
    dimensionAssignments: extractDimensionAssignments(line, customSegmentCodes),
  }));

  const lines: MappedNsLine[] = [
    ...debitLines,
    {
      accountCode: apCode,
      credit: total.toFixed(4),
      description: `AP — ${ns.tranid}`,
      partyCode: vendorCode,
      dimensionAssignments: [],
    },
  ];

  return {
    entry: {
      documentDate: docDate,
      memo: `Bill ${ns.tranid}`,
      currencyCode: ns.currency,
      lines,
      customFields: extractCustomFields(ns as Record<string, unknown>, "custbody_"),
      sourceSystem: "NETSUITE",
      sourceRecordType: "VendorBill",
      sourceRecordId: ns.internalid,
      sourcePayload: ns,
      mappingVersion,
    },
    apOpening: {
      amount: total.toFixed(4),
      vendorCode,
      controlAccountCode: apCode,
      referenceNumber: ns.tranid,
      openedDate: docDate,
      dueDate,
      currencyCode: ns.currency,
      sourceRecordType: "VendorBill",
      sourceRecordId: ns.internalid,
      sourcePayload: ns,
    },
  };
}

export function mapNsCustomerPayment(
  ns: NsCustomerPayment,
  mappingVersion = "ns-v1"
): MappedNsCustomerPaymentResult {
  const total = new Decimal(ns.total);
  const customerCode = nsCustomerCode(ns.entity);
  const docDate = new Date(ns.trandate);
  const cashCode = nsAccountCode(ns.depositaccount);
  const arCode = nsAccountCode("1200");

  return {
    entry: {
      documentDate: docDate,
      memo: `Customer payment — ${ns.internalid}`,
      currencyCode: ns.currency,
      lines: [
        {
          accountCode: cashCode,
          debit: total.toFixed(4),
          description: "Cash receipt",
          dimensionAssignments: [],
        },
        {
          accountCode: arCode,
          credit: total.toFixed(4),
          partyCode: customerCode,
          description: `Apply against invoice(s) ${ns.apply.map((a) => a.doc).join(",")}`,
          dimensionAssignments: [],
        },
      ],
      customFields: {},
      sourceSystem: "NETSUITE",
      sourceRecordType: "CustomerPayment",
      sourceRecordId: ns.internalid,
      sourcePayload: ns,
      mappingVersion,
    },
    application: {
      appliedDate: docDate,
      applications: ns.apply.map((a) => ({ linkedInvoiceId: a.doc, amount: fmt(a.amount) })),
    },
  };
}

export function mapNsVendorPayment(
  ns: NsVendorPayment,
  mappingVersion = "ns-v1"
): MappedNsVendorPaymentResult {
  const total = new Decimal(ns.total);
  const vendorCode = nsVendorCode(ns.entity);
  const docDate = new Date(ns.trandate);
  const cashCode = nsAccountCode(ns.account);
  const apCode = nsAccountCode("2000");

  return {
    entry: {
      documentDate: docDate,
      memo: `Vendor payment — ${ns.internalid}`,
      currencyCode: ns.currency,
      lines: [
        {
          accountCode: apCode,
          debit: total.toFixed(4),
          partyCode: vendorCode,
          description: `Pay bill(s) ${ns.apply.map((a) => a.doc).join(",")}`,
          dimensionAssignments: [],
        },
        {
          accountCode: cashCode,
          credit: total.toFixed(4),
          description: "Cash out",
          dimensionAssignments: [],
        },
      ],
      customFields: {},
      sourceSystem: "NETSUITE",
      sourceRecordType: "VendorPayment",
      sourceRecordId: ns.internalid,
      sourcePayload: ns,
      mappingVersion,
    },
    application: {
      appliedDate: docDate,
      applications: ns.apply.map((a) => ({ linkedBillId: a.doc, amount: fmt(a.amount) })),
    },
  };
}

export function mapNsJournalEntry(
  ns: NsJournalEntry,
  customSegmentCodes: string[],
  mappingVersion = "ns-v1"
): MappedNsJournalEntry {
  const docDate = new Date(ns.trandate);

  const lines: MappedNsLine[] = ns.lines.map((line, idx) => ({
    accountCode: nsAccountCode(line.account),
    debit: line.debit && line.debit > 0 ? fmt(line.debit) : undefined,
    credit: line.credit && line.credit > 0 ? fmt(line.credit) : undefined,
    description: line.memo ?? `JE line ${idx + 1}`,
    dimensionAssignments: extractDimensionAssignments(line, customSegmentCodes),
  }));

  return {
    documentDate: docDate,
    memo: ns.memo ?? `Journal Entry ${ns.tranid}`,
    currencyCode: "USD", // NS JE doesn't carry currency at header in our fixture; default to USD
    lines,
    customFields: {},
    sourceSystem: "NETSUITE",
    sourceRecordType: "JournalEntry",
    sourceRecordId: ns.internalid,
    sourcePayload: ns,
    mappingVersion,
  };
}

// Helper used by import.ts — extracts the list of custom segment codes
// to look for on each line.
export function customSegmentCodes(segments: NsCustomSegment[] | undefined): string[] {
  return (segments ?? []).map((s) => s.internalid);
}
