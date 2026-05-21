// Standard chart of accounts for a small SaaS company.
//
// Numbering convention:
//   1xxx — Assets
//   2xxx — Liabilities
//   3xxx — Equity
//   4xxx — Revenue
//   5xxx-9xxx — Expenses
//
// This is deliberately small (~20 accounts). A real SaaS company would have
// 100-200, but for portfolio demos, more accounts ≠ more impressive.

import { AccountType, NormalBalance } from "../accounting/types";

export interface SeedAccount {
  code: string;
  name: string;
  type: AccountType;
  normalBalance: NormalBalance;
  isContra?: boolean;
}

export const CHART_OF_ACCOUNTS: SeedAccount[] = [
  // ---- Assets ----
  { code: "1000", name: "Cash — Operating", type: "ASSET", normalBalance: "DEBIT" },
  { code: "1010", name: "Cash — Payroll", type: "ASSET", normalBalance: "DEBIT" },
  { code: "1200", name: "Accounts Receivable", type: "ASSET", normalBalance: "DEBIT" },
  { code: "1400", name: "Prepaid Expenses", type: "ASSET", normalBalance: "DEBIT" },
  { code: "1500", name: "Computer Equipment", type: "ASSET", normalBalance: "DEBIT" },
  {
    code: "1510",
    name: "Accumulated Depreciation — Equipment",
    type: "ASSET",
    normalBalance: "CREDIT", // contra
    isContra: true,
  },

  // ---- Liabilities ----
  { code: "2000", name: "Accounts Payable", type: "LIABILITY", normalBalance: "CREDIT" },
  { code: "2100", name: "Accrued Expenses", type: "LIABILITY", normalBalance: "CREDIT" },
  { code: "2200", name: "Deferred Revenue", type: "LIABILITY", normalBalance: "CREDIT" },
  { code: "2300", name: "Sales Tax Payable", type: "LIABILITY", normalBalance: "CREDIT" },

  // ---- Equity ----
  { code: "3000", name: "Common Stock", type: "EQUITY", normalBalance: "CREDIT" },
  { code: "3100", name: "Additional Paid-in Capital", type: "EQUITY", normalBalance: "CREDIT" },

  // ---- Revenue ----
  { code: "4000", name: "Subscription Revenue", type: "REVENUE", normalBalance: "CREDIT" },
  { code: "4100", name: "Professional Services Revenue", type: "REVENUE", normalBalance: "CREDIT" },

  // ---- Expenses ----
  { code: "5000", name: "Cost of Revenue — Hosting", type: "EXPENSE", normalBalance: "DEBIT" },
  { code: "5100", name: "Cost of Revenue — Support", type: "EXPENSE", normalBalance: "DEBIT" },
  { code: "6000", name: "Salaries & Wages", type: "EXPENSE", normalBalance: "DEBIT" },
  { code: "6100", name: "Payroll Taxes", type: "EXPENSE", normalBalance: "DEBIT" },
  { code: "6200", name: "Benefits", type: "EXPENSE", normalBalance: "DEBIT" },
  { code: "7000", name: "Software & SaaS Tools", type: "EXPENSE", normalBalance: "DEBIT" },
  { code: "7100", name: "Marketing", type: "EXPENSE", normalBalance: "DEBIT" },
  { code: "7200", name: "Professional Fees", type: "EXPENSE", normalBalance: "DEBIT" },
  { code: "7300", name: "Office & General", type: "EXPENSE", normalBalance: "DEBIT" },
  { code: "8000", name: "Depreciation Expense", type: "EXPENSE", normalBalance: "DEBIT" },
];
