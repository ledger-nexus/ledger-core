# Control deficiency log

**Version:** 1.0 · **Effective date:** {{DATE}} · **Owner:** {{NAME}}

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
| 1 | 2026-05-25 | Critical | Auth uses dev cookie stub, not real auth | SOC2_READINESS.md gap analysis | `src/lib/auth/session.ts` uses HMAC-signed cookie keyed by `AUTH_STUB_SECRET` and a user-controlled email. Anyone with the secret can impersonate any user. | Swap to Clerk per `auth-swap.md`. Tracked Phase 1 of SOC2_ROADMAP. | {{NAME}} | Open | — |
| 2 | 2026-05-25 | High | No CSP header | SOC2_READINESS.md gap analysis | `next.config.js` ships HSTS + X-Frame-Options + X-Content-Type-Options + Referrer-Policy but no Content-Security-Policy. Next.js inline scripts make naïve CSP break the app. | Implement nonce-based CSP via middleware. Phase 2 of SOC2_ROADMAP. | {{NAME}} | Open | — |
| 3 | 2026-05-25 | High | No backup restore drill | SOC2_READINESS.md gap analysis | We have backups documented in `business-continuity.md` but have never validated a restore. Backup-without-test is "we have hope" not "we have backups." | Quarterly DR drill starting Q3 2026. | {{NAME}} | Open | — |
| 4 | 2026-05-25 | High | npm deps not pinned to exact versions | SOC2_READINESS.md gap analysis | `package.json` uses `^` and `~` ranges. A malicious dep update could ship into prod through Dependabot or fresh install. | Pin to exact versions; rely on Dependabot to surface upgrade PRs we then review. Phase 2. | {{NAME}} | Open | — |
| 5 | 2026-05-25 | Medium | No Sentry / no error tracking | SOC2_READINESS.md gap analysis | Errors live only in Vercel function logs (7-day retention on free tier). Slow incident detection. | Wire Sentry with PII scrubbing. Phase 2. | {{NAME}} | Open | — |
| 6 | 2026-05-25 | Medium | No MFA on Vercel / GitHub / Neon | SOC2_READINESS.md gap analysis | Founder account credential theft = full production compromise. MFA is the single best control here. | Enable MFA on all three; print recovery codes; store physically. Phase 1. | {{NAME}} | Open | — |
| 7 | 2026-05-25 | Medium | No formal access review | SOC2_READINESS.md gap analysis | Solo posture today, but no documented quarterly review. When contributors join this gap becomes Critical. | Add to calendar: quarterly access review. Document in `access-control.md` what gets reviewed. | {{NAME}} | Open | — |
| 8 | 2026-05-25 | Medium | No vendor SOC 2 reports on file | SOC2_READINESS.md gap analysis | We claim Neon, Vercel, Anthropic SOC 2 in `vendor-management.md` but don't have copies. Auditors want to see them. | Request SOC 2 Type 2 from each vendor; file in `docs/vendor-receipts/`. Phase 1. | {{NAME}} | Open | — |
| 9 | 2026-05-25 | Medium | Audit log not replicated outside primary DB | SOC2_READINESS.md gap analysis | If the Neon DB is lost, the audit trail goes with it. Audit logs need to survive DB loss to be credible evidence. | Mirror audit_log to append-only S3 or dedicated DB. Phase 3. | {{NAME}} | Open | — |
| 10 | 2026-05-25 | Low | No formal training / acknowledgement records | SOC2_READINESS.md gap analysis | Policies in `docs/policies/` don't have signed acknowledgement from the founder. SOC 2 expects sign-off evidence per person per year. | Add `docs/policies/acknowledgements/{name}-{year}.md` with content + signature. Annual cadence. | {{NAME}} | Open | — |
| 11 | 2026-05-25 | High | tenantId is nullable; not yet enforced at query layer | Phase 1 of multi-tenancy work | Schema had `tenantId String?` on every tenant-scoped model. Phase 4a wired write enforcement (engine refuses cross-tenant); Phase 4c scoped the highest-leverage read queries; Phase 4b applied `ALTER COLUMN tenantId SET NOT NULL` on 26 tables (audit_log intentionally excluded for pre-identity TOKEN_REJECTED events). Remaining gap: composite `[tenantId, code]` uniques deferred until customer #2 onboards. | Closed via Phases 4a + 4b + 4c. Composite uniques tracked as Phase 4b-followup. | {{NAME}} | Closed | 2026-05-26 |
| 12 | 2026-05-25 | High | No Postgres Row-Level Security (RLS) | Phase 1 of multi-tenancy work | RLS would catch any query that forgets `where: { tenantId }` at the database layer. Application-level scoping is the only enforcement in v1. Documented as a planned follow-up in `docs/multi-tenancy.md`. | Add per-table RLS policies; set `app.current_tenant_id` per Prisma connection. Tracked v2 of multi-tenancy. | {{NAME}} | Open | — |
| 13 | 2026-06-10 | Critical | Migration-only DDL had no reproducible source; production ran without it | 2026-06-10 db:reset incident post-audit | The schema is `db push`-managed; append-only triggers, CHECK constraints, GIN indexes, and the lineage partial unique index existed only in migration SQL — or nowhere (the audit_log trigger and lineage index had no migration at all). The 2026-06-10 reset recovery restored schema + data but none of this DDL, so production ran with no audit-trail no-rewrite enforcement until a live-DB pg_catalog audit caught it. Docs claimed the enforcement existed; the database disagreed. | `prisma/sql/migration-mirror.sql` created as the idempotent single source of truth; applied by `npm run db:restore-ddl`, chained into `db:reset`, applied in CI, re-applied to production and verified via pg_catalog (PR #232). Rule: all future migration-only DDL goes in the mirror file too. | {{NAME}} | Closed | 2026-06-10 |
| 14 | 2026-06-10 | High | audit_log DELETE not blocked at the DB layer | PR #232 CI run (DELETE trigger failed 21 tests) | The audit_log no-rewrite trigger blocks UPDATE only. A DELETE-blocking trigger is the CC7.2 ideal, but the test suite isolates audit assertions by deleting its own audit rows in ~12 files' hooks — and the suite's green history confirms DELETE was never blocked historically either. Compensating controls: FK `audit_log → tenant` is ON DELETE RESTRICT, no runtime code path deletes audit rows, and deficiency #9 (off-DB audit replication) covers survivability. | Rework test audit-row isolation (per-run fixture tenants or assertion-by-marker instead of delete-then-assert), then add the `audit_log_no_delete` trigger to `prisma/sql/migration-mirror.sql` (the file marks the spot). | {{NAME}} | Open | — |

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
