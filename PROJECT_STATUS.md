# Project Status

The single source of truth for "where the portfolio is and what's next."
Updated end-of-session so the next pickup (human or Claude Code) doesn't
need to re-derive context.

**Last updated:** 2026-05-27 (late)

---

## The portfolio at a glance

This file used to track only ledger-core. It now tracks the **ledger-nexus
portfolio** — five repos sharing one Postgres, each owning its slice of
the accounting stack:

| Repo            | Role                                                       | Latest | Port |
|-----------------|------------------------------------------------------------|--------|------|
| `ledger-core`   | Universal substrate. GL, sub-ledgers, ERP mappers, UI, tax | v1.21  | 3000 |
| `recon`         | AI-assisted bank reconciliation                            | v1.0   | 3001 |
| `revenue-rec`   | ASC 606 / IFRS 15 revenue recognition                      | v0.2   | 3002 |
| `integrations`  | Third-party data feeds (Plaid)                             | v0.1   | 3003 |
| `fa-amort`      | Fixed assets + depreciation + AI capex/UL/impairment       | v0.6   | 3004 |

All four companion repos talk to `ledger-core` through HTTP boundary
endpoints (`/api/internal/journal-entries`,
`/api/internal/fixed-asset/record-depreciation`, etc.) — never via direct
DB writes to substrate tables.

The portfolio-level architecture canon is `docs/universal-schema.md` in
ledger-core. Each companion repo has its own `docs/ARCHITECTURE.md`
describing its boundary to the substrate.

---

## Where each repo is

### `ledger-core` (v1.21 — substrate + UI + multi-tenancy)

The portfolio's foundation. Universal GL with multi-book Pattern 2 posting,
ERP mappers (QBO floor + NetSuite ceiling), three financial statements,
multi-entity consolidation with intercompany elimination, BTD + Schedule
M-3 detail for tax provision, ownership/queues/reassignment engine,
audit log, period close UI with month-end packet (CSV + PDF), and a
one-command deploy script.

Multi-tenancy landed in 8 phases (Phases 1–8 in the decision log).
Phase 4b made codes unique-per-tenant (not globally). Phase 8 wired
Clerk auth + a UserSwitcher dev stub. Four passes of pen-testing closed
cross-tenant read/write leaks, hash-chained the audit log, fixed CSV
formula injection in shared export code, patched a TOCTOU race in
payment application, and added constant-time token comparison.

**Headline new surfaces since v1.1:**
- v1.2 — internal HTTP endpoint companion repos use
- v1.3–v1.9 — ownership + queues + reassignment-rules engine (AR-first,
  then universal)
- v1.10 — notifications
- v1.11 — idempotent JE posts (partial unique index on lineage triple)
  + transactional depreciation endpoint
- v1.12–v1.16 — period close UI, month-end composite, PDF/CSV packet
- v1.17 — `pnpm demo` one-shot CPA-ready May-2026 flow
- v1.18–v1.21 — shareable month-end URLs, fixed-asset HTTP endpoint,
  production deployment scaffolding, `bin/deploy.sh`
- Multi-tenancy Phases 1–8 (Clerk + per-tenant API tokens + scoped
  reads/writes + UI switcher + onboarding wizard)
- 4× pen-test passes (cross-tenant leaks, reassign+internal endpoints,
  CSV injection / TOCTOU / token timing, middleware fail-closed)

**What this repo doesn't do:** AI calls. ledger-core has no Anthropic
client. The companion repos make the AI proposals; humans approve;
ledger-core posts the JEs. That's the architectural separation.

### `recon` (v1.0 — bank reconciliation)

CSV bank statement parsing with reconciliation invariants
(Σ lines = Δ balance). Deterministic match scoring + Claude Haiku 4.5 AI
suggester (forced tool-use for structured output, prompt caching on the
system prefix). Bulk "suggest for all unmatched", per-line ignore with
audit columns, statement progress summary, AI audit panel.

Adjustment-JE flow for unmatched lines (e.g. a $50 wire fee never booked)
posts through ledger-core's HTTP bridge with `source: "MANUAL"`. AI-
sourced approvals post with `source: "AI_APPROVED"`.

This was the first companion repo to prove the cross-repo bridge pattern.

### `revenue-rec` (v0.2 — ASC 606 engine)

Deterministic core: SSP allocator + recognition schedule generator
(POINT_IN_TIME + OVER_TIME_STRAIGHT). Penny-perfect rounding with last-
period absorption.

AI contract extractor uses Claude Opus 4.7 (per CLAUDE.md: contract
language is reasoning-heavy, do not downgrade for cost). `messages.parse`
+ `zodOutputFormat` for structured output. Prompt caching on the system
prefix. Every extraction persists to `AiExtractionSuggestion` for audit.

Month-end recognition posting goes through the same HTTP bridge as recon
adjustments.

### `integrations` (v0.1 — Plaid bank-feed)

The connector pattern + one real connector. Plaid `/transactions/sync`
polling, idempotent dedup via `externalRef`, cursor advances only on
SUCCESS. Sync runner orchestrates fetch → stage → map → promote.

Pushes to recon via HTTP bridge (`POST /api/internal/bank-lines`),
not direct DB write. Symmetric with how recon pushes to ledger-core.

### `fa-amort` (v0.6 — fixed assets + 3 AI surfaces)

Deterministic depreciation math (straight-line + double-declining with
salvage floor). MACRS lookup tables are v0.3 work. Server Action loads
asset → schedules → posts one JE per (asset × book × month) through the
transactional ledger-core endpoint (no drift window between JE post and
book-attrs update).

Three AI surfaces, all Opus 4.7:
1. Capex classifier — paste invoice text, get capitalize/expense decision
2. Useful-life reassessment — ASC 250-10-45-17 prospective change
3. Impairment-indicator screener — ASC 360-10 Step 1 trigger detection

The capex loop is closed: accepted classifications create a real
FixedAsset via ledger-core's `/api/internal/fixed-asset` endpoint.

---

## Cross-cutting: security posture

This is the work the last 30 sessions actually shipped, and it's distinct
from feature work.

**Multi-tenancy (8 phases across the portfolio):**
1. Schema: tenant + memberships + per-row tenantId
2. Tenant context helpers + Server Action wiring
3. Clerk integration (env-gated; dev cookie stub in development)
4. Substrate write enforcement (4a) + read scoping (4c) + Phase 4b
   `(tenantId, code)` unique constraints
5. Per-tenant API tokens for HTTP boundaries
6. Tenant UI: switcher + onboarding wizard
7. Audit log: tenant-scoped DATA_EXPORT events on every CSV/PDF download
8. Companion-repo Clerk mirror (recon, revenue-rec, integrations, fa-amort)

**Pen-test passes (4 rounds, ~37 findings, 31 fixes):**
- Pass 1: cross-tenant read/write leaks via Server Actions taking ids
- Pass 2: reassign + internal fixed-asset endpoints
- Pass 3: CSV formula injection, TOCTOU on payment application,
  token timing attacks
- Pass 4: tenant scope + auth on critical actions across all 5 repos

**Pen-test pass 4 follow-ups (this session):**
- Middleware fails closed in production when `CLERK_SECRET_KEY` is unset
  (503 on non-public routes; pass-through in dev, sign-in/health still
  served)
- Page-level cross-tenant read leaks closed in all 4 companion repos
  (Server Actions were locked but `/contracts/[id]`, `/statements/[id]`,
  `/connections/[id]`, `/fixed-assets/[id]` were still leaking)
- `tenantId` column on AI suggestion tables in recon, revenue-rec,
  fa-amort (with backfill SQL); the AI audit pages can now show
  pending suggestions for the right tenant — they were being filtered
  out for the owner too
- AI rate limit + monthly Anthropic spend cap (`RateLimitEvent` table,
  `Tenant.monthlyAiSpendCapUsd`, post-flight cap enforcement via
  per-model pricing table). Defaults: 600 calls/tenant/hour,
  60/user/minute, $50/tenant/month. Env-overridable.

**SOC 2 readiness:**
- Audit log with hash chaining (CC4)
- Security headers + CSP (CC6)
- CI scans: gitleaks, npm audit (CC7)
- CODEOWNERS
- Written policies in `docs/soc2/` + 90-day implementation roadmap

---

## What's next

Three categories, in roughly the order they should land.

### Category 1 — Close the door (security + multi-tenant completeness)

Mostly done after this session. Remaining:

- [ ] **External pen test.** Four self-administered passes is good
      discipline but doesn't substitute for an independent red team.
- [ ] **Anthropic spend alerting.** A cap blocks; an alert warns.
      Slack/email at 80% of the per-tenant monthly cap.
- [ ] **Rate-limit cleanup cron.** `RateLimitEvent` rows grow indefinitely
      today. Periodic `DELETE WHERE createdAt < now() - INTERVAL '7 days'`
      either via pg_boss or `vercel.json` cron.
- [ ] **`/admin/ai-budget` page.** Per-tenant view of this month's spend,
      cap, and recent throttled requests. Data is already in the tables.

### Category 2 — Make it usable by a stranger (productize)

This is what gates a real second user. Most of it shipped on 2026-05-27.

- [x] **Tenant onboarding flow.** Sign-up → create tenant → first-entity
      setup were already wired (the `/onboarding` two-step from Phase 7).
      Inviting teammates was the missing piece, now added.
- [x] **Per-user RBAC inside a tenant.** OWNER / ADMIN / MEMBER / VIEWER
      enum + `policy.ts` module with 16 named permissions. Migrated
      `requireAdmin()` to use the policy. Mirrored to all 4 companion
      repos. 90 tests on the role hierarchy.
- [x] **Team management UI.** `/admin/team` with invite-by-email,
      role-change dropdown, and remove-member. Schema: `TenantInvite`
      with single-use tokens + 14-day TTL. Audit-logged.
- [x] **Email notifications.** `src/lib/email/send.ts` with Resend
      backend; LOGGED_ONLY path when no API key. Invite emails wired.
      Other templates (period close approaching, AI suggestion ready,
      sync failed) are 1-day adds on the same primitive.
- [x] **Billing / subscription skeleton.** `/admin/billing` with plan
      picker + Stripe Checkout + billing portal. Webhook handler with
      HMAC-SHA256 signature verification (12 tests including replay-
      attack rejection). `docs/billing-setup.md` operator runbook.
- [ ] **Docs site + marketing surface.** Still in the repo only. Punted
      for now — the operator runbooks (`docs/deployment.md`,
      `docs/billing-setup.md`) cover technical deployment; a customer-
      facing marketing surface is a separate project.

### Category 2.5 — Productize, harder pieces (future work)

The skeleton work above unblocks a real second user but doesn't ship
the polish:

- [ ] **Plan-tier feature gating.** Today plans are flat-rate with no
      enforced limits. Wire entity count / AI token cap to the plan tier
      and refuse in the relevant Server Actions.
- [ ] **Stripe usage-based metering.** Report AI token volume to a
      metered Price in Stripe via a daily cron. Lets us bill heavy AI
      users more than light ones without a custom invoicing flow.
- [ ] **Marketing site.** Separate Next.js project (or static site).
      Pricing page, demo flow, /sign-up CTA.
- [ ] **Email templates beyond invites.** Period close 3 days out,
      AI suggestion ready for review, sync failed, weekly digest.
      Each is a small typed wrapper around `sendEmail`.
- [ ] **Ownership transfer.** Currently OWNER can't be demoted /
      removed. Need a flow where current OWNER promotes another member,
      they accept, ownership atomically swaps. Schema-only change to
      `Tenant.ownerUserId` plus the migration UI.

### Category 3 — Fill out the accounting features

The accounting depth is what makes this defensible. None of this is
shipped except where noted.

**ledger-core:**
- [ ] FX gain/loss on monthly currency revaluation
- [ ] Multi-currency revaluation cycle
- [ ] JE approval workflow (maker-checker — currently anyone with access
      can post)

**recon:**
- [ ] Statement-level `RECONCILED` status with lock after 100% resolved
- [ ] Bulk approve / bulk ignore by description regex
- [ ] Multi-line adjustments (currently only cash + counter)

**revenue-rec (v0.3 roadmap):**
- [ ] OVER_TIME_USAGE pattern (currently errors)
- [ ] OVER_TIME_MILESTONE pattern (currently errors)
- [ ] Variable consideration (expected value / most-likely-amount)
- [ ] Contract modifications (cumulative catch-up vs prospective vs
      separate-contract)
- [ ] Multi-book recognition basis differences (schema supports it; engine
      only emits US_GAAP)

**integrations (v0.2 roadmap):**
- [ ] Plaid webhook receivers (`TRANSACTIONS_UPDATES_AVAILABLE`)
- [ ] Scheduled syncs via pg_boss
- [ ] Stripe connector → AR open items
- [ ] Gusto connector → payroll JE via posting-rules
- [ ] Bill.com → AP open items

**fa-amort (v0.7 roadmap):**
- [ ] MACRS lookup tables (3/5/7/15-year half-year)
- [ ] Disposal flow with JE (write off NBV, recognize gain/loss)
- [ ] Impairment write-down flow (the AI screener exists; no JE path)
- [ ] Bonus depreciation / §179
- [ ] SL crossover convention for DDB

---

## Open decisions

- **Per-tenant rate-limit defaults.** 600/hour and $50/month feel right
  for a working CPA but are guesses. First real customer will inform the
  tightening. Override via env or per-tenant column.
- **AiAssetSuggestion orphan rows.** Rows with `assetId` null AND `tenantId`
  null (pre-multi-tenancy seed data) are unrecoverable. Backfill SQL
  joins through `asset.entity` where possible; pre-creation CAPEX runs
  without an asset stay invisible. Probably fine — they have no tenant
  claim anyway — but flag if real data shows up.
- **Anthropic pricing in code.** Hardcoded per-model price table in each
  repo's `src/lib/auth/ai-budget.ts`. If Anthropic changes pricing, three
  files to edit. Acceptable for v1; promote to a shared source-of-truth
  later if pricing churns.
- **External pen test timing.** Worth $5–15k. When ready, run before
  signing first paying customer. Not before.

---

## Decision log (additions since 2026-05-21)

- **2026-05-22** — ledger-nexus XBRL deferred. Considered building an
  iXBRL filing companion (`xbrl-filer`) for SEC submissions; deferred
  pending a public-company audience. Architecture sketch preserved in
  the memory note for revival.
- **2026-05-22 to 2026-05-25** — Multi-tenancy Phases 1–8 landed in
  order. Decisions through the series:
  - Phase 4a: writes go through tenant-aware helpers; never via raw
    Prisma in Server Actions
  - Phase 4b: codes are unique per `(tenantId, code)`, not globally —
    the OLD `@unique` was a UNIQUE INDEX not a constraint, so the
    `DROP CONSTRAINT IF EXISTS` migration was a no-op until fixed by
    migration 0007
  - Phase 5: HTTP bridges use per-tenant API tokens, not a global one
  - Phase 7: `lc-scope` cookie was supplanted by tenant membership for
    canonical "current tenant" resolution
- **2026-05-25** — Companion repos mirror ledger-core's Tenant/User/
  TenantMembership tables read-only. They never write to those tables;
  ledger-core owns the canonical write path.
- **2026-05-26** — Pen-test pass 4 deferred items: classify-* actions
  in fa-amort (anonymous Anthropic spend), `tenantId` columns on the
  three AI suggestion tables, propose-matches + extract-contract
  hardening. All closed in this session.
- **2026-05-27** — Page-level cross-tenant read leaks closed across
  all 4 companion repos (Server Actions were locked in pen-test pass 4
  but pages were still leaking via direct `findUnique(where: {id})`).
- **2026-05-27** — AI suggestion tables now carry `tenantId`. Filtering
  via the column directly instead of joining through `asset.entity` /
  `contract.entity` / `bankLine.statement.bankAccount.entity` is cleaner
  AND makes pending rows (assetId null) visible to their owning tenant
  again.
- **2026-05-27** — AI rate limit + monthly Anthropic spend cap added
  across recon, revenue-rec, fa-amort. Canonical `Tenant.monthlyAiSpend
  CapUsd` column on ledger-core's schema; companion repos mirror it
  read-only. Post-flight cap enforcement (sum tokens from each repo's
  AI suggestion table, multiply by per-model pricing, refuse next call
  if over). Accepted limitation: one call can push over by its own cost.
- **2026-05-27 (late)** — Per-tenant RBAC landed across the portfolio.
  TenantRole enum gains VIEWER; new `policy.ts` module with 16 named
  permission helpers (`canPostJournalEntries`, `canClosePeriods`,
  `canDeleteTenant`, etc.). `requireAdmin()` migrated from email
  allowlist to tenant-role check — meaning an admin in tenant A is no
  longer automatically admin in tenant B. The legacy `isAdmin(user)`
  sync helper still exists for UI button-visibility gating but Server
  Actions go through `requireAdmin()` → `policy.canViewAdminPages(role)`.
- **2026-05-27 (late)** — Team management at `/admin/team`. New
  `TenantInvite` model with single-use 32-byte tokens + 14-day TTL;
  /invites/accept verifies token + email match before creating the
  membership. Email-mismatch refusal is the security boundary —
  prevents invite-link hijacking.
- **2026-05-27 (late)** — Transactional email via Resend. Decided
  against the Stripe-SDK / Resend-SDK approach in favor of direct
  HTTP — smaller bundle, fewer Next.js runtime conflicts, and the four
  Stripe endpoints + Resend's single POST are stable enough to call
  directly. LOGGED_ONLY fallback persists the email body to the
  EmailDelivery table when no API key is set, so dev / pre-domain-
  verification deploys still flow visibly.
- **2026-05-27 (late)** — Stripe billing skeleton landed. Plans defined
  in `src/lib/billing/plans.ts` with Price ids env-mapped per
  deployment. Webhook signature verification with HMAC-SHA256 +
  constant-time compare + 5-minute replay-tolerance window. Deferred:
  plan-tier feature gating, usage-based metering, plan-change preview.
  See `docs/billing-setup.md` for the operator runbook.

(Historical decisions from before 2026-05-21 preserved below in the
"Pre-2026-05-21 decisions" section. They cover the substrate /
mapper / UI choices that shaped v0.2 through v1.0.)

---

## Pre-2026-05-21 decisions (preserved verbatim)

- Rebrand: `mini-ledger` → `ledger-core`. Reframes the project from
  "tiny correct ledger" to "universal substrate."
- Locked: US + IFRS only (no per-country statutory); own sub-ledgers
  natively; QBO-floor, NetSuite-ceiling.
- Locked: multi-book Pattern 2 (full parallel posting). Pattern 1
  (derive other books from a primary) rejected.
- Surrogate keys are UUIDs (`gen_random_uuid()`), not cuid. Currency
  PK is the ISO 4217 code (stable across systems).
- AR/AP open items are keyed per (entity, book). Cash-basis tax
  customers need per-book open-item lifecycles even when GAAP and TAX
  are usually identical.
- Revenue recognition math: month-based, not day-based. Day-based
  drifts by pennies per period and breaks clean BTD demos.
- Posting-rules engine DSL is intentionally minimal: `$.path` lookups
  + `${$.path}` interpolation. Arithmetic and conditionals are OUT —
  author in TS directly.
- Bad debt write-off ships with both DIRECT (default) and ALLOWANCE
  (opt-in via `method: "ALLOWANCE"`).
- QBO Account codes get a `Q` prefix in `code`; NetSuite gets `NS`.
  Original ID is preserved in `sourceRecordId` for roundtrip integrity.
- `exportToQbo` is a lineage-replay function: reads `sourcePayload`
  verbatim, no re-translation. The practical demonstration of why
  Layer 6 lineage requires the frozen raw payload.
- NS dimension engine: dedup at line scope via stable hash of sorted
  `(dimensionCode, valueCode)` pairs. Plain string hash, not crypto.
- NS custom segments map to `Dimension` rows keyed by the uppercased
  internalid. Built-in and custom dimensions share one engine.
- UI primitives inlined in `src/components/ui/` — no shadcn CLI dep.
- Cash flow classification: subtype-driven heuristic with an
  `uncategorized` panel as the safety net. Decided NOT to add a
  `cashFlowCategory` enum column to `Account`.
- `POST /api/admin/reset` fails closed when `ADMIN_TOKEN` is unset
  (503, not 401). Communicates "endpoint intentionally disabled."

---

## Notes for the next session

- Each repo has its own `CLAUDE.md` and (for companion repos)
  `docs/ARCHITECTURE.md`. Read those first when picking up work in a
  specific repo.
- ledger-core's `docs/universal-schema.md` is the portfolio-level
  architecture canon. Multi-book Pattern 2 is locked; do not
  re-litigate.
- Schema migrations run from each repo individually via `pnpm db:push`
  (no separate migrations directory in companion repos; ledger-core has
  Prisma migrations). When pushing to a shared DB, push ledger-core
  first since the companion repos mirror its tables.
- Headline test command per repo: `pnpm test`. ledger-core tests need
  a live Postgres; companion repo tests are mostly unit tests with
  some DB-touching exceptions (recon's `tests/ignore-line.test.ts`).
- AI suggestion table backfill SQLs live at
  `prisma/backfill-ai-*-tenant.sql` in each companion repo. Run AFTER
  `pnpm db:push` adds the nullable column.
- The portfolio's deployment story is partially defined: ledger-core
  has `bin/deploy.sh` and `docs/deployment.md`. Companion repos have
  `v0.3-ish` production-deployment scaffolding commits but no
  end-to-end deploy guide. Tenant onboarding is the gating item before
  any of this matters to a stranger.
