// The report catalog — one entry per built-in report.
//
// We ship twelve report routes and, until this file, no front door: you either
// knew the URL or hunted the sidebar. Campfire's answer is a card catalog with
// category tabs and a provenance badge (built-in vs customer-made), and the
// shape is worth copying because it is a shell over reports that already exist
// (docs/design/campfire-product-surface.md §9).
//
// ⚠️ THIS IS A SECOND LIST OF THE SAME ROUTES, and second lists drift. The nav
// catalog (`src/components/nav/catalog.ts`) already names every report; this
// one adds the metadata a card needs — a category and a sentence — which the
// nav has no place for. `tests/reports-catalog.test.ts` asserts the two agree
// in BOTH directions and that every slug resolves to a real route directory,
// so the drift fails a test instead of leaving a card that 404s or a report
// nobody can find.

export type ReportCategory =
  | "General"
  | "Revenue"
  | "Expenses"
  | "Cash"
  | "Receivables"
  | "Payables"
  | "Tax"
  | "Close";

export interface ReportEntry {
  /** Path under /reports — also the directory name, which the test checks. */
  slug: string;
  title: string;
  /** One sentence. What the report answers, not what it is called again. */
  description: string;
  category: ReportCategory;
}

/**
 * Descriptions are deliberately about the QUESTION, not the artifact.
 * "Trial balance for the selected period" tells a reader nothing they did not
 * get from the title; "every account's debit and credit totals, proving the
 * ledger balances" tells them when to open it.
 */
export const REPORTS: ReportEntry[] = [
  {
    slug: "trial-balance",
    title: "Trial balance",
    description:
      "Every account's debit and credit totals for the period, and the proof that the two sides agree.",
    category: "General",
  },
  {
    slug: "income-statement",
    title: "Income statement",
    description:
      "Revenue, expenses and the resulting profit for a period. Amounts drill through to the lines behind them.",
    category: "General",
  },
  {
    slug: "balance-sheet",
    title: "Balance sheet",
    description: "Assets, liabilities and equity as at a single date.",
    category: "General",
  },
  {
    slug: "cash-flow",
    title: "Cash flow",
    description:
      "Operating, investing and financing movements for the period, reconciled from net income (indirect method).",
    category: "Cash",
  },
  {
    slug: "ar-aging",
    title: "AR aging",
    description:
      "Open customer invoices bucketed by how overdue they are — the collections worklist.",
    category: "Receivables",
  },
  {
    slug: "ap-aging",
    title: "AP aging",
    description: "Open supplier bills bucketed by age, and what falls due next.",
    category: "Payables",
  },
  {
    slug: "book-tax-difference",
    title: "Book-tax difference",
    description:
      "Where the tax book diverges from GAAP, account by account — the starting point for the provision.",
    category: "Tax",
  },
  {
    slug: "m3-detail",
    title: "M-3 detail",
    description: "Book-tax differences arranged for Schedule M-3 of Form 1120.",
    category: "Tax",
  },
  {
    slug: "fx-revaluation",
    title: "FX revaluation",
    description:
      "Unrealized gain or loss on monetary balances held in a foreign currency (ASC 830), behind an approval gate.",
    category: "General",
  },
  {
    slug: "consolidation",
    title: "Consolidation",
    description:
      "Multiple entities combined into one statement, with intercompany balances eliminated.",
    category: "General",
  },
  {
    slug: "month-end",
    title: "Month-end packet",
    description:
      "The close package — statements, reconciliation status and open items — as one reviewable PDF.",
    category: "Close",
  },
  {
    slug: "builder",
    title: "Report builder",
    description:
      "Compose a custom statement from account groups and save it for the team.",
    category: "General",
  },
];

/** Tab order. "All" and "Custom" are rendered by the page, not listed here. */
export const CATEGORY_ORDER: ReportCategory[] = [
  "General",
  "Revenue",
  "Expenses",
  "Cash",
  "Receivables",
  "Payables",
  "Tax",
  "Close",
];

/**
 * Categories that currently have at least one built-in report.
 *
 * ⚠️ Derived, not hand-listed. Campfire shows an `Expenses` tab with content;
 * ours would be empty, and a tab that opens onto nothing reads as a broken
 * feature rather than an honest gap. Empty categories simply do not render,
 * so the tab strip grows by itself when a report is added to one.
 */
export function populatedCategories(): ReportCategory[] {
  const present = new Set(REPORTS.map((r) => r.category));
  return CATEGORY_ORDER.filter((c) => present.has(c));
}

export function reportsByCategory(category: ReportCategory): ReportEntry[] {
  return REPORTS.filter((r) => r.category === category);
}
