# DR drills

**Owner:** Founder
**Last reviewed:** 2026-06-03

This directory holds the **evidence trail** for every disaster
recovery drill the portfolio performs. Each file is an auditable
record the SOC 2 assessor reads to verify the DR procedure documented
in `docs/policies/business-continuity.md` actually operates.

If this directory is empty, that means no drills have been run yet.
**That is the current state** (risk-register #19 — the single Open
row). The trigger to start populating: first paying customer signs
→ Neon Launch upgrade → quarterly restore drill begins.

## File naming

Two file kinds:

### Quarterly restore drills

```
YYYY-QN-restore.md
```

Example: `2026-Q3-restore.md`

Created after each quarterly drill per the BC policy's "DR test
cadence" table.

### Tabletop exercises (scenario walkthroughs)

```
YYYY-QN-tabletop-<scenario>.md
```

Example: `2026-Q3-tabletop-vercel-outage.md`

The tabletop is a paper walkthrough of one of the 7 scenarios in
`business-continuity.md` "Restore procedures (per scenario)" without
actually simulating the disaster.

### Real DR events (when they happen)

```
YYYY-MM-DD-dr-<event>.md
```

Example: `2026-09-14-dr-neon-outage.md`

A real outage from an upstream vendor that triggered our DR procedure.
Distinguished from per-incident files in `docs/incidents/` because
DR events span longer windows and may involve multiple incident files
as sub-events.

## Restore-drill file format

```markdown
# YYYY-QN — Backup restore drill

**Date:** YYYY-MM-DD
**Performed by:** [name]
**Backup source:** [Neon PITR timestamp / pg_dump snapshot path]
**Target environment:** [Neon branch name]
**Expected duration:** [from BC policy RTO table]
**Actual duration:** HH:MM
**Audit-log row:** [audit_log row id of CONFIG_CHANGE/dr_drill.completed]

## Steps performed

1. Pulled backup from [source] at [timestamp]
2. Restored to Neon branch [name]
3. Swapped DATABASE_URL in a staging Vercel project
4. Ran smoke test suite ([list])
5. Verified `/api/health` returns 200 with expected schema fingerprint

## Smoke test results

| Test | Pass/Fail | Notes |
|---|---|---|
| Login flow | | |
| Post JE (ledger-core) | | |
| Read report (any 1) | | |
| Audit log row created | | |
| Encryption read path (one encrypted column) | | |

## What worked

Controls + procedures that fired correctly.

## What didn't

Steps that took longer than expected. Controls that didn't catch
expected issues. Documentation that was missing or wrong.

## Action items

| Owner | Description | Due date | Status |
|---|---|---|---|

## Updated BC policy

Any change to `docs/policies/business-continuity.md` triggered by
what this drill surfaced. Cross-reference the section + line.

## Updated risk register

Any score or status changes to `docs/policies/risk-register.md`
based on the drill.
```

## Tabletop file format

```markdown
# YYYY-QN — Tabletop: [scenario name]

**Date:** YYYY-MM-DD
**Facilitator:** [name]
**Participants:** [list]
**Scenario:** [one of the 7 from BC policy "Restore procedures (per scenario)" — name + section reference]

## Walkthrough

The paper procedure walked step-by-step. For each step, note who
was responsible, what tool/file they touched, and any uncertainty.

## Gaps surfaced

What was unclear or missing in the documented procedure.

## Action items

| Owner | Description | Due date | Status |
|---|---|---|---|
```

## What an auditor asks for, and where the answer lives

| Auditor question | Where the answer lives |
|---|---|
| "Show me proof you've tested your restore" | `YYYY-QN-restore.md` per quarter |
| "Show me your DR drill history" | This directory |
| "When did the most recent drill happen, and what did you find?" | The most recent `YYYY-QN-restore.md` file's "What worked" + "What didn't" sections |
| "Show me your tabletop history" | `YYYY-QN-tabletop-<scenario>.md` files |
| "Show me the audit-log row for the most recent drill" | The drill file's `Audit-log row` header field |
