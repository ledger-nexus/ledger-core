# Change management policy

**Version:** 2.0 · **Effective date:** 2026-06-03 · **Owner:** Founder (sole maintainer)
**Last reviewed:** 2026-06-03
**Prior version:** 1.0 (pre-CI-hardening, pre-CODEOWNERS, pre-`/soc2-check`)

This is the SOC 2 CC8 (Change Management) artifact. Every gate cited
below is **either enforced in code or documented as a compensating
control** with the specific file path. If the auditor asks "show me
where this is enforced", every gate has an answer.

## Purpose

Production code changes are reviewed, tested, and approved before
they ship. CC8 covers (a) authorization of changes, (b) controls over
the development → production path, (c) emergency change handling.

## What counts as a "change"

| Category | Examples | Gate path |
|---|---|---|
| Code | Any file in any of the 5 repos | Standard PR cycle |
| Schema | `prisma/schema.prisma` + raw SQL via `prisma db execute` | Standard PR cycle + CODEOWNERS auto-request on `prisma/` |
| Encrypted-column registry | `src/lib/db/encrypted-fields-extension.ts` | Standard PR cycle + post-deploy `verify-encryption-rollout.sh` |
| Retention policy | `src/lib/retention/policies.ts` | Standard PR cycle + audit-log row of next run confirms wiring |
| Cron schedule | `vercel.json` `crons[]` array | Standard PR cycle — every new cron MUST add a corresponding audit-log emission |
| Config (env vars in Vercel) | `FIELD_ENCRYPTION_KEY`, `CRON_SECRET`, `INTERNAL_API_TOKEN`, etc. | `docs/policies/access-control.md` rotation procedure; production env diff visible only to founder |
| Deploy script | `bin/deploy.sh`, `package.json` `scripts.*` | Standard PR cycle |
| Dependency | `package.json`, `package-lock.json` | Standard PR cycle + Dependabot batches in CI |
| Vendor | New SaaS provider, switched provider | Update `docs/policies/vendor-management.md` in same PR |
| Policy | Any file in `docs/policies/` | Standard PR cycle; **version-bump required** if the change is substantive (this doc is at v2.0) |
| Audit-log schema | `AuditEventType` enum, `audit_log` columns | Standard PR cycle + bypass-log entry if the append-only RULE has to be dropped during migration |

## Required gates

| Gate | Tool / file | Bypass allowed? |
|---|---|---|
| 1. PR opened against `main` | GitHub (branch protection) | No |
| 2. CI passes | `.github/workflows/*.yml` — `test`, `typecheck`, `eslint`, `gitleaks`, `npm audit`, CodeQL weekly | No (status checks required) |
| 3. Pre-commit hook ran clean | `scripts/pre-commit-secrets-scan.sh` symlinked to `.git/hooks/pre-commit` | No — `--no-verify` is **forbidden** per CC6.7 (see "Bypass log" below) |
| 4. Knip backlog clean | `knip` (configured in `knip.json`); hard-fail in CI | No |
| 5. `/soc2-check` clean on the diff | `.claude/commands/soc2-check.md` slash command | Soft-gate today; documented as a CC8.1 manual step until automation matures |
| 6. Code Owner approval | `.github/CODEOWNERS` | See solo-dev exception below |
| 7. Linear history | GitHub branch protection (require linear history) | No |
| 8. Signed commits | GitHub branch protection (require signed commits) | No |

See `.github/BRANCH_PROTECTION.md` for the exact GitHub settings, and
`docs/SOC2_CONTROL_MATRIX.md` CC8 row for the auditor-facing summary.

## Solo-dev exception (compensating controls)

While the founder is the only developer, the "Code Owner approval"
gate creates a self-approval situation. Compensating controls
documented for the auditor:

1. **Every PR gets reviewed by Claude before merge.** The review
   thread is preserved in the PR comments; the reviewer's
   identification, the diff seen, and the issues flagged are
   visible in git history. This is the substantive CC8.1 review,
   not a rubber stamp.
2. **No direct pushes to `main`.** Every change — even a one-line
   typo fix — goes through a PR. This creates the audit trail SOC 2
   expects, and the PR itself becomes the auditor's evidence packet.
3. **Stacked PRs are encouraged.** When a sequence of changes is
   logically separable, each layer gets its own PR (visible in the
   "Stacked on" line in the PR body). A 6-stack like the current SOC 2
   sprint produces 6 independently-reviewable change packages instead
   of one 6-times-bigger one. See PR #10 → PR #15 for the canonical
   example.
4. **Bypass log.** If branch protection MUST be bypassed (e.g.,
   emergency rollback), the bypass is documented in
   `docs/policies/bypass-log.md` (date, reason, remediation plan,
   audit-log row id). Auditor can grep this file for the
   self-disclosed bypass history.

When a second developer joins, the exception goes away and the
"1 approval required" rule takes over.

## Deploy procedure

1. PR merged to `main` triggers Vercel preview build.
2. Vercel preview deployment is validated visually (smoke check on
   key flows: `/`, `/journal-entries`, `/reports/month-end`,
   `/api/health`).
3. Production deploy: push another commit to `main` or run
   `vercel --prod` (Vercel auto-deploys `main`).
4. Production smoke test:
   - `GET /api/health` returns `200` with `database: { ok: true }`
     and the expected schema fingerprint.
   - One key flow per repo (e.g., a JE post in ledger-core; a recon
     match in recon; a depreciation post in fa-amort).
5. If smoke test fails: rollback via Vercel's redeploy of the
   previous deployment. Document the rollback in `bypass-log.md`.

## Schema migrations

Substrate schema lives in `ledger-core/prisma/schema.prisma`. Other
repos have schema mirrors (read-replicas for FK convenience) and MUST
NOT run `prisma db push` against the shared DB — it would drop other
repos' tables.

**Schema-change procedure:**

1. Edit `ledger-core/prisma/schema.prisma`.
2. Author the raw SQL DDL with `IF NOT EXISTS` clauses (so re-runs
   are idempotent during the rollout window).
3. Run `prisma db execute --file <ddl.sql>` against a Neon branch
   first; verify the migration applies cleanly + the app boots.
4. PR the schema change + the DDL file + any backfill scripts in one
   commit. CODEOWNERS auto-requests review on `prisma/` paths.
5. After merge: apply to production via `prisma db execute`. Capture
   the audit-log row id of the corresponding `CONFIG_CHANGE/schema.migration`
   event.
6. Mirror the schema change in companion repos within 24 hours
   (auto-issue via CI if drift detected).
7. Update the affected tests.

**Field-encryption rollout** is a special schema change with its own
runbook: `docs/runbooks/encryption-rollout.md`. Backfill scripts go
under `scripts/`; the post-deploy verifier is
`scripts/verify-encryption-rollout.sh`.

## Cross-repo changes (portfolio-wide)

When a change touches multiple repos in the portfolio (e.g., adding
an encrypted column that requires mirror updates):

1. Land the **canonical change in ledger-core** first.
2. Open follow-on PRs in each affected companion repo within 24 hours,
   referencing the ledger-core PR in the body.
3. The audit-log row of the ledger-core change is the cross-repo
   coordination point; companion repo audit emissions reference the
   same `correlationId` so the auditor can pull the full portfolio
   transaction.

## Audit trail per change

Every privileged mutation emits an `audit_log` row via
`auditPrivilegedAction` or `auditedMutation()`. The audit log is
append-only at the DB level (Postgres RULE on the `audit_log`
table — `prisma/sql/audit-log-append-only.sql`). This means:

- **Every change SHIPPED to production has a permanent record.**
- **No one — including the founder — can mutate the audit log** to
  hide a change after the fact.
- **A regulator can query `audit_log` to verify any specific change
  was reviewed + deployed by the expected actor.**

The audit-log table cannot be DROPPED without dropping the append-only
RULE first; the RULE drop itself is a SCHEMA_CHANGE event captured in
Postgres's own DDL log.

## Emergency changes

If a critical security issue requires a fix BEFORE the normal PR
cycle can complete:

1. Founder authorizes the emergency change in writing (Slack to self,
   or a `bypass-log.md` entry with timestamp).
2. The change is made directly on `main` (bypass branch protection;
   GitHub records the bypass).
3. A retroactive PR is opened **within 24 hours** documenting what
   changed and why; the PR body links to the bypass-log entry.
4. The retroactive PR is reviewed via the normal cycle even though
   the change is already live. CI must still pass on the retroactive PR.
5. Audit-log row of the emergency change includes
   `outcome: "BYPASSED"` so the row is filterable by the auditor.

The bypass log lives at `docs/policies/bypass-log.md`. Every
emergency change MUST land a row.

## What an auditor asks for, and where the answer lives

| Auditor question | Where the answer lives |
|---|---|
| "Show me your change management policy" | This file |
| "Show me an example PR that was reviewed and shipped" | Any GitHub PR — the review thread + CI checks + audit-log row id |
| "Show me where the PR-required gate is enforced" | GitHub branch protection settings; `.github/BRANCH_PROTECTION.md` |
| "Show me where unauthorized changes are detected" | `audit_log` table with append-only RULE — any production change that didn't go through a PR is detectable |
| "Show me your emergency change procedure and history" | This file → "Emergency changes"; `docs/policies/bypass-log.md` for history |
| "Show me your schema-change procedure" | This file → "Schema migrations"; example DDL files in `prisma/sql/` |
| "Show me the audit trail of a specific change" | `audit_log` rows with `eventType=CONFIG_CHANGE` and `metadata.commitSha` or `metadata.prUrl` |

## Annual review

Reviewed annually. Trigger an out-of-cycle review when:

- A second developer joins (the solo-dev exception goes away)
- A new gate is added to CI (new tool, new check)
- The audit-log schema changes (new `AuditEventType`, new column)
- The append-only RULE has to be dropped for any reason (the bypass
  log entry triggers this review)
- An incident postmortem identifies a gate that should have caught
  the regression

The review itself goes in the audit log as
`CONFIG_CHANGE/change_management.review` by the founder.
