// Report Builder PR 6 — RenderedMatrix → CSV serializer.
//
// Turns a builder-rendered matrix into the SAME CSV shape the legacy
// /api/reports/<name>/csv routes emit, so a CPA opening the file in
// Excel sees the familiar columns. The serializer is template-agnostic:
// any 4-GAAP statement (or a user-defined custom one) flows through
// here without route-specific code.
//
// SECURITY (CWE-1236 CSV formula injection):
// All cell content goes through `toCsv` which prefixes any cell whose
// first character is `=` / `+` / `-` / `@` / tab / CR with a literal
// apostrophe so Excel reads it as text, not formula. Row labels in
// system templates are safe today but user-defined templates may
// carry attacker-controlled labels — the formula-leader escape on the
// shared helper is the last line of defense.

import type {
  RenderedMatrix,
  RenderedRow,
  ReportTemplate,
} from "./types";
import { toCsv, csvFilename, type CsvCell } from "@/lib/utils/csv";

export interface RenderedMatrixCsvOptions {
  /** Free-text scope description placed in the first row. */
  scopeLabel?: string;
  /** Include indent markers in the leftmost label cell. */
  indent?: boolean;
}

/**
 * Serialize a RenderedMatrix to a CSV string. Header line names the
 * template + scope; then one column per template column; one row per
 * non-spacer template row.
 *
 * SPACER rows become blank lines (one CR). HEADER rows render with no
 * cell values. SUBTOTAL / FORMULA rows render with their formatted
 * cell value.
 */
export function renderedMatrixToCsv(
  matrix: RenderedMatrix,
  options: RenderedMatrixCsvOptions = {}
): string {
  const indent = options.indent ?? true;
  const colHeaders = matrix.columns.map((c) => c.label);

  const headerLine: CsvCell[] = [
    matrix.template.name,
    ...(options.scopeLabel ? [options.scopeLabel] : []),
  ];

  const rows: CsvCell[][] = [
    headerLine,
    [],
    ["Row", ...colHeaders],
    ...matrix.rows.map((r) => rowToCells(r, indent)),
  ];

  return toCsv(rows);
}

function rowToCells(row: RenderedRow, indent: boolean): CsvCell[] {
  if (row.isSpacer) {
    return [""];
  }
  if (row.isHeader) {
    return [row.label];
  }
  // Indent FORMULA / SUBTOTAL one space so visual hierarchy survives
  // the round-trip into Excel. The renderer already knows depth via
  // RenderedRow.indent but spacing keeps it readable in raw CSV too.
  const label = indent && (row.isFormula || row.isSubtotal)
    ? `  ${row.label}`
    : row.label;
  return [label, ...row.cells.map((c) => c.display)];
}

/**
 * Build the standard `Content-Disposition` filename for a builder
 * template export.
 *
 *   "income-statement_2026-01-01_2026-03-31.csv"
 *   "balance-sheet_2026-03-31.csv"
 */
export function builderCsvFilename(
  template: ReportTemplate,
  suffix?: string
): string {
  return csvFilename(template.code.toLowerCase(), suffix);
}
