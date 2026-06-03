# Data classification + retention policy

**Version:** 1.1
**Effective date:** 2026-05-31
**Owner:** Hosung Son (founder)
**Last reviewed:** 2026-05-29

The PII-field list in `src/lib/soc2/index.ts` (the `PII_FIELD_NAMES`
constant) is the runtime enforcement of this classification — every
log line that includes a sensitive field name gets redacted before
emit. When you add a new CONFIDENTIAL field below, also add its
column name to that constant.

## Classification levels

| Level | Description | Examples in ledger-nexus |
|---|---|---|
| **PUBLIC** | OK to share externally | Documentation, marketing copy, open-source code |
| **INTERNAL** | OK within the company; not for public release | Code, architecture diagrams, financial test data |
| **CONFIDENTIAL** | Customer financial data; access limited to authorized users | Journal entries, AR/AP records, fixed asset detail, bank statement lines |
| **RESTRICTED** | Production secrets; access limited to operators | API tokens, DB connection strings, signing keys |

## Field inventory

Per-model classification of every field that could contain regulated data:

### `User` (CONFIDENTIAL)

| Field | Classification | Notes |
|---|---|---|
| `id` | INTERNAL | Internal UUID; not customer-facing |
| `email` | CONFIDENTIAL | PII; required for login + audit attribution. NOT encrypted at rest yet — login flow requires equality lookups; deterministic encryption or HMAC index column is a future workstream. |
| `displayName` | CONFIDENTIAL | PII; not used for auth. **Encrypted at rest** (2026-05-31) via the Prisma extension. |
| `isActive` | INTERNAL | Provisioning state |

### `JournalEntry` (CONFIDENTIAL)

| Field | Classification | Notes |
|---|---|---|
| `memo` | CONFIDENTIAL | Free-form; may contain customer/vendor names. **Encrypted at rest** (2026-05-29) via the Prisma extension. |
| `documentDate`, `postingDate` | CONFIDENTIAL | Could reveal customer activity timing |
| `sourcePayload` | CONFIDENTIAL | Frozen ERP payload (Json column). Often the highest single-row PII density in the substrate — embeds customer/vendor names, full addresses, dollar amounts per line, source-ERP user emails, custom-field values, tax IDs. **Encrypted at rest** (2026-05-31) via the Prisma extension in `type: "json"` mode (JSON.stringify before AES-GCM; JSON.parse after decrypt; roundtrip is bit-exact). |
| `sourceRecordId` | INTERNAL | Identifier, not data |

### `Party` (CONFIDENTIAL)

| Field | Classification | Notes |
|---|---|---|
| `displayName` | CONFIDENTIAL | Customer/vendor names. **Encrypted at rest** (2026-05-30) via the Prisma extension in ledger-core (write side) and recon (read side; recon reads via the matching candidate pipeline). |
| `code` | INTERNAL | Stable identifier; the searchable lookup key, intentionally NOT encrypted. |

### `JournalEntryNote` (CONFIDENTIAL)

| Field | Classification | Notes |
|---|---|---|
| `body` | CONFIDENTIAL | CPA-authored plain-text annotation on a journal entry. Regularly includes customer / vendor names + internal context. **Encrypted at rest** (2026-05-30) via the Prisma extension. |
| `authorEmail` | CONFIDENTIAL | PII; preserved at write time so authorship survives if the User row goes away. |
| `resolvedAt`, `createdAt` | INTERNAL | Lifecycle timestamps. |

### `BankAccount`, `BankStatement`, `BankStatementLine` (CONFIDENTIAL, possibly RESTRICTED)

Bank-related data is the highest-sensitivity in the system. Recon's bank statement lines include transaction amounts, dates, and descriptions that can reveal customer identity, business patterns, and account activity.

### `AuditLog`, `AiAssetSuggestion`, `AiSuggestion`, `AiExtractionSuggestion`

| Field | Classification | Notes |
|---|---|---|
| `inputText` | CONFIDENTIAL | May contain pasted customer data or invoice content. **Encrypted at rest** (fa-amort, 2026-05-31). |
| `outputJson` | CONFIDENTIAL | AI-generated structured data referencing customer specifics. **Encrypted at rest** (Json mode — fa-amort, recon, revenue-rec, 2026-05-31). |
| `metadata` (in AuditLog) | CONFIDENTIAL | Per-event payload (action, reason, resource ids, actor context). **Encrypted at rest** (Json mode, 2026-05-31). Note: production legacy rows stay plaintext for the 7-year retention window because the append-only RULE blocks UPDATE — new writes from rollout date forward encrypt automatically; dev/staging backfill works via `withAuditLogMutable`. |

### Production secrets (RESTRICTED)

- `DATABASE_URL`, `INTERNAL_API_TOKEN`, `RECON_INTERNAL_API_TOKEN`
- `AUTH_STUB_SECRET`, `ADMIN_TOKEN`
- `ANTHROPIC_API_KEY`, `PLAID_CLIENT_ID`, `PLAID_SECRET`
- `VERCEL_TOKEN`

Stored exclusively in:
- Vercel's environment variable UI (production)
- Local `.env` files (development; gitignored)
- 1Password / equivalent secret manager (long-term storage)

## Storage

| Classification | Storage | Encryption |
|---|---|---|
| PUBLIC | GitHub repos | None |
| INTERNAL | GitHub repos, Vercel deployments | TLS in transit; Postgres at rest |
| CONFIDENTIAL | Neon Postgres | TLS in transit; Neon's default at-rest encryption |
| RESTRICTED | Vercel env / 1Password | TLS in transit; vendor-encrypted at rest |

**Gaps to close:**
- [x] **Field-level encryption helper shipped** 2026-05-29 —
  `src/lib/soc2/field-encryption.ts` provides `encryptField` /
  `decryptField` via AES-256-GCM (`node:crypto`), keyed off
  `FIELD_ENCRYPTION_KEY` env var (32 bytes hex). Wire format includes
  a version byte for future key rotation. 15 unit tests cover round-
  trip, tampered-ciphertext rejection (GCM auth tag), wrong-key
  rejection, multibyte unicode, and KeyNotConfiguredError. **What's
  next:** column-by-column rollout — update Prisma write/read paths
  for `JournalEntry.memo` first (highest-value target), then
  `EmailDelivery.bodyText`, then bank-statement-line descriptions.
- [x] **Encryption key management** — `FIELD_ENCRYPTION_KEY` lives
  in Vercel's encrypted env (RESTRICTED tier per the inventory
  above). Rotation procedure in `docs/policies/access-control.md`.
  Future: AWS KMS / Vercel Secrets — drop-in via the `loadKey()`
  helper.

## Retention

| Classification | Default retention | Deletion mechanism |
|---|---|---|
| `AuditLog` | 7 years (SOC 2 + IRS recordkeeping) | Manual review before deletion |
| `JournalEntry` + `JournalLine` | Indefinite (financial records) | Soft-delete only; no hard delete |
| `Period` + `PeriodClose` | Indefinite | No deletion |
| `User` | Soft-delete via `deactivatedAt`; hard delete after 1 year of inactivity | Manual |
| `AiAssetSuggestion` + `AiSuggestion` + `AiExtractionSuggestion` | 7 years | Manual review |
| `RecordEvent` | 7 years | Manual review |
| Vercel function logs | 7 days (free) / 30 days (Pro) | Auto-rotate by Vercel |

**Gaps to close:**
- [x] **Automated retention enforcement** (2026-06-02). Declarative
  policy table in `src/lib/retention/policies.ts` walked once per day
  by `src/app/api/cron/retention/route.ts` (Vercel Cron, `0 3 * * *`,
  gated by `CRON_SECRET` via `constantTimeEqual`). Every run writes a
  `CONFIG_CHANGE` row to `audit_log` with per-policy counts + errors
  — the SOC 2 auditor's "show me the eviction job" evidence is that
  audit row. Current policies: `notification.seen` (365d),
  `notification.unseen_stale` (730d), `tenant_invite.terminal` (30d
  past accepted/revoked/expired), `email_delivery.transient` (90d).
  Add new policies to the registry, not new endpoints. Test:
  `tests/retention.test.ts`.
- [ ] **Soft-delete enforcement.** `User.deactivatedAt` exists but other models lack it. Add `deletedAt` to `JournalEntry`, etc., for non-financial-record models that should be subject to deletion.
- [x] **GDPR / CCPA data subject requests** (2026-06-02). Procedure
  documented at `docs/policies/data-subject-requests.md` covering
  Art. 15 (access) + Art. 17 (erasure) + Art. 16 (rectification) + the
  CPRA equivalents. Per-channel identity verification, 30-day SLA
  with documented extension path, OWNER-only erasure gate, edge
  cases (OWNER trying to erase themselves, conflicting tenant/subject
  requests). Executable artifacts: `src/lib/privacy/user-data.ts`
  (`buildUserDataExport` + `eraseUserPii`), Server Actions in
  `src/app/actions/data-subject-request.ts`, UI at
  `/admin/data-subject-requests`. Every request emits a `DATA_EXPORT`
  or `DATA_ERASURE` row to the append-only `audit_log` (the
  regulator's evidence trail).

### `Tenant` (CONFIDENTIAL for billing fields, INTERNAL otherwise)

| Field | Classification | Notes |
|---|---|---|
| `name` | CONFIDENTIAL | Customer organization name. **Encrypted at rest** (2026-05-31) via the Prisma extension. |
| `slug` | INTERNAL | URL-safe stable identifier; the lookup key, intentionally NOT encrypted. |
| `stripeCustomerId`, `stripeSubscriptionId` | CONFIDENTIAL | Billing identifiers (PCI-adjacent; Stripe owns the card data itself) |
| `monthlyAiSpendCapUsd`, `jeApprovalMinAmount` | INTERNAL | Configuration values |
| `pendingOwnerTransferToUserId` | INTERNAL | Workflow state |
| `ownerUserId`, `requireJeApproval` | INTERNAL | Configuration |

### `TenantInvite` (CONFIDENTIAL)

| Field | Classification | Notes |
|---|---|---|
| `email` | CONFIDENTIAL | PII; the invited person's email |
| `token` | RESTRICTED | Single-use secret; constant-time-compared on accept |
| `expiresAt`, `acceptedAt`, `revokedAt` | INTERNAL | Lifecycle timestamps |

### `LegalEntity` (CONFIDENTIAL)

| Field | Classification | Notes |
|---|---|---|
| `name` | CONFIDENTIAL | Customer's legal company name (e.g. "Acme Corp, Inc."). **Encrypted at rest** (2026-05-31) via the Prisma extension. |
| `code` | INTERNAL | Stable lookup key; the searchable identifier used in WHERE clauses, intentionally NOT encrypted. |
| `parentEntityId` | INTERNAL | Hierarchy edge for consolidation. |
| `functionalCurrencyId` | INTERNAL | FX setting. |

### `Notification` (CONFIDENTIAL)

| Field | Classification | Notes |
|---|---|---|
| `title` | CONFIDENTIAL | Rendered notification headline. Often includes customer / vendor names + dollar amounts. **Encrypted at rest** (2026-05-31) via the Prisma extension. |
| `body` | CONFIDENTIAL | Optional longer text — same PII surface as title. **Encrypted at rest** (2026-05-31) via the Prisma extension. |
| `category` | INTERNAL | Enum used for filter / grouping; intentionally NOT encrypted. |
| `link` | INTERNAL | Internal route the bell click opens. |
| `readAt`, `dismissedAt` | INTERNAL | Lifecycle. |

### `EmailDelivery` (CONFIDENTIAL)

| Field | Classification | Notes |
|---|---|---|
| `toEmail` | CONFIDENTIAL | PII |
| `subject`, `bodyText`, `bodyHtml` | CONFIDENTIAL | Email content — may include JE memos / tenant info. **Encrypted at rest** (2026-05-29) via the Prisma extension. |
| `providerId` (Resend message id) | INTERNAL | Tracking |
| `metadata` | INTERNAL | Includes `tenantId`, `entryId`; no raw PII (we don't pass it through) |

### Plaid `Connection.credentialsJson` (RESTRICTED)

The `accessToken` field nested inside is a Plaid access token — it grants ongoing access to the customer's bank data. Treated as RESTRICTED. Never logged; only read inside `src/lib/connectors/plaid/client.ts`.

## Annual review

Reviewed annually. **Next review: 2027-05-29.** Walk through every model in `prisma/schema.prisma`; for any new column added since the last review, classify it here and update the `PII_FIELD_NAMES` constant in `src/lib/soc2/index.ts` if it should be redacted in logs.
