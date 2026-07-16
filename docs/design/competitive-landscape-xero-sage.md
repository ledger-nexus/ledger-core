# Competitive landscape II: the incumbents — Xero & Sage vs. ledger-nexus

**As of:** 2026-07-16. Companion to [competitive-landscape-campfire-rillet.md](competitive-landscape-campfire-rillet.md) — that doc covers the AI-native frontier; this one covers the incumbent mass market. Figures are point-in-time and sourced from FY25/FY26 filings and press; UNVERIFIED items flagged at the end.
**One line:** The startups showed the gap; the incumbents *prove it's structural* — Xero has publicly declined to build rev-rec and consolidation because its single-entity architecture can't carry them, Intacct charges $15–75K/yr + consulting for exactly the depth ledger-nexus has natively, and both incumbents' AI trust doctrine independently converged on the control model this repo already enforces.

---

## Why these two

Campfire and Rillet are ~2-year-old rockets; Xero and Sage are the 20-year record of what actually wins at scale. Xero (~4.9M subscribers, NZ$2.8B FY26 revenue) is the definitive study in *channel-led* SMB distribution and its limits. Sage (£2.5B FY25 revenue, 101% renewal-by-value) spans the whole ladder — from the decaying Sage 50 desktop base to **Sage Intacct**, the closest incumbent analog to what this repo is: a dimensional, multi-entity, multi-book, native-ASC-606 financials layer, endorsed by the AICPA and growing 23% in the US.

### Xero — the channel machine with a shallow ledger
- **Scale:** FY26 revenue NZ$2.8B (+31%; +21% organic); 4.9M subscribers; ~1.03% monthly churn; overwhelmingly ANZ+UK.
- **Won ANZ/UK** by being cloud-native with daily bank feeds and a superior reconciliation UX while MYOB/Sage slept on desktop — and, decisively, by recruiting accountants as the salesforce (free practice tools: Xero HQ, XPM; certification; partner tiers; 250K+ accountants/bookkeepers). Partners migrate whole client books.
- **Lost the US** to Intuit's ProAdvisor channel + localized compliance depth (payroll/sales tax/1099s). After 15 years organic (~7% of sales), the answer was to buy distribution: **Melio, up to US$3B** (closed Oct 2025) — US bill-pay with ~5× Xero's ARPU per customer. Also bought **Syft Analytics (~$70M)** — its own ecosystem's best reporting app — to paper over the consolidation it never built.
- **Ledger depth:** single-entity architecture; **no consolidation** (publicly not planned), **no revenue recognition** ("not something we'll be developing"), fixed assets with a ~500-asset practical ceiling, US payroll retired (Gusto partnership), multi-currency gated to the $90/mo top tier. The historic differentiator is the **bank-rec surface**: community-trained ML predictions (since 2021), now JAX-driven auto-reconciliation of high-confidence matches (beta, region-gated).
- **AI (JAX / "Just Ask Xero"):** chat + insights + drafting live and free; agentic execution early/beta. Trust posture: "JAX Assure" guardrails, full user visibility over automated rec.

### Sage — the portfolio, and Intacct as the mid-market moat
- **Scale:** FY25 underlying revenue £2,513M (+10%), 97% recurring, renewal 101% by value. **Intacct is the growth engine**: US revenue £461M (+23%), >45% of US revenue; Sage 50 is the maintained-but-eroding desktop base whose migration pain (cloud sibling can't absorb complex setups) strands customers.
- **Intacct's ledger** is the incumbent proof of this repo's architecture bet: **dimension-tagged GL** (not a bloated COA), **native multi-entity consolidation with intercompany eliminations**, **native ASC 606 / IFRS 15 with dual-treatment parallel books**, close-oriented releases — designed in the early 2000s and still the moat two decades later. It wins the *graduation moment* off QBO/Xero, and the triggers are almost always **multi-entity, rev-rec, or investor-grade reporting**.
- **Price of that depth:** quote-only, typically **$15K–$35K/yr** (to $75K+), modules $3–10K each, implementation ≈ 1–1.5× first-year subscription, VAR-delivered. Weaknesses: dated UI, hard report writer, cumbersome corrections, historically weak bank connectivity.
- **Channel:** VARs + the **Sage Intacct Accountants Program** (CPA firms run outsourced-accounting practices *on* Intacct) + the **AICPA endorsement** (the only financial management solution endorsed via CPA.com) as institutional distribution.
- **AI (Sage Copilot):** live across five products; **40K+ eligible but only ~11K active** — a useful honesty check on AI-adoption claims. FY25 added named agents (compliance, reconciliation, AP, tax). Trust posture is the most concrete in the industry: the **AI Trust Label** (in-product nutrition-label disclosure of what each AI feature does and what data it uses, live in Intacct since Nov 2025) and an architecture where **agents recommend but cannot execute without human sign-off**, with who-initiated/who-approved/what-changed traceability.

---

## What the incumbent record validates in this repo

These aren't aspirations — they're confirmations of choices already made, from the two companies with the longest evidence base:

1. **Multi-book / multi-entity from day one (universal-schema Pattern 2).** Xero's single-entity silo is now *unfixable* — it spent $70M buying Syft rather than retrofit consolidation, and publicly declines rev-rec. Intacct's dimensional multi-entity multi-book core from ~2003 is still why it wins deals in 2026. Architecture decisions in a GL are forever; this repo made the Intacct-shaped one.
2. **The §-line on AI ("AI suggests; humans approve; the system posts") is the industry's convergent trust doctrine.** JAX Assure and Sage's agents-recommend-never-post + Trust Label + full audit trace are, independently, the same control model this repo enforces in code — and the same one the automation-library design (§8: deterministic may auto-post, AI may not) writes down. Notably, **the first agentic feature both incumbents shipped is auto-reconciliation of high-confidence matches with full visibility** — i.e., the exact shape of the held bank-feed Car 3, evidence the design is right *and* that it's table stakes once approved.
3. **The `/automations` control center is a home-grown Trust Label.** Sage shipped the disclosure surface (what acts on your behalf, on what data, under what control) as a headline trust feature in Nov 2025; this repo shipped the same governance surface (#255) as Phase 0 of the automation library. Same instinct, independently derived — keep investing in it.
4. **Bank feeds + reconciliation are the daily hook.** Xero's stickiness (1% monthly churn) was built on the rec surface, not reports; its community-ML categorization is the at-scale version of the learned-rules engine in the bank feed (#253). Retention lives on that surface. (Sober note: *feed coverage* — 300+ direct connections at Xero — is an aggregator-partnership grind; Plaid dependency is the realistic path, as already planned.)
5. **Two-way migration mappers are strategy, not plumbing.** Incumbent pricing behavior (Xero's near-annual increases into feature-gated tiers; Sage's 101% renewal-by-value) is a disruption subsidy — but only to products that can *absorb* switchers. Stranded Sage 50 desktops (Windows-11-era breakage, £450–1,200 migration quotes, a cloud sibling that can't hold complex setups) and price-fatigued Xero orgs are the accessible cohorts; the QBO/NetSuite roundtrip mappers are exactly the right muscle, and a Sage 50 mapper is the obvious candidate third.

## The gaps the incumbents expose (honest list)

- **Channel is the whole game at scale, and ledger-nexus has none.** Xero's win was 250K accountants with free practice tools; Intacct's is VARs + CPA firms + the AICPA's blessing. A solo build can't replicate that — but the CPA-founder version exists in miniature: a CAS practice run *on* the substrate (the SIAP pattern), and the RevRec Engine adjacency. The lesson isn't "build a partner program"; it's that any commercial path must answer *"which accountants bring their book, and what do they get?"*
- **Feed coverage, payroll, and localization breadth** are partnership surfaces, not build surfaces. Xero retiring its own US payroll for Gusto is the precedent: partnering there is a pattern, not a failure. Depth in ONE jurisdiction's compliance (US GAAP, ASC 606/842 — already the strength) beats breadth.
- **Payments is where monetization went** (Melio at ~5× software ARPU is why Xero took on net debt for it). The portfolio's "no card/ACH moved by us" posture still permits the workflow layer both incumbents chase — invoicing, pay-links, remittance matching — with a partner moving funds. Already the RevRec stance; the incumbent record endorses it.
- **Measure *active* AI use, not access.** Sage's 40K-eligible / 11K-active gap is the cautionary stat for any AI feature (including `/ask`): adoption claims need an activity denominator.

## Strategic read (unchanged, sharpened)

The Campfire/Rillet doc concluded the defensible plays are (1) CPA-vertical depth, (2) the semantic-layer/API bet, (3) lab-that-feeds-RevRec. The incumbent record *sharpens* #1: the specific, priced, structural gap is **Intacct-grade ledger depth (multi-entity, multi-book, dimensions, native 606/842) at Xero-grade price and self-serve implementation** — a lane the incumbents cannot enter (Xero architecturally, Intacct economically) and the AI-natives entered from the SaaS-vertical side only. That is, almost verbatim, what this repo already is. The missing halves are channel and compliance breadth, which are business problems, not schema problems.

---

## Sources & verification notes (2026-07-16)

- Xero: FY25/FY26 market releases (openbriefing/Listcorp), H1 FY26 interims; Melio acquisition (PR Newswire, CPA Practice Advisor, Flagship Advisory — US$2.5B upfront, up to $3B); Syft (~$70M, Accountants Daily); JAX (xero.com/ai-in-accounting/jax, Accounting Today, AccountingWEB); bank-rec ML (Xero blog 2021, CPA Practice Advisor); no-rev-rec / no-consolidation (Xero product-ideas forum, Xero Central, Claryx/Mayday analyses); partner program (xero.com); pricing via third-party trackers (xero.com blocked direct fetch).
- Sage: FY25 RNS (Investegate) — revenue, Intacct US +23%, renewal 101%; Copilot one-year milestone (40K eligible / 11K active); AI Trust Label + agent architecture (Sage press releases Nov 2025, ERP Today, Earmark CPE); Intacct capabilities (sage.com, RSM, ERP Research, multientityaccounting.com); Intacct pricing (Cargas, ERP Research — quote-gated ranges); SIAP/Baker Tilly; Sage 50 migration pain (Accupe, Sage community).
- **UNVERIFIED / gaps:** exact Xero US subscriber count; partner-channel % of new subs (third-party only); Sage 50 standalone revenue; authoritative Intacct customer count (trackers: 11–21K); Intacct marketplace size; Planday divestment; QBO's "80% NA share" (third-party estimate).
