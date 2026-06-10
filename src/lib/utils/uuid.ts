// Canonical UUID validation. Used to distinguish human-actor UUIDs from
// system sentinels in the sub-ledgers and to gate tenant ids before they
// reach SQL (tenant-context). One regex — don't redeclare locally.

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}
