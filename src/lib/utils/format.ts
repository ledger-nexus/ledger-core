// Money formatting. Always run through this so currency display is
// consistent across the UI: 2 decimals, comma thousands, parens for
// negatives (accountant convention).

import type { Decimal } from "@/lib/utils/decimal";

export function formatMoney(value: Decimal | string | number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const num =
    typeof value === "object" && "toNumber" in value ? (value as Decimal).toNumber() : Number(value);
  if (Number.isNaN(num)) return "—";
  const abs = Math.abs(num).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return num < 0 ? `(${abs})` : abs;
}

export function formatDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toISOString().slice(0, 10);
}

export function moneyClass(value: Decimal | string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const num =
    typeof value === "object" && "toNumber" in value ? (value as Decimal).toNumber() : Number(value);
  if (Number.isNaN(num) || num === 0) return "";
  return num < 0 ? "text-negative" : "";
}
