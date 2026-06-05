# Postgres Row-Level Security (RLS) — design + rollout

**Status:** Phase 1 design complete · **Closes:** deficiency #12 (No Postgres Row-Level Security)
**Owner:** Founder · **Effective date:** 2026-06-05 (design); rollout pending

## Why RLS

Multi-tenancy in this substrate enforces tenant isolation at the **application layer** today — every customer-data query goes through Prisma + `assertTenantScope()` helpers + the pen-test-tenant-isolation suite catches regressions. This is the v1 mitigation per deficiency #11 (now Closed) and risk #17.

The remaining gap is **defense-in-depth at the database layer**: an application bug that forgets `where: { tenantId }` returns the wrong tenant's rows. RLS adds a Postgres-enforced backstop:

```sql
-- Without RLS: app bug → cross-tenant data leak
SELECT * FROM party WHERE id = ?;  -- returns ANY tenant's party

-- With RLS: app bug → empty result
SELECT * FROM party WHERE id = ?;  -- returns 0 rows if id doesn't match current_tenant_id
```

The auditor's question: *"What if a developer writes raw SQL or forgets the tenantId predicate?"* RLS is the answer.

## The pattern

**Per-tenant Postgres GUC** (`SET LOCAL app.current_tenant_id = '<uuid>'`) + **policy per table** (`USING (tenantId = current_setting('app.current_tenant_id', true)::uuid)`).

```sql
-- 1. Enable RLS on the table (defines that policies CAN apply)
ALTER TABLE party ENABLE ROW LEVEL SECURITY;

-- 2. Create the policy (says: only rows where tenantId matches current GUC)
CREATE POLICY party_tenant_isolation ON party
  FOR ALL
  USING ("tenantId" = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant_id', true)::uuid);

-- 3. FORCE RLS (enforces even for table owner = Neon connection role).
--    Without FORCE, owner queries bypass the policy.
ALTER TABLE party FORCE ROW LEVEL SECURITY;
```

`current_setting('app.current_tenant_id', true)` returns `NULL` if the GUC isn't set; the policy's `USING` clause becomes `tenantId = NULL` which evaluates `false` for every row — failing closed.

## Phase rollout

This is a **3-phase rollout** to land RLS without bricking production:

### Phase 1 — Policies defined, NOT enforced (this PR)

**What:** Migration SQL that `ENABLE ROW LEVEL SECURITY` + `CREATE POLICY` on every tenant-scoped table. **NOT** `FORCE`.

**Effect on production:** Zero. Without `FORCE`, the table owner (Neon connection role) bypasses every policy. Application queries return the same rows they always did.

**What it gets us:** The policy definitions are auditable + ready to FORCE. Schema-fingerprint CI will detect drift in the policy set. The migration is reversible (`DROP POLICY`).

### Phase 2 — Prisma integration (separate PR)

**What:** Wrap every Prisma query in a transaction that issues `SET LOCAL app.current_tenant_id = '<tenant.id>'` first. Via `prisma.$extends({ query: { $allModels: { ... } } })` OR `prisma.$transaction(async (tx) => { await tx.$executeRaw\`SET LOCAL ...\`; ... })`.

**Why a transaction:** `SET` without `LOCAL` persists for the connection's lifetime — with Prisma's pooled connections, the next caller inherits the GUC. `SET LOCAL` is scoped to the current transaction and auto-resets at COMMIT/ROLLBACK.

**Effect on production:** Zero. RLS still isn't enforced (no FORCE yet); the SET LOCAL is a no-op against unenforced policies.

**What it gets us:** Every query carries the tenant context to Postgres. Ready for Phase 3.

### Phase 3 — FORCE + cross-tenant test suite (separate PR)

**What:**
1. Run `ALTER TABLE <each> FORCE ROW LEVEL SECURITY;` (this is the real switch).
2. Ship a test suite that explicitly attempts cross-tenant reads/writes and asserts they fail or return 0 rows.
3. Update `assertTenantScope()` helper to be defense-in-depth + document RLS as the load-bearing control.

**Effect on production:** **Real.** Any query without a correctly-set `app.current_tenant_id` GUC returns 0 rows / fails. Bugs that forget tenantId become visible immediately.

**Rollback if needed:** `ALTER TABLE <each> NO FORCE ROW LEVEL SECURITY;` reverts to application-level enforcement. The policies stay defined.

## Tenant-scoped tables (Phase 1 migration target)

Direct-tenantId (32 tables — RLS via own `tenantId` column):

| Table | Notes |
|---|---|
| `tenant` | self-ref — RLS USING `id = current_tenant_id` |
| `tenant_membership` | RLS USING `tenantId = current_tenant_id` |
| `tenant_api_token` | same |
| `legal_entity` | same |
| `fiscal_calendar` | same |
| `period` | same |
| `period_close` | same |
| `party` | same |
| `party_role` | same |
| `item` | same |
| `account` | same |
| `gl_entry_header` | same |
| `gl_entry_line` | same (tenantId denormalized to line for fast filter) |
| `journal_entry_note` | same |
| `recurring_entry` | same |
| `dimension` | same |
| `dimension_value` | same |
| `dimension_set` | same |
| `posting_rule` | same |
| `custom_field_definition` | same |
| `ar_open_item` | same |
| `ar_application` | same |
| `ap_open_item` | same |
| `ap_application` | same |
| `fixed_asset` | same |
| `lease` | same |
| `revenue_contract` | same |
| `queue` | same |
| `record_event` | same |
| `reassignment_rule` | same |
| `notification` | same |
| `audit_log` | **special** — tenantId is nullable for pre-identity TOKEN_REJECTED events. Policy: `USING (tenantId IS NULL OR tenantId = current_tenant_id)`. Justified because audit_log is append-only (Postgres RULE) so cross-tenant write isn't possible. |

Child tables via FK (11 tables — RLS via JOIN to parent):

| Table | Parent | Policy pattern |
|---|---|---|
| `fixed_asset_book_attributes` | `fixed_asset` | EXISTS subquery |
| `lease_book_attributes` | `lease` | EXISTS subquery |
| `revenue_contract_book_attributes` | `revenue_contract` | EXISTS subquery |
| `performance_obligation` | `revenue_contract` | EXISTS subquery |
| `recurring_entry_line` | `recurring_entry` | EXISTS subquery |
| `dimension_set_value` | `dimension_set` | EXISTS subquery |
| `queue_member` | `queue` | EXISTS subquery |

Shared global tables (no RLS — read by all tenants):

| Table | Justification |
|---|---|
| `book` | US_GAAP / US_TAX / IFRS are portfolio-wide concepts |
| `currency` | ISO 4217 reference data |
| `fx_rate` | Daily rates shared across tenants |
| `app_user` | Users belong to tenants via `tenant_membership` (no PII leaked from user table itself per data-classification.md) |

## Why this scheme, not the alternatives

**Alternative A: schema-per-tenant.** Postgres supports it but Prisma doesn't have great ergonomics. Rejected — too disruptive.

**Alternative B: views with WHERE clauses + revoke base-table access.** Theoretically clean but requires rewriting every query through views. Rejected — too invasive.

**Alternative C: application-only enforcement (status quo).** Works today; pen-test suite catches regressions. **Not sufficient for SOC 2 CC6.1 evidence quality** — auditors specifically grade "database-layer enforcement" as a higher CC level.

**Alternative D (CHOSEN): RLS + GUC + 3-phase rollout.** Standard Postgres pattern. Reversible at each phase. Zero production risk in Phases 1+2.

## Schema-fingerprint CI implications

`schemaFingerprint` helper (`src/lib/soc2/index.ts`) reads Prisma's schema definition. RLS policies are Postgres-level + don't show in Prisma's schema. Phase 1 also ships a companion fingerprint that hashes the policy-definition SQL — captured in `/api/health` so the auditor can verify the policy set hasn't drifted.

## Path to deficiency #12 closure

- **Phase 1 (this PR):** Defined + auditable; deficiency #12 status moves Open → Remediated (policies exist, not enforced)
- **Phase 2:** Prisma integration; deficiency #12 remains Remediated (RLS infrastructure complete, awaiting FORCE)
- **Phase 3:** FORCE + tests; deficiency #12 moves Remediated → Closed

## Risk + rollback

| Phase | Production risk | Rollback |
|---|---|---|
| 1 | None — policies defined but not enforced | `DROP POLICY <name> ON <table>; ALTER TABLE <table> DISABLE ROW LEVEL SECURITY;` |
| 2 | None — SET LOCAL is no-op against unforced RLS | Revert PR; transactions still work |
| 3 | **Real** — bad GUC value returns 0 rows for the affected query | `ALTER TABLE <each> NO FORCE ROW LEVEL SECURITY;` — reverts to v1 enforcement |

## Audit evidence trail

After Phase 3 lands:

- **Deficiency log:** #12 closure cites this PR + Phase 2 + Phase 3 PRs
- **SOC2_READINESS:** CC6.1 row updated from "application-layer enforcement" to "application-layer + DB-layer (RLS)"
- **Risk register:** #17 (multi-tenant data leakage) status updated from "Mitigated" to "Mitigated end-to-end (RLS + assertTenantScope)"
- **Schema fingerprint:** policy-set hash exposed at `/api/health` so the auditor can sample any day's state

## Cross-repo implications

This RLS design is ledger-core-only — companion repos (recon, revenue-rec, fa-amort, integrations) read/write ledger-core via internal HTTP endpoints. Those endpoints (server-side in ledger-core) become the trust boundary; companion repos don't need their own RLS.

However: the internal API endpoints in ledger-core must `SET LOCAL app.current_tenant_id` based on the authenticated tenant context. The Phase 2 integration covers this — every endpoint wraps its DB work in a transaction with the SET LOCAL.


## Graft amendment (2026-07-15)

The June chain covered 39 tables. At graft time the schema had grown;
11 post-June tables (close_task, close_task_template, close_task_comment,
close_task_state_change, flux_statement, flux_line, reconciliation,
reconciliation_attachment, reconciliation_config, notification_channel,
notification_dispatch — all direct NOT NULL tenantId) were appended as
sections 40-50, and recurring_entry_line's join column was corrected to
`templateId` (the chain assumed `recurringEntryId`). app_user is
deliberately NOT policied: User is global by design; tenancy attaches
via tenant_membership. Applied to the dev database 2026-07-15:
50 enabled / 0 forced / 50 policies.
