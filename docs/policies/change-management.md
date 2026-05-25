# Change management policy

**Version:** 1.0 · **Effective date:** {{DATE}} · **Owner:** {{NAME}}

## Purpose

Production code changes are reviewed, tested, and approved before they ship. This covers SOC 2 CC8.

## What counts as a "change"

- Code changes (any file in any repo)
- Configuration changes (env vars in Vercel, schema migrations)
- Deploy-script changes (`bin/deploy.sh`)
- Vendor changes (adding/removing a dependency, switching providers)
- Policy changes (this file and others in `docs/policies/`)

## Required gates

| Gate | Tool | Bypass allowed? |
|---|---|---|
| 1. PR opened against `main` | GitHub | No |
| 2. CI passes (`test`, `gitleaks`, `npm-audit`, `codeql`) | `.github/workflows/*.yml` | No (status checks required) |
| 3. Code Owner approval | `.github/CODEOWNERS` | See solo-dev exception below |
| 4. Linear history | GitHub branch protection | No |
| 5. Signed commits | GitHub branch protection | No |

See `.github/BRANCH_PROTECTION.md` for the exact GitHub settings.

## Solo-dev exception

While {{NAME}} is the only developer, the "Code Owner approval" gate creates a self-approval situation. Compensating controls:

1. **Every PR gets reviewed by Claude (or equivalent AI) before merge.** The reviewer is captured in the PR comment thread and visible in git history.
2. **No direct pushes to `main`.** Every change goes through a PR even when self-authored. This creates the audit trail SOC 2 expects.
3. **Bypass log.** If branch protection MUST be bypassed (e.g., emergency rollback), the bypass is documented in `docs/policies/bypass-log.md` with date, reason, and remediation plan.

When a second developer joins, the exception goes away and the "1 approval required" rule takes over.

## Deploy procedure

1. PR merged to `main` (triggers Vercel preview build).
2. Vercel preview deployment validated visually (smoke check on key flows).
3. Promote to production via `vercel --prod` or push another commit to `main` (Vercel auto-deploys main).
4. Production smoke test: hit `/api/health` (Phase 3 follow-up) and `/reports/month-end` on each repo.
5. If smoke test fails: rollback via Vercel's redeploy of the previous deployment. Document the rollback in `bypass-log.md`.

## Schema migrations

Substrate schema lives in `ledger-core/prisma/schema.prisma`. Other repos have schema mirrors and MUST NOT run `prisma db push` against the shared DB (would drop other repos' tables).

Schema-change procedure:
1. Edit `ledger-core/prisma/schema.prisma`
2. Run `prisma db execute --file <ddl.sql>` locally with raw SQL — never `prisma db push` in production
3. Mirror the changes in companion repos' schemas (read-only)
4. Update the affected tests
5. Document the migration in the commit message

## Emergency changes

If a critical security issue requires a fix BEFORE the normal PR cycle can complete:
1. {{NAME}} authorizes the emergency change verbally (or in writing, with timestamp)
2. The change is made directly on `main` (bypass branch protection if needed; logs in `bypass-log.md`)
3. A retroactive PR is opened within 24 hours documenting what changed and why
4. The retroactive PR is reviewed via the normal cycle even though the change is already live

## Annual review

Reviewed annually on {{REVIEW_DATE}}.
