# Data classification + retention policy

**Version:** 1.0 · **Effective date:** {{DATE}} · **Owner:** {{NAME}}

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
| `email` | CONFIDENTIAL | PII; required for login + audit attribution |
| `displayName` | CONFIDENTIAL | PII; not used for auth |
| `isActive` | INTERNAL | Provisioning state |

### `JournalEntry` (CONFIDENTIAL)

| Field | Classification | Notes |
|---|---|---|
| `memo` | CONFIDENTIAL | Free-form; may contain customer/vendor names |
| `documentDate`, `postingDate` | CONFIDENTIAL | Could reveal customer activity timing |
| `sourcePayload` | CONFIDENTIAL | Frozen ERP payload; may contain PII from source system |
| `sourceRecordId` | INTERNAL | Identifier, not data |

### `Party` (CONFIDENTIAL)

| Field | Classification | Notes |
|---|---|---|
| `displayName` | CONFIDENTIAL | Customer/vendor names |
| `code` | INTERNAL | Stable identifier |

### `BankAccount`, `BankStatement`, `BankStatementLine` (CONFIDENTIAL, possibly RESTRICTED)

Bank-related data is the highest-sensitivity in the system. Recon's bank statement lines include transaction amounts, dates, and descriptions that can reveal customer identity, business patterns, and account activity.

### `AuditLog`, `AiAssetSuggestion`, `AiSuggestion`, `AiExtractionSuggestion`

| Field | Classification | Notes |
|---|---|---|
| `inputText` | CONFIDENTIAL | May contain pasted customer data or invoice content |
| `outputJson` | CONFIDENTIAL | AI-generated structured data referencing customer specifics |
| `metadata` (in AuditLog) | INTERNAL | Action metadata |

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
- [ ] **Field-level encryption** for the most sensitive columns (`JournalEntry.memo`, `BankStatementLine.description`). Today they're plaintext in Postgres. Auditor will flag.
- [ ] **Encryption key management** — when field-level encryption lands, where do keys live? AWS KMS? Vercel's encrypted env? Document.

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
- [ ] **Automated retention enforcement.** Today retention is policy-only; no cron job purges old data. A SOC 2 auditor will ask "show me the eviction job" and we'll have to admit we don't have one.
- [ ] **Soft-delete enforcement.** `User.deactivatedAt` exists but other models lack it. Add `deletedAt` to `JournalEntry`, etc., for non-financial-record models that should be subject to deletion.
- [ ] **GDPR / CCPA data subject requests.** When a customer asks "what do you have on me?", we need a procedure to answer (data export) and to delete (right-to-be-forgotten). Today no procedure exists.

## Annual review

Reviewed annually on {{REVIEW_DATE}}. Walk through every model in `prisma/schema.prisma` and verify classifications match.
