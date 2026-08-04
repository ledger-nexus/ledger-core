# Portfolio data locations

**Last reviewed:** 2026-06-03

This document is the **first thing a SOC 2 auditor reads** when
they're trying to understand the ledger-nexus system. It answers two
questions:

1. **Where does each kind of data live, physically?** (which repo's
   Postgres database holds it)
2. **What is its classification and protection posture?**
   (encryption-at-rest, retention, access-control, audit)

The data-classification policy
(`docs/policies/data-classification.md`) classifies fields *within*
ledger-core. This document looks at the **whole 5-repo portfolio**
and maps each datum to its canonical home + replicas.

If a contradiction surfaces between this document and a per-repo
policy doc, this document is authoritative on **location**; the
per-repo doc is authoritative on **handling**.

---

## The 5 repos at a glance

| Repo | Role | Has user PII? | Has tenant data? | Has secrets? |
|---|---|---|---|---|
| `ledger-core` | Canonical user identity + ledger substrate + audit log | **Canonical** | Yes (ledger, books, audit_log) | Yes (env vars, encrypted at rest) |
| `recon` | Bank reconciliation + AI matching | Replica (read-mostly) | Yes (statements, matches) | No |
| `fa-amort` | Fixed-asset register + depreciation | Replica (read-mostly) | Yes (assets, dep schedules) | No |
| `revenue-rec` | ASC 606 contract revenue recognition | Replica (read-mostly) | Yes (contracts, schedules) | No |
| `integrations` | Connector engine (Plaid, Stripe, …) | Replica (read-mostly) | Yes (connections, sync history) | **Yes (OAuth tokens)** |

---

## Canonical data — where it lives, who owns the write path

**Rule:** "Canonical" means writes happen here first; replicas
follow asynchronously. An auditor asking "where is the source of
truth for X" must get an unambiguous answer.

### User identity + tenant membership

**Canonical:** `ledger-core` — `User`, `Tenant`, `TenantMembership`,
`TenantInvite`, `Notification`, `EmailDelivery`.

**Replicas:** `recon`, `fa-amort`, `revenue-rec`, `integrations` —
each holds `User`, `Tenant`, `TenantMembership` for FK-convenience.
Read-mostly. The canonical write in `ledger-core` propagates to the
replica via the sync paths in each repo.

**Why replicated:** every repo's customer-data tables carry a
`tenantId` and many carry an `actorUserId`. Foreign-key integrity
requires a local copy of the referenced row. The alternative
(every query joins across the network to ledger-core) is operationally
prohibitive.

**Implication for DSR:** an erasure on ledger-core MUST propagate to
all 4 replicas. Today this happens via the standing sync; on a real
DSR the privacy lead verifies the propagation completed before
responding to the subject. See `docs/policies/data-subject-requests.md`.

### Ledger substrate (universal accounting schema)

**Canonical:** `ledger-core` — `LegalEntity`, `Book`, `Account`,
`JournalEntry`, `JournalLine`, `Period`, `PeriodClose`, `Currency`,
`FxRate`, `FiscalCalendar`, `Dimension`, `DimensionValue`,
`DimensionSet`, `Party`, `PartyRole`, `Item`.

**Replicas of `LegalEntity` + `Party`:** `recon`, `fa-amort`,
`revenue-rec` (FK-convenience; same model as User).

**Posting boundary:** Every ledger write goes through `ledger-core`'s
`postJournalEntry`. Companion repos write JEs by POSTing to
`/api/internal/journal-entries` (token-gated). This is the **single
write boundary** — there are no other paths. Companion repos that
need ledger writes for their domain (recon: bank reconciliations
→ JEs; fa-amort: depreciation → JEs; revenue-rec: rec events → JEs)
go through this endpoint.

### Audit log

**Canonical and exclusive:** `ledger-core` — `AuditLog`.

**No replicas.** Companion repos POST to `ledger-core`'s
`/api/internal/audit-log` endpoint (token-gated). This is the SOC 2
CC5/CC7 evidence trail; having one append-only table simplifies the
regulator's "show me what happened" query.

**Append-only enforcement:** Postgres RULE
(`prisma/sql/audit-log-append-only.sql`) silently no-ops UPDATEs and
DELETEs. Even an OWNER cannot tamper with the audit log; even an
attacker with SQL access cannot tamper with it. Read more in
`docs/SOC2_CONTROL_MATRIX.md` CC5.1 + CC7.3.

---

## Per-repo personal-data inventory

The full per-column classification lives in each repo's
`docs/policies/data-classification.md` (ledger-core) or
`docs/policies/data-subject-requests.md` (companion repos). The
table below is the **portfolio-level summary** for the auditor.

### Personal data of USERS (subjects)

| Field | Repos holding | Canonical | Encrypted at rest? |
|---|---|---|---|
| `User.email` | ledger-core + 4 replicas | ledger-core | ✅ all 5 |
| `User.displayName` | ledger-core + 4 replicas | ledger-core | ✅ all 5 |
| `TenantMembership.role` | ledger-core + 4 replicas | ledger-core | ❌ not encrypted (role is enum, not PII) |
| `JournalEntryNote.body` + `.authorEmail` | ledger-core | ledger-core | ✅ (body: AES, email: HMAC search hash) |

### Personal data of COUNTERPARTIES (parties, vendors, customers)

Counterparties are NOT users of our system; they are TENANT data.
The tenant is the data controller for counterparty PII; we are the
processor.

| Field | Repos holding | Canonical | Encrypted at rest? |
|---|---|---|---|
| `Party.displayName` | ledger-core + recon + fa-amort + revenue-rec | ledger-core | ✅ all 4 |
| `LegalEntity.name` | ledger-core + 4 companion repos | ledger-core | ✅ all 5 |

### Tenant business data (incidental PII)

These are the TENANT's books. They may contain incidental PII
(vendor names in memos, addresses in contracts) but are not personal
data of any user. **Preserved on subject erasure** under Art. 17(3)(b/e).

| Field | Repo (canonical) | Encrypted at rest? |
|---|---|---|
| `JournalEntry.sourcePayload` (Json) | ledger-core | ✅ |
| `EmailDelivery.{subject, bodyText, bodyHtml}` | ledger-core | ✅ |
| `Notification.{title, body}` | ledger-core | ✅ |
| `Tenant.name` | ledger-core (replicated) | ✅ all 5 |
| `BankAccount.{displayName, bankName, accountNumberLast4}` | recon | ✅ |
| `BankStatement.{filename, rawPayload}` | recon | ✅ |
| `BankStatementLine.description` | recon | ✅ |
| `AiSuggestion.candidatesJson` (recon) | recon | ✅ (Json mode) |
| `FixedAsset.description` | fa-amort | ✅ |
| `AiAssetSuggestion.{inputText, outputJson}` | fa-amort | ✅ (input: AES, output: Json mode) |
| `RevenueContract.description` | revenue-rec | ✅ |
| `PerformanceObligation.description` | revenue-rec | ✅ |
| `ContractDocument.{filename, rawText}` | revenue-rec | ✅ — **highest-sensitivity column in the portfolio** |
| `AiExtractionSuggestion.{inputText, outputJson}` | revenue-rec | ✅ |
| `JournalLine.description` | ledger-core + recon + revenue-rec | ❌ (intentionally — heavily queried for reporting; defense is per-tenant scoping) |

### Secrets

| Field | Repo | Treatment |
|---|---|---|
| `Connection.credentialsJson` (Plaid + future) | integrations | RESTRICTED. ✅ encrypted at rest (Json mode). Never logged. Erasure-driven revocation calls Plaid `/item/remove` at source before nulling locally. |
| Webhook signing secrets (env) | per-repo | Vercel encrypted env. `src/lib/env.ts` refuses to boot if missing. |
| Internal API tokens (env) | per-repo | Same. `constantTimeEqual` for verification. |
| Field-encryption key (`FIELD_ENCRYPTION_KEY`) | per-repo | Vercel encrypted env. One key per repo, currently same value across repos for the portfolio rollout (deliberate — rotation requires coordinated re-encrypt). |
| Deterministic search-hash key (`FIELD_DETERMINISTIC_KEY`) | ledger-core | Vercel encrypted env. Two-key separation from `FIELD_ENCRYPTION_KEY` (defense in depth — search hash leak ≠ ciphertext leak). |

---

## Data flow — write paths an auditor should know

The arrow convention: A → B means A writes to B (or A POSTs to B's
HTTP boundary).

```
USER
  ↓ (UI, Server Action)
ledger-core
  ↓ (postJournalEntry — every ledger write)
ledger-core.JournalEntry + JournalLine

ledger-core
  ↓ (logAuditEvent — every privileged mutation)
ledger-core.AuditLog (append-only, RULE-enforced)

USER
  ↓ (UI, recon Server Action)
recon
  ↓ (BankStatement / ReconciliationMatch in recon DB; never JEs directly)
  ↓ (HTTP POST when posting a derived JE)
ledger-core /api/internal/journal-entries
  ↓
ledger-core.JournalEntry + JournalLine

USER
  ↓ (UI, fa-amort Server Action)
fa-amort
  ↓ (FixedAsset / FixedAssetBookAttributes in fa-amort DB)
  ↓ (HTTP POST when posting depreciation JE)
ledger-core /api/internal/journal-entries

USER
  ↓ (UI, revenue-rec Server Action)
revenue-rec
  ↓ (RevenueContract / PerformanceObligation / ContractDocument in revenue-rec DB)
  ↓ (HTTP POST when posting a rec-event JE)
ledger-core /api/internal/journal-entries

Plaid webhook + cron
  ↓
integrations
  ↓ (SyncRun, ImportStagingRecord in integrations DB)
  ↓ (HTTP POST when promoting a mapped record)
recon /api/internal/bank-lines
  ↓
recon.BankStatement + BankStatementLine

EVERY companion repo
  ↓ (every privileged mutation)
  ↓ (HTTP POST)
ledger-core /api/internal/audit-log
  ↓
ledger-core.AuditLog
```

**Two invariants from this diagram:**

1. **All ledger writes flow through `ledger-core.postJournalEntry`.**
   Companion repos NEVER write to ledger-core's tables directly; the
   HTTP boundary is the contract. Token-gated, schema-validated.
2. **All audit rows land in `ledger-core.AuditLog`.** No companion
   repo maintains its own audit log. This is the regulator's
   single-query evidence surface.

---

## Cross-cutting protection posture

### Encryption at rest

**Helper:** `src/lib/soc2/field-encryption.ts` (in every repo; mirrored
from ledger-core).
**Extension:** `src/lib/db/encrypted-fields-extension.ts` — Prisma
client extension that transparently encrypts on write + decrypts on
read for registered columns.
**Algorithm:** AES-256-GCM with random IV per row + auth tag + version
byte prefix. Five-check `looksEncrypted` defense against plaintext
false-positives.
**Json mode:** for Json columns, `JSON.stringify` before AES-GCM and
`JSON.parse` after decrypt; column stays Prisma-typed.
**Search hashes:** HMAC-SHA256 with domain separation
(`domain || NUL || normalize(plaintext)`) for equality-lookup-required
columns (User.email, TenantInvite.email). Two-key separation from the
AES key (FIELD_DETERMINISTIC_KEY vs FIELD_ENCRYPTION_KEY).

### Retention

**Engine:** `ledger-core/src/lib/retention/policies.ts` declarative
table; `ledger-core/src/app/api/cron/retention/route.ts` walks it once
daily (Vercel Cron `0 3 * * *`). Every run audit-logs a
`CONFIG_CHANGE/retention.purge` row.

**Companion repos:** today the engine only runs in ledger-core. Each
companion repo's transient data (recon's AiSuggestion, fa-amort's
AiAssetSuggestion, revenue-rec's AiExtractionSuggestion) inherits the
data-classification doc's 7-year AI-audit-trail retention; no purge
runs against them. Future work: mirror the engine to each companion.

### Audit log

**Single table** in ledger-core. Companion repos POST audit events
to `/api/internal/audit-log`. Append-only Postgres RULE; no UPDATE
or DELETE survives. Per-event payload (`metadata`) is Json mode —
encrypted at rest.

### Authentication + authorization

Auth is Clerk (managed via ledger-core). Companion repos don't run
their own auth — they accept a forwarded user identity from ledger-core
via a signed session token or verify the request came from
ledger-core's internal API path.

**Per-tenant isolation:** every customer-data query is pinned to the
session-derived `tenantId` (resolved by `getCurrentScope()`, never
client input). A generic `assertTenantScope()` helper exists in
`@/lib/soc2/index.ts` as an available post-fetch defense-in-depth check,
but is not currently wired in (0 call sites) — the operative control is
the per-query `WHERE tenantId`. The `pen-test-tenant-isolation` suite
guards it.

**Per-role access:** privileged Server Actions gate on per-tenant role
checks (`isTenantAdmin` = OWNER/ADMIN, or global `requireAdmin`) after
`requireCurrentUser()` + scope resolution. A centralized
`requirePermission()` / `src/lib/auth/policy.ts` permission matrix is
**planned, not built** (access-control v2.1, deficiency #29).

---

## What an auditor asks for, and where the answer lives

| Auditor question | Where the answer lives |
|---|---|
| "Where is each kind of data stored?" | This document, "Per-repo personal-data inventory" |
| "Show me the write boundary between repos" | This document, "Data flow" — every cross-repo write is an HTTP POST through a token-gated endpoint |
| "Where is the audit log, and how is its integrity protected?" | This document, "Audit log" — `ledger-core.AuditLog`, append-only Postgres RULE, encrypted metadata |
| "Show me your data classification" | `ledger-core/docs/policies/data-classification.md` (per column) + per-repo `data-subject-requests.md` |
| "Show me the field-encryption rollout evidence" | `ledger-core/docs/runbooks/encryption-rollout.md` + the encrypted-columns table in this doc |
| "Where do you store secrets?" | This document, "Secrets" table |
| "Are OAuth tokens encrypted at rest?" | This document, "Secrets" table — yes, `Connection.credentialsJson` Json-mode encrypted |
| "How long do you keep X?" | `ledger-core/docs/policies/data-classification.md` retention table + `ledger-core/src/lib/retention/policies.ts` for the executable form |
| "What happens to data when a user requests erasure?" | `ledger-core/docs/policies/data-subject-requests.md` (canonical) + each companion repo's `docs/policies/data-subject-requests.md` |

---

## Annual review

Re-read this document when **any** of the following changes:

1. A new companion repo joins the portfolio (the matrix grows a row).
2. A new connector ships in `integrations` (the Secrets table grows
   a row).
3. The HTTP boundary shape between repos changes.
4. A new encrypted column is added — update the encrypted-at-rest
   tables above before the migration ships, not after.
5. The retention engine starts running in a companion repo.

The review goes in the audit log as a `CONFIG_CHANGE/architecture.review`
row.
