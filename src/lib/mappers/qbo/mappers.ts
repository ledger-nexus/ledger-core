// Pure mapping functions: QBO shape → ledger-core shape.
//
// No Prisma calls in this file. These are deterministic, side-effect-free
// transformations that produce the data the orchestrator writes to the DB.
// Pure functions are easy to test (no fixtures, no DB setup) and easy to
// reverse for the roundtrip exporter.

import { Decimal } from "decimal.js";
import type {
  QboAccount,
  QboAccountType,
  QboCustomer,
  QboVendor,
  QboInvoice,
  QboBill,
  QboPayment,
  QboBillPayment,
  QboJournalEntry,
} from "./types";

// ---- Account type mapping ------------------------------------------

const QBO_ACCOUNT_TYPE_TO_LEDGER: Record<
  QboAccountType,
  { type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE"; normalBalance: "DEBIT" | "CREDIT" }
> = {
  "Bank": { type: "ASSET", normalBalance: "DEBIT" },
  "Accounts Receivable": { type: "ASSET", normalBalance: "DEBIT" },
  "Other Current Asset": { type: "ASSET", normalBalance: "DEBIT" },
  "Fixed Asset": { type: "ASSET", normalBalance: "DEBIT" },
  "Other Asset": { type: "ASSET", normalBalance: "DEBIT" },
  "Accounts Payable": { type: "LIABILITY", normalBalance: "CREDIT" },
  "Credit Card": { type: "LIABILITY", normalBalance: "CREDIT" },
  "Other Current Liability": { type: "LIABILITY", normalBalance: "CREDIT" },
  "Long Term Liability": { type: "LIABILITY", normalBalance: "CREDIT" },
  "Equity": { type: "EQUITY", normalBalance: "CREDIT" },
  "Income": { type: "REVENUE", normalBalance: "CREDIT" },
  "Other Income": { type: "REVENUE", normalBalance: "CREDIT" },
  "Cost of Goods Sold": { type: "EXPENSE", normalBalance: "DEBIT" },
  "Expense": { type: "EXPENSE", normalBalance: "DEBIT" },
  "Other Expense": { type: "EXPENSE", normalBalance: "DEBIT" },
};

const ACCOUNT_SUBTYPE_HINTS: Record<string, string | undefined> = {
  "Checking": "CASH",
  "Savings": "CASH",
  "AccountsReceivable": "AR_TRADE",
  "AccountsPayable": "AP_TRADE",
  "OpeningBalanceEquity": "OPENING_BALANCE",
  "SalesOfProductIncome": "REVENUE_PRODUCT",
  "ServiceFeeIncome": "REVENUE_SERVICE",
  "LegalProfessionalFees": "PROFESSIONAL_FEES",
};

// Prefix QBO Ids with "Q" so the imported chart doesn't collide with the
// native shared chart (codes 1000, 2000, …) in the same entity scope.
export function qboAccountCode(qboId: string): string {
  return `Q${qboId}`;
}

export interface MappedAccount {
  code: string;
  name: string;
  type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
  normalBalance: "DEBIT" | "CREDIT";
  isContra: boolean;
  isControlAccount: boolean;
  isBank: boolean;
  subtype: string | null;
  active: boolean;
  sourceSystem: "QBO";
  sourceRecordType: "Account";
  sourceRecordId: string;
  sourcePayload: QboAccount;
  mappingVersion: string;
}

export function mapAccount(qbo: QboAccount, mappingVersion = "qbo-v1"): MappedAccount {
  const lg = QBO_ACCOUNT_TYPE_TO_LEDGER[qbo.AccountType];
  if (!lg) {
    throw new Error(`Unmapped QBO AccountType: ${qbo.AccountType}`);
  }
  return {
    code: qboAccountCode(qbo.Id),
    name: qbo.Name,
    type: lg.type,
    normalBalance: lg.normalBalance,
    isContra: false,
    isControlAccount:
      qbo.AccountType === "Accounts Receivable" || qbo.AccountType === "Accounts Payable",
    isBank: qbo.AccountType === "Bank",
    subtype: qbo.AccountSubType ? ACCOUNT_SUBTYPE_HINTS[qbo.AccountSubType] ?? qbo.AccountSubType : null,
    active: qbo.Active,
    sourceSystem: "QBO",
    sourceRecordType: "Account",
    sourceRecordId: qbo.Id,
    sourcePayload: qbo,
    mappingVersion,
  };
}

// ---- Party mapping ------------------------------------------------

export function qboCustomerCode(qboId: string): string {
  return `QCUST-${qboId}`;
}
export function qboVendorCode(qboId: string): string {
  return `QVEND-${qboId}`;
}

export interface MappedParty {
  code: string;
  displayName: string;
  role: "CUSTOMER" | "VENDOR" | "EMPLOYEE" | "OTHER";
  sourceSystem: "QBO";
  sourceRecordType: "Customer" | "Vendor";
  sourceRecordId: string;
  sourcePayload: QboCustomer | QboVendor;
  mappingVersion: string;
}

export function mapCustomer(qbo: QboCustomer, mappingVersion = "qbo-v1"): MappedParty {
  return {
    code: qboCustomerCode(qbo.Id),
    displayName: qbo.DisplayName,
    role: "CUSTOMER",
    sourceSystem: "QBO",
    sourceRecordType: "Customer",
    sourceRecordId: qbo.Id,
    sourcePayload: qbo,
    mappingVersion,
  };
}

export function mapVendor(qbo: QboVendor, mappingVersion = "qbo-v1"): MappedParty {
  return {
    code: qboVendorCode(qbo.Id),
    displayName: qbo.DisplayName,
    role: "VENDOR",
    sourceSystem: "QBO",
    sourceRecordType: "Vendor",
    sourceRecordId: qbo.Id,
    sourcePayload: qbo,
    mappingVersion,
  };
}

// ---- Transaction mapping ------------------------------------------

export interface MappedJournalLine {
  accountCode: string;
  debit?: string;       // formatted Decimal string
  credit?: string;
  description?: string;
  partyCode?: string;
}

export interface MappedJournalEntry {
  documentDate: Date;
  postingDate: Date;
  memo: string;
  currencyCode: string;
  lines: MappedJournalLine[];
  sourceSystem: "QBO";
  sourceRecordType: string;     // "Invoice" | "Bill" | "Payment" | "BillPayment" | "JournalEntry"
  sourceRecordId: string;
  sourcePayload: unknown;
  mappingVersion: string;
}

// Sub-ledger side-effect: invoices / bills open AR / AP items. Payments
// apply against them. We surface these so the orchestrator can wire them
// after posting the JE.
export interface MappedArOpening {
  amount: string;
  customerCode: string;
  controlAccountCode: string;
  referenceNumber: string;
  openedDate: Date;
  dueDate: Date | null;
  currencyCode: string;
  sourceRecordType: "Invoice";
  sourceRecordId: string;
  sourcePayload: QboInvoice;
}

export interface MappedApOpening {
  amount: string;
  vendorCode: string;
  controlAccountCode: string;
  referenceNumber: string;
  openedDate: Date;
  dueDate: Date | null;
  currencyCode: string;
  sourceRecordType: "Bill";
  sourceRecordId: string;
  sourcePayload: QboBill;
}

// "Apply this AR payment to QBO invoices identified by LinkedTxn[]" —
// orchestrator resolves the invoice IDs to ledger-core open-item IDs.
export interface MappedArApplication {
  appliedDate: Date;
  appliedAmount: string;
  linkedInvoiceQboIds: string[];
}

export interface MappedApApplication {
  appliedDate: Date;
  appliedAmount: string;
  linkedBillQboIds: string[];
}

export interface MappedInvoiceResult {
  entry: MappedJournalEntry;
  arOpening: MappedArOpening;
}
export interface MappedBillResult {
  entry: MappedJournalEntry;
  apOpening: MappedApOpening;
}
export interface MappedPaymentResult {
  entry: MappedJournalEntry;
  application: MappedArApplication;
}
export interface MappedBillPaymentResult {
  entry: MappedJournalEntry;
  application: MappedApApplication;
}

function fmt(n: number | string): string {
  return new Decimal(n).toFixed(4);
}

export function mapInvoice(qbo: QboInvoice, mappingVersion = "qbo-v1"): MappedInvoiceResult {
  const total = new Decimal(qbo.TotalAmt);
  const arAccountCode = qboAccountCode(qbo.ARAccountRef?.value ?? "2");
  const currencyCode = qbo.CurrencyRef?.value ?? "USD";
  const customerCode = qboCustomerCode(qbo.CustomerRef.value);

  // Build credit lines from each invoice line. Income account comes from
  // the line's SalesItemLineDetail.AccountRef if present, else the invoice-
  // level IncomeAccountRef. SaaS QBO invoices typically have one item line.
  const creditLines: MappedJournalLine[] = qbo.Line
    .filter((l) => l.DetailType === "SalesItemLineDetail")
    .map((line, idx) => {
      const incomeAcct =
        line.SalesItemLineDetail?.AccountRef?.value ??
        qbo.IncomeAccountRef?.value ??
        "5"; // default to a guessed income account
      return {
        accountCode: qboAccountCode(incomeAcct),
        credit: fmt(line.Amount),
        description: line.Description ?? `Invoice line ${idx + 1}`,
      };
    });

  const lines: MappedJournalLine[] = [
    {
      accountCode: arAccountCode,
      debit: total.toFixed(4),
      description: `AR — ${qbo.CustomerRef.name ?? qbo.CustomerRef.value}`,
      partyCode: customerCode,
    },
    ...creditLines,
  ];

  const docDate = new Date(qbo.TxnDate);
  const dueDate = qbo.DueDate ? new Date(qbo.DueDate) : null;

  return {
    entry: {
      documentDate: docDate,
      postingDate: docDate,
      memo: `Invoice ${qbo.DocNumber ?? qbo.Id} — ${qbo.CustomerRef.name ?? qbo.CustomerRef.value}`,
      currencyCode,
      lines,
      sourceSystem: "QBO",
      sourceRecordType: "Invoice",
      sourceRecordId: qbo.Id,
      sourcePayload: qbo,
      mappingVersion,
    },
    arOpening: {
      amount: total.toFixed(4),
      customerCode,
      controlAccountCode: arAccountCode,
      referenceNumber: qbo.DocNumber ?? qbo.Id,
      openedDate: docDate,
      dueDate,
      currencyCode,
      sourceRecordType: "Invoice",
      sourceRecordId: qbo.Id,
      sourcePayload: qbo,
    },
  };
}

export function mapBill(qbo: QboBill, mappingVersion = "qbo-v1"): MappedBillResult {
  const total = new Decimal(qbo.TotalAmt);
  const apAccountCode = qboAccountCode(qbo.APAccountRef?.value ?? "3");
  const currencyCode = qbo.CurrencyRef?.value ?? "USD";
  const vendorCode = qboVendorCode(qbo.VendorRef.value);

  // Each bill line debits an expense account. Pure account-based expense
  // lines are the typical case; item-based detail mapping is deferred.
  const debitLines: MappedJournalLine[] = qbo.Line
    .filter((l) => l.DetailType === "AccountBasedExpenseLineDetail")
    .map((line, idx) => {
      const acctRef = line.AccountBasedExpenseLineDetail?.AccountRef;
      if (!acctRef) {
        throw new Error(`QBO Bill line ${idx} missing AccountRef`);
      }
      return {
        accountCode: qboAccountCode(acctRef.value),
        debit: fmt(line.Amount),
        description: line.Description ?? `Bill line ${idx + 1}`,
      };
    });

  const lines: MappedJournalLine[] = [
    ...debitLines,
    {
      accountCode: apAccountCode,
      credit: total.toFixed(4),
      description: `AP — ${qbo.VendorRef.name ?? qbo.VendorRef.value}`,
      partyCode: vendorCode,
    },
  ];

  const docDate = new Date(qbo.TxnDate);
  const dueDate = qbo.DueDate ? new Date(qbo.DueDate) : null;

  return {
    entry: {
      documentDate: docDate,
      postingDate: docDate,
      memo: `Bill ${qbo.DocNumber ?? qbo.Id} — ${qbo.VendorRef.name ?? qbo.VendorRef.value}`,
      currencyCode,
      lines,
      sourceSystem: "QBO",
      sourceRecordType: "Bill",
      sourceRecordId: qbo.Id,
      sourcePayload: qbo,
      mappingVersion,
    },
    apOpening: {
      amount: total.toFixed(4),
      vendorCode,
      controlAccountCode: apAccountCode,
      referenceNumber: qbo.DocNumber ?? qbo.Id,
      openedDate: docDate,
      dueDate,
      currencyCode,
      sourceRecordType: "Bill",
      sourceRecordId: qbo.Id,
      sourcePayload: qbo,
    },
  };
}

export function mapPayment(qbo: QboPayment, mappingVersion = "qbo-v1"): MappedPaymentResult {
  const total = new Decimal(qbo.TotalAmt);
  const depositAccountCode = qboAccountCode(qbo.DepositToAccountRef?.value ?? "1");
  const currencyCode = qbo.CurrencyRef?.value ?? "USD";
  const customerCode = qboCustomerCode(qbo.CustomerRef.value);
  const docDate = new Date(qbo.TxnDate);

  // QBO payments don't carry the AR account ref directly — it's implied by
  // the LinkedTxn invoice's ARAccountRef. We hardcode the standard QBO AR
  // account Id "2" → "Q2"; the orchestrator can override if the actual
  // invoice used a different AR account.
  const arAccountCode = "Q2";

  const linkedInvoiceQboIds = qbo.Line
    .flatMap((l) => l.LinkedTxn ?? [])
    .filter((t) => t.TxnType === "Invoice")
    .map((t) => t.TxnId);

  return {
    entry: {
      documentDate: docDate,
      postingDate: docDate,
      memo: `Payment — ${qbo.CustomerRef.name ?? qbo.CustomerRef.value}`,
      currencyCode,
      lines: [
        {
          accountCode: depositAccountCode,
          debit: total.toFixed(4),
          description: `Cash receipt — ${qbo.CustomerRef.name ?? qbo.CustomerRef.value}`,
        },
        {
          accountCode: arAccountCode,
          credit: total.toFixed(4),
          partyCode: customerCode,
          description: `Apply against invoice(s) ${linkedInvoiceQboIds.join(",")}`,
        },
      ],
      sourceSystem: "QBO",
      sourceRecordType: "Payment",
      sourceRecordId: qbo.Id,
      sourcePayload: qbo,
      mappingVersion,
    },
    application: {
      appliedDate: docDate,
      appliedAmount: total.toFixed(4),
      linkedInvoiceQboIds,
    },
  };
}

export function mapBillPayment(qbo: QboBillPayment, mappingVersion = "qbo-v1"): MappedBillPaymentResult {
  const total = new Decimal(qbo.TotalAmt);
  const sourceAccountCode = qboAccountCode(
    qbo.CheckPayment?.BankAccountRef?.value ?? qbo.CreditCardPayment?.CCAccountRef?.value ?? "1"
  );
  const currencyCode = qbo.CurrencyRef?.value ?? "USD";
  const vendorCode = qboVendorCode(qbo.VendorRef.value);
  const docDate = new Date(qbo.TxnDate);

  // Standard QBO AP account id "3".
  const apAccountCode = "Q3";

  const linkedBillQboIds = qbo.Line
    .flatMap((l) => l.LinkedTxn ?? [])
    .filter((t) => t.TxnType === "Bill")
    .map((t) => t.TxnId);

  return {
    entry: {
      documentDate: docDate,
      postingDate: docDate,
      memo: `Vendor payment — ${qbo.VendorRef.name ?? qbo.VendorRef.value}`,
      currencyCode,
      lines: [
        {
          accountCode: apAccountCode,
          debit: total.toFixed(4),
          partyCode: vendorCode,
          description: `Pay bill(s) ${linkedBillQboIds.join(",")}`,
        },
        {
          accountCode: sourceAccountCode,
          credit: total.toFixed(4),
          description: `Cash out — ${qbo.VendorRef.name ?? qbo.VendorRef.value}`,
        },
      ],
      sourceSystem: "QBO",
      sourceRecordType: "BillPayment",
      sourceRecordId: qbo.Id,
      sourcePayload: qbo,
      mappingVersion,
    },
    application: {
      appliedDate: docDate,
      appliedAmount: total.toFixed(4),
      linkedBillQboIds,
    },
  };
}

export function mapJournalEntry(qbo: QboJournalEntry, mappingVersion = "qbo-v1"): MappedJournalEntry {
  const currencyCode = qbo.CurrencyRef?.value ?? "USD";
  const docDate = new Date(qbo.TxnDate);

  const lines: MappedJournalLine[] = qbo.Line.map((line, idx) => {
    const det = line.JournalEntryLineDetail;
    const amount = fmt(line.Amount);
    return {
      accountCode: qboAccountCode(det.AccountRef.value),
      debit: det.PostingType === "Debit" ? amount : undefined,
      credit: det.PostingType === "Credit" ? amount : undefined,
      description: line.Description ?? `JE line ${idx + 1}`,
    };
  });

  return {
    documentDate: docDate,
    postingDate: docDate,
    memo: qbo.PrivateNote ?? `Journal Entry ${qbo.DocNumber ?? qbo.Id}`,
    currencyCode,
    lines,
    sourceSystem: "QBO",
    sourceRecordType: "JournalEntry",
    sourceRecordId: qbo.Id,
    sourcePayload: qbo,
    mappingVersion,
  };
}
