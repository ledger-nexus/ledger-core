// RLS Phase 2 — Prisma SET LOCAL integration helper.
//
// See docs/architecture/rls-design.md for the full design.
//
// Why this exists:
//   Phase 1 defined per-table RLS policies that read
//   `current_setting('app.current_tenant_id')` to scope visible rows.
//   The policies are not yet FORCED so they're informational-only —
//   but this helper is the path forward.
//
//   `withTenantContext(tenantId, fn)` wraps `fn`'s DB work in a
//   Postgres transaction with `app.current_tenant_id` set to
//   `tenantId` for the duration. Every query inside the callback
//   inherits the GUC, so when Phase 3 lands and the policies are
//   FORCED, the queries automatically scope to the correct tenant.
//
// Why a transaction:
//   `SET LOCAL` is transaction-scoped — it auto-resets at COMMIT /
//   ROLLBACK. Without the LOCAL clause (or set_config with is_local
//   = true), the setting persists for the connection's entire
//   lifetime. With Prisma's pooled connections, the next caller would
//   inherit the previous tenant's GUC. That's a Critical-tier bug
//   (cross-tenant query bleed). The transaction is the load-bearing
//   isolation primitive.
//
// Why set_config() not raw SET LOCAL:
//   Prisma's `$executeRaw` template literal interpolation parameterizes
//   values for SQL injection safety, but parameterized identifiers
//   (variable names) aren't supported. `set_config(name, value, is_local)`
//   is a SQL function that accepts both as values — fully parameterized.
//
// Phase 2a (this file): the helper + tests
// Phase 2b (separate PR): migrate Server Actions + internal HTTP
//   endpoints to wrap their DB work in withTenantContext
// Phase 3: ALTER TABLE FORCE ROW LEVEL SECURITY makes the policies
//   load-bearing; cross-tenant test suite proves it works.

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

/**
 * Run `fn` inside a Postgres transaction with `app.current_tenant_id`
 * set to `tenantId`. The setting is scoped to this transaction (via
 * is_local=true) so concurrent transactions in other connections see
 * their own GUC.
 *
 * Every query inside `fn` receives the `tx` transaction client.
 * Queries issued through `prisma` (the singleton) outside the
 * callback do NOT inherit the GUC — they run on the connection
 * pool's other connections. This is a deliberate constraint: it
 * forces callers to thread `tx` through their data layer.
 *
 * Once Phase 3 lands + RLS is FORCED, queries without the GUC
 * configured will return 0 rows from every tenant-scoped table —
 * a loud failure mode that's easy to catch in tests and impossible
 * to ignore in production.
 *
 * @param tenantId - UUID of the tenant. Must be non-empty.
 * @param fn - Callback that receives the transactional Prisma client.
 *             Throw to abort the transaction.
 * @returns The value `fn` returned.
 * @throws Error if `tenantId` is empty/invalid; whatever `fn` throws.
 *
 * @example
 * await withTenantContext(tenant.id, async (tx) => {
 *   const parties = await tx.party.findMany();
 *   // Phase 3+: parties are RLS-filtered to current tenant.
 *   return parties;
 * });
 */
export async function withTenantContext<T>(
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  if (typeof tenantId !== "string" || tenantId.length === 0) {
    throw new Error(
      "withTenantContext: tenantId is required and must be a non-empty string"
    );
  }

  return prisma.$transaction(async (tx) => {
    // SET LOCAL via set_config() with is_local=true. Returns the
    // configured value (we don't use it but Postgres requires SELECT).
    // The parameterized $executeRaw form is the only injection-safe
    // way to issue this — never interpolate tenantId via string
    // concatenation.
    await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
    return fn(tx);
  });
}

/**
 * Read-only variant. Same semantics as `withTenantContext` but
 * configures the transaction as READ ONLY. Useful for report queries
 * + DSR exports where mutation would be a bug.
 *
 * Postgres rejects any DML against the transaction's connection if
 * the transaction is READ ONLY — a defensive backstop against
 * accidental writes in code paths that should only read.
 */
export async function withTenantContextReadOnly<T>(
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  if (typeof tenantId !== "string" || tenantId.length === 0) {
    throw new Error(
      "withTenantContextReadOnly: tenantId is required and must be a non-empty string"
    );
  }

  return prisma.$transaction(async (tx) => {
    // Make the transaction read-only first; then set the GUC.
    // The order matters: SET TRANSACTION must precede any other
    // statement in the transaction.
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
    return fn(tx);
  });
}

/**
 * Read the currently-configured tenant from the GUC inside an
 * already-open transaction. Useful for assertions in test code
 * that verifies `withTenantContext` wired the GUC correctly.
 *
 * Returns NULL if the GUC isn't set on this connection — that's the
 * fail-closed state Phase 3 RLS relies on (NULL won't match any
 * tenantId predicate).
 */
export async function getCurrentTenantGuc(
  tx: Prisma.TransactionClient
): Promise<string | null> {
  const rows = await tx.$queryRaw<Array<{ tenant_id: string | null }>>`
    SELECT NULLIF(current_setting('app.current_tenant_id', true), '') AS tenant_id
  `;
  return rows[0]?.tenant_id ?? null;
}
