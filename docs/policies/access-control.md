# Access control policy

**Version:** 2.0 · **Effective date:** 2026-06-03 · **Owner:** Founder (sole maintainer)
**Last reviewed:** 2026-06-03
**Prior version:** 1.0 (pre-Clerk, pre-RBAC, pre-tenant-scoped-membership)

This is the SOC 2 CC6.1/CC6.2/CC6.3 anchor document. Every rule
below is **either enforced in code or has a documented compensating
control**. If the auditor asks "show me where this is enforced",
every row points at a file path.

## Authentication

| Item | Standard | Current state (2026-06-03) |
|---|---|---|
| Authentication provider | Clerk-managed OIDC | **Shipped** — `src/lib/auth/clerk.ts`. Middleware fails closed in production without Clerk env (`commit b99bbb4`). |
| Dev auth | HMAC cookie stub gated by `NODE_ENV !== "production"` | `src/lib/auth/current-user.ts` — refuses to issue a dev session in production builds |
| Password storage | Clerk-managed | N/A in our DB |
| MFA | Available; enforced for OWNER role | **Partial** — Clerk-side configuration; documented in `docs/policies/risk-register.md` #20 as Partial pending IP-anomaly alerting |
| Session timeout | 8h idle / 24h absolute | Clerk default; tunable per tenant once `Tenant.sessionMaxIdleMinutes` lands |
| Session revocation | Logout + Clerk admin "remote sign-out" | Clerk dashboard |

**Action items:**
- [ ] Enforce Clerk MFA for OWNER + ADMIN roles (currently optional)
- [ ] Wire IP-anomaly alerting into Sentry (#20 in risk register)
- [ ] Document founder account recovery procedure (for the single-OWNER case)

## Authorization

**Per-tenant role-based access control.** Every tenant has its own
4-role hierarchy + 16 named permissions. The policy module is the
single source of truth.

### Role hierarchy

```
OWNER > ADMIN > MEMBER > VIEWER
```

| Role | Typical use case | Source-of-truth |
|---|---|---|
| `OWNER` | Founder / CFO of the tenant. One per tenant (enforced). Transfer flow via `/admin/tenant`. | `TenantMembership.role` |
| `ADMIN` | Controller / accounting manager. Can manage memberships, close/reopen periods, run admin reset. | `TenantMembership.role` |
| `MEMBER` | Bookkeeper / accountant. Post JEs, run reports, view all tenant data. | `TenantMembership.role` |
| `VIEWER` | Read-only auditor or auditing CPA. No write actions. | `TenantMembership.role` |

### Permission catalog (16 named permissions)

All in `src/lib/auth/policy.ts`. Each Server Action calls the matching
`canX(role)` helper. Hard-coded role-string comparisons are forbidden
(`/soc2-check` scans for them).

| Permission | Min role | Server Action examples |
|---|---|---|
| `canViewReports` | VIEWER | every `/reports/*` page |
| `canPostJournalEntries` | MEMBER | `/journal-entries/new`, all import paths |
| `canManageMemberships` | ADMIN | `/admin/team` invite + revoke |
| `canClosePeriod` | ADMIN | `/periods` close/reopen |
| `canReopenPeriod` | ADMIN | `/periods` reopen (separate gate so it can tighten to OWNER later) |
| `canExportAuditLog` | ADMIN | `/admin/audit-log` CSV download |
| `canRunAdminReset` | OWNER | `/admin/reset` (irreversible — owner-only) |
| `canTransferOwnership` | OWNER | `/admin/tenant` owner-transfer flow |
| `canEraseUserData` | OWNER | DSR erasure Server Action (irreversible — owner-only per `docs/policies/data-subject-requests.md`) |
| `canExportUserData` | ADMIN | DSR export Server Action (or self) |
| `canManageBilling` | OWNER | Stripe billing dashboard |
| `canManageConfig` | ADMIN | `Tenant.monthlyAiSpendCapUsd`, `jeApprovalMinAmount`, `requireJeApproval` |
| `canApproveJournalEntry` | ADMIN | JE approval queue |
| `canSubmitJournalEntryForApproval` | MEMBER | JE submit-for-approval |
| `canRunRetentionPurge` | (system only — `CRON_SECRET`) | `/api/cron/retention` |
| `canPostInternalEvent` | (system only — `INTERNAL_API_TOKEN`) | `/api/internal/*` |

**Non-negotiables:**
- "User is signed in" is necessary but NEVER sufficient. Every Server
  Action calls `requirePermission(...)` after `requireCurrentUser()` +
  `requireCurrentTenant()`. The pen-test-tenant-isolation suite covers
  attempted bypass.
- Cross-tenant data access is impossible: every customer-data query
  carries `tenantId`; `assertTenantScope()` from `@/lib/soc2`
  enforces post-fetch. See `docs/SOC2_CONTROL_MATRIX.md` CC6.1.

## Provisioning

**Today (multi-tenant, Clerk-backed):**

1. User signs up via Clerk hosted page.
2. Clerk webhook (`/api/webhooks/clerk`) creates the local `User` row
   in ledger-core's DB (canonical) + queues replication to companion
   repos.
3. User accepts a `TenantInvite` (or creates their own tenant).
4. `TenantMembership` row created with the invited role; default is
   `MEMBER` unless the invite specified otherwise. OWNER is set at
   tenant creation and not invitable.
5. Provisioning event writes a `PROVISIONING/user.invited` row to
   `audit_log` with the invite token id.

**Tenant creation:**
- A user with no current tenant lands on the "Create tenant" path.
- The creating user becomes the first OWNER. There is no other path
  to OWNER except via owner transfer.

## Deprovisioning

| Step | What | File |
|---|---|---|
| 1 | User self-deactivates OR ADMIN deactivates them | `setDeactivatedAt` Server Action |
| 2 | All `prisma.user.find*` calls filter by `deactivatedAt = null` by default; signed-in session is invalidated | `src/lib/auth/current-user.ts` |
| 3 | Orphan-records review surfaces any records still owned by the deactivated user | `src/lib/ownership/orphan-detection.ts` |
| 4 | Reassignment via `/admin/orphans` (ADMIN-gated) | Server Action |
| 5 | Audit row `LIFECYCLE/user.deactivated` written | `audit_log` |

**Contractor / departing employee offboarding:**

1. **Revoke Vercel access** within the same business day. The Vercel
   audit log captures the revocation.
2. **Remove from `.github/CODEOWNERS`** in a same-day PR.
3. **Deactivate User row** in production via the Server Action.
4. **Rotate any tokens they had access to:** `INTERNAL_API_TOKEN`,
   `CRON_SECRET`, `FIELD_ENCRYPTION_KEY` if they handled it directly.
5. **Verify with the access-review procedure** that no role they had
   is now orphaned (i.e., they were not the sole ADMIN of any tenant).
6. Audit row `LIFECYCLE/user.offboarded` with the rotation manifest.

## Access reviews

**Cadence:** Quarterly. **Trigger:** Calendar reminder on the first
Monday of each quarter.

**Procedure:**

1. Export current users + per-tenant memberships via
   `/admin/access-review` (CSV download — `ADMIN` role on each tenant
   the reviewer touches).
2. For each user × tenant: verify the assigned role is still
   warranted. Promote, demote, or revoke.
3. **For each OWNER:** verify the OWNER is still the appropriate one.
   If a tenant has been transferred since the last review, verify the
   transfer is reflected.
4. **For each ADMIN:** verify the assignment is still warranted given
   the user's actual responsibilities.
5. **For service tokens** (`INTERNAL_API_TOKEN`, `CRON_SECRET`,
   `FIELD_ENCRYPTION_KEY`, `FIELD_DETERMINISTIC_KEY`): verify rotation
   age (see rotation table below). Rotate any token older than the
   policy cadence.
6. Sign off in `docs/policies/access-review-{YYYY-Q}.md` (new file
   per quarter). Audit row `CONFIG_CHANGE/access_review.completed`.

## Service tokens

The portfolio uses 4 standing service tokens. All live in Vercel's
encrypted env (RESTRICTED tier). Verification via `constantTimeEqual`
from `@/lib/soc2` — never `===` (no timing oracle).

| Token | Used by | Rotation cadence | Last rotated |
|---|---|---|---|
| `INTERNAL_API_TOKEN` | Companion repos → ledger-core internal APIs | 90 days | 2026-05-30 (initial provisioning) |
| `CRON_SECRET` | Vercel Cron → `/api/cron/*` | 90 days | 2026-06-02 (initial provisioning) |
| `FIELD_ENCRYPTION_KEY` | All 5 repos (AES-256-GCM) | Annual (re-encrypts every encrypted row — high-cost rotation) | 2026-05-31 (initial provisioning) |
| `FIELD_DETERMINISTIC_KEY` | ledger-core (HMAC-SHA256 search hash) | Annual (re-hashes every email row — high-cost rotation) | 2026-05-31 (initial provisioning) |

### Rotation procedure (per token)

**Standard rotation (`INTERNAL_API_TOKEN`, `CRON_SECRET`):**

1. Generate new token: `openssl rand -hex 32`.
2. Set in Vercel as a NEW env var (e.g., `INTERNAL_API_TOKEN_NEW`).
3. Update consuming code to accept either old or new (2-week overlap window).
4. Push to all 5 repos.
5. Update each consumer's matching env var.
6. After 2 weeks: remove old env var; update code to accept only new.
7. Audit-log row `CONFIG_CHANGE/token.rotated`.

**Encryption-key rotation (`FIELD_ENCRYPTION_KEY`, `FIELD_DETERMINISTIC_KEY`):**

These are higher-cost: every encrypted row needs re-encryption (AES key)
or re-hashing (HMAC key). Procedure:

1. Generate new key: `openssl rand -hex 32`.
2. Land a code change that supports both keys during the rollout
   (key version byte allows it — AES-GCM rows carry a version prefix).
3. Schedule a maintenance window. During the window:
   - Backfill script re-encrypts/re-hashes every affected row using
     the new key.
   - Idempotent: re-run safe if interrupted.
4. After backfill completes, remove the old key from code and env.
5. Verify via `verify-encryption-rollout.sh`.
6. Audit-log row `CONFIG_CHANGE/key.rotated` with key version transition.

Full procedure: `docs/runbooks/encryption-rollout.md` (the same runbook
used for the initial encryption-at-rest rollout).

## Database access

| Surface | Access path | Authorization |
|---|---|---|
| Production Neon (Vercel-bound) | Vercel env `DATABASE_URL` | Vercel admin only (founder) |
| Neon branches (dev/staging) | `neonctl` CLI | Founder's Neon account |
| Local dev | `.env.local` `DATABASE_URL` | Single-user, local machine |
| Read-only diagnostic | None today — would require provisioning a read-only Postgres role | Documented gap; trigger at first paying customer |

The Postgres append-only RULE on `audit_log` blocks UPDATE + DELETE
regardless of role. Even a DB admin with `psql` access cannot tamper
without first dropping the rule (which itself is loggable in
Postgres's DDL log).

## What an auditor asks for, and where the answer lives

| Auditor question | Where the answer lives |
|---|---|
| "Show me your auth provider" | This file → "Authentication"; `src/lib/auth/clerk.ts` |
| "Show me MFA enforcement" | This file → "Authentication"; documented Partial in risk-register #20 |
| "Show me your roles and what each can do" | This file → "Authorization"; `src/lib/auth/policy.ts` |
| "Show me the permission gate for a specific Server Action" | The Server Action file calls `requirePermission(...)` against a named helper from `policy.ts` |
| "Show me an offboarding that you performed" | `audit_log` rows with `eventType=LIFECYCLE` `action=user.offboarded` |
| "Show me your service token rotation history" | This file → "Service tokens" table; `audit_log` rows with `action=token.rotated` |
| "Show me an access review" | `docs/policies/access-review-{YYYY-Q}.md` (one per quarter); `audit_log` row of completion |
| "Who has production database access?" | This file → "Database access" |

## Annual review

Reviewed annually. Trigger an out-of-cycle review when:

- A new role joins the hierarchy (changes the permission catalog)
- A new tenant-aware feature ships (adds a permission row)
- A second developer joins (changes the database-access surface)
- A new service token is added
- An incident postmortem identifies a permission gap

The review itself goes in the audit log as
`CONFIG_CHANGE/access_control.review` by the founder.
