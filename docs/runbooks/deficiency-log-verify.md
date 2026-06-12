# Runbook — Deficiency log verification

**Owner:** Founder · **Cadence:** Nightly (CI) + on every push touching
the deficiency log · **CC mapping:** CC4 Monitoring Activities · **Closes:**
deficiency #27 (Task-completion attestations diverge from `main`)

## Why this exists

On 2026-06-05 evening a verification sweep caught 3 distinct cases where
a task had been marked completed but the work had never actually landed
on `main` in the relevant repo:

| Task | Claim | Reality |
|---|---|---|
| #63 | "Fix tsc TS18049 errors in recon middleware tests" | recon `main` still had the errors |
| #81 | "Replicate tsc TS18049 fix to integrations / fa-amort / revenue-rec" | None of the 3 repos had the fix on `main` |
| #60 | "SECURITY.md sweep — 5 repos" | File DID ship; deficiency #18 was never flipped Closed in the log |

The pattern is a CC4 (Monitoring Activities) process gap — the
"closed" attestation in the task log diverged from the merged-to-main
reality. This automation closes the loop.

## What it does

`scripts/verify-deficiency-log.ts` parses
`docs/policies/control-deficiency-log.md`, extracts every PR URL cited in
the Remediation cell of Closed/Remediated rows, and calls
`gh pr view <n> --repo <owner>/<repo> --json state,mergedAt` for each.
A row "passes" if every cited PR returns `state=MERGED` and
`mergedAt != null`.

The GitHub Actions workflow
`.github/workflows/deficiency-log-verify.yml` runs the script nightly
at 04:00 UTC and on every push that touches the deficiency log or the
script itself.

## Failure modes the script catches

1. **Falsely-claimed closure** — row says Closed, cited PR is still
   OPEN/DRAFT. (Today: deficiency #13's 4 cited PRs would all fail
   the check until they merge.)
2. **Citation without URL** — row says Closed but cites "PR #46"
   without a full URL. Reported as `[skip]`; passes by default but
   fails with `--strict`.
3. **Cross-repo permission gaps** — script reports `ERROR` if `gh`
   can't reach the cited repo. Workflow continues; auditor can
   inspect the evidence artifact.

## Failure modes it does NOT catch

- A merged PR that didn't actually close the deficiency in code.
  (That's a code-review responsibility.)
- A deficiency that should exist but isn't in the log at all.
  (Adversarial-pass audits are the discovery channel for those.)
- Commit-cited closures ("commit fe4bb6a"). Commit citations are
  a separate evidence channel — `git show` is the verifier.

## Running locally

```bash
# Verbose human-readable output:
pnpm tsx scripts/verify-deficiency-log.ts

# Machine-readable JSON (used in CI for the evidence artifact):
pnpm tsx scripts/verify-deficiency-log.ts --json

# Treat skipped rows (no PR URLs) as failures:
pnpm tsx scripts/verify-deficiency-log.ts --strict
```

Exit codes: 0 = all cited PRs merged · 1 = at least one not merged
(or `--strict` with skipped rows) · 2 = script error.

## Evidence artifact

The workflow uploads a JSON file
`docs/operational-evidence/deficiency-log-verify/YYYY-MM-DD.json`
on every run, with 90-day retention. Auditors can:

1. Sample any night's run + verify the per-row pass/fail matches
   the deficiency log's stated state.
2. Trace divergences (Closed rows whose PR became un-merged via
   force-push, etc.) to the date they occurred.
3. Confirm the CC4 monitoring loop is exercising regularly.

## When this closes deficiency #27

The current deficiency-log entry for #27 says:

> Today's mitigation is the row's existence + a process change
> (every task closure cites a merged PR URL); future automation
> (nightly cross-check of task log vs. merged-to-main reality)
> flips it to Closed.

**This script + workflow IS the future automation.** Once the
workflow has run green for two consecutive nights against the
v2.3 log (after the cited PRs merge), #27 can flip from Open →
Remediated, with the script + workflow as the cited remediation.

When it flips to Remediated, the row's evidence cell should cite:
- `scripts/verify-deficiency-log.ts`
- `.github/workflows/deficiency-log-verify.yml`
- The first 7 days of evidence artifacts in
  `docs/operational-evidence/deficiency-log-verify/`

To flip to **Closed**: same evidence + a 90-day green-run streak.

## Bootstrap caveat (read once)

The script enforces the URL-only spec. Today most v2.3 rows cite
PRs by number ("PR #46") instead of full URLs. **Every Closed row
should be back-filled with full URLs in a follow-up doc PR** before
the workflow is useful as a hard gate. Until then, the workflow
runs informational only — failures are visible but don't block
anything.

Tracked as follow-up after this PR lands.

## SOC 2 evidence summary

| Question | Where to look |
|---|---|
| What does the deficiency log say is Closed? | `docs/policies/control-deficiency-log.md` |
| What backs the Closed claim? | Cited PR URLs in the Remediation cell |
| What proves the PRs actually merged? | Last night's workflow run + 90 days of evidence artifacts |
| What catches a divergence? | The same workflow (fails loudly) |
| What closes deficiency #27 itself? | This automation existing + running green |
