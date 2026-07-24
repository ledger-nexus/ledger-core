// Resolver for "the default tenant" — the single Tenant row created by
// the Phase 1 multi-tenancy migration (slug = "default"). Used by seeds
// and test fixtures that need to create LegalEntities, Accounts, etc.,
// before any real tenant is provisioned.
//
// New production data (post-Clerk-sign-up) should NOT use this helper —
// it should use the requesting user's actual current tenant via
// `requireCurrentTenant()`. This helper is for the migration window
// between v1 (single default tenant) and v2 (real multi-tenant).
//
// Once Phase 4b applies NOT NULL to tenantId everywhere, this resolver
// becomes the only sensible default for legacy code paths still being
// migrated.

import type { Prisma, PrismaClient } from "@prisma/client";

// Widened DB client type — accepts both PrismaClient and TransactionClient.
// RLS Phase 2b pattern; see docs/architecture/rls-phase-2b-migration-guide.md.
type Db = PrismaClient | Prisma.TransactionClient;

const DEFAULT_TENANT_SLUG = "default";

export async function getDefaultTenantId(prisma: Db): Promise<string> {
  const t = await prisma.tenant.findUnique({
    where: { slug: DEFAULT_TENANT_SLUG },
    select: { id: true },
  });
  if (!t) {
    throw new Error(
      `Default tenant (slug="${DEFAULT_TENANT_SLUG}") not found. ` +
        "Run prisma migration 0002_multi_tenancy first (creates it + " +
        "backfills existing rows). See docs/multi-tenancy.md."
    );
  }
  return t.id;
}

// Same bootstrap identity CI uses, so a locally-reset database and the CI
// database agree on who owns the default tenant.
const BOOTSTRAP_USER_EMAIL = "ci-bootstrap@northwind.test";

// SEED/CLI USE ONLY. Creates the default tenant (and its owner user) when
// missing. In a migrate-deploy world this is migration 0002_multi_tenancy's
// DO block — but the schema is `db push`-managed (no baseline migration), so
// a fresh or force-reset database has no tenant row at all and the Northwind
// seed would throw in getDefaultTenantId.
//
// Runtime code must never call this: tenants are provisioned through
// sign-up, and a runtime path that silently mints a tenant would bypass it.
// getDefaultTenantId stays strict (throws) for exactly that reason.
export async function ensureDefaultTenant(prisma: PrismaClient): Promise<string> {
  // CC6 — `email` is encrypted at rest with a random IV, so the same
  // plaintext yields different ciphertext on every write. That makes the
  // column's @unique unenforceable AND would make this upsert never match
  // an existing row, silently minting a second bootstrap owner on every
  // call with no constraint violation to catch it.
  //
  // The filter below stays in plaintext ON PURPOSE: the encrypted-fields
  // extension rewrites it onto the deterministic `emailHash` when a
  // deterministic key is configured, and leaves it alone when there isn't
  // one (in which case writes weren't hashed either, so plaintext is the
  // correct match). Calling the hash helper here directly would THROW in
  // any environment without FIELD_DETERMINISTIC_KEY — which includes CI.
  const owner = await prisma.user.upsert({
    where: { email: BOOTSTRAP_USER_EMAIL },
    update: {},
    create: { email: BOOTSTRAP_USER_EMAIL, displayName: "CI Bootstrap" },
    select: { id: true },
  });
  const tenant = await prisma.tenant.upsert({
    where: { slug: DEFAULT_TENANT_SLUG },
    update: {},
    create: {
      slug: DEFAULT_TENANT_SLUG,
      name: "Default Tenant",
      ownerUserId: owner.id,
    },
    select: { id: true },
  });
  return tenant.id;
}
