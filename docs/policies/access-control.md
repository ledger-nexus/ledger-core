# Access control policy

**Version:** 2.1 · **Effective date:** 2026-07-17 · **Owner:** Founder (sole maintainer)
**Last reviewed:** 2026-07-17
**Prior versions:** 2.0 (2026-06-03, described a target RBAC ahead of the code); 1.0 (pre-Clerk)

> **2026-07-17 reconciliation (v2.1):** v2.0 documented a centralized
> permission layer (`src/lib/auth/policy.ts` + `requirePermission()` + 16
> `canX` helpers) and a four-role hierarchy including a read-only
> `VIEWER` — **none of which exist in code** (`TenantRole` is three
> roles; there is no `policy.ts`). It also cited `assertTenantScope()`
> as the tenant-isolation control; that helper *does* exist in
> `@/lib/soc2` but has **zero call sites**, so the operative control is
> the per-query `WHERE tenantId` (hardened in the 2026-07-17 getScope
> sweep), not a post-fetch assertion. The Authorization section below now
> describes what is actually implemented and flags the centralized layer
> + `VIEWER` as planned (control-deficiency-log #29). This closes a
> documentation drift that would otherwise be an audit finding.

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

**Per-tenant role-based access.** Every tenant carries its own membership
roles on `TenantMembership.role`. Authorization is enforced **per Server
Action / page** by explicit role checks — there is no single policy
module today (see "Enforcement model"). "User is signed in" is necessary
but NEVER sufficient.

### Role hierarchy (implemented)

```
OWNER > ADMIN > MEMBER
```

| Role | Typical use case | Source-of-truth |
|---|---|---|
| `OWNER` | Founder / CFO of the tenant. One per tenant (enforced). | `TenantMembership.role` (enum `TenantRole`, `prisma/schema.prisma`) |
| `ADMIN` | Controller / accounting manager. Manage memberships, close/reopen periods, admin surfaces. | `TenantMembership.role` |
| `MEMBER` | Bookkeeper / accountant. Post JEs, run reports, view all tenant data. | `TenantMembership.role` |

> **Planned — NOT implemented (do not represent as a live control):**
> a read-only **`VIEWER`** role (auditor / auditing CPA) and a
> **centralized permission layer** — `requirePermission()` + a named
> `canX` catalog in `src/lib/auth/policy.ts`. Neither exists: the
> `TenantRole` enum is the three roles above and there is no `policy.ts`.
> `src/lib/auth/tenant.ts` carries the standing note that the global
> `isAdmin` "retires and callers move to [`isTenantAdmin`]" once "per-tenant
> RBAC lands." Tracked as **control-deficiency-log #29**.

### Enforcement model (what actually gates each action)

Every privileged path runs, in order:

1. `requireCurrentUser()` — authenticated. Clerk in prod; an HMAC dev
   stub gated to `NODE_ENV !== "production"`. `src/lib/auth/current-user.ts`.
2. `requireCurrentScope()` / `requireCurrentTenant()` — resolves tenant +
   (entity, book) from the session, never from client input.
   `src/lib/scope.ts`, `src/lib/auth/tenant.ts`.
3. A role check where the action is privileged:
   - `isTenantAdmin(tenant)` → `OWNER | ADMIN`, per-tenant. `src/lib/auth/tenant.ts`.
   - `isAdmin(user)` / `requireAdmin()` — global admin (email allowlist
     today), retiring in favour of `isTenantAdmin` when the permission
     layer lands. `src/lib/auth/current-user.ts`.

Cross-tenant data access is closed by pinning **every** customer-data
query to the session-derived `tenantId` (resolved by `getCurrentScope()`).
A generic `assertTenantScope(row, tenantId)` helper exists in
`@/lib/soc2` as an available post-fetch defense-in-depth check, but it
currently has **zero call sites** — the operative control is the
per-query `WHERE tenantId`, not a post-fetch assertion. (Wiring
`assertTenantScope` in as belt-and-suspenders, or removing it as dead
code, is tracked with #29.) The `tests/pen-test-tenant-isolation.ts`
suite exercises attempted bypass (forged `lc-scope` cookie, cross-tenant
id). See `docs/SOC2_CONTROL_MATRIX.md` CC6.1.

### Intended permission map (design target for the planned policy layer)

The table is the **target** for the centralized layer and records which
role SHOULD gate each capability. Today each is enforced by the inline
check in the listed surface — NOT by a `canX(role)` helper. When the
policy layer lands (#29), these become named permissions.

| Capability | Min role (target) | Enforced today at |
|---|---|---|
| View reports | MEMBER (VIEWER once it lands) | `/reports/*` — tenant membership required |
| Post journal entries | MEMBER | `/journal-entries/new`, import paths — `requireCurrentUser` + scope |
| Manage memberships | ADMIN | admin surfaces — `isTenantAdmin` |
| Close / reopen period | ADMIN | `/periods` close/reopen actions — admin-gated |
| Export audit log | ADMIN | `/admin/audit-log` — admin-gated |
| Erase user data (DSR) | OWNER | DSR erasure Server Action — owner-gated |
| Approve journal entry | ADMIN | JE approval queue — admin-gated |
| Run retention purge | system (`CRON_SECRET`) | `/api/cron/*` — timing-safe token |
| Post internal event | system (`INTERNAL_API_TOKEN`) | `/api/internal/*` — timing-safe token |

> The v2.0 draft mapped capabilities to admin routes that don't exist
> (`/admin/team`, `/admin/reset`, `/admin/tenant`, `/admin/access-review`).
> The live admin surfaces are `/admin/users`, `/admin/audit-log`,
> `/admin/orphans`, and `/admin/notification-channels`.

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
| "Show me your roles and what each can do" | This file → "Authorization"; enum `TenantRole` in `prisma/schema.prisma`; `isTenantAdmin` in `src/lib/auth/tenant.ts` |
| "Show me the permission gate for a specific Server Action" | The Server Action calls `requireCurrentUser()` + `requireCurrentScope()`, then a role check (`isTenantAdmin` / `requireAdmin`) for privileged actions — see "Enforcement model". (A centralized `requirePermission()` is planned, #29.) |
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
