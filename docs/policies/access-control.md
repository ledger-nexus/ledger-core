# Access control policy

**Version:** 1.0 · **Effective date:** {{DATE}} · **Owner:** {{NAME}}

## Authentication

| Item | Standard | Current state |
|---|---|---|
| Authentication provider | Production: Clerk or NextAuth via OIDC | **Stub (HMAC cookie)** — replace before any customer data |
| Password storage | N/A (provider-managed) | N/A |
| MFA | Required for all users | **Not enforced** |
| Session timeout | 8h idle / 24h absolute | **Not enforced** (cookie expires after 1 year) |
| Session revocation | Logout + remote session kill | **Logout only** |

**Action items:**
- [ ] Complete the Clerk swap documented in `docs/auth-swap.md`
- [ ] Configure Clerk to require MFA for the admin role
- [ ] Set session lifetime to 8h idle in Clerk dashboard

## Authorization

Role-based access control:

| Role | Capabilities | Granted via |
|---|---|---|
| `User` | View reports, post own JEs in still-open periods | Login |
| `Admin` | All of `User` + close/reopen periods, deactivate users, run admin reset | Email allowlist (`ADMIN_EMAIL_ALLOWLIST` in `src/lib/auth/current-user.ts`) — **migrate to DB-driven role table when real auth lands** |
| `System` (no human) | JE posting via the internal API endpoints (token-gated) | `INTERNAL_API_TOKEN` env var |

**Action items:**
- [ ] Move admin assignment from hardcoded email allowlist to a `UserRole` table
- [ ] Add a "role assignment audit log" entry to `audit_log` when roles change
- [ ] Build the `/admin/roles` UI for granting/revoking

## Provisioning

Today: users are manually created via the seed (`prisma db seed`) or via a dev-mode UI dropdown. No customer-facing signup flow.

Once production-ready:
1. New users sign up via the auth provider (Clerk).
2. A webhook from Clerk creates the local `User` row.
3. Default role is `User`. Admin assignment requires explicit grant by an existing admin.
4. Every provisioning event writes to `audit_log` with `eventType=PRIVILEGED_ACTION`.

## Deprovisioning

- Users with `User.deactivatedAt != null` are blocked at login (see `setCurrentUserAction`).
- Deactivation triggers the orphan-records review (see `src/lib/ownership/orphan-detection.ts`).
- Records still owned by a deactivated user must be reassigned (manually via `/admin/orphans`).

**Action items:**
- [ ] Ensure ALL `prisma.user.find*` calls filter by `deactivatedAt = null` by default
- [ ] Document the offboarding runbook (see `incident-response.md` template)

## Access reviews

**Cadence:** Quarterly.

**Procedure:**
1. Export current users + roles via `/admin/users`.
2. For each user: verify they still need the listed role (especially admin).
3. For each admin: verify their email is in the allowlist intentionally.
4. Sign off in `docs/policies/access-review-{YYYY-Q}.md` (a new doc per quarter).

## Internal API tokens

The shared `INTERNAL_API_TOKEN` gates all `/api/internal/*` endpoints. It's a single value (no per-caller tokens yet).

**Rotation procedure:**
1. Generate new token: `openssl rand -hex 32`
2. Set in Vercel UI for ledger-core under a new env var `INTERNAL_API_TOKEN_NEW`
3. Update endpoint code to accept either old or new (2-week overlap window)
4. Update each consumer repo's `LEDGER_CORE_INTERNAL_TOKEN` to the new value
5. After 2 weeks: remove `INTERNAL_API_TOKEN_NEW` and update code to accept only the new one

**Cadence:** Every 90 days. Track rotations in this file.

| Rotation date | Reason | Performed by |
|---|---|---|
| {{DATE}} | Initial provisioning | {{NAME}} |
