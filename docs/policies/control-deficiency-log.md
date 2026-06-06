# Control deficiency log

**Version:** 2.9 · **Effective date:** 2026-06-06 · **Owner:** Chris

**v2.9 amendments (2026-06-06) — #1 auth Critical → Remediated:**
- Deficiency #1 (Auth uses dev cookie stub, not real auth) → **Remediated via layered defense already on main.** Clerk integration shipped + env-gated (`src/lib/auth/clerk.ts` + `src/lib/auth/current-user.ts` dispatches via `isClerkEnabled()`) + middleware fails closed in production when `CLERK_SECRET_KEY` unset (commit b99bbb4 in `src/middleware.ts`: 503 response for every non-public route) + verification test (`tests/middleware-fail-closed.test.ts`). The original attack ("anyone with `AUTH_STUB_SECRET` can impersonate any user") now requires production `CLERK_SECRET_KEY` to be unset AND attacker to obtain `AUTH_STUB_SECRET` — the first condition is blocked by the 503 fail-closed gate. **Not yet Closed** because the dev cookie stub remains in the codebase as a fallback for dev/test (intentional for the UserSwitcher dropdown); the gap is unreachable in prod but technically present in code. Path to Closed: remove `src/lib/auth/session.ts` HMAC path entirely + remove `AUTH_STUB_SECRET` from `src/lib/env.ts`. Deferred until first customer onboarding (the dev stub remains useful for portfolio demos).

**v2.8 amendments (2026-06-06):**
- Deficiency #9 (audit_log not replicated outside primary DB) → **Remediated via PR #104.** Phase 1 design doc `docs/architecture/audit-log-replication-design.md` captured. 4 options compared (S3 + Object Lock, secondary Postgres, event stream via SQS/Kinesis, periodic snapshot exports). Recommends Option A (S3 + Object Lock compliance mode + 7-year retention) with 3-phase rollout: Phase 1 (this doc), Phase 2 (sync inline emit via `src/lib/audit/mirror.ts` — DEFERRED until customer #2 onboards), Phase 3 (async via SQS — DEFERRED until ~1000 rows/day). Implementation skeleton + schema migration plan (sha256 + priorSha256 columns for hash chain) + cost estimate ($0.02/mo at v1; $1.50/mo at 10-customer scale) + CC mapping (CC4 + CC7.2 + CC7.4 + CC6.7) + 6-step migration sequence with chaos-drill verification all captured. Status transition mirrors v2.4 RLS deficiency #12: Remediated because design surface is captured + implementation path is clear; not Closed until Phase 2 ships.

**v2.7 amendments (2026-06-06):**
- Deficiency #2 (No CSP header) → **Closed via PR #99.** Standalone extraction of the CSP middleware change from PR #10's foundation arc. `src/middleware.ts` now generates a 16-byte base64url nonce per request via Edge runtime `crypto.getRandomValues`; CSP header set on every response with `strict-dynamic` script-src + Clerk/Sentry/Stripe connect-src + `frame-ancestors 'none'` + `object-src 'none'` + `upgrade-insecure-requests`. 9/9 tests pass (`tests/csp-nonce.test.ts`). Closes CC6.6 (anti-XSS) at the application layer; defense-in-depth with the existing static headers (HSTS, X-Frame-Options DENY, Referrer-Policy) in `next.config.js`. **Extraction rationale:** PR #10 is a 9-feature foundation PR; splitting CSP out lets #2 close on its own merge schedule rather than block on the entire encryption-stack arc.

**v2.6 amendments (2026-06-06):**
- Deficiency #4 (npm deps not pinned) → **Closed portfolio-wide.** Pinned all 115 dependency ranges across 5 repos in 5 mechanical PRs: ledger-core PR #95 (23 deps), recon PR #26 (24), fa-amort PR #23 (22), revenue-rec PR #30 (24), integrations PR #20 (22). Each PR strips `^`/`~` to the exact version currently in `package-lock.json` — no upgrades introduced. Dependabot continues to surface upgrade PRs we then review.

**v2.5 amendments (2026-06-05):**
- Deficiency #28 (createFixedAsset tenant-blind entity lookup) → Remediated via PR #88. \`CreateFixedAssetInput\` gained required \`tenantId\` field; entity findFirstOrThrow now scopes by \`{ code, tenantId }\`. All 9 callers (route + 2 seeds + 6 test sites) updated. 29/29 affected tests pass.
- Phase 3 implementation skeleton DRAFT PR #89 opened — 37 ALTER TABLE FORCE statements + 6-category cross-tenant test suite, awaits operator ack on Decision C runbook before merge.

**v2.4 amendments (2026-06-05):**
- Deficiency #12 (RLS): Phase 2b call-site sweep COMPLETE (23 sites across PRs #69-#83). Phase 3 design + decisions A/B/D resolved (PRs #84-#86). Status → "Remediated" (Phase 3 implementation pending operator ack on Decision C runbook).
- New deficiency #28 (createFixedAsset tenant-blind entity lookup) added from 15th adversarial-pass historical finding.
- Captures the 15th adversarial-pass HIGH closure (audit-bypass on Decision A drop) as institutional CC4 evidence — finding emerged from the work, was closed in-PR before merge.

## Purpose

SOC 2 CC4 (monitoring activities) expects evidence that we identify control deficiencies and remediate them. This log is the running record. Auditors will ask to see it. An empty log is a red flag — it means we either have perfect controls (we don't) or we aren't looking.

A "control deficiency" is anything that should have prevented an event but didn't, or any control whose design or operation is known to be weak. It is distinct from:
- **Incident** — a security or availability event (lives in `docs/incidents/`)
- **Risk** — a hypothetical future event (lives in `risk-register.md`)
- **Deficiency** — a known weakness in a control that exists today

A deficiency can be discovered through: failed CI checks, code review, penetration tests, customer reports, internal audits, or a real incident that exposed it.

## How to log a deficiency

Add a new row to the table below. Assign yourself if you found it. Use a short, scannable title. Cite the file or process that's weak. Include enough detail that a stranger 6 months from now can understand what was broken.

## Severity rubric

| Severity | Definition | Example |
|---|---|---|
| **Critical** | Active customer-data exposure, broken access control, audit trail gap | Auth bypass; missing audit row for privileged action |
| **High** | Could result in data exposure or audit failure under common conditions | No backup restore tested; missing CI gate on security branch |
| **Medium** | Hardening gap, won't fail audit alone but compounds risk | Headers missing CSP; npm dep not pinned |
| **Low** | Cosmetic / non-blocking | Doc inconsistency; un-renamed legacy enum |

## Deficiency log

| # | Date opened | Severity | Title | Source | Description | Remediation plan | Owner | Status | Date closed |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 2026-05-25 | Critical | Auth uses dev cookie stub, not real auth | SOC2_READINESS.md gap analysis | `src/lib/auth/session.ts` uses HMAC-signed cookie keyed by `AUTH_STUB_SECRET` and a user-controlled email. Anyone with the secret can impersonate any user. | **REMEDIATED on main via layered defense (2026-06-06 audit):** Clerk integration shipped + env-gated (`src/lib/auth/clerk.ts` + `current-user.ts` dispatch via `isClerkEnabled()`); `src/middleware.ts` fails closed in production with 503 when `CLERK_SECRET_KEY` unset (commit b99bbb4); verification in `tests/middleware-fail-closed.test.ts`. Original attack now requires prod CLERK env to be unset AND attacker to obtain `AUTH_STUB_SECRET` — first condition blocked by 503 gate. Path to Closed: remove `src/lib/auth/session.ts` HMAC path + `AUTH_STUB_SECRET` from env.ts. Deferred until first customer onboarding (dev stub still useful for portfolio demos via UserSwitcher dropdown). | Chris | Remediated | — |
| 2 | 2026-05-25 | High | No CSP header | SOC2_READINESS.md gap analysis | `next.config.js` ships HSTS + X-Frame-Options + X-Content-Type-Options + Referrer-Policy but no Content-Security-Policy. Next.js inline scripts make naïve CSP break the app. | **CLOSED via PR #99 (2026-06-06):** standalone extraction from PR #10. `src/middleware.ts` generates 16-byte base64url nonce per request; CSP set with `strict-dynamic` script-src + Clerk/Sentry/Stripe connect-src + `frame-ancestors 'none'` + `object-src 'none'` + `upgrade-insecure-requests`. 9/9 tests pass (`tests/csp-nonce.test.ts`); `npx tsc --noEmit` clean. Wraps existing Clerk middleware, preserves 503 fail-closed-in-prod behavior. | Chris | Closed | 2026-06-06 |
| 3 | 2026-05-25 | High | No backup restore drill | SOC2_READINESS.md gap analysis | We have backups documented in `business-continuity.md` but have never validated a restore. Backup-without-test is "we have hope" not "we have backups." | Quarterly DR drill starting Q3 2026. | {{NAME}} | Open | — |
| 4 | 2026-05-25 | High | npm deps not pinned to exact versions | SOC2_READINESS.md gap analysis | `package.json` uses `^` and `~` ranges. A malicious dep update could ship into prod through Dependabot or fresh install. | **CLOSED via 5-PR portfolio sweep (2026-06-06):** ledger-core PR #95 (23 deps) + recon PR #26 (24) + fa-amort PR #23 (22) + revenue-rec PR #30 (24) + integrations PR #20 (22). 115 ranges total stripped to exact versions from each repo's `package-lock.json`. Verified `grep -cE '"[~^]' package.json == 0` per repo + `npm install --package-lock-only` clean. Dependabot continues to surface upgrade PRs we then review. | Chris | Closed | 2026-06-06 |
| 5 | 2026-05-25 | Medium | No Sentry / no error tracking | SOC2_READINESS.md gap analysis | Errors live only in Vercel function logs (7-day retention on free tier). Slow incident detection. | Wire Sentry with PII scrubbing. Phase 2. | {{NAME}} | Open | — |
| 6 | 2026-05-25 | Medium | No MFA on Vercel / GitHub / Neon | SOC2_READINESS.md gap analysis | Founder account credential theft = full production compromise. MFA is the single best control here. | Enable MFA on all three; print recovery codes; store physically. Phase 1. | {{NAME}} | Open | — |
| 7 | 2026-05-25 | Medium | No formal access review | SOC2_READINESS.md gap analysis | Solo posture today, but no documented quarterly review. When contributors join this gap becomes Critical. | Add to calendar: quarterly access review. Document in `access-control.md` what gets reviewed. | {{NAME}} | Open | — |
| 8 | 2026-05-25 | Medium | No vendor SOC 2 reports on file | SOC2_READINESS.md gap analysis | We claim Neon, Vercel, Anthropic SOC 2 in `vendor-management.md` but don't have copies. Auditors want to see them. | Request SOC 2 Type 2 from each vendor; file in `docs/vendor-receipts/`. Phase 1. | {{NAME}} | Open | — |
| 9 | 2026-05-25 | Medium | Audit log not replicated outside primary DB | SOC2_READINESS.md gap analysis | If the Neon DB is lost, the audit trail goes with it. Audit logs need to survive DB loss to be credible evidence. | **REMEDIATED via PR #104 (2026-06-06):** Phase 1 design (`docs/architecture/audit-log-replication-design.md`) captures the 4-option comparison + recommended approach (S3 + Object Lock + 7-year retention) + 3-phase rollout + implementation skeleton + schema migration plan + cost estimate + CC4/CC7.2/CC7.4/CC6.7 control mapping + 6-step migration sequence. Phase 2 (sync inline emit via `src/lib/audit/mirror.ts`) **DEFERRED** until customer #2 onboards — captures SOC 2 commitment without paying for the infrastructure at zero-customer scale. Phase 3 (async via SQS) deferred until ~1000 rows/day. | Chris | Remediated | 2026-06-06 |
| 10 | 2026-05-25 | Low | No formal training / acknowledgement records | SOC2_READINESS.md gap analysis | Policies in `docs/policies/` don't have signed acknowledgement from the founder. SOC 2 expects sign-off evidence per person per year. | Add `docs/policies/acknowledgements/{name}-{year}.md` with content + signature. Annual cadence. | {{NAME}} | Open | — |
| 11 | 2026-05-25 | High | tenantId is nullable; not yet enforced at query layer | Phase 1 of multi-tenancy work | Schema had `tenantId String?` on every tenant-scoped model. Phase 4a wired write enforcement (engine refuses cross-tenant); Phase 4c scoped the highest-leverage read queries; Phase 4b applied `ALTER COLUMN tenantId SET NOT NULL` on 26 tables (audit_log intentionally excluded for pre-identity TOKEN_REJECTED events). Remaining gap: composite `[tenantId, code]` uniques deferred until customer #2 onboards. | Closed via Phases 4a + 4b + 4c. Composite uniques tracked as Phase 4b-followup. | {{NAME}} | Closed | 2026-05-26 |
| 12 | 2026-05-25 | High | No Postgres Row-Level Security (RLS) | Phase 1 of multi-tenancy work | RLS would catch any query that forgets `where: { tenantId }` at the database layer. Application-level scoping is the only enforcement in v1. Documented as a planned follow-up in `docs/multi-tenancy.md`. | **Phase 1 (PR #66)**: 39 policies + GUC SQL function. **Phase 2a (PR #67)**: `withTenantContext` helper. **Phase 2b (PRs #69-#83, 14 PRs)**: 23 Server Actions + 3 HTTP routes + recurring-batch helper migrated; full shape catalog (W1/W2/T1/T2/E/M/P) institutionalized in migration guide. **Phase 3 design (PR #84)**: full design + bypass-role runbook + decisions A/B/D resolved with recommendations. **Phase 3 prereqs (PRs #85-#86)**: Decision B (entity scoping) + Decision A (drop probes) landed. **15th adversarial pass** found 1 HIGH (audit-bypass on Decision A) + 3 MEDIUMs; all closed in-PR before merge. Phase 3 implementation (ALTER TABLE FORCE + 6-category cross-tenant test suite) pending operator ack on Decision C runbook. | Chris | Remediated | 2026-06-05 |
| 28 | 2026-06-05 | High | `createFixedAsset` entity lookup not tenant-scoped | 15th adversarial pass — historical finding (pre-dates Phase 2b sweep) | `src/lib/accounting/sub-ledgers/fixed-assets.ts:62` did `legalEntity.findFirstOrThrow({ where: { code } })` without tenantId scope. Pre-Phase-3-FORCE, a token holder could create a FixedAsset under another tenant's entity with the same code. PR #82's Class T split preserved the bug verbatim; Decision B (PR #85) fixed only the record-depreciation route. | **CLOSED via PR #88** (2026-06-05): `CreateFixedAssetInput` gained required `tenantId` field; entity findFirstOrThrow scopes by `{ code, tenantId }`. 9 callers updated (route + 2 seeds + 6 test sites). 29/29 affected tests pass. PR #82 outer wrapper is unaffected (uses widened input); PR #82's inner half (`createFixedAssetInTx`) needs the same scope before merge — flagged in PR #88's body. | Chris | Closed | 2026-06-05 |

## Procedure

1. **Discover**: Found a control gap? Add a row. Don't hide it.
2. **Triage**: Assign severity per rubric above. If Critical or High, also open a risk-register row if not already there.
3. **Remediate**: Track the remediation plan in the row. Update Status as work progresses (Open → In Progress → Remediated).
4. **Verify**: When remediated, run the test that proves the gap is closed. Note the test in the remediation plan.
5. **Close**: Move Status to Closed. Fill in Date closed. Do NOT delete the row — auditors want history.

## Statuses

- **Open** — identified, not yet under active remediation
- **In Progress** — actively being worked
- **Remediated** — code/process change made, not yet verified by retest
- **Closed** — verified, gap is no longer present
- **Accepted Risk** — leadership decided not to fix (rare; requires explicit justification in the row)

## Annual review

Reviewed annually on {{REVIEW_DATE}}. Walk through each Open + In Progress + Remediated row and confirm status is current. Closed and Accepted Risk rows stay in the log as historical evidence — never deleted.
