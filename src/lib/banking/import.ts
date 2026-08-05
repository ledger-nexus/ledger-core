// Bank-feed CSV import: parse a downloaded bank/card CSV into staging rows,
// and hash each row so re-importing the same file is a no-op.
//
// This is deliberately a small, forgiving parser rather than the full
// statement parser in the recon companion — a personal export is just
// date / description / amount, and we want it to swallow the handful of
// header shapes real banks emit without configuration.

import { createHash } from "node:crypto";
import { Decimal } from "@/lib/utils/decimal";

export interface ParsedBankRow {
  postedDate: Date;
  description: string;
  /**
   * Signed on the ACCOUNT HOLDER's normal side: positive = the account's
   * balance went UP (a deposit into a bank account, a charge onto a credit
   * card), negative = it went down. This is the sign the categorize step
   * turns into debit/credit against the bank account's normal side.
   */
  amount: Decimal;
  externalRef?: string;
}

export interface ParseResult {
  rows: ParsedBankRow[];
  /** Header labels we recognized, for a "we read your file as…" confirmation. */
  mapped: { date: string; description: string; amount: string };
  skipped: number; // rows we couldn't parse (blank/short), reported not hidden
}

export class BankCsvError extends Error {}

// --- header resolution -------------------------------------------------------

const DATE_HEADERS = ["date", "posted date", "transaction date", "post date", "posting date"];
const DESC_HEADERS = ["description", "memo", "name", "payee", "details", "transaction", "narrative"];
const AMOUNT_HEADERS = ["amount", "transaction amount"];
const IN_HEADERS = ["deposit", "credit", "money in", "paid in", "deposits", "inflow"];
const OUT_HEADERS = ["withdrawal", "debit", "money out", "paid out", "withdrawals", "outflow", "payment"];
const REF_HEADERS = ["reference", "ref", "transaction id", "id", "check number", "check #"];

function findCol(headers: string[], candidates: string[]): number {
  const norm = headers.map((h) => h.trim().toLowerCase());
  for (const c of candidates) {
    const i = norm.indexOf(c);
    if (i >= 0) return i;
  }
  return -1;
}

// --- cell parsing ------------------------------------------------------------

// "$1,234.56", "(45.00)" (parens = negative), "-45.00", "1234.56 CR"/"DR"
function parseAmountCell(raw: string): Decimal | null {
  let s = raw.trim();
  if (!s) return null;
  let sign = 1;
  if (/\(.*\)/.test(s)) sign = -1; // accounting parens
  const crdr = /\b(cr|dr)\b/i.exec(s);
  s = s.replace(/[()$,\s]/g, "").replace(/\b(cr|dr)\b/i, "");
  if (s === "" || s === "-") return null;
  let n: Decimal;
  try {
    n = new Decimal(s);
  } catch {
    return null;
  }
  if (crdr && /dr/i.test(crdr[1])) sign = -1; // "DR" = money out
  return n.times(sign);
}

// Accept ISO (2026-07-15), US (07/15/2026 or 7/15/26), and dotted EU-ish.
function parseDateCell(raw: string): Date | null {
  const s = raw.trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return utc(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})$/.exec(s);
  if (m) {
    let [, mm, dd, yy] = m.map(Number) as unknown as [string, number, number, number];
    if (yy < 100) yy += 2000;
    return utc(yy, mm, dd);
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
}

function utc(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d));
}

// --- CSV splitting (quote-aware, minimal RFC-4180) --------------------------

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        q = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      q = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

export function parseBankCsv(csv: string): ParseResult {
  const lines = csv
    .split(/\r\n|\r|\n/)
    .filter((l) => l.trim() !== "");
  if (lines.length < 2) {
    throw new BankCsvError("The file has no data rows.");
  }

  // Find the header row: the first line that names a date and a
  // description-ish column. Real exports sometimes prepend metadata lines.
  let headerIdx = -1;
  let headers: string[] = [];
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    const cells = splitCsvLine(lines[i]);
    if (findCol(cells, DATE_HEADERS) >= 0 && findCol(cells, DESC_HEADERS) >= 0) {
      headerIdx = i;
      headers = cells;
      break;
    }
  }
  if (headerIdx < 0) {
    throw new BankCsvError(
      "Couldn't find a header row with a date and a description column."
    );
  }

  const dateCol = findCol(headers, DATE_HEADERS);
  const descCol = findCol(headers, DESC_HEADERS);
  const amountCol = findCol(headers, AMOUNT_HEADERS);
  const inCol = findCol(headers, IN_HEADERS);
  const outCol = findCol(headers, OUT_HEADERS);
  const refCol = findCol(headers, REF_HEADERS);

  if (amountCol < 0 && inCol < 0 && outCol < 0) {
    throw new BankCsvError(
      'Couldn\'t find an amount column (looked for "Amount", or "Deposit"/"Withdrawal").'
    );
  }

  const rows: ParsedBankRow[] = [];
  let skipped = 0;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const postedDate = parseDateCell(cells[dateCol] ?? "");
    const description = (cells[descCol] ?? "").trim();

    let amount: Decimal | null = null;
    if (amountCol >= 0) {
      amount = parseAmountCell(cells[amountCol] ?? "");
    } else {
      const paidIn = inCol >= 0 ? parseAmountCell(cells[inCol] ?? "") : null;
      const paidOut = outCol >= 0 ? parseAmountCell(cells[outCol] ?? "") : null;
      if (paidIn && !paidIn.isZero()) amount = paidIn.abs();
      else if (paidOut && !paidOut.isZero()) amount = paidOut.abs().negated();
    }

    if (!postedDate || !description || amount === null || amount.isZero()) {
      skipped++;
      continue;
    }
    rows.push({
      postedDate,
      description,
      amount,
      externalRef: refCol >= 0 ? (cells[refCol] ?? "").trim() || undefined : undefined,
    });
  }

  if (rows.length === 0) {
    throw new BankCsvError("No usable rows found under the header.");
  }

  return {
    rows,
    mapped: {
      date: headers[dateCol],
      description: headers[descCol],
      amount: amountCol >= 0 ? headers[amountCol] : `${headers[inCol] ?? ""}/${headers[outCol] ?? ""}`,
    },
    skipped,
  };
}

/**
 * Content hash for idempotent re-import. Computed on PLAINTEXT (before the
 * description column is encrypted at rest), so importing the same file
 * twice collides on the unique (tenantId, dedupeHash) index and is skipped.
 */
export function computeDedupeHash(input: {
  bankAccountId: string;
  postedDate: Date;
  amount: Decimal;
  description: string;
  externalRef?: string | null;
}): string {
  const normDesc = input.description.trim().toLowerCase().replace(/\s+/g, " ");
  const key = [
    input.bankAccountId,
    input.postedDate.toISOString().slice(0, 10),
    input.amount.toFixed(4),
    normDesc,
    input.externalRef ?? "",
  ].join("|");
  return createHash("sha256").update(key).digest("hex");
}
