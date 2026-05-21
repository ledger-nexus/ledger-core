// Minimal CSV writer. RFC 4180-ish: quote cells containing comma, double-
// quote, or newline; escape embedded double-quotes by doubling them. No
// streaming — everything is buffered in memory. Fine at portfolio scale
// (a 10k-row TB CSV is ~500 KB).

export type CsvCell = string | number | null | undefined;

export function toCsv(rows: CsvCell[][]): string {
  return rows.map((row) => row.map(cell).join(",")).join("\n");
}

function cell(value: CsvCell): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
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
