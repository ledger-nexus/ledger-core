// v0.9 NS SuiteAnalytics Phase 2 — NS internalid → ledger-core code resolver.
//
// The /api/external/ns-analytics/* endpoints accept NS-side params
// (subsidiary=1, accountingBook=2) so external BI tools can call us
// the same way they'd call a real NS tenant. These resolvers map those
// NS internalids to ledger-core codes via lineage already populated by
// the import path:
//
//   - LegalEntity.extensions.nsInternalid  (written by setupSubsidiaries, v0.7)
//   - Book.extensions.nsAccountingBookSourcePayloads
//                                          (written by setupBooks, v0.9 Phase 4.5)
//   - Account.sourceSystem = "NETSUITE" + sourceRecordId
//                                          (written by NS import, v0.6)
//
// Every resolver:
//   - Scopes by tenantId — cross-tenant probes return null
//   - Returns { code, id } on hit, null on miss
//   - Caller turns null into 404 with a structured error body

import type { PrismaClient } from "@prisma/client";

export interface ResolvedEntity {
  entityCode: string;
  entityId: string;
}

export interface ResolvedBook {
  bookCode: string;
  bookId: string;
}

export interface ResolvedAccount {
  accountCode: string;
  accountId: string;
}

/**
 * NS Subsidiary internalid → ledger-core LegalEntity.
 *
 * Reads LegalEntity.extensions.nsInternalid (populated by v0.7
 * setupSubsidiaries). Multi-tenant safe — scopes by tenantId so a token
 * for tenant A can never resolve tenant B's NS subsidiary.
 *
 * Ambiguity case: if an operator imported the same NS subsidiary twice
 * with different entityCodePrefix values (e.g. ACME and BETA), two
 * LegalEntity rows share nsInternalid="1". findFirst returns the
 * first one ordered by code — deterministic but operator-actionable.
 * The caller's audit log records which entityCode was hit.
 */
export async function resolveNsSubsidiary(
  prisma: PrismaClient,
  input: { tenantId: string; nsInternalid: string }
): Promise<ResolvedEntity | null> {
  const row = await prisma.legalEntity.findFirst({
    where: {
      tenantId: input.tenantId,
      extensions: { path: ["nsInternalid"], equals: input.nsInternalid },
    },
    select: { id: true, code: true },
    orderBy: { code: "asc" },
  });
  if (!row) return null;
  return { entityCode: row.code, entityId: row.id };
}

/**
 * NS AccountingBook internalid → ledger-core Book.
 *
 * Reads Book.extensions.nsAccountingBookSourcePayloads — a dictionary
 * keyed by NS internalid that v0.9 Phase 4.5 setupBooks stashes when
 * the multi-book NS import lands. Multiple NS books may fold into one
 * ledger-core Book (operator-controlled mapping), so the dictionary
 * holds N entries per Book row.
 *
 * NOT tenant-scoped: Book is a global resource in ledger-core (one
 * "US_GAAP" row shared across tenants). The endpoint layer pairs this
 * with the tenant-scoped subsidiary resolver so combined scope is still
 * tenant-correct.
 */
export async function resolveNsAccountingBook(
  prisma: PrismaClient,
  input: { nsInternalid: string }
): Promise<ResolvedBook | null> {
  // We can't filter by nested JSON dict keys directly in a single
  // Prisma query (the JSON-path filter requires a scalar comparator),
  // and `not: undefined` is not a valid Prisma filter shape. Fetch all
  // books + scan client-side. The cardinality is tiny (typically 3-5
  // books per deployment), so this is cheaper than maintaining a
  // denormalized table.
  const candidates = await prisma.book.findMany({
    select: { id: true, code: true, extensions: true },
    orderBy: { code: "asc" },
  });
  for (const b of candidates) {
    const ext = (b.extensions ?? {}) as Record<string, unknown>;
    const stash = (ext.nsAccountingBookSourcePayloads as
      | Record<string, unknown>
      | undefined) ?? {};
    if (input.nsInternalid in stash) {
      return { bookCode: b.code, bookId: b.id };
    }
  }
  return null;
}

/**
 * NS Account internalid → ledger-core Account.
 *
 * Reads Account.sourceRecordId — populated by the v0.6 NS importer.
 * NS-imported accounts are global (entityId: null per the v0.7 chart-
 * of-accounts decision), so this isn't entity- or tenant-scoped at the
 * row level. Tenant scoping is enforced upstream — the endpoint only
 * calls this resolver after the subsidiary resolver succeeds for the
 * caller's tenant.
 */
export async function resolveNsAccount(
  prisma: PrismaClient,
  input: { tenantId: string; nsInternalid: string }
): Promise<ResolvedAccount | null> {
  // Tenant-scoped (CC6.1): "global" NS accounts are entityId-null but
  // still carry tenantId — an unscoped lookup would be a cross-tenant
  // existence oracle (another tenant's account code via hit-vs-404).
  const row = await prisma.account.findFirst({
    where: {
      tenantId: input.tenantId,
      sourceSystem: "NETSUITE",
      sourceRecordId: input.nsInternalid,
    },
    select: { id: true, code: true },
    orderBy: { code: "asc" },
  });
  if (!row) return null;
  return { accountCode: row.code, accountId: row.id };
}
