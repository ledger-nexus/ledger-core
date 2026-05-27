// Paste-from-Excel parser for journal entry lines.
//
// What this solves: a CPA opens Excel, has a list of JE lines (typically
// 5-50 rows: complex year-end accruals, customer-detail billings rolled
// up into one JE, prepaid-amortization schedules, etc.), and pastes it
// into our app. We accept the tab-separated format Excel produces on
// copy and turn it into a balanced JournalEntry draft.
//
// Scope of v1: ONE journal entry per paste. The user enters
// (entity, book, documentDate, memo) in the form; the paste only
// supplies LINES. Bulk-JE import (a year of monthly entries pasted
// at once) is v2 — different parser, different shape, different
// validation surface.
//
// Input forms accepted:
//
//   1. Tab-separated, no header row:
//      "1000\t500\t\tCash received\n4000\t\t500\tRevenue earned"
//      Columns: accountCode, debit, credit, description (optional),
//               partyCode (optional), itemCode (optional)
//
//   2. Tab-separated, WITH header row (any column order, case-insensitive):
//      "account\tdebit\tcredit\tdescription\n1000\t500\t\tCash received\n..."
//      Recognized headers: account / accountcode, debit, credit,
//      description / memo, party / partycode, item / itemcode
//
//   3. Comma-separated (paste from Google Sheets or a CSV file):
//      same shapes as above, but with commas.
//
// What we do NOT accept: mixed quoted/unquoted CSV with embedded commas,
// fancy locales with "," as decimal separator, currency symbols in
// numeric cells. CPAs paste clean number columns from Excel; everything
// else is best handled by saving as CSV first.
//
// The parser is pure: no DB, no fetch, no Decimal precision loss. All
// money values are normalized via decimal.js so downstream invariants
// (sum-of-debits = sum-of-credits) are exact.

import { Decimal } from "decimal.js";

export interface ParsedLine {
  /** 1-indexed row number in the user's paste (excludes header if detected). */
  rowNumber: number;
  accountCode: string;
  debit: Decimal;
  credit: Decimal;
  description?: string;
  partyCode?: string;
  itemCode?: string;
}

export interface ParsedPasteResult {
  lines: ParsedLine[];
  /** Sum of all line debits. */
  debitTotal: Decimal;
  /** Sum of all line credits. */
  creditTotal: Decimal;
  /** debit - credit (zero = balanced). */
  difference: Decimal;
  isBalanced: boolean;
  /**
   * Per-row warnings (e.g. "row 3: both debit and credit non-zero — skipped").
   * Parser is tolerant: warnings don't block the parse, but they're surfaced
   * so the user knows what was dropped.
   */
  warnings: string[];
  /**
   * Per-row hard errors (e.g. "row 2: missing accountCode"). If errors is
   * non-empty, the result must not be posted as-is.
   */
  errors: string[];
  /** Did we detect + skip a header row? */
  hadHeader: boolean;
}

// Header tokens we recognize. Anything not in this list in a candidate
// header row triggers "no header" detection and the first row is treated
// as data.
const HEADER_TOKENS: Record<string, keyof ParsedLine | "_skip"> = {
  account: "accountCode",
  accountcode: "accountCode",
  "account code": "accountCode",
  acct: "accountCode",
  acctcode: "accountCode",
  debit: "debit",
  dr: "debit",
  credit: "credit",
  cr: "credit",
  description: "description",
  desc: "description",
  memo: "description",
  party: "partyCode",
  partycode: "partyCode",
  "party code": "partyCode",
  vendor: "partyCode",
  customer: "partyCode",
  item: "itemCode",
  itemcode: "itemCode",
  "item code": "itemCode",
};

/** Split a row into cells, preferring tabs (Excel paste) over commas (CSV). */
function splitRow(row: string): string[] {
  // If there's at least one tab, use tab as the delimiter. Excel pastes
  // tab-separated; this is the dominant case.
  if (row.includes("\t")) return row.split("\t").map((c) => c.trim());
  // Fall back to comma. Naive — quoted fields with embedded commas are
  // out of scope (see header comment).
  return row.split(",").map((c) => c.trim());
}

/** Normalize a money cell into a Decimal. Empty / dash → 0. */
function parseMoney(cell: string): { value: Decimal; ok: boolean } {
  const trimmed = cell.trim();
  if (trimmed === "" || trimmed === "-" || trimmed === "—") {
    return { value: new Decimal(0), ok: true };
  }
  // Strip $ and thousands commas. Accountants use both freely.
  const stripped = trimmed.replace(/[$,]/g, "");
  // Handle parens for negative (1,234.56) → -1234.56 — accountant convention.
  let negated = false;
  let numeric = stripped;
  if (numeric.startsWith("(") && numeric.endsWith(")")) {
    negated = true;
    numeric = numeric.slice(1, -1);
  }
  if (!/^-?\d+(?:\.\d+)?$/.test(numeric)) {
    return { value: new Decimal(0), ok: false };
  }
  let d = new Decimal(numeric);
  if (negated) d = d.negated();
  return { value: d, ok: true };
}

/**
 * Detect whether the first row is a header. Heuristic: if MORE THAN HALF
 * the cells in row 0 match a known header token, it's a header. Otherwise
 * treat row 0 as data.
 */
function detectHeader(firstRowCells: string[]): {
  isHeader: boolean;
  columnMap: Record<number, keyof ParsedLine | "_skip">;
} {
  const columnMap: Record<number, keyof ParsedLine | "_skip"> = {};
  let matched = 0;
  for (let i = 0; i < firstRowCells.length; i++) {
    const cell = firstRowCells[i].toLowerCase().trim();
    const mapped = HEADER_TOKENS[cell];
    if (mapped) {
      columnMap[i] = mapped;
      matched += 1;
    } else {
      columnMap[i] = "_skip";
    }
  }
  return { isHeader: matched > firstRowCells.length / 2, columnMap };
}

/** Default column positions when no header is detected. */
const DEFAULT_COLUMNS: Record<number, keyof ParsedLine | "_skip"> = {
  0: "accountCode",
  1: "debit",
  2: "credit",
  3: "description",
  4: "partyCode",
  5: "itemCode",
};

/**
 * Parse a pasted block of text into a JE-draft. Pure function, returns
 * everything needed by the UI to render a preview before any DB write:
 * the lines, the running totals, and any per-row warnings/errors.
 */
export function parsePastedLines(input: string): ParsedPasteResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  const lines: ParsedLine[] = [];

  // Normalize line endings. CRLF (Windows / Excel) and CR-only (legacy
  // Mac, vanishingly rare but cheap to handle) both collapse to LF.
  const normalized = input.replace(/\r\n?/g, "\n");
  const rawRows = normalized
    .split("\n")
    .map((r) => r.replace(/\s+$/, "")) // trim trailing whitespace, NOT leading (preserves indent if any)
    .filter((r) => r.trim().length > 0);

  if (rawRows.length === 0) {
    return {
      lines: [],
      debitTotal: new Decimal(0),
      creditTotal: new Decimal(0),
      difference: new Decimal(0),
      isBalanced: false,
      warnings: [],
      errors: ["No rows pasted."],
      hadHeader: false,
    };
  }

  const firstRowCells = splitRow(rawRows[0]);
  const { isHeader, columnMap: headerColumnMap } = detectHeader(firstRowCells);
  const columnMap = isHeader ? headerColumnMap : DEFAULT_COLUMNS;
  const dataRows = isHeader ? rawRows.slice(1) : rawRows;

  let debitTotal = new Decimal(0);
  let creditTotal = new Decimal(0);

  for (let i = 0; i < dataRows.length; i++) {
    const rowNumber = i + 1;
    const cells = splitRow(dataRows[i]);
    const draft: Partial<ParsedLine> = { rowNumber };

    for (let c = 0; c < cells.length; c++) {
      const colKey = columnMap[c];
      if (!colKey || colKey === "_skip") continue;
      const cell = cells[c];
      if (colKey === "debit" || colKey === "credit") {
        const { value, ok } = parseMoney(cell);
        if (!ok) {
          errors.push(`Row ${rowNumber}: ${colKey} "${cell}" is not a valid number.`);
        }
        (draft as any)[colKey] = value;
      } else if (colKey === "rowNumber") {
        // Defensive — should never happen, rowNumber isn't in HEADER_TOKENS.
      } else {
        const val = cell.trim();
        if (val !== "") (draft as any)[colKey] = val;
      }
    }

    // Defaults for missing money cells.
    if (!draft.debit) draft.debit = new Decimal(0);
    if (!draft.credit) draft.credit = new Decimal(0);

    // Validations per substrate rules:
    // - accountCode required
    // - amounts non-negative
    // - exactly one of (debit, credit) > 0
    if (!draft.accountCode) {
      errors.push(`Row ${rowNumber}: missing accountCode.`);
      continue;
    }
    if (draft.debit!.isNegative() || draft.credit!.isNegative()) {
      errors.push(`Row ${rowNumber}: amounts must be non-negative.`);
      continue;
    }
    const debitPositive = draft.debit!.greaterThan(0);
    const creditPositive = draft.credit!.greaterThan(0);
    if (debitPositive && creditPositive) {
      warnings.push(
        `Row ${rowNumber}: both debit and credit are non-zero — split into two lines or zero one out.`
      );
      errors.push(`Row ${rowNumber}: a line must have either debit XOR credit > 0.`);
      continue;
    }
    if (!debitPositive && !creditPositive) {
      warnings.push(`Row ${rowNumber}: both debit and credit are zero — line skipped.`);
      continue;
    }

    debitTotal = debitTotal.plus(draft.debit!);
    creditTotal = creditTotal.plus(draft.credit!);
    lines.push(draft as ParsedLine);
  }

  const difference = debitTotal.minus(creditTotal);
  const isBalanced = difference.isZero() && debitTotal.greaterThan(0);

  if (!isBalanced && errors.length === 0 && lines.length > 0) {
    errors.push(
      `Unbalanced: debits ${debitTotal.toFixed(2)} ≠ credits ${creditTotal.toFixed(2)} (diff ${difference.toFixed(2)}).`
    );
  }
  if (lines.length === 1) {
    errors.push("A journal entry needs at least 2 lines.");
  }

  return {
    lines,
    debitTotal,
    creditTotal,
    difference,
    isBalanced,
    warnings,
    errors,
    hadHeader: isHeader,
  };
}
