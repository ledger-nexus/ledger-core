# Competitive landscape: Campfire & Rillet vs. ledger-nexus

**As of:** 2026-07-16. These are blitzscaling startups — treat every figure as a point-in-time snapshot and re-verify before relying on it. Sources are listed at the end.
**One line:** On accounting *depth* ledger-nexus is closer to these two than their funding suggests — and ahead in the classic-CPA long tail they skip; the gaps that actually decide the market are not features.

---

## Why these two

Campfire and Rillet are the two most-hyped entrants in the "AI-native ERP" category, both explicitly built to replace **NetSuite / Sage Intacct / QuickBooks** for high-growth and mid-market companies. If ledger-nexus is measured against anyone, it's them.

Both are **2023-founded, ~2024 out of stealth, raised ~$100M+ each in under a year** from top-tier VCs, and are growing fast. That is the frame for everything below: this is a solo, weekend-built portfolio measured against two well-run, well-capitalized rockets with ~2-year head starts, live products, and hundreds of paying customers.

### Campfire (campfire.ai)
- **Positioning:** "The AI-native ERP… built for high-growth." Nicknamed *"Slack for accounting."* Targets **seed–Series B through mid-market**, SaaS-heavy; runs a dedicated NetSuite rip-out page ("close in 3 days not 15, live in 8 weeks not 6 months").
- **Funding:** Series A $35M (Accel, ~Aug 2025) → Series B $65M (Accel + Ribbit, Oct 2025). **$100M+ total.** ~65 staff (Dec 2025). Founder **John Glasgow** (ex-Bill.com / Adobe). Valuation undisclosed.
- **Customers (named):** Replit, Decagon, PostHog, CloudZero, Advisor360, AssemblyAI, several named NetSuite rip-outs. (Note: **OpenAI is *not* a customer** — the link is an ex-OpenAI Controller as angel investor.)
- **AI:** two-model architecture — **LAM** ("Large Accounting Model," proprietary, does auto-reconciliation/categorization/anomaly detection, claimed 95%+ task accuracy) + **Ember**, a plain-English copilot **running on Anthropic Claude**.

### Rillet (rillet.com)
- **Positioning:** "The Financial ERP for the AI Age… built by accountants, for accountants." Mission: **"zero-day close."** Targets **Series A–D hypergrowth up to public companies >$1B ARR**; more accountant-led and later-stage than Campfire.
- **Funding:** Series A $25M (Sequoia, ~May 2025) → Series B $70M (a16z + ICONIQ, Aug 2025). **$100M+ total**, ~$500M valuation *reported* (unconfirmed). Founders **Nicolas Kopp / Stelios Modes** (ex-N26); spec input from "50+ Big Four CPAs." **500+ customers** (2026).
- **Customers (named):** Postscript (>$100M ARR, 3-day close), Windsurf.
- **AI:** **Aura AI** embedded in the GL — natural-language querying of the live ledger, agents that draft accruals/JEs with source docs, **draft-and-approve** with audit trail. Underlying model undisclosed.

---

## What ledger-nexus actually ships

The portfolio (ledger-core + revenue-rec + recon + fa-amort + integrations):

- **Multi-book GL** — GAAP / US_TAX / IFRS **parallel posting** (Pattern 2), chart of accounts, entities/currencies/calendars/periods.
- **Sub-ledgers** — AR/AP open items + applications, **fixed assets + depreciation (6 book methods) + disposal**, **ASC 842 leases**, revenue contracts, allowance-method bad debt.
- **Revenue recognition (ASC 606)** — revenue-rec companion: contracts → performance obligations → allocation → recognition schedules, with AI contract extraction behind a human-approval gate.
- **Native billing / AR** — invoice PDF + numbering + delivery + hosted pay page + Stripe pay-link + auto-apply-to-AR.
- **Bank feed** — CSV import → For-Review inbox → categorize / learned rules / match-to-existing / exclude (Cars 1–2); recon companion adds deterministic + AI matching.
- **Close management** — reconciliation state machine + sign-off, close-task DAG + templates, flux/variance analysis, cross-pillar dashboard + alerts.
- **Reports** — TB, IS, BS, cash flow, **multi-entity consolidation w/ intercompany eliminations**, AR/AP aging, **book-tax difference, M-3 detail (Form 1120)**, month-end packet (PDF).
- **FX** — ASC 830 revaluation behind an approval gate.
- **ERP mappers** — QBO and NetSuite (incl. multi-subsidiary), **import and export, with roundtrip proofs** — a migration path in and out.
- **Automation control center** — one governed surface listing every standing automation (see `automation-library.md`).
- **SOC 2 stack** — append-only audit log, encryption at rest, RLS (Phase 1 + partial 2b), DSR export/erasure, control matrix + deficiency log.

---

## Gap analysis

### A. At parity — or ahead (the CPA long tail they skip)

Both competitors are **SaaS-founder-led, chasing VC-backed SaaS**. That shapes what they skip. Neither Campfire nor Rillet advertises these; ledger-nexus has them:

| Capability | ledger-nexus | Campfire | Rillet |
|---|---|---|---|
| Multi-book **parallel tax-basis** posting (GAAP + TAX + IFRS) | ✅ | — | — |
| **ASC 842 leases** | ✅ | not advertised | not advertised |
| **Fixed-asset register + depreciation** | ✅ (6 methods) | not advertised | not advertised |
| **Book-tax difference / M-3 / 1120** (provision territory) | ✅ | — | — |
| Multi-entity **consolidation + intercompany elimination** | ✅ | ✅ | ✅ |
| **Close management** (recon / close-task DAG / flux) | ✅ | ✅ | ✅ |
| **ERP migration mappers** (QBO + NetSuite, both ways) | ✅ | partial (sync-in) | partial (sync-in) |
| **Preset automation bundles** (governance surface) | ✅ (design + Phase 0) | — | — |

On raw double-entry depth, ledger-nexus is not behind. In the classic-CPA long tail — tax basis, leases, fixed assets, provision — it is ahead.

### B. The real feature gaps

1. **The AI-native workflow layer — the category-defining one.** Campfire (LAM + Ember-on-Claude) and Rillet (Aura) both offer a plain-English copilot over the live GL and agents that draft entries/accruals/reconciliations for approval. ledger-nexus has AI *extraction* (rev-rec) and AI *matching* (recon) but **no copilot, no "ask your GL anything," no agentic close.** This is the thing that names the category and it's missing. *It is also the closeable gap:* Campfire's copilot is literally Claude, and the semantic-layer / MCP north star (`api-mcp-spec`) points exactly here. A "talk to your ledger" layer is weekend-scale in a way distribution never is.

2. **Native integration breadth.** They advertise 100+ connectors (Stripe, Ramp, Brex, BILL, Gusto, HubSpot, Salesforce, Plaid banks). ledger-nexus has Plaid + the ERP mappers. A large, ongoing, unglamorous build-and-maintain surface — a genuine gap.

### C. The gaps that actually decide it — none are features

- **Capital + team:** ~$100M and dozens of people each, vs. one person's nights and weekends.
- **A live product with customers:** they have 200–500 paying customers + implementation teams; ledger-nexus is a codebase + a personal dogfood instance. The difference between software and a business.
- **Third-party-attested trust:** ledger-nexus has the *controls* (append-only audit, encryption, RLS, DSR) but no attestation. Rillet advertises **SOC 2 Type II + EY/KPMG/RSM**; Campfire SOC 1 & 2. For a system that holds the books, the auditor's signature + observation window *is* the product, and it's a function of time and money, not code.
- **Distribution:** two of the most-hyped names in the category with top-tier VC megaphones. The moat isn't in the repo.

---

## Strategic read

A solo weekend build will not out-build and out-distribute two well-run $100M rockets head-to-head — and that isn't the real question. Options, most→least defensible for a solo CPA-builder:

1. **The CPA-vertical depth they underserve.** Built for VC SaaS by SaaS operators, they skip the tax-basis / leases / fixed-assets / provision depth a *CPA firm's clients* (real businesses, not just software startups) need. That's ground already stood on. A niche, not a category win — but a defensible one.
2. **The semantic-layer / API / MCP bet** — the portfolio's own north star, and *orthogonal* to them. They're building the ERP; that thesis is to be the layer AI agents and tools talk *to*. A solo builder can't win "the ERP," but the layer is a different game requiring no head-to-head distribution — be integrated, not out-marketed.
3. **Lab / proof-of-depth that feeds RevRec** — likely the truthful answer given where the energy actually is (weekend-only, own-time posture). This build is already the R&D engine behind RevRec's overlapping ASC 606 + GL + AR surface.

**Blunt version:** on features, closer than the funding gap implies; on the things that make a company win, not close — and closing *those* isn't a coding problem. **Constructive version:** the one narrow AI feature that defines the category is also the one gap uniquely cheap to close here, because it's Claude; nearly everything else worth chasing is a business you may not want to run.

---

## Sources (2026-07-16; re-verify — these move weekly)

- Campfire: campfire.ai (home, /core-accounting, /ember, /customers, /competitors/netsuite, /integrations); PR Newswire Series A ($35M Accel) + Series B ($65M Accel/Ribbit); "Introducing LAM" blog; claude.com/customers/campfire; CFO Brew "Slack for accounting"; YC company page.
- Rillet: rillet.com (about, /product/advanced-revenue-recognition, /product/aura-ai, /product/bank-reconciliation, /product/native-integrations); Rillet Series B blog (a16z/ICONIQ $70M); PR Newswire Series A ($25M Sequoia); GlobeNewswire "$70M to replace 20th-century accounting software"; Crunchbase News (~$500M reported); Sequoia partnering post.
- Comparison: numeric.io "Rillet vs Campfire"; G2 Campfire reviews.
- Verification notes: OpenAI-as-Campfire-customer is *false* (ex-OpenAI Controller = angel investor). Valuations, AI-accuracy stats, team sizes, and exact founding years are company/marketing claims or thin public record — flagged in the research, not independently audited.
