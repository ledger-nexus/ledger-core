# Project Status

The single source of truth for "where the portfolio is and what's next."
Updated end-of-session so the next pickup (human or Claude Code) doesn't
need to re-derive context.

**Last updated:** 2026-05-29 (post-multi-tenant audit-pass + getScope sweep)

---

## The portfolio at a glance

This file used to track only ledger-core. It now tracks the **ledger-nexus
portfolio** — five repos sharing one Postgres, each owning its slice of
the accounting stack:

| Repo            | Role                                                       | Latest | Port |
|-----------------|------------------------------------------------------------|--------|------|
| `ledger-core`   | Universal substrate. GL, sub-ledgers, ERP mappers, UI, tax | v1.21  | 3000 |
| `recon`         | AI-assisted bank reconciliation                            | v1.0   | 3001 |
| `revenue-rec`   | ASC 606 / IFRS 15 revenue recognition                      | v0.3   | 3002 |
| `integrations`  | Third-party data feeds (Plaid)                             | v0.2   | 3003 |
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

### `revenue-rec` (v0.3 — ASC 606 engine + usage-based recognition)

Deterministic core: SSP allocator + recognition schedule generator
(POINT_IN_TIME + OVER_TIME_STRAIGHT + OVER_TIME_USAGE). Penny-perfect
rounding with last-period absorption. OVER_TIME_USAGE rows accrete
as consumption is recorded via the recordUsageAction UI on the
contract detail page.

AI contract extractor uses Claude Opus 4.7 (per CLAUDE.md: contract
language is reasoning-heavy, do not downgrade for cost). `messages.parse`
+ `zodOutputFormat` for structured output. Prompt caching on the system
prefix. Every extraction persists to `AiExtractionSuggestion` for audit.

Month-end recognition posting goes through the same HTTP bridge as recon
adjustments.

### `integrations` (v0.2 — Plaid bank-feed + webhooks)

The connector pattern + one real connector. Plaid `/transactions/sync`
polling, idempotent dedup via `externalRef`, cursor advances only on
SUCCESS. Sync runner orchestrates fetch → stage → map → promote.

Plaid webhooks (v0.2, 2026-05-28): POST /api/plaid/webhook receives
SYNC_UPDATES_AVAILABLE + related events, matches by item_id, and
triggers an immediate runConnectionSync (triggerType=WEBHOOK).
PlaidWebhookEvent audit table records every payload regardless of
outcome. URL-token shared-secret auth for v1; ES256 JWT verification
is a v2 follow-up.

Pushes to recon via HTTP bridge (`POST /api/internal/bank-lines`),
not direct DB write. Symmetric with how recon pushes to ledger-core.

### `fa-amort` (v0.7 — fixed assets + 3 AI surfaces + MACRS)

Deterministic depreciation math (straight-line + double-declining with
salvage floor + MACRS 3/5/7/15-year half-year, shipped 2026-05-27).
Server Action loads
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

**Multi-tenant report-scoping audit-pass (2026-05-29):**
- Class of bug: shared-chart accounts (`Account.entityId = NULL`)
  rely on Postgres `(entityId, code)` unique indexes — but PG treats
  `NULL ≠ NULL` so multiple tenants can each own a (null, code=X)
  account. Any query that joined by `{ entityId: null }` without
  also constraining `tenantId` would non-deterministically match a
  sibling tenant's account; report-side dedup maps would then drop
  lines, and seed-side `findFirst + create` would skip creating
  the chart this tenant actually needs.
- One reproduction: `tests/seeded-company.test.ts` walked Northwind's
  US_GAAP TB across 6 month-ends and saw a -$24,000 imbalance from
  three "1500" rows colliding in dedup. Same root cause hit cash-flow,
  BTD, M3, and consolidation reports — none of which exercised the
  cross-tenant case in tests, so they passed silently in CI.
- Fixed: `resolveEntityBook` returns tenantId; every report
  (`getTrialBalance`, `getBalanceSheet`, `getIncomeStatement`,
  `getCashFlowStatement`, `getBookTaxDifference`, `getM3Detail`,
  `getConsolidatedTrialBalance`) scopes its account query by tenant.
  Mappers (`exportToQbo`, `exportToNs`) resolve `entityId` up-front
  rather than relying on the cross-tenant `entity: { code }` relation
  filter. Northwind seed + 6 test setups now tenant-scope their
  shared-chart upsert.
- Net: 89 ledger-core tests went from failing/skipped to all 616 green;
  recon went from 163+6-skipped to 169 clean; the shared Neon DB
  picked up an additive-only schema sync to backfill missing columns
  surfaced during the run.

**Pen-test pass 4 follow-ups (2026-05-27):**
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

Effectively complete after the 2026-05-29 audit-pass + getScope sweep.
Remaining:

- [ ] **External pen test.** Four self-administered passes is good
      discipline but doesn't substitute for an independent red team.
      Worth $5–15k; before signing first paying customer.
- [x] **Anthropic spend alerting.** Shipped — `emitSpendAlertIfThresholdCrossed`
      in each AI-using companion's `src/lib/auth/ai-budget.ts`. 80% + 100%
      thresholds, AiSpendAlert table for per-repo per-month dedup, optional
      AI_ALERT_WEBHOOK_URL for Slack/Discord/email-relay POSTs.
- [x] **Rate-limit cleanup cron.** Shipped — `vercel.json` cron at 3 AM
      nightly hits `/api/cron/cleanup-rate-limits` in each companion;
      bounded delete of RateLimitEvent rows older than 7 days.
- [x] **`/admin/ai-budget` page.** Shipped — `src/app/admin/ai-budget/page.tsx`
      reads cross-repo aggregates via raw SQL (substrate→consumer reverse
      dependency avoided), shows per-tenant month-to-date spend, recent
      threshold alerts, last-30-days usage-report panel.

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

### Category 2.5 — Productize, harder pieces (mixed status)

The skeleton work above unblocks a real second user. This bucket is
the polish + harder pieces:

- [x] **Plan-tier feature gating.** Shipped 2026-05-27 (late).
      Per-plan maxUsers / maxEntities / defaultAiSpendCapUsd /
      availableRepos enforced in inviteMemberAction. Webhook seeds
      Tenant.monthlyAiSpendCapUsd from the plan default. /admin/billing
      shows usage + limits + AT LIMIT badges. /admin/team header shows
      X/Y users. past_due subscriptions auto-downgrade to free-tier
      limits. BILLING_ENFORCE_LIMITS env flag stages the rollout.
- [x] **Maker-checker JE approval workflow.** Shipped 2026-05-27 (late).
      PENDING_APPROVAL status + audit columns. Lifecycle module with
      separation-of-duties guard + period-close re-check. /journal-
      entries/pending FIFO queue + inline approve/reject card on entry
      detail. Tenant.requireJeApproval toggle on /admin/team.
- [x] **Stripe usage-based metering.** Shipped 2026-05-28
      (commit `e0458d2`). Daily cron `/api/cron/report-ai-usage`
      reports the prior day's per-tenant token volume to a metered
      Price in Stripe. AiUsageReport table per-day idempotency. Lets
      us bill heavy AI users more than light ones without a custom
      invoicing flow.
- [ ] **Marketing site.** Separate Next.js project (or static site).
      Pricing page, demo flow, /sign-up CTA.
- [~] **Email templates beyond invites.** Shipped 2026-05-27 (later):
      je_approved + je_rejected templates fire automatically from the
      maker-checker Server Actions. Extended 2026-05-29:
      owner_transfer_offered + _accepted + _withdrawn/_declined wired
      into the ownership-transfer actions (mirror of the bell-icon
      notifications, fire-and-forget). Period close 3 days out, AI
      suggestion ready, sync failed, weekly digest are still future
      work.
- [x] **Ownership transfer.** Shipped 2026-05-29 (commit `4827ad5`).
      Two-step opt-in: current OWNER initiates an offer; target
      accepts via `/admin/team`; either side can cancel.
      Tenant.pendingOwnerTransferToUserId + initiatedAt columns
      track the offer; accept runs the swap (target → OWNER,
      previous → ADMIN, ownerUserId rotated, pending cleared) in
      one $transaction. 13 lifecycle tests. Audit log captures
      `tenant.owner_transfer_initiate / _accept / _cancel`.
- [x] **Companion-repo plan enforcement.** Shipped 2026-05-27 (later).
      Each companion repo (recon / revenue-rec / fa-amort / integrations)
      now has `src/lib/auth/repo-access.ts` mirroring the plan catalog's
      `availableRepos`. Dashboards show upgrade banner when not included;
      high-cost Server Actions (Anthropic calls, sync runs, depreciation)
      hard-refuse when `BILLING_ENFORCE_LIMITS=true`. revenue-rec + fa-amort
      gated to Growth+; integrations gated to Scale.
- [x] **Withdraw your own pending JE.** Shipped 2026-05-29
      (commit `b7dfb4f`). `withdrawJournalEntry` lifecycle helper
      with an inverse SoD check (only the submitter can withdraw).
      Reuses the VOID rejection columns with a `Withdrawn:` reason
      prefix so audit log + JE detail can distinguish withdrawal
      from third-party rejection. UI: WithdrawAction client component
      on `/journal-entries/[id]` for PENDING_APPROVAL entries where
      `entry.submittedById === currentUser.id`. 6 new lifecycle tests.
- [x] **Threshold-based JE approval.** Shipped 2026-05-29
      (commit `8eedcbe`). Tenant.jeApprovalMinAmount Decimal? (18,4);
      null preserves the original binary behavior, positive value
      filters which entries actually queue. Pure helper
      `resolveApprovalRoute` (4-axis matrix → ApprovalRoute) with 11
      unit tests. `/admin/team` adds a $-prefixed numeric input
      below the existing toggle.

### Category 3 — Fill out the accounting features

The accounting depth is what makes this defensible. None of this is
shipped except where noted.

**ledger-core:**
- [x] FX gain/loss + multi-currency revaluation cycle. Shipped
      2026-05-27 (latest+++). previewFxRevaluation +
      postFxRevaluation. /reports/fx-revaluation page with
      preview → post. CLOSE rate type, account-level aggregation,
      one JE per cycle, deterministic lineage record-id makes
      re-runs naturally idempotent (carrying value after first
      run already matches revalued).
- [x] JE approval workflow (shipped earlier in maker-checker commit).

**recon:**
- [x] Statement-level `RECONCILED` status with lock after 100%
      resolved. Shipped 2026-05-27 (latest++). New BankStatement.status
      enum + reconciledAt/By columns. assertStatementOpen helper
      wired into every mutating action (propose / decide / ignore /
      adjustment). Reconcile button on /statements/[id] when
      fullyResolved; admin-only Reopen button with reason input.
- [ ] Bulk approve / bulk ignore by description regex
- [ ] Multi-line adjustments (currently only cash + counter)

**revenue-rec (v0.3 roadmap):**
- [x] OVER_TIME_USAGE pattern. Shipped 2026-05-27 (latest+). Schema
      gains PerformanceObligation.pricePerUnit + unitName +
      RecognitionSchedule.usageQuantity. Schedule generator returns []
      for this pattern; setUsagePricingAction + recordUsageAction
      create schedule rows on-the-fly as consumption is reported.
      UI: inline pricing + usage forms on /contracts/[id] below each
      OVER_TIME_USAGE PO row.
- [ ] OVER_TIME_MILESTONE pattern (still throws — named-completion-point
      recognition is more involved than usage; needs milestone-level
      inputs not just date math)
- [x] **Variable consideration** (expected value / most-likely-amount).
      Shipped — schema has `VariableConsideration` +
      `VariableConsiderationOutcome` + `VariableConsiderationReassessment`
      models; methods enum covers both EXPECTED_VALUE and
      MOST_LIKELY_AMOUNT. Server Actions in
      `src/app/actions/variable-consideration.ts` (proposeVarCons,
      resolveVariableConsiderationAction, removeVariableConsiderationAction,
      reassessAction with ASC 606-10-32-14 cumulative catch-up).
      Self-audit fix landed this session (commit `0686944`) — throws on
      negative back-derived base instead of silently clamping to 0.
- [ ] Contract modifications (cumulative catch-up vs prospective vs
      separate-contract)
- [ ] Multi-book recognition basis differences (schema supports it; engine
      only emits US_GAAP)
- [ ] AI extractor learns to pull pricePerUnit + unitName for
      OVER_TIME_USAGE patterns from contract text (today: manual via
      setUsagePricingAction)

**integrations (v0.2 — webhooks landed; v0.3 roadmap):**
- [x] Plaid webhook receivers. Shipped 2026-05-28. POST
      /api/plaid/webhook with URL-token shared-secret auth.
      parseWebhookEvent on the Plaid connector routes
      SYNC_UPDATES_AVAILABLE / DEFAULT_UPDATE / INITIAL_UPDATE /
      HISTORICAL_UPDATE / TRANSACTIONS_REMOVED through to
      runConnectionSync with triggerType=WEBHOOK; ITEM / ERROR
      marks Connection.status=ERROR. Every payload audited via
      PlaidWebhookEvent regardless of outcome.
- [x] **Plaid JWT signature verification.** Shipped (already
      live). `src/lib/connectors/plaid/webhook-verification.ts`
      hand-rolls ES256 verification on `node:crypto` (no `jose`
      dep): JWT parse, JWK fetch from
      `/webhook_verification_key/get` with in-process kid cache,
      signature verify with `ieee-p1363` raw `r||s`, 5-minute
      replay window via `iat`, body-hash check against the signed
      `request_body_sha256`. Wired into the webhook route with a
      two-ladder auth policy: JWT first (production-required by
      default), URL-token belt-and-suspenders if both env vars
      set. 15 unit tests + e2e plaid-webhook tests.
- [ ] Scheduled syncs via pg_boss
- [ ] Stripe connector → AR open items
- [ ] Gusto connector → payroll JE via posting-rules
- [ ] Bill.com → AP open items

**fa-amort (v0.8 roadmap):**
- [x] MACRS lookup tables (3/5/7/15-year half-year). Shipped 2026-05-27.
- [x] Disposal flow with JE (write off NBV, recognize gain/loss).
      Shipped 2026-05-27 (latest). New POST
      /api/internal/fixed-asset/dispose endpoint in ledger-core +
      disposeAssetAction + DisposeForm on /fixed-assets/[id]. The
      lifecycle is now complete: acquire → depreciate (SL / DDB /
      MACRS) → dispose with catch-up + gain/loss recognition.
- [x] Impairment write-down flow. Shipped 2026-05-27 (latest++).
      The AI impairment screener now has a JE path: ASC 360-10 Step 2
      measurement via POST /api/internal/fixed-asset/impair +
      impairAssetAction + ImpairForm. Per-book amounts (typically TAX
      skipped). When invoked with a sourceSuggestionId, stamps the
      AI screening with the resulting JE entry numbers — closes the
      AI loop end-to-end (screen → flag → measure → JE).
- [ ] Bonus depreciation / §179
- [x] **SL crossover convention for DDB.** Shipped 2026-05-29
      (fa-amort commit `b750f61`). Per-month max(DDB candidate,
      SL crossover candidate) — stateless, idempotent on re-run.
      Final month absorbs rounding residual so cumulative ties
      exactly to (cost - salvage). Closes the v0.2 carve-out in
      fa-amort's CLAUDE.md non-negotiable #5.
- [ ] MACRS mid-quarter + mid-month conventions (real property)

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
- **2026-05-27 (later)** — Plan-tier limit enforcement. Free tier
  (3 users / 5 entities / $10 AI / recon-only) + starter / growth /
  scale ladders. inviteMemberAction refuses at user cap (counts
  pending invites toward the total). Webhook seeds
  Tenant.monthlyAiSpendCapUsd from plan default on subscription;
  explicit operator overrides are sticky. BILLING_ENFORCE_LIMITS env
  gates hard refusal — default OFF in dev (warn-only) so seeded
  tenants keep working; flip to ON for production. past_due
  subscriptions auto-downgrade to free tier.
- **2026-05-27 (later)** — Maker-checker JE approval. New
  PENDING_APPROVAL status routes MEMBER posts through an admin queue.
  Lifecycle module enforces separation of duties (submitter ≠ approver)
  + re-runs period-close at approval (since the period might close
  between submit and approve). Rejected entries flip to VOID with a
  required reason preserved on the row. ON_INSERT rules fire at
  approve time, not at submit (entry isn't really live until then).
  Tenant.requireJeApproval toggle defaults false for backwards compat.
- **2026-05-27 (latest)** — JE approval emails. Submitter gets pinged
  via Resend (je_approved / je_rejected templates) the moment an admin
  acts on their submission. Failure-isolated — a Resend outage doesn't
  break the approval flow. Without an API key, the LOGGED_ONLY
  EmailDelivery row still lands so the operator can hand-deliver.
- **2026-05-27 (latest)** — Companion-repo plan enforcement. Each
  companion repo (recon / revenue-rec / fa-amort / integrations) now
  mirrors the canonical plan-to-repo map in its own `repo-access.ts`.
  Dashboards show an amber upgrade banner when not included; high-cost
  Server Actions hard-refuse when `BILLING_ENFORCE_LIMITS=true`.
  Decision: hardcode the plan-to-repo map in each companion rather
  than HTTP-call ledger-core on every request — the catalog is stable
  + the duplication is trivially audit-able. When the catalog changes,
  update plans.ts + the four repo-access.ts files together.
- **2026-05-27 (latest)** — MACRS in fa-amort. IRS Pub 946 Table A-1
  half-year-convention percentages for 3 / 5 / 7 / 15-year property.
  Monthly recognition: annual percentage / 12 with year-end month
  absorbing rounding residual. Salvage value IGNORED (matches tax
  practice — the table drives cumulative to 100% × cost). MACRS
  recovery spans MORE than usefulLifeMonths because of the half-year
  stub year (5-year MACRS = 6 calendar years of recovery). 25 tests
  asserting Year 1..N totals match the IRS table exactly.
- **2026-05-27 (latest)** — Fixed-asset disposal flow. ledger-core
  already had disposeFixedAsset under sub-ledgers; this commit added
  the HTTP boundary (POST /api/internal/fixed-asset/dispose) and the
  fa-amort wiring (bridge helper, Server Action, UI form). Also
  threaded tenantId through disposeFixedAsset + runDepreciation so
  same-coded entities across tenants can't be cross-leaked. The
  disposal JE per book: Dr Cash (proceeds) + Dr Accum Dep (zero out
  contra) + Cr Asset (gross cost) + Dr-or-Cr Gain/Loss (balancing
  line). Gain/loss differs per book because accumulated depreciation
  differs — a clean BTD demonstration where a temporary timing
  difference flips to permanent at disposal.
- **2026-05-28** — Plaid webhook receivers in integrations. Real-time
  bank-feed updates replace polling. Decisions:
    - URL-token shared-secret auth for v1 (vs Plaid's ES256 JWT
      verification). The webhook URL is configured in the Plaid
      dashboard with a `?token=` query param; the route refuses
      mismatches via constant-time compare. Equivalent posture to
      INTERNAL_API_TOKEN we use elsewhere. Full JWT verification
      (fetch key from /webhook_verification_key/get, verify
      ES256 signature over body, check request_body_sha256 claim)
      lands in a v2 follow-up.
    - Always 2xx on auth-pass (vs returning 500 on unrouted /
      unknown event types). Plaid retries non-2xx for 24h; we
      persist + ack to prevent retry storms when Plaid adds new
      event types.
    - Idempotency via the /transactions/sync cursor — duplicate
      "new transactions available" webhooks just produce zero new
      records on the second sync. No explicit dedup needed.
    - parseWebhookEvent on the connector returns
      { records: [], needsImmediateFetch: true } for transactions
      events. Plaid webhooks are notifications, not record payloads.
- **2026-05-27 (latest+++)** — Multi-currency FX revaluation cycle in
  ledger-core. Period-end JE that adjusts foreign-currency balance-
  sheet account carrying values to the CLOSE rate at as-of date.
  Decisions:
    - ACCOUNT-LEVEL aggregation (vs LINE-LEVEL): each account's net
      foreign-currency balance revalues as a group. AR/AP at real
      firms often does line-level so gains on appreciated invoices
      don't mask losses on depreciated ones in the same account.
      Acceptable v1 simplification; future work tracked.
    - ONE JE per cycle (vs N per account): simpler audit trail.
      Internal natural offset is balanced by construction (Σdebits =
      Σcredits when delta is signed via normalBalance).
    - CLOSE rate type only. AVG (for P&L translation during
      consolidation) composes the same primitive separately.
    - Deterministic lineage record-id (`<entity>:<book>:<asOfDate>`).
      Re-runs on the same date produce zero deltas naturally — the
      carrying value already matches revalued after the first run.
      No need for explicit dedup.
    - Skips REVENUE / EXPENSE accounts. P&L accounts translate at
      AVG during consolidation, not at CLOSE here.
- **2026-05-27 (latest++)** — RECONCILED statement lock in recon. New
  BankStatement.status enum with OPEN | RECONCILED. The lock helper
  (assertStatementOpen) is called by every mutating action; reconcile
  is MEMBER+, reopen is ADMIN+. Refusing 100%-of-the-time when locked
  closes the most common CPA-side anxiety ("did anyone touch this
  after I signed off?").
- **2026-05-27 (latest++)** — Impairment write-down flow in fa-amort.
  Parallels disposal: catch up depreciation, then post per-book JE
  (Dr Impairment Loss / Cr Accum Dep). Decisions:
    - Per-book amounts (vs single amount applied to every book):
      lets the CPA skip the TAX book, which doesn't impair in
      practice (tax basis is depreciation-based, not fair-value).
    - Use existing accumDepreciationAccountCode (vs a separate
      "Accumulated Impairment" account): GAAP-acceptable simplification;
      firms with material impairment can wire a dedicated account
      via the account-edit UI later.
    - Asset stays IN_SERVICE (vs DISPOSED). Subsequent depreciation
      runs from the lower NBV over remaining useful life. This is
      what GAAP requires — the asset isn't gone, it's just worth less.
    - sourceSuggestionId optional parameter stamps the originating
      AI screening with the JE entry numbers, closing the loop:
      AI screen → CPA flag → CPA measures via this flow → JE posted
      AND the original screening updated to reference the JE.
- **2026-05-27 (latest+)** — OVER_TIME_USAGE recognition in revenue-rec.
  Schedule generator returns [] for this pattern; rows accrete via
  recordUsageAction as consumption is reported. Schema:
  PerformanceObligation.pricePerUnit + unitName,
  RecognitionSchedule.usageQuantity. Decision: don't pre-emit periods
  (subscriptions with usage-based billing have no terminal date for
  consumption, and we don't want to lock in a schedule that might
  never materialize). Each recorded period creates a single PLANNED
  RecognitionSchedule row that goes through the existing
  postRecognitionAction → bridge path — no new posting infrastructure
  needed.

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
- **Test flakiness — fixed 2026-05-29 (commit `c76c965`)**: the
  intermittent ~10-40 cross-file failures during a single
  `vitest run` (with 0 failures on re-run) traced to two test files
  — `cash-flow.test.ts` and `sub-ledgers.test.ts` — running global
  `prisma.journalEntry.deleteMany()` etc. in their `clearAll()`
  helpers. With sibling tests' AR/AP open items in the shared Neon
  DB, the unscoped JE delete blocked on
  `ar_open_item_openedByEntryId_fkey (RESTRICT)`. Both files now
  scope their clears by the test's entity ID. Three back-to-back
  full-suite runs land 647/647 green on the first try after this
  fix. Other test files (consolidation, invariants,
  property-fuzz-substrate, qbo-mapping, etc.) were already scoped
  and were innocent bystanders to the cleanup race.
