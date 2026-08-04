// Per-transaction tenant context for Postgres Row-Level Security (RLS).
//
// RLS PHASE 1 — the foundation. This wires the mechanism that future RLS
// policies will read; it does NOT enable RLS. Today nothing consumes the
// GUC, so calling this is completely inert and safe: it sets a custom
// transaction-local setting that no policy reads yet.
//
// Why a transaction: `SET LOCAL` / set_config(..., is_local => true) is
// scoped to the current transaction, so the tenant GUC can't leak across
// Prisma's pooled connections. Every query that must be RLS-protected has
// to run on the SAME connection where the GUC was set — i.e. on the `tx`
// client this passes to the callback, never the bare singleton.
//
// Why set_config with a bound parameter (not `SET LOCAL ... = '<uuid>'`):
// `SET LOCAL` can't take a bind parameter, so injecting the tenantId would
// mean string-interpolating it into SQL. set_config(name, value, is_local)
// is a function call whose `value` arg parameter-binds cleanly through
// Prisma's tagged-template $executeRaw — a malformed tenantId can't break
// out into SQL (defense-in-depth on top of the uuid check below).
//
// Roadmap (each a later, separately-reviewed phase — NOT in this PR):
//   2.  CREATE POLICY USING (tenantId = current_setting('app.current_tenant_id')::uuid)
//       on every tenant-scoped table.
//   2b. migrate all Server Actions + HTTP endpoints to run inside
//       withTenantContext instead of the raw singleton.
//   3.  FORCE ROW LEVEL SECURITY + DB-layer cross-tenant tests.
//
// SOC 2 CC6.1: this is the substrate for database-layer multi-tenant
// isolation (today enforced only at the application WHERE-clause layer).

import { PrismaClient, Prisma } from "@prisma/client";

import { UUID_RE } from "@/lib/utils/uuid";

/** The Postgres GUC future RLS policies will read. Keep in sync with the policies. */
export const TENANT_GUC = "app.current_tenant_id";

export class InvalidTenantIdError extends Error {
  constructor(value: string) {
    // Don't echo the raw value beyond a short prefix — it's a tenant id,
    // not a secret, but keep logs tidy.
    super(`withTenantContext requires a UUID tenantId (got "${value.slice(0, 16)}…")`);
    this.name = "InvalidTenantIdError";
  }
}

/**
 * Run `fn` inside a transaction whose Postgres session has
 * `app.current_tenant_id` set to `tenantId` (transaction-local). All
 * queries inside `fn` MUST use the provided `tx` client so they share the
 * connection the GUC was set on.
 *
 * Inert until RLS policies exist — safe to adopt incrementally ahead of
 * the policy + FORCE phases.
 */
export async function withTenantContext<T>(
  prisma: PrismaClient,
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  if (!UUID_RE.test(tenantId)) {
    throw new InvalidTenantIdError(tenantId);
  }
  return prisma.$transaction(async (tx) => {
    // is_local => TRUE makes this a SET LOCAL: the GUC reverts at the end
    // of the transaction and never escapes onto the pooled connection.
    await tx.$executeRaw`SELECT set_config(${TENANT_GUC}, ${tenantId}, TRUE)`;
    return fn(tx);
  });
}

/**
 * Read the current transaction's tenant GUC. Returns null when unset
 * (uses current_setting's missing_ok=true so it never throws). Exposed
 * mainly so tests + diagnostics can assert the context is wired; policies
 * read the GUC directly in SQL, not through this.
 */
export async function currentTenantId(
  tx: Prisma.TransactionClient
): Promise<string | null> {
  const rows = await tx.$queryRaw<Array<{ tid: string | null }>>`
    SELECT current_setting(${TENANT_GUC}, TRUE) AS tid
  `;
  const tid = rows[0]?.tid;
  return tid === "" || tid === undefined ? null : tid;
}
