# SOC 2 roadmap — 90-day plan

**Status:** Plan, not commitment. Items marked **(blocked: vendor)** require an external party.
**Companion doc:** `SOC2_READINESS.md` (gap analysis) and `docs/policies/` (policy framework).
**Goal:** End of Week 12 — ready to engage a SOC 2 Type 1 service auditor.

A note on what this is for: SOC 2 Type 2 attestation requires a 6-month observation window where the auditor watches the controls operate. This roadmap covers everything we can do BEFORE that window starts. After Week 12 the work shifts from "build the controls" to "operate them visibly for 6 months." The earliest realistic Type 2 attestation date is Week 12 + 6 months observation + 4-8 weeks audit fieldwork = roughly **9 months from today**.

---

## Phase 1 — Weeks 1-4: lockdown and auth

The most important and most expensive work. Without auth, nothing else matters.

### Week 1 — Real authentication

| Task | Files | Outcome |
|---|---|---|
| Swap dev-cookie stub for Clerk | `src/lib/auth/*`, `src/app/login/*`, all `requireCurrentUser` callers | Real password / SSO login |
| Add MFA enforcement | Clerk config | All accounts must have MFA before first JE post |
| Migrate existing users into Clerk | `prisma/migration` + Clerk dashboard | User.email is the linking key |
| Update audit log to capture Clerk session ID | `src/lib/audit/log.ts` | `metadata.clerkSessionId` on every event |

**Acceptance**: Login flow walks through Clerk hosted UI; MFA prompt appears on first login; `audit_log.eventType=LOGIN_SUCCESS` rows reference Clerk session IDs.

### Week 2 — Vendor receipts + MFA on infrastructure

| Task | Outcome |
|---|---|
| Request SOC 2 Type 2 from Neon | PDF in `docs/vendor-receipts/neon-soc2-{date}.pdf` (encrypted, gitignored) |
| Request SOC 2 Type 2 from Vercel | PDF in `docs/vendor-receipts/` |
| Request SOC 2 Type 2 from Anthropic | PDF in `docs/vendor-receipts/` |
| Enable MFA on GitHub | Founder account + any contributor accounts |
| Enable MFA on Vercel | Same |
| Enable MFA on Neon | Same |
| Print 2FA recovery codes physically | Stored offline in a fireproof location |
| Sign DPAs with each vendor | Filed in `docs/vendor-receipts/dpa-{vendor}-{date}.pdf` |

**Acceptance**: All three vendor SOC 2 reports on file. Founder account cannot log in to any prod service without MFA. Recovery codes exist.

### Week 3 — Backup + restore

| Task | Files | Outcome |
|---|---|---|
| Upgrade Neon to Launch tier | Neon dashboard | 7-day PITR enabled |
| Document restore procedure | `docs/policies/business-continuity.md` (already done) — add the exact commands | Anyone can restore in <1 hour |
| Run first restore drill | New Neon branch + smoke tests | `docs/dr-drills/2026-Q2-restore.md` |
| Add quarterly DR drill to calendar | Calendar reminder | Recurring quarterly |

**Acceptance**: A real restore drill documented with timestamp. Backup is no longer hope.

### Week 4 — npm supply chain + secrets hygiene

| Task | Files | Outcome |
|---|---|---|
| Pin all production deps to exact versions | `package.json` in all 5 repos | No `^` or `~` |
| Move `INTERNAL_API_TOKEN` rotation to a documented cadence | `docs/policies/access-control.md` | Quarterly rotation calendared |
| Add gitleaks pre-commit hook (not just CI) | `.husky/pre-commit` or equivalent | Secrets caught before they're committed |
| Verify CodeQL CI workflows green for all 5 repos | `.github/workflows/security.yml` | Zero high/critical findings |

**Acceptance**: `npm install --frozen-lockfile` produces identical builds. Gitleaks ran against full git history with zero unexplained findings.

---

## Phase 2 — Weeks 5-8: observability and hardening

Now that the front door is locked, harden everything behind it.

### Week 5 — Error monitoring

| Task | Files | Outcome |
|---|---|---|
| Wire Sentry with PII scrubbing | `sentry.config.ts` in all 5 repos | Errors captured; `email`, `displayName`, `memo` scrubbed |
| Configure alert rules | Sentry dashboard | Notify on error rate > 1% sustained 10min |
| Add `/api/health` endpoint to each repo | `src/app/api/health/route.ts` | Vercel health checks have a target |

**Acceptance**: Trigger a known error in staging; Sentry receives it with PII redacted; alert fires.

### Week 6 — CSP + remaining headers

| Task | Files | Outcome |
|---|---|---|
| Implement nonce-based CSP via middleware | `src/middleware.ts` | CSP header sets per-request nonce; inline scripts use it |
| Add Subresource Integrity for any CDN scripts | All `<script>` tags | SRI hashes present |
| Run securityheaders.com against prod | External tool | A or A+ grade |
| Run observatory.mozilla.org against prod | External tool | A or higher |

**Acceptance**: Two external scanner grades are A or better; CSP doesn't break any flow.

### Week 7 — Multi-tenancy preparation (if going multi-tenant)

| Task | Files | Outcome |
|---|---|---|
| Add `tenantId` to every model | `prisma/schema.prisma` | Every row carries a tenant scope |
| Add Postgres RLS policies | Raw SQL migration | Even direct DB access can't read across tenants |
| Update every query to filter by tenant | All `prisma.*` calls | No query is tenant-agnostic |
| Add per-tenant test suite | `tests/multi-tenant.test.ts` | Test inserts data for two tenants, verifies isolation |

**Acceptance**: A query attempted as tenant A cannot return tenant B's rows even with a malicious WHERE clause.

> **Skip if**: still pre-multi-tenant. Document the decision and revisit Phase 3.

### Week 8 — Audit log durability

| Task | Files | Outcome |
|---|---|---|
| Mirror audit_log to external append-only store | New worker + S3 or dedicated audit DB | Audit history survives primary DB loss |
| Quarterly audit log review process | `docs/policies/access-control.md` | Documented review cadence |
| Run first audit log review | Manual | Sign-off in `docs/access-reviews/2026-Q2.md` |

**Acceptance**: Audit log replication tested by killing primary DB in staging and verifying audit_log mirror is intact.

---

## Phase 3 — Weeks 9-12: penetration test + final polish

Now we let outsiders try to break it.

### Week 9 — Penetration test prep

| Task | Outcome |
|---|---|
| Select a pen-test vendor | Cobalt, HackerOne, Bishop Fox, or boutique firm |
| Scope the engagement | Targets, exclusions, dates |
| Provision pen-test environment | Staging copy of prod with test data |
| Brief vendor on scope | NDA signed; rules of engagement documented |

### Week 10-11 — Penetration test execution + remediation

| Task | Outcome |
|---|---|
| Vendor executes test | Report delivered to founder |
| Triage findings | Map each finding to deficiency log + severity |
| Remediate Critical and High findings | Code changes + retest |
| Document Accepted Risks | Any Medium/Low findings we choose not to fix |

**Acceptance**: All Critical and High findings remediated and retested.

### Week 12 — Pre-audit final walkthrough

| Task | Outcome |
|---|---|
| Run a tabletop incident response exercise | Documented in `docs/incidents/tabletop-2026.md` |
| Verify every policy in `docs/policies/` has a signed acknowledgement | Acknowledgements filed |
| Review every Open item in `control-deficiency-log.md` | Either Remediated or Accepted Risk |
| Brief the SOC 2 service auditor on the system | Kickoff meeting scheduled |
| Confirm 6-month observation window starts | Calendar marked |

**Acceptance**: Service auditor kickoff scheduled. We are ready to engage Type 1 fieldwork and start the Type 2 observation window.

---

## What this roadmap deliberately does NOT cover

These are real SOC 2 prerequisites but require external parties or out-of-scope decisions:

- **Legal entity formation** — SOC 2 attestation is issued to a legal entity. If we're still operating as a personal project, an LLC or C-Corp filing is a prerequisite.
- **MSA + customer contracts** — auditors will ask about customer agreements. Standard SaaS MSA needed.
- **Cyber insurance** — many auditors expect E&O or cyber liability coverage. Quote from Coalition / Vouch / similar.
- **Background checks** — when employees join, background checks are CC1 evidence. Use Checkr or similar.
- **Employee training records** — when employees join, annual security awareness training is required (KnowBe4 or similar).
- **Auditor selection and engagement** — choosing a SOC 2 service auditor is a 2-4 week process. Start the search at Week 8 so you have a signed engagement letter by Week 12.

---

## Estimated cost (rough)

- Clerk: $0-25/mo on free / Pro tier
- Sentry: $0-26/mo on Team tier
- Neon Launch: $19/mo
- Vercel Pro: $20/mo if not already
- Pen test: $5,000-$25,000 one-time (range covers solo boutique to top-tier firm)
- SOC 2 Type 1 attestation: $5,000-$15,000 (one-time, point-in-time report)
- SOC 2 Type 2 attestation: $10,000-$30,000 (annual, 6+ month window)
- Cyber insurance: $1,000-$5,000/yr
- Background checks (per employee): $25-$100

Total Year 1: roughly **$25,000-$75,000** end-to-end if you're going solo + boutique. Doubles if you're using top-tier firms.

---

## What success looks like

End of Week 12:
- Every Open item in `control-deficiency-log.md` is either Remediated or has an explicit Accepted Risk justification
- Every policy in `docs/policies/` has a signed acknowledgement on file
- All three vendor SOC 2 reports on file
- Pen test report on file with all Critical and High findings remediated
- Sentry firing on real errors
- One documented DR drill restore
- Service auditor engaged and kickoff scheduled

**Then** the 6-month observation window starts. Don't shortcut it — auditors will reject Type 2 reports that don't have a full window of evidence.

---

## How to use this roadmap

1. Don't try to do it all in 12 weeks if the team is solo. Adjust the cadence honestly.
2. Items in earlier phases are dependencies for later phases. Don't reorder Week 1 (auth) — without it, every later control assumes a broken foundation.
3. Update `control-deficiency-log.md` as items get remediated. Auditors want to see history.
4. If a vendor receipt isn't available (e.g., a smaller vendor without a SOC 2 report), document the alternative due-diligence performed in `vendor-management.md`.

## Updated

Reviewed at the end of each phase. When Week 12 closes, archive this file and replace with `SOC2_OBSERVATION.md` covering the 6-month window's operational evidence collection.
