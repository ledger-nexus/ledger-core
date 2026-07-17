# AGENTS.md — ledger-core

Instructions for AI coding/review agents (Codex, etc.). This is the **reviewer's contract**: what to check, and — just as important — what is *intentional and must NOT be reported as a defect*. The full engineering contract is [`CLAUDE.md`](CLAUDE.md) and the architecture canon [`docs/universal-schema.md`](docs/universal-schema.md); read both before a substantive review. Current state + version history: [`PROJECT_STATUS.md`](PROJECT_STATUS.md).

## What this is

`ledger-core` is a multi-book, double-entry general-ledger substrate, owned and specified by a CPA. The architecture in `docs/universal-schema.md` is **LOCKED** — multi-book and Pattern-2 (full parallel posting) are decisions, not oversights. Do not propose replacing them; review *within* that contract.

## Review THESE first — where real defects actually live

- **Every new Server Action / API route** must: authenticate **and** authorize (verify resource *ownership*, not merely "is logged in"); derive `tenantId` from the session (`getCurrentScope()` / `requireCurrentTenant()`), **never** from client input; validate every input with Zod and reject bad input with 400; write an `audit_log` row on every mutation. Missing tenant scoping / IDOR is the highest-value bug class in this repo.
- **Every ledger write goes through `postJournalEntry`.** Any code that inserts into `gl_entry_header` / `gl_entry_line` directly, or bypasses its debits==credits / period-close / account-validity checks, is a defect.
- **Money math:** `Decimal` (decimal.js) only, never `Number`; compare with `.equals()` / `.comparedTo()`, never `===`/`==`; convert Prisma decimals via `new Decimal(v.toString())`. A `Number(...)` or `===` on a money value is a real bug.
- **Schema changes:** migration reversible where practical; non-Prisma DDL (triggers, rules) also mirrored idempotently into `prisma/sql/migration-mirror.sql`; and the **schema fingerprint** (`prisma/schema.prisma.sha256`) regenerated (`./scripts/check-schema-fingerprint.sh --update`) — a stale fingerprint is a red CI gate worth catching pre-merge. Two schema PRs in flight will also collide on that hash file; expect it.
- **AI never posts unattended.** AI output flows through `postJournalEntry` with `source: "AI_APPROVED"` only after explicit human approval (reference: the FX-revaluation gate). An AI path that posts without a human in the loop is a defect.
- **Provenance is server-stamped.** `JournalEntry.source` must be set server-side, never read from client `formData` (regression #247). Flag any client-controlled `source`.
- **Tests** run against a real, shared, persistent Postgres. They must be collision-safe: per-run tenants / natural-key prefixes, self-healing `beforeAll` scrubs. **Do not hard-delete `app_user` rows** in fixtures — the `audit_log` append-only rule (migration 0015) turns the FK's referential action into a no-op, so the delete throws `XX000` on any rerun against a dirty DB; `upsert`/reuse the fixture user instead.

## Intentional — do NOT report these as defects

- **RLS is Phase-1 only.** Tenant-isolation policies exist but are inert / un-FORCED; enforcement today is application-level `WHERE tenantId` clauses (tracked as deficiency #12). "This table has no RLS policy protecting it" is known and by design for now — not a finding.
- **`postJournalEntry` falls back to an unscoped `legalEntity.findFirst` when `tenantId` is omitted** — a documented single-tenant legacy fallback. Flag a *new* caller that omits the pin; the fallback mechanism itself is intentional.
- **Reports include shared accounts (`entityId = null`)** alongside entity-specific ones — shared charts are per-tenant, by design.
- **Expenses and costs reported as positive numbers** on debit-normal lines is correct accounting sign convention, not a sign bug.
- **`@@unique([entityId, code])` with nullable `entityId`** — Postgres treats `NULL != NULL`, so shared-account rows coexist across tenants; queries pin `tenantId` to disambiguate. Known.
- **Not every migration ships a `down()`**, and merges are squash-via-API. Fresh databases are built with `prisma db push`; reversibility is by revert. Don't flag the missing `down()` as a blocker.

## Security lens (SOC 2 Type 2 readiness)

Grade against [`SECURITY.md`](SECURITY.md) and `docs/policies/`: multi-tenant isolation (CC6.1), append-only audit logging (CC7.2), secrets from env only — never logged, never in `NEXT_PUBLIC_*` (CC6.7), authorization ≠ authentication (CC6.3), Zod validation (CC6.8), timing-safe comparison for tokens/signatures, and no PII or financial values in logs (redact). A self-found, tests-pinned HIGH closed before merge is the portfolio's strongest CC4 evidence — surface real ones plainly.
