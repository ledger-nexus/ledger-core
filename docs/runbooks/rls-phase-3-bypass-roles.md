# RLS Phase 3 — bypass-role operator runbook

**Status:** DRAFT. Awaits operator sign-off.
**Companion design doc:** `docs/architecture/rls-phase-3-design.md` (Decision C).
**Goal:** Provision Postgres `BYPASSRLS` roles for paths that legitimately need cross-tenant reads after Phase 3 FORCE.

---

## Scope

After Phase 3 FORCE, queries without the `app.current_tenant_id` GUC set return 0 rows from every tenant-scoped table. **Most** application paths handle this correctly via the Phase 2b sweep (PRs #69-#83). A handful of system paths legitimately need a global view across tenants:

| Path | Why cross-tenant | Bypass mechanism | Status |
|---|---|---|---|
| `runRecurringEntries` templates `findMany` | Admin "run all templates" semantics — fetches templates across tenants then iterates with per-iteration GUC | **NONE** (handled inside PR #83 with per-iteration `withTenantContext`) | Already done |
| `/api/cron/retention` (when branch lands) | Daily eviction sweep across all tenants per policy | **Choice:** per-iteration `withTenantContext(tenant.id, ...)` per affected tenant in each policy, OR `revrec_retention_purger` role | Pending — depends on Decision C |
| `/api/health` schema-fingerprint check | DB ping + schema diff; reads no user data; no tenant context exists | **NONE** (no tenant-scoped read in the query path) | Already done |
| `/admin/audit-log` reader UI | Operator/auditor sees all tenant audit rows for incident investigation | **Choice:** `revrec_audit_reader` role (recommended) OR per-tenant outer loop in the page render | Pending — depends on Decision C |
| `buildUserDataExport` DSR pathway | User membership can span multiple tenants; export aggregates across them | **NONE** (existing code already iterates per-tenant; just needs Phase 2b-style wrap added) | Already done — verified in PR #74 |

**The only two paths that genuinely need a `BYPASSRLS` role are the retention engine cron and the audit-log reader UI.** The recurring-entries path uses the P-shape; health check has no tenant-scoped read; DSR aggregates already loop per-tenant.

---

## Decision matrix — per use-case

### Audit-log reader UI (`/admin/audit-log`)

**Question:** Should the operator see all tenants' audit rows in one view, or one tenant at a time via the workspace switcher?

| Option | Trade-off | Recommendation |
|---|---|---|
| Per-tenant loop (status quo) | Operator must switch workspaces to see other tenants' rows; correct for tenant admins. Less useful for the SAAS operator investigating an incident across tenants. | Keep for tenant admins. |
| Dedicated `revrec_audit_reader` BYPASSRLS role | One query sees all rows. SAAS operator can investigate incidents across tenants. Adds a role with read access to every tenant's audit log → potential data-access surface. | Add for the SAAS operator's incident-response tier only. Tenant admins keep using the workspace-switcher path. |

**Recommendation:** Provision `revrec_audit_reader` for the SAAS operator's incident-response tier. Tenant-admin UI continues to use the standard tenant-scoped path.

### Retention engine cron (`/api/cron/retention`, when its branch merges)

**Question:** Should retention iterate per-tenant (P-shape), or run as a single bypass-role query?

| Option | Trade-off | Recommendation |
|---|---|---|
| P-shape (per-iteration) | Each policy's DELETE is wrapped in `withTenantContext(tenant.id, ...)` per affected tenant. Cleanest separation. Slow for many tenants. | Recommended for now (low tenant count). Reassess at 100+ tenants. |
| `revrec_retention_purger` BYPASSRLS role | One query deletes across all tenants. Faster. Role has DELETE access to many tables → larger attack surface if leaked. | Reserved for high-scale (post-100-tenant) optimization. |

**Recommendation:** P-shape until tenant count justifies otherwise. The retention engine's PR (`automated-retention-engine` branch) MUST apply per-iteration `withTenantContext` before it merges to main; this is the gate.

---

## Migration SQL — bypass role provisioning

If/when the operator approves the `revrec_audit_reader` role:

```sql
-- prisma/sql/2026-XX-XX-rls-phase-3-bypass-roles.sql
-- 
-- Provisions BYPASSRLS roles for paths that legitimately need cross-tenant reads.
-- See docs/runbooks/rls-phase-3-bypass-roles.md for the decision matrix.

BEGIN;

-- Role 1: audit-log reader for SAAS-operator incident response.
-- Read-only on audit_log. NO write privileges to anything else.
CREATE ROLE revrec_audit_reader WITH
  LOGIN
  BYPASSRLS
  NOINHERIT
  NOCREATEDB
  NOCREATEROLE
  NOSUPERUSER
  PASSWORD :'audit_reader_password';   -- set via psql var

GRANT CONNECT ON DATABASE :"db_name" TO revrec_audit_reader;
GRANT USAGE ON SCHEMA public TO revrec_audit_reader;
GRANT SELECT ON TABLE "audit_log" TO revrec_audit_reader;

-- Default privileges so future audit-log-related tables inherit SELECT.
ALTER DEFAULT PRIVILEGES FOR ROLE revrec_audit_reader
  IN SCHEMA public GRANT SELECT ON TABLES TO revrec_audit_reader;

-- Role 2: ONLY provision if/when retention cron is migrated to bypass-role path
-- (recommendation: P-shape per-tenant iteration until 100+ tenants). Reserved
-- for future use:
--
-- CREATE ROLE revrec_retention_purger WITH
--   LOGIN
--   BYPASSRLS
--   NOINHERIT
--   PASSWORD :'retention_purger_password';
-- GRANT CONNECT ON DATABASE :"db_name" TO revrec_retention_purger;
-- GRANT USAGE ON SCHEMA public TO revrec_retention_purger;
-- GRANT SELECT, DELETE ON ALL TABLES IN SCHEMA public TO revrec_retention_purger;

COMMIT;
```

Run via:
```bash
psql $DATABASE_URL \
  -v db_name="revrec" \
  -v audit_reader_password="$AUDIT_READER_PASSWORD" \
  -f prisma/sql/2026-XX-XX-rls-phase-3-bypass-roles.sql
```

---

## Secrets management

Required env vars in the deployment:

```
# Standard application DB role (RLS-subject)
DATABASE_URL=postgresql://revrec_app:***@host/revrec

# Bypass roles (used only by specific paths)
DATABASE_URL_AUDIT_READER=postgresql://revrec_audit_reader:***@host/revrec
# DATABASE_URL_RETENTION=postgresql://revrec_retention_purger:***@host/revrec  (not yet provisioned)
```

**Secrets storage:** Same vault as `DATABASE_URL` (Vercel env vars, encrypted at rest, scoped to production). NEVER commit to git.

**Rotation policy:** 90 days. Concretely:
1. Generate new password via `openssl rand -base64 32`.
2. `ALTER ROLE revrec_audit_reader PASSWORD '<new>';`
3. Update env var in Vercel (production scope).
4. Redeploy application.
5. Verify old password is invalidated (`psql` with old DSN → "password authentication failed").

---

## Application code changes (post-role-provisioning)

When the operator approves the `revrec_audit_reader` role and provisions `DATABASE_URL_AUDIT_READER`, the application needs:

1. A second Prisma client targeted at the bypass-role DSN:
   ```ts
   // src/lib/db/audit-reader.ts
   import { PrismaClient } from "@prisma/client";

   // Only constructed when DATABASE_URL_AUDIT_READER is set. Falls back
   // to undefined; callers MUST handle the absence (i.e., the role wasn't
   // provisioned, so the UI degrades to per-tenant-only view).
   export const auditReaderPrisma =
     process.env.DATABASE_URL_AUDIT_READER
       ? new PrismaClient({
           datasources: { db: { url: process.env.DATABASE_URL_AUDIT_READER } },
         })
       : undefined;
   ```

2. The `/admin/audit-log` page detects the bypass client's presence and offers an "across all tenants" toggle:
   ```ts
   const showAllTenants = searchParams.allTenants === "true";
   const client = showAllTenants && auditReaderPrisma ? auditReaderPrisma : prisma;
   const rows = await client.auditLog.findMany({ ... });
   ```

3. Audit-log emit MUST record the bypass-role usage when the operator toggles the across-all-tenants view — a meta-audit so the bypass role's reads are themselves logged.

---

## Operator approval checklist

Operator signs off on the following before this runbook lands:

- [ ] Approve the `revrec_audit_reader` role provisioning. (Owner: ops team)
- [ ] Defer the `revrec_retention_purger` role until tenant count justifies it. (Owner: ops team)
- [ ] Sign off on the 90-day rotation cadence. (Owner: ops + sec team)
- [ ] Confirm Vercel-env-var secret-storage plan. (Owner: ops team)
- [ ] Acknowledge that the application UI gains a new "across all tenants" toggle for the audit-log reader, gated on the env var. (Owner: product)

---

## Decision C resolution

**RESOLVED conditionally** — this runbook proposes:
- `revrec_audit_reader` role provisioned (operator's discretion)
- `revrec_retention_purger` role DEFERRED in favor of P-shape (retention engine PR includes per-iteration `withTenantContext` before merge)

Phase 3 implementation can proceed once the operator acks the above checklist. The application code changes (audit-reader client + UI toggle) ship as a follow-up PR alongside Phase 3 implementation.
