// QuickBooks Online API shape types.
//
// Hand-rolled from the QBO REST API documentation. The QBO SDK has its own
// types; we don't depend on it because (a) it's a heavy dep, and (b) we
// don't want to track every QBO API change. The shape stable enough for our
// purposes is the subset of fields that show up in actual export JSON.

export interface QboRef {
  value: string;     // QBO Id of the referenced object
  name?: string;     // denormalized display name (informational only)
}

export interface QboCurrencyRef {
  value: string;     // ISO 4217 code
  name?: string;
}

// ---- Account --------------------------------------------------------

export type QboAccountType =
  | "Bank"
  | "Accounts Receivable"
  | "Other Current Asset"
  | "Fixed Asset"
  | "Other Asset"
  | "Accounts Payable"
  | "Credit Card"
  | "Other Current Liability"
  | "Long Term Liability"
  | "Equity"
  | "Income"
  | "Other Income"
  | "Cost of Goods Sold"
  | "Expense"
  | "Other Expense";

export interface QboAccount {
  Id: string;
  Name: string;
  AccountType: QboAccountType;
  AccountSubType?: string;
  Active: boolean;
  Classification?: "Asset" | "Liability" | "Equity" | "Revenue" | "Expense";
  ParentRef?: QboRef;
  CurrencyRef?: QboCurrencyRef;
}

// ---- Customer / Vendor ----------------------------------------------

export interface QboCustomer {
  Id: string;
  DisplayName: string;
  CompanyName?: string;
  Active: boolean;
  Balance?: number;
  PrimaryEmailAddr?: { Address: string };
}

export interface QboVendor {
  Id: string;
  DisplayName: string;
  CompanyName?: string;
  Active: boolean;
  Balance?: number;
}

// ---- Transactions ---------------------------------------------------

export interface QboInvoiceLine {
  Amount: number;
  DetailType: "SalesItemLineDetail" | "DescriptionOnly" | "SubTotalLineDetail";
  Description?: string;
  SalesItemLineDetail?: {
    ItemRef?: QboRef;
    Qty?: number;
    UnitPrice?: number;
    AccountRef?: QboRef; // explicit income account; falls back to invoice-level
  };
}

export interface QboInvoice {
  Id: string;
  DocNumber?: string;
  TxnDate: string;        // ISO date
  DueDate?: string;
  CustomerRef: QboRef;
  TotalAmt: number;
  Balance: number;
  CurrencyRef?: QboCurrencyRef;
  Line: QboInvoiceLine[];
  ARAccountRef?: QboRef;
  IncomeAccountRef?: QboRef; // optional invoice-level income default
  PrivateNote?: string;
}

export interface QboBillLine {
  Amount: number;
  DetailType: "AccountBasedExpenseLineDetail" | "ItemBasedExpenseLineDetail";
  Description?: string;
  AccountBasedExpenseLineDetail?: {
    AccountRef: QboRef;
  };
  ItemBasedExpenseLineDetail?: {
    ItemRef: QboRef;
    Qty?: number;
    UnitPrice?: number;
  };
}

export interface QboBill {
  Id: string;
  DocNumber?: string;
  TxnDate: string;
  DueDate?: string;
  VendorRef: QboRef;
  TotalAmt: number;
  Balance: number;
  CurrencyRef?: QboCurrencyRef;
  APAccountRef?: QboRef;
  Line: QboBillLine[];
  PrivateNote?: string;
}

export interface QboLinkedTxn {
  TxnId: string;
  TxnType: "Invoice" | "Bill" | "JournalEntry" | "Payment" | "BillPayment";
}

export interface QboPaymentLine {
  Amount: number;
  LinkedTxn?: QboLinkedTxn[];
}

export interface QboPayment {
  Id: string;
  TxnDate: string;
  CustomerRef: QboRef;
  TotalAmt: number;
  DepositToAccountRef?: QboRef;
  CurrencyRef?: QboCurrencyRef;
  Line: QboPaymentLine[];
  PrivateNote?: string;
}

export interface QboBillPayment {
  Id: string;
  TxnDate: string;
  VendorRef: QboRef;
  TotalAmt: number;
  PayType?: "Check" | "CreditCard";
  CheckPayment?: { BankAccountRef: QboRef };
  CreditCardPayment?: { CCAccountRef: QboRef };
  CurrencyRef?: QboCurrencyRef;
  Line: QboPaymentLine[];
  PrivateNote?: string;
}

export interface QboJournalEntryLine {
  Amount: number;
  DetailType: "JournalEntryLineDetail";
  Description?: string;
  JournalEntryLineDetail: {
    PostingType: "Debit" | "Credit";
    AccountRef: QboRef;
    Entity?: { EntityRef: QboRef; Type: "Customer" | "Vendor" | "Employee" };
  };
}

export interface QboJournalEntry {
  Id: string;
  DocNumber?: string;
  TxnDate: string;
  PrivateNote?: string;
  CurrencyRef?: QboCurrencyRef;
  Line: QboJournalEntryLine[];
}

// ---- Top-level export shape ------------------------------------------

export interface QboExport {
  _meta?: {
    sourceSystem?: string;
    companyName?: string;
    exportedAt?: string;
    fiscalYearStart?: string;
    functionalCurrency?: string;
    comment?: string;
  };
  Account?: QboAccount[];
  Customer?: QboCustomer[];
  Vendor?: QboVendor[];
  Invoice?: QboInvoice[];
  Bill?: QboBill[];
  Payment?: QboPayment[];
  BillPayment?: QboBillPayment[];
  JournalEntry?: QboJournalEntry[];
}
