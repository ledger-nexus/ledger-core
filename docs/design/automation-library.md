# Design: Automation Library

**Status:** proposal / pre-build. No code committed. This is the shape to review before we build any of it.
**Author:** Chris (idea) + Claude (research + design), 2026-07-16.
**One line:** A single governed surface where a user turns standing automations on and off — organized into trust-calibrated preset bundles, with per-automation override — so that everything the system does on the user's behalf is discoverable, auditable, and revocable in one place.

---

## 1. The idea

> "Maybe there should be a complete automation toggle library? There should be configuration sets that toggle common sets of data … but allows users to do fine tuning on what should be automatic." — Chris

This started as a narrow question ("auto-add bank rules — yes/no?") and became the right one: instead of bolting each automation on as a separate feature with its own scattered settings, treat **all** the automation the system can do as one first-class surface.

## 2. Thesis: an automation library is a governance surface for standing approvals

The whole product runs on one rule (`CLAUDE.md` non-negotiable #3): *AI suggests; humans approve; the system posts.* An automation library sounds like it violates that. It does not — it **relocates** approval, from per-transaction to per-policy, and makes that relocation **explicit, logged, and revocable**.

Two facts make this not just safe but *better*:

- **We already auto-post unattended.** Recurring journal entries fire on a cron with no per-transaction review. The question was never "should the system act without me watching each entry" — it already does. The question is "should there be one governed place to see and control everything that acts on my behalf." For a SOC 2 product the answer is obviously yes: *"here is the complete list of standing authorizations, what each does, who enabled it and when"* is a **stronger** control story than a human clicking Add two hundred times and leaving no durable record of intent.

- **The relocation is auditable.** A per-transaction click leaves an audit row per transaction and no record of the *policy*. A standing authorization leaves one durable, revocable record of exactly what the user authorized and when — plus a provenance stamp on every entry the automation subsequently creates. That is more legible to an auditor, not less.

## 3. What we already automate (the surface to unify)

Automation today is real but scattered across cron routes, lib modules, and per-feature settings, with no single place to see or govern it:

| Automation | Where it lives | Acts how |
|---|---|---|
| Recurring JE templates | `src/lib/accounting/recurring.ts` + `/api/cron/recurring-je-run` | **auto-posts** on schedule |
| Bank-feed learned rules | `src/lib/banking/rules.ts` (Car 2) | suggests a category |
| Bank-feed match-to-existing | `src/lib/banking/match.ts` (Car 2) | suggests a link |
| FX revaluation | `src/lib/accounting/revaluation*.ts` | suggests → human posts (gated) |
| Close alerts / digest | `/api/cron/close-alerts-{dispatch,digest}` | auto-sends notifications |
| Slack notifications | `src/lib/notifications/` | auto-sends (immediate / daily) |
| Dashboard action items | `src/app/page.tsx` | surfaces nudges |

The library's first job is not to add automation — it's to make *this list* visible and governable.

## 4. Prior art (what the field ships)

From a competitive study (QBO, Xero, NetSuite, Sage Intacct, Ramp, Brex, Bill.com, Puzzle, Digits, Bench/Pilot, Monarch, Copilot, YNAB, Simplifi, Rocket Money):

- **Nobody ships a preset bundle of standing GL automations** with per-automation override and trust-calibrated defaults. The construct exists only in practitioner advice: *"run tighter thresholds in month one, loosen as trust builds; a recurring SaaS charge can auto-post at 90% confidence while any vendor payment over a dollar limit waits for review no matter how confident."* That threshold ladder is the risk model — described everywhere, shipped as UI nowhere.
- **Closest prior art:** Ramp/Brex **spend-policy templates** — one-click bundles of limits + approvals + controls per use case (Travel, Procurement). Proves the "flip a preset → coherent bundle" UX works. But it governs *money-out authorization*, not GL posting, and isn't trust-calibrated household-vs-business.
- **Configuration is scattered everywhere.** No product has a single "here's everything acting on your behalf" control center. Brex's Automation page and Ramp's Accounting Rules + Agent are the best *partial* versions, both scoped to coding/export.
- **Provenance bar to beat: Puzzle.** Per-entry reasoning trail + confidence + append-only audit + *"automation that never hides what it did."* Incumbents (QBO) only give a synthetic-user label ("System Administration") in a separate log — no badge on the entry itself. Most of the field lets an auto-posted entry look identical to a hand-keyed one.

**Conclusion:** the preset-bundle-for-a-GL is genuinely novel. Frame it as porting the proven spend-management policy-template pattern and the known bookkeeping confidence-ladder onto double-entry posting.

## 5. The model — three layers

**Automation** — one atomic capability the system can perform on the user's behalf. Declares:
- `id`, `category` (categorization / matching / recurring / reconciliation / send / close / detection / alert)
- what it does, in one plain sentence
- `governanceLevel` (see §6) — the strongest level it is *allowed* to run at
- `enabled` + config (scope, thresholds, amount caps)
- `provenanceSource` — the honest source stamped on anything it posts (§7)

**Configuration set (preset)** — a named bundle that sets the enable-state + config of a coherent group of automations at once. Trust-calibrated. Applying one is a single, logged act. A preset is a **starting point, not a lock**.

**Override (fine-tuning)** — a per-automation change on top of a preset. Overriding detaches that one automation from the preset and marks it *customized*, so the user always sees where they've diverged from the bundle.

## 6. Governance levels

Every automation runs at exactly one of three levels; a preset or override may only set it *at or below* the level the automation declares as allowed:

- **SUGGEST** — pre-fills a choice; a human still acts. (Car 2 learned rules, match-to-existing, FX reval.) Cannot post unattended. Constitutionally trivial.
- **REVIEW** — acts, but the result is *collected for review and flagged*, never silently final. (e.g. auto-categorize but hold in an inbox.) Post-with-fallback.
- **AUTO** — posts unattended. (Recurring JE today; auto-add bank rules tomorrow.) Requires the guardrails in §6.1 and the constitutional line in §8.

### 6.1 Guardrails (from field best-practice)

Any AUTO automation must carry:
- **Small enable-unit** — per rule / per account, never a global "auto-post everything."
- **Amount cap** — optional per-automation ceiling; over it, fall back to REVIEW *no matter how confident*.
- **Confidence gate** — for any ML-driven automation, a minimum confidence to act; below it, fall back to REVIEW.
- **Needs-review fallback** — the automation must always have a defined "when unsure, don't post — surface it" path.
- **Kill switch** — one toggle disables it instantly; already-created entries stay (they're real postings) but nothing new fires.
- **Provenance** — §7, non-negotiable.

## 7. Provenance — the Puzzle bar, which we can clear

An automated entry must never be indistinguishable from a hand-keyed one. This extends the provenance discipline from the JE-source fix (a manual entry is stamped `MANUAL` server-side; `AI_APPROVED` asserts a control ran) — an auto-posted entry is **neither**.

- **Honest source.** Introduce sources that name *what* acted — e.g. `RECURRING`, `RULE` (deterministic auto-add), and keep `AI_APPROVED` reserved for genuine AI-proposed-then-human-approved. Stamped server-side; the client can never claim one.
- **Visible badge.** Every surface that renders an entry (register, JE list, detail) shows which automation placed it. "Automation that never hides what it did."
- **Audit trail.** Enabling/disabling an automation, applying a preset, and every unattended post are audit-logged (which automation, when, by whom authorized, at what confidence if applicable). We already have an append-only `audit_log`; this rides it.
- **Reasoning, where it exists.** For rule-driven posts, record *which rule* and *why it matched* (the merchant text, the amount). For ML, record the confidence.

## 8. Constitutional reconciliation — the principled line

`CLAUDE.md` #3 stays literally true under one rule:

> **The library may run the user's own deterministic rules unattended. It may not let AI post unattended.**

- **Deterministic, human-authored automations** — recurring templates, exact-match bank rules, auto-add — *may* reach AUTO. The user authored the rule with full knowledge; the rule does exactly and only what it says; "the human approved" is satisfied at rule-creation and is revocable. This is the same pattern recurring JEs already use.
- **AI/ML-driven automations** — learned categorization suggestions, recurring-transaction detection, anomaly flags — *may not* exceed SUGGEST/REVIEW by default. AI proposes; a human disposes. `AI_APPROVED` remains a claim that a human confirmed.

This line is both principled (the constitution holds) and safe (the risky, non-deterministic stuff never posts unattended). It is also a *marketing* line: "our AI will never post to your ledger without you — only your own rules do."

## 9. The control center (IA)

One surface — `/automations` (or `/settings/automations`) — the "everything acting on your behalf" page the field doesn't have. Per automation: on/off, governance level, scope, last-acted, and count of entries it has created (click through to them). Preset selector at the top; a per-automation config drawer. Relevance-gated like the rest of the app: a single-entity household never sees multi-entity automations.

## 10. Preset designs (illustrative — the trust ladder)

| Preset | Posture | Sets |
|---|---|---|
| **Manual** | nothing acts unattended | everything → SUGGEST; recurring templates require a click; no auto-add |
| **Household starter** (default) | conservative | learned suggestions ON; match-to-existing ON; recurring templates AUTO; auto-add OFF; notifications digest-only |
| **Small business** | looser | + auto-add for confirmed fixed-payee rules (amount-pinned); + recurring detection at REVIEW; immediate alerts |

Presets set *defaults*; every line is overridable. The names encode the threshold ladder the field only describes in blog posts.

## 11. Build phasing

- **Phase 0 — read-only registry.** Surface the §3 automations in the `/automations` control center: what exists, what it does, whether it's on. No new automation, no schema. Pure visibility — and instantly valuable, because today nobody (not even us) can see this list. *Lowest risk, highest clarity; the honest first slice.*
- **Phase 1 — real toggles.** Make the existing automations enable/disable + configurable through the registry (persist an `Automation` config row per tenant).
- **Phase 2 — presets + override.** Configuration sets; apply/override with the customized-detachment UX.
- **Phase 3 — first new AUTO capability.** Auto-add bank rules behind the framework, with the `RULE` provenance source and all §6.1 guardrails. This is the first feature that posts to the ledger without per-transaction review — deliberately gated behind the whole library rather than shipped loose.
- **Phase 4 — AI-driven at SUGGEST/REVIEW.** Recurring-transaction detection, anomaly flags. Never AUTO (§8).

## 12. Open decisions (for Chris)

1. **Scope for v1:** is this a personal-books feature, or a ledger-core-wide product surface? (It reads as a genuine product differentiator — nobody ships it — which argues for ledger-core-wide.)
2. **Preset names + defaults:** are "Manual / Household starter / Small business" the right three, and is Household-starter the right default posture?
3. **The §8 line:** confirm the principle — *deterministic rules may auto-post; AI may not*. This is the load-bearing constitutional call.
4. **Provenance sources:** add `RECURRING` + `RULE` (this doc's proposal), or a single `AUTOMATION` source plus an automation-id column? (The former is more legible in reports; the latter is fewer enum values.)
5. **Build order:** start at Phase 0 (read-only registry) to make the shape concrete, or jump to Phase 3 (auto-add) because that's the immediate want? Recommendation: Phase 0 first — it's cheap, it de-risks the model, and it delivers the "see everything acting on your behalf" value on day one.
