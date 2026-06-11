// DB query sentinels.
//
// Helpers for "match nothing" filters in Prisma where clauses, used by
// pages and components that gracefully degrade to "no data" when the
// caller isn't signed in or hasn't selected a tenant.
//
// HISTORY: previously, several Server Components used `{ id: "__none__" }`
// or `{ tenantId: "__none__" }` to express "match nothing." That sentinel
// was a string literal containing an underscore, which Prisma rejects
// at deserialization time when the target column is typed `@db.Uuid` —
// the error is `Inconsistent column data: Error creating UUID, ... found
// '_' at 1`. Effect: every signed-out page request crashed at the layout
// level (BookSwitcher) or at the page level (journal-entries / ap / ar /
// consolidation). Caught by runtime verification 2026-06-09; the fix
// here is a single well-known nil UUID instead of an ad-hoc string.
//
// `NIL_UUID` matches no real row because all production UUIDs come from
// `gen_random_uuid()` which never returns the all-zeros UUID. It's also
// the value the Postgres `uuid_nil()` function returns, so it's a
// portable sentinel any UUID column accepts.

/** All-zeros UUID — a valid UUID string that matches no real row. */
export const NIL_UUID = "00000000-0000-0000-0000-000000000000" as const;

/**
 * Build a "match no tenant" filter — used by Server Components that need
 * to return zero rows when there's no current tenant rather than throwing.
 *
 * Pass a real tenant id (typically from `getCurrentTenant()`) and you get
 * `{ tenantId: <id> }`. Pass null / undefined and you get `{ tenantId:
 * NIL_UUID }` — the query runs, returns no rows, no Prisma crash.
 */
export function tenantScopeOrNone(tenantId: string | null | undefined): {
  tenantId: string;
} {
  return { tenantId: tenantId ?? NIL_UUID };
}
