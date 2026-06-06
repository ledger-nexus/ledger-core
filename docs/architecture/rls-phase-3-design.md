# RLS Phase 3 — design

**Status:** DRAFT. Open for review. NOT yet implemented.
**Prereq:** Phases 1 (PR #66), 2a (PR #67), 2b (PRs #69-#83) all merged.
**Closes:** Final scope of deficiency #12 (RLS not FORCED).
**Goal:** Make RLS policies LOAD-BEARING. Queries without `app.current_tenant_id` GUC set return 0 rows (fail closed).

---

## What FORCE does

`ALTER TABLE <t> FORCE ROW LEVEL SECURITY` flips an RLS-ENABLEd table from advisory to enforcing:
- Without FORCE: policies are evaluated but not enforced unless the connecting role has `BYPASSRLS = false`. Application roles (like our Postgres user) typically have `BYPASSRLS = true` via being the table owner — so all rows are visible regardless of policy.
- With FORCE: policies are enforced even for the table owner. Only roles with explicit `BYPASSRLS` privilege can read past them.

After FORCE:
- Queries with `app.current_tenant_id = '<uuid>'` set on the connection see only matching rows.
- Queries WITHOUT the GUC set see 0 rows from every tenant-scoped table (because `tenantId = NULL` matches nothing).
- A query that bypasses the helpers (raw `prisma.<model>.findMany()` outside `withTenantContext`) will silently return empty results — a LOUD failure mode in tests, a SILENT data-disappearance bug in production if shipped without test coverage.

The empty-result mode is what makes Phase 2b's call-site sweep load-bearing. Every call site has to be wrapped or it stops working.

---

## Pre-flight checklist

Before flipping FORCE, verify:

1. **All Phase 1 policies present on every tenant-scoped table.**
   ```bash
   psql $DATABASE_URL -c "\d+ <table>"   # confirm "ENABLE ROW LEVEL SECURITY" on every table
   psql $DATABASE_URL -c "SELECT tablename FROM pg_policies WHERE schemaname='public';"   # confirm policy count
   ```
   The Phase 1 migration creates 39 policies. Diff against `prisma/sql/2026-06-05-rls-phase-1-policies.sql` to confirm none were dropped post-migration.

2. **Every Server Action / route / cron uses `withTenantContext`.**
   ```bash
   # Should produce ONLY the documented exceptions + Phase-2b-skipped paths:
   grep -rn "import { prisma }" src/app/api/internal/ src/app/actions/ | grep -v node_modules
   ```
   Expected exceptions (intentionally outside the wrap):
   - `setCurrentUserAction` (User table is shared global; no tenant scope)
   - `setTenantAction` (cross-tenant membership lookup by design)
   - `setScopeAction` (cookie write, no DB)
   - Cross-tenant security probes in `/api/internal/journal-entries` + `/api/internal/fixed-asset` UnknownEntity handlers (see "Probe handling" below)
   - The `runRecurringEntries` templates `findMany` (see "Bypass-role helpers" below)

3. **Cross-tenant test suite green on Phase 1+2b stack.** (See "Test suite design" below.)

4. **Operator runbook drafted + signed off.** Includes rollback procedure (drop FORCE, document why).

---

## What FORCE does NOT do

- Does not solve cross-tenant security probes (entity-code collision, suspicious-lookup audit). Those are application-layer concerns.
- Does not enforce the dimension engine's per-tenant scoping (DimensionSet rows are tenant-scoped via existing predicates; their RLS policies were already established in Phase 1).
- Does not encrypt data at rest or alter the existing column-level encryption from the deterministic-encryption arc.
- Does not protect against application-layer privilege escalation. A signed-in user with admin permissions can still cause damage within their tenant.

---

## Outstanding decisions from Phase 2b

### A. Cross-tenant security probes

Two routes intentionally do a GLOBAL `legalEntity.findFirst({ where: { code } })` outside `withTenantContext` to detect a token holder targeting another tenant's entity (security audit-event):

- `/api/internal/journal-entries` (PR #81, line ~338)
- `/api/internal/fixed-asset` (PR #82, line ~181)

After FORCE, these queries will return null even when an entity exists in another tenant — the audit event will never fire, and the operator loses visibility into cross-tenant probe attempts.

**Options:**

1. **DROP the probes.** Accept uniform `UNKNOWN_ENTITY` responses. Audit chain doesn't depend on the cross-tenant detection — every internal-API call already audits success/failure. Loss is operator visibility into mis-configured companion-repo tokens (token tagged tenant-A but trying to write to tenant-B).
2. **Create a `BYPASSRLS` role for the probe paths.** Use a dedicated read-only Postgres role for the probe query. Carries operational overhead (role provisioning, secrets management).
3. **Re-implement probes via DB-side trigger on insert failure.** When `UNKNOWN_ENTITY` would fire, a Postgres function checks whether the entity exists ANYWHERE (via SECURITY DEFINER) and signals via NOTIFY. Application listens and audits. Adds complexity.

**Recommendation:** Option 1. The audit-on-token-use already captures the failure event with the entity code attempted. Cross-tenant detection is a nice-to-have, not load-bearing for SOC 2 CC6.7. **Decision needed before FORCE.**

### B. Shape-E known-gap class (entity-code collisions)

`period-close.ts` (PR #75) and `record-depreciation/route.ts` (PR #82) resolve entities by code WITHOUT tenantId scope. Phase 3 FORCE will naturally mitigate (RLS blocks cross-tenant read), but the resulting `UNKNOWN_ENTITY` error is less informative than a proper "wrong tenant" rejection.

**Recommendation:** Add explicit `requireCurrentTenant()` + tenantId-scoped entity lookup to both sites in a follow-up PR (separate from Phase 3 flip). Lands BEFORE FORCE to provide informative errors. Tracked as a follow-up deficiency.

### C. Bypass-role helpers

A handful of system paths legitimately need to read across tenants:

- `runRecurringEntries` templates fetch (cross-tenant by design — admin "run all templates" semantics)
- DSR export tools (`buildUserDataExport` walks all tenants the user is a member of)
- Audit-log readers (operator sees all tenant audit rows)
- Health-check endpoint (`/api/health` queries no user data but does check schema)

After FORCE, these need to either:
1. Wrap each per-tenant iteration in its own `withTenantContext(tenantId, ...)` (the **P-shape** pattern from PR #83).
2. Use a dedicated `BYPASSRLS` Postgres role.

**Recommendation:** Option 1 wherever possible (per-tenant iteration). Option 2 only for paths that genuinely need a global view (audit log, health check). Provision a `revrec_audit_reader` role for those paths with documented use-cases.

### D. Cron job migration

The retention engine cron + the recurring-entries cron both call into shared infra. Audit each cron's data-access pattern and migrate to the P-shape OR document a bypass role.

---

## Cross-tenant test suite design

Phase 3 needs a load-bearing test suite that proves FORCE actually works. Design:

```
tests/rls-phase-3-cross-tenant.test.ts
```

### Fixtures

- Tenant A (slug `rls-tenant-a`), Tenant B (slug `rls-tenant-b`). Both with:
  - 1 LegalEntity (codes `A_CORP` / `B_CORP`)
  - 1 Book (`US_GAAP` — shared global)
  - 1 ChartOfAccounts entry (`1000` Cash)
  - 1 posted JournalEntry
  - 1 Notification

### Test categories

**Category 1: GUC missing → 0 rows.** For each tenant-scoped table:
```ts
it("findMany on <table> returns 0 rows when no GUC set (post-FORCE)", async () => {
  const rows = await prisma.<table>.findMany();
  expect(rows).toHaveLength(0);
});
```
Expected ~30 tests (one per direct-tenantId table). Fail-closed verification.

**Category 2: Correct GUC → correct tenant's rows.** For each table:
```ts
it("findMany on <table> with tenant-A GUC returns ONLY tenant-A rows", async () => {
  const rows = await withTenantContext(tenantA.id, async (tx) => tx.<table>.findMany());
  for (const row of rows) {
    expect(row.tenantId).toBe(tenantA.id);
  }
});
```

**Category 3: Cross-tenant write attempt → rejection.** Force a tenant-A GUC and try to write a tenant-B row:
```ts
it("create with mismatched tenantId fails under FORCE", async () => {
  await expect(
    withTenantContext(tenantA.id, async (tx) =>
      tx.party.create({ data: { tenantId: tenantB.id, code: "ACME", ... } })
    )
  ).rejects.toThrow();
});
```

**Category 4: Per-record write check (WITH CHECK clause).** Confirm policies' `WITH CHECK` rejects inserts whose `tenantId` doesn't match the GUC.

**Category 5: Shape-specific regression suite.** One test per migration shape (W1/W2/T1/T2/E/M/P) that proves the migrated call site WORKS under FORCE. Use the existing Phase 2b tests as scaffolds.

**Category 6: Negative tests — known-exception paths.** Verify that explicitly-excepted paths (setCurrentUserAction, etc.) still function — they don't try to read tenant-scoped rows so should be unaffected.

### Test setup

```ts
beforeAll(async () => {
  // Create tenant A + B with fixtures.
  // FORCE is already on (set by Phase 3 migration that runs before tests).
});

afterAll(async () => {
  // Cascade-delete tenant rows. RLS doesn't apply to TRUNCATE/DELETE
  // by the owner role, so cleanup is straightforward.
});
```

### CI gating

The cross-tenant test suite runs on every PR that touches `src/lib/db/`, `src/app/`, `prisma/`, or any helper widening. Gates PR merge. Treat failures as ship-blockers.

---

## Migration SQL (Phase 3)

```sql
-- prisma/sql/2026-XX-XX-rls-phase-3-force.sql
-- 
-- Phase 3: flip every tenant-scoped table from ENABLE to FORCE.
-- After this migration, all queries against these tables filter by
-- the app.current_tenant_id GUC. Queries without the GUC return 0
-- rows (fail closed).
--
-- Pre-flight: see docs/architecture/rls-phase-3-design.md.
-- Rollback: ALTER TABLE <t> NO FORCE ROW LEVEL SECURITY; (re-runs)

BEGIN;

-- Direct-tenantId tables (32) — these have a tenantId column directly:
ALTER TABLE "Party" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Account" FORCE ROW LEVEL SECURITY;
ALTER TABLE "LegalEntity" FORCE ROW LEVEL SECURITY;
-- ... etc.

-- Child tables via EXISTS (7) — these inherit tenancy via FK to a parent:
ALTER TABLE "JournalLine" FORCE ROW LEVEL SECURITY;
-- ... etc.

-- Verification:
SELECT relname,
       relrowsecurity AS rls_enabled,
       relforcerowsecurity AS rls_forced
FROM pg_class
WHERE relkind = 'r'
  AND relnamespace = 'public'::regnamespace
ORDER BY relname;
-- Every tenant-scoped table should show rls_enabled=true AND rls_forced=true.

COMMIT;
```

Migration is **idempotent** — re-running is a no-op. Rollback is dropping FORCE on each table (preserves policies; just makes them advisory again).

---

## Rollout plan

### Phase 3a — preparation (no operator action)

1. Land all Phase 2b PRs (#69-#83) on `main`.
2. Land follow-up PRs addressing decisions A, B, C, D above.
3. Land the Phase 3 cross-tenant test suite (CI-gated, against Phase 1 policies — they're advisory at this point, but the tests should still pass because the GUC is correctly set everywhere).

### Phase 3b — staged FORCE on dev

1. Apply Phase 3 migration to dev branch.
2. Run full test suite. Expect everything to pass.
3. Manual smoke test: log in, navigate every page, post a JE, run a depreciation batch.
4. Validate audit logs continue to populate (auditTokenUse, auditPrivilegedAction).

### Phase 3c — production FORCE

1. Operator schedules a maintenance window (FORCE flip is fast — likely < 5 seconds — but rollback discipline matters).
2. Apply migration. Monitor:
   - `/api/health` → must return ok
   - Error rates in monitoring (Sentry shim)
   - Any 5xx surge in routes
3. If anything breaks, run rollback: `ALTER TABLE <t> NO FORCE ROW LEVEL SECURITY;` per affected table. Document in incident response log.

### Success criteria

- Audit-log volume: NO DROP. (Verify same hourly rate pre- and post-FORCE.)
- Health-check: 200 ok.
- No new INTERNAL_ERROR / 500 traces in Sentry.
- Cross-tenant test suite: 100% green.

---

## Open questions

- [ ] Decision A: drop probes, role-based bypass, or NOTIFY-based audit? **Default recommendation: drop probes.**
- [ ] Decision B: when does the shape-E gap fix land? **Recommend: before Phase 3.**
- [ ] Decision C: bypass-role provisioning — who manages secrets? **Recommend: dedicated role per use-case, secrets in env.**
- [ ] Decision D: cron migration — block on Phase 3 or treat as follow-up? **Recommend: must precede Phase 3.**
- [ ] Decision E: should the test suite require Phase 3 to be on, or run against Phase 1 advisory mode? **Recommend: both modes via a CI matrix.**

---

## CC4 monitoring note

This design doc is the institutional artifact that ties the Phase 2b sweep's outcomes to the Phase 3 next steps. The fact that 4 distinct decisions surfaced (A-D) is direct evidence that the sweep was non-trivial — they're not afterthoughts, they're constraints the sweep discovered while migrating real code. Each was inline-documented in its originating PR. This doc consolidates them so the Phase 3 implementer doesn't need to dig through 14 PRs to find them.

The decision section explicitly lists "Recommend: X" so a future operator (or auditor) can see what shape the design defaults to. If they pick differently, they document why. If they pick the recommendation, they ack it. Either way the audit chain is intact.
