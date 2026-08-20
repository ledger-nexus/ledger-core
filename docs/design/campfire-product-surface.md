# Design: Campfire's product surface, and what we take from it

**Status:** study + build spec. No code committed.
**Author:** Chris (screenshots + direction) + Claude (study + design), 2026-08-08.
**One line:** Fourteen screenshots of Campfire's running product, read against what `ledger-core` already ships, converted into a copy-this / don't-copy-this list with a build order.

**Companions — read these first, this doc does not repeat them:**
- [`competitive-landscape-campfire-rillet.md`](./competitive-landscape-campfire-rillet.md) (2026-07-16) — *should* we compete, and where. Strategic read stands unchanged.
- [`automation-library.md`](./automation-library.md) (2026-07-16) — the governance thesis for standing approvals. §5 below is that thesis with Campfire's shipped control surface attached to it.
- [`../design-system.md`](../design-system.md) — the token scales every mock here resolves to.

---

## 0. Provenance, and what this evidence can and cannot support

The July competitive doc was built from **marketing pages**. This one is built from **fourteen screenshots of the product running**, which is a real upgrade in evidence quality and still has hard limits worth stating before anyone builds against it:

- One org (`Campfire, Inc. - Demo`), one user (Brad Dillon), one session. Demo data.
- **The numbers are demo fiction and must not be read as scale claims.** `$558M` overdue AR across 1,804 invoices, 1,388 uncategorized transactions, 156 pending approvals, 1,429 contracts, 247 products, 109 agents. What is *informative* is the shape — which counters they chose to put on the home screen — not the magnitudes.
- Screens observed, not behaviour. We see a "Bulk Update" button; we have never watched it run. Every "how it works" below is inference from labels and layout, and is marked where it matters.
- No pricing, no permissions model, no error states, no empty states except two, no mobile.

**What we copy and what we don't.** Information architecture, interaction patterns, and control surfaces are the vocabulary of the category — a filter chip, a saved view, a confidence band. Those we take freely and they are what this doc is about. What we do not take: their microcopy verbatim, their visual identity, their brand names. Our agent layer is not called Ember. Where a screenshot's wording is quoted below it is quoted **as evidence of a design decision**, not as copy to paste.

---

## 1. The verdict, in one paragraph

On accounting depth `ledger-core` is not behind — 65 models, multi-book parallel posting, ASC 842, fixed assets with six depreciation methods, book-tax/M-3, consolidation with IC elimination, a close-management pillar. The July doc established that and the screenshots do not disturb it. **What the screenshots show is that Campfire's lead is entirely in the operator surface**: the layer between a correct ledger and a person who has to work in it eight hours a day. Saved views, filter chips, a column picker, bulk update, breadcrumbs, a report catalog, tag groups, validation rules, connection settings, and an agent-governance console. Every one of those is thin relative to a depreciation engine. **We have the hard part and are missing the visible part**, which is an unusually good position to be in and an unusually easy one to misread as being behind.

---

## 2. Measured gap table

Checked against the schema and the route table on `main` (65 models, 60 `page.tsx` routes) rather than from memory.

| Campfire surface | ledger-core today | Gap |
|---|---|---|
| Left nav: 8 top-level groups, expand-in-place | `NAV_SECTIONS` catalog, every destination visible | **At parity.** Ours is deliberately flat — no progressive disclosure. Keep it. |
| **Approvals as top-level nav + count badge** | `/journal-entries/pending`, buried under Transactions | Cheap, high value |
| Breadcrumbs on every page | none found | Missing |
| Persistent search + assistant button in header | `/ask` exists as a *page* | Reposition, not rebuild |
| **Saved views** (lists + reports) | no `SavedView` model, no UI | **Missing — highest-leverage single item** |
| **Filter chips** w/ per-chip × and "Clear all" | filter bars, no chips | Missing |
| **Column picker** (right-edge tab) | none | Missing |
| **Bulk update** on lists | none | Missing |
| Inline edit (pencil in a table cell) | none | Missing |
| Pagination w/ page-size + "1 to 20 of 42" | varies | Standardise |
| **Report catalog** (categories, favorites, built-in vs custom badge) | `/reports/builder` exists; no catalog | Missing shell over existing parts |
| Report controls: range / cadence / entity / zero-balance / group-by / download | mostly present per report | Standardise into one contract |
| Drill-down from a report cell | not found | Missing |
| **Tag Groups** (Region / Project / Location) | `Dimension` + `DimensionValue` + `DimensionSet` **engine exists**, no UI | **Missing UI over a built engine** |
| **Validation Rules** (condition → requirement) | posting-rules engine (different job) | Missing |
| Objects settings hub (~18 master-data CRUDs) | models exist, screens scattered | Missing shell |
| **Connections** settings (per-integration sync config, entity mapping) | QBO/NS mappers, `/import/netsuite` | Missing config surface |
| Developer: API keys / webhooks / SMTP | webhook channel (0041), token script | Missing UI |
| **Agent console** (catalog, approval routing, confidence bands, runs) | none — `automation-library.md` is design-only | **Missing; §5** |
| Contract detail w/ 9 sub-object tabs | `RevenueContract` model | Missing UI |
| Products & usage tiers | `Item` model | Partial |
| Budget vs Actual report | no `Budget` model | Missing |
| Departments / Payment Terms / Tax Rates / Prepaids / Payees / Product Bundles / Cost Allocations / Contract Templates | **no models** | Missing |

Nothing in the "missing" column is architecturally hard. Most of it is a table component and a settings shell.

---

## 3. The chrome — copy wholesale

Campfire's shell is three fixed regions and it does not vary between pages. Ours varies. Theirs is better and the fix is mechanical.

```
┌──────────────┬────────────────────────────────────────────────────────┐
│ logo    [⊟]  │ ⌂ › Section › Page              [search]  [Ask ▸]  [?] │
│              ├────────────────────────────────────────────────────────┤
│ Home         │ Page Title                        [Secondary] [Primary]│
│ Reporting  › │ ┌─ control bar ────────────────────────────────────┐   │
│ Revenue    › │ │ Range │ Type │ Filters(n) │ View ▾ 💾🗑 │ Search │   │
│ Accounting › │ └──────────────────────────────────────────────────┘   │
│ Cash Mgmt  › │ [chip: Range 2026-04-01–06-30 ×] [chip: Account ×] Clear│
│ Close Mgmt › │ ┌──────────────────────────────────────────────────┐ ┃ │
│ Approvals 156│ │ table / report / detail                          │ C │
│ Ember AI   › │ └──────────────────────────────────────────────────┘ ┃ │
│              │ Page Size 20 ▾        1 to 20 of 42      |‹ ‹ 1/3 › ›| │
│ Settings     │                                                        │
│ Help · Logout│                                                        │
│ [org ⇕]      │                                                        │
└──────────────┴────────────────────────────────────────────────────────┘
```

Take specifically:

1. **Breadcrumb on every page**, home-icon rooted. We have deep routes (`/close/reconciliations/[id]`) with no way back up.
2. **Title row = title + actions, always.** Campfire puts `Actions` and `Bulk Update` top-right on Transactions, `Refresh Token / Exit / Save` on a connection. One slot, consistent side.
3. **Org switcher pinned bottom-left** with org name, user name, email. Ours has the scope cookie but no persistent identity anchor.
4. **A demo/environment banner.** Campfire runs a magenta `Campfire, Inc. - Demo (Demo)` bar. We seed Northwind and have no visual marker that you are in demo data — a genuine footgun for a CPA product, and one line of chrome.
5. **Sidebar sections expand in place**, sibling sections stay visible. Matches our standing no-progressive-disclosure rule (pages get added visibly; no "More (N)" drawers) — Campfire independently landed on the same thing, which is mild evidence the rule is right.

**Do not copy:** their nav *taxonomy*. "Revenue / Accounting / Cash Management" is a SaaS-controller's mental model. Ours is `Transactions / Sub-ledgers / Lists / Reports / Period & close`, which is a *CPA's* model and is the vertical we chose. Keep ours.

---

## 4. The list contract — the highest-leverage copy

Every Campfire list is the same object. Ours are each hand-rolled. **One `<DataTable>` contract, adopted everywhere, is worth more than any single feature in this document.**

The contract, from Transactions / Contracts / Products / Tag Groups:

| Element | Behaviour | Notes for us |
|---|---|---|
| **Control bar** | Range, type, Filters (`n Applied ×`), View, currency, search | Fixed order, left→right |
| **Saved views** | dropdown + 💾 save + 🗑 delete | New `SavedView` model — see below |
| **Filter chips** | one per active filter, own ×, plus "Clear all" | The state is *visible*; a filter bar alone hides it |
| **Column picker** | vertical tab pinned to the right edge | Cheap; unlocks wide tables |
| **Export** | ⤓ icon, list-level | We have CSV routes already — surface them |
| **Bulk select** | header checkbox + row checkboxes → Bulk Update | ⚠️ ledger writes must still go through `postJournalEntry`; bulk = N calls in a tx, never a raw `updateMany` |
| **Inline edit** | pencil beside an editable cell (Account, on Transactions) | Only for non-posting attributes |
| **Row actions** | `Actions ▾` per row, right-aligned | |
| **Pagination** | page-size select · `1 to 20 of 42` · first/prev/n of m/next/last | The `x to y of z` string matters — "Page 1 of 3" alone hides the total |
| **Sortable headers** | arrow on the active column | |

**`SavedView` — the one new model this section needs:**

```
SavedView {
  id, tenantId, entityId?      // null = tenant-wide
  surface   String             // "transactions" | "income-statement" | …
  name      String
  ownerId   String             // creator
  shared    Boolean @default(false)
  config    Json                // filters, columns, sort, cadence, grouping
  @@unique([tenantId, surface, ownerId, name])
}
```
`config` is deliberately opaque `Json` — each surface owns its own shape and versions it. A view that fails to deserialise renders the surface's default and warns; it never throws. **This must be tenant-scoped in the query, not just the column** — see `tests/tenant-scope-guard.test.ts`, and deficiency log #28, for why that sentence is in this doc at all.

---

## 5. The agent console — the important one

This is the gap the July doc called "category-defining… and uniquely cheap to close here, because it's Claude" (§B.1), and `automation-library.md` already wrote our governance thesis: *an automation library relocates approval from per-transaction to per-policy, explicitly, logged and revocable.*

**Campfire has shipped the control surface that thesis specified.** That is the single most valuable thing in these screenshots, and we should take its structure almost verbatim.

### 5.1 The catalog

Agents are **cards in a filterable grid**: `All 109 · Continuous 7 · On-Demand 2 · Custom 100`. Each card is icon + name + optional `Inactive` pill + one-line description. Built-ins read as capabilities (`Continuous Close` — "Identifies uncategorized items and proposes actions"; `Accounts Receivable` — "Cash application, payment matching, and AR aging analysis"; `Fixed Asset Capitalization` — "Reviews expenses for items that should be capitalized per your policy"). Custom agents carry **creator attribution** (avatar + "Created by William Tu").

Three things to take:
- **The continuous / on-demand split.** A standing watcher is a different governance object from a thing you run once. Our automation library should carry the same distinction.
- **Inactive is a visible state on the card**, not a hidden setting. Seven of the observed built-ins ship off.
- **Creator attribution on custom agents.** Provenance is the Puzzle-bar problem `automation-library.md` §7 already flagged; this is a cheap piece of it.

### 5.2 The governance control — copy this exactly

The AR agent's settings screen is the thesis rendered as a control, and it is **two-axis**:

```
Approval Routing:   [ Threshold ▾ ]      "Require approval for actions above threshold"
Approval Threshold: [ $ 10,000.00  ]     "Actions with amounts above this threshold will require approval"

AI Confidence Thresholds
  "…it assigns a confidence score from 0 to 100 … Use the two handles below
   to set what happens at each confidence level."

  ├──────────●───────────────────●────────┤
   Not shown     Needs review      Auto-applied

  ┌───────────────┬────────────────┬──────────────────────────────┐
  │ Not shown     │ Sent for review│ Auto-applied                 │
  │ isn't confident│ good suggestion,│ highly confident — applied  │
  │ — silently     │ wants a human   │ automatically IF it also    │
  │ skipped        │ to confirm      │ falls within the $ threshold│
  └───────────────┴────────────────┴──────────────────────────────┘
```

What makes this good, and worth copying beat for beat:

1. **Two axes, ANDed.** Confidence gates *quality*; dollars gate *blast radius*. Either alone is wrong: a 99%-confident $4M match still deserves eyes, and a low-confidence $12 match is noise. The auto-apply band explicitly says "if it **also** falls within the dollar threshold above."
2. **Three bands, not a switch.** The bottom band is *silence*, not rejection — the machine declining to waste your attention is a designed outcome, and naming it "Not shown" is honest about what happens to those items.
3. **The explainer cards under the slider** are plain-English, one sentence, no jargon. A two-handle slider is genuinely ambiguous; the cards remove the ambiguity at the point of use rather than in a help article.
4. **The threshold is a dollar amount the operator types**, not a preset tier. It is their materiality, and materiality is a judgement they already make.

### 5.3 Where we must diverge — and it is not optional

**`CLAUDE.md` non-negotiable #3: AI suggests; humans approve; the system posts.**

Campfire's third band **auto-applies cash application**, which is a ledger write. Adopting that band as-shown would violate our canon. Two honest options, and this is a **decision for Chris, not a thing to infer**:

- **(a) Two bands for anything that posts.** `Not shown | Needs review`, with the auto-apply band available only for non-posting actions (categorisation suggestions, draft creation, flagging, notification). The canon stays absolute.
- **(b) Three bands, where auto-apply is redefined as a *standing* approval** — exactly the relocation `automation-library.md` §2 argues for — provided that: the policy itself was approved by a human with the authority to approve that dollar amount; every auto-applied action writes `source: "AI_APPROVED"` plus an `audit_log` row naming the policy and the confidence score; and the policy is revocable with one click and the revocation is logged.

(b) is defensible and is what the automation-library doc already argues for. It is still a **change in what non-negotiable #3 means in practice**, and that is Chris's call to make explicitly rather than something that arrives inside a feature.

Whichever is chosen: **the confidence score must be persisted on the action**, not just used at runtime. An auditor asking "why did this post itself" needs a number, a policy id and a timestamp, not a shrug.

---

## 6. Reports — a catalog, and one control contract

**The catalog** (`Reporting > Reports`): tabs `All / Favorites / General / Revenue / Expenses / Cash / Receivables / Payables / Tax / Custom`, and within each a grid of cards — title, ★ favourite, provenance badge (`Campfire` = built-in), one-line description. We have ~12 report routes and a report builder with **no front door**. The catalog is a shell over parts that already exist, and the provenance badge maps directly onto built-in vs `ReportTemplate`.

**The control contract**, from the Income Statement:

| Control | Campfire | Ours |
|---|---|---|
| Report Range | date range picker | present |
| Cadence | `Quarterly (Calendar)` — calendar vs fiscal is explicit in the label | ⚠️ we have fiscal calendars per entity; the label must say which |
| Entity | `All entities` | present via scope cookie |
| Show Zero Balance Accounts | toggle | missing, wanted |
| Group By / Filter | present | partial |
| Collapse / expand all | present | missing |
| View | saved view + 💾 | missing (§4) |
| Download | button | CSV routes exist, not surfaced |

**Two details worth stealing precisely:**
- **Negatives in parentheses**, `($406,499.47)`. Accounting convention, not a minus sign. **`formatMoney()` already does this** (`src/lib/utils/format.ts`) — the gap is that not every report renders through it.
- **The selected cell has a focus ring** — `$293,632.84` is boxed. A report cell is a **drill-down affordance**: cell → the transactions behind it. That is the single most-requested thing in any close tool and we have every part needed to build it (the transactions list, the filter chips, the account and period are both known at the cell).

**Budget vs Actual** needs a `Budget` model we do not have: budget rows keyed `(tenantId, entityId?, departmentId?, accountId, periodId, amount)`, then the report is `Budget | Actual | Difference | Percentage` per period band. Note their header block prints the budget's *own* metadata (name, breakdown type, cadence, start/end) above the table — good practice for a report whose meaning depends on which budget it ran against.

---

## 7. Objects & Automations — the settings hub

Campfire's settings is a **three-column shell**: nav ▸ settings-nav ▸ content, grouped `Your Account` / `Objects` / `Automations` / `Developer`. Roughly eighteen master-data CRUDs sit under Objects, each the same table + `Create X` + search + column-picker + export.

### 7.1 Tag Groups → our dimension engine

The best find in the screenshots. Campfire has **Tag Groups** (`Region`, `Project`, `Location`) — a named group, each holding values, applied to transactions and contracts. The contract detail shows `Department / Tag / Location / Project / Region` as first-class fields; the contracts list shows them as columns.

**That is our dimension engine.** `Dimension` = tag group, `DimensionValue` = tag, `DimensionSet` = the deduplicated combination on a line. The engine is built, canonical (`getOrCreateDimensionSet`), and `CLAUDE.md` describes it as *"an empty table seam since v0.2"*. Campfire shows exactly what the seam is for.

**Build the UI over the existing engine. Do not add a parallel `Tag` model.** A second dimensioning concept would be an anti-pattern against a LOCKED schema and would fragment reporting forever.

### 7.2 Validation Rules

A two-step builder: **Conditions** → **Requirements**. Their own example is the giveaway:

> "To require a department on all operating expense transactions, select 'Account Type is one of' → 'Operating Expense', then proceed to the next page."

So validation rules exist primarily to **make dimensions mandatory conditionally** — which is what turns a dimension engine from optional metadata into data you can actually report on. Rules are `(name, conditions[], requirements[])`, conditions are `field / operator / value` with `is empty | is filled | contains | excludes | is one of`.

This is **not** our posting-rules engine — that derives *lines* from a source event. Validation rules gate *field completeness* before a write. Different job, different table, and worth saying out loud so nobody tries to overload the `$.path` DSL, whose minimalism is deliberate.

Enforcement point: inside `postJournalEntry`, alongside the existing balance/period/account checks, so it cannot be bypassed by a caller.

### 7.3 Connections

Per-integration config (`Ramp` observed): title, last-synced timestamp, pull-from date, `Refresh Token / Exit / Save`, sync-settings tabs (`General / Card Transaction / Reimbursement / Bill Pay`), labelled toggles each with a description line, and an **entity-mapping table** — `Ramp Entity → Campfire Entity → Ramp Card Account → Reimbursement Liability`. The mapping table is the important part: the integration is *configured*, not assumed, and the mapping is visible.

We have QBO and NetSuite mappers with no configuration surface at all. The entity-mapping table is the shape to build. ⚠️ **Any connection UI touches stored credentials** — tokens stay encrypted at rest, are never rendered, and `Refresh Token` must be an action that never displays the value.

---

## 8. Revenue — contract detail and usage tiers

**Contract detail** is a dense read-only field grid (three columns, ~30 fields) above a **tab strip of related objects**: `Revenue / Subscriptions / Usage / Milestones / Invoices / Credit Memos / Sales Commissions / Attachments / Journal Entries`. Take both: the grid for detail pages generally (invoice detail uses the identical pattern), and the tab strip as the way to attach sub-objects to a parent without a new route each. Small touch worth copying: **the customer id has a copy-to-clipboard icon** next to it (`CUST-0000191 ⧉`) — reference numbers exist to be pasted elsewhere.

**Products & usage tiers.** Products carry deferred / revenue / AR account mappings per product, plus **usage groups** with tiers (`API Overage`, tier 1 `0–9999` → 0, tier 2 `10000–No limit` → 2.5). The tier table appears in a hover popover from a `6 groups` link — good density, and note `No limit` is spelled out rather than left blank. Usage-based revenue is a real ASC 606 surface and our `Item` model is thin next to this. Worth a separate design doc; not this one.

---

## 9. What we deliberately do not copy

| Not copying | Why |
|---|---|
| Their nav taxonomy | Ours is CPA-shaped; theirs is SaaS-controller-shaped. Deliberate divergence (§3). |
| "Ember", their icons, their copy verbatim | Not ours to take (§0). |
| A 109-agent catalog | 100 of 109 are user-created. The *platform* is the product; a shipped catalog of 109 is a vanity count. Ship ~6 that work. |
| Auto-apply on ledger writes, as-shown | Non-negotiable #3. See §5.3 — needs an explicit decision, not a default. |
| Vanity KPI tiles | Their dashboard leads with **work queues** (overdue AR, uncategorized, approvals) — 3 of the top 4 cards are problems, not achievements. That is the *right* instinct for an operate surface and is the thing to copy; the specific tiles are not. |
| Their demo magnitudes | §0. Demo data. |

**One dashboard detail that *is* worth copying:** every KPI carries a denominator sub-line — `$558M` / *"across 1,804 invoices"*, `$107,286,465.47` / *"8 cash accounts"*, `$118M` / *"806 active contracts"*. **A number is never alone.** Cheap rule, and it kills the "big number, no idea what it means" failure mode.

---

## 10. Build order

Sequenced so each phase makes the next cheaper. Every phase is independently shippable.

| Phase | What | Why here |
|---|---|---|
| **0** | Chrome: breadcrumbs, title/action row, org anchor, demo banner | Pure layout; unblocks every page below |
| **1** | `<DataTable>` contract + `SavedView` + filter chips + column picker + pagination string | The compounding one. Every list and report consumes it. |
| **2** | Reports catalog + report control contract + zero-balance toggle + **cell drill-down** | Shell over existing reports; drill-down is the highest-value single feature and needs phase 1's chips |
| **3** | Tag-group UI over the **existing dimension engine** + dimension columns on lists | Wakes a seam that has been empty since v0.2 |
| **4** | Validation Rules, enforced inside `postJournalEntry` | Only useful once dimensions are enterable (phase 3) |
| **5** | Objects settings hub; migrate scattered admin screens into it | Mechanical once 1 and 3 exist |
| **6** | Agent console — catalog, per-agent settings, runs, actions | **Gated on the §5.3 decision.** Do not start before it. |
| **7** | Connections config + entity mapping | Independent; slot where convenient |
| later | Budgets + Budget vs Actual; contract detail tabs; usage tiers | Each needs its own design doc |

Phases 0–2 are, on the evidence here, most of the perceived distance between the two products.

---

## 11. Open decisions — for Chris

1. **§5.3 is the big one.** Two bands or three? If three, does a standing policy approved by an authorised human satisfy non-negotiable #3? This changes what the product is allowed to do on its own and should be decided in words before it is decided in code.
2. **Saved views: private, shared, or both?** Shared views are a small permissions surface (who may edit a view others depend on).
3. **Does auto-apply, if adopted, need its own approval authority** — i.e. may only someone who can approve $50k set a $50k auto-apply threshold? (Recommend yes; it is the same authority, relocated.)
4. **Departments** — Campfire treats them as a first-class object separate from tags. Do we add a `Department` model, or is department just another dimension? (Recommend: another dimension. One dimensioning concept.)
5. **Budgets** — real model, or defer until someone asks?
6. **Drill-down target** — does a report cell open the transactions list pre-filtered, or a modal? (Recommend the list: it is a real URL, shareable and back-button-able.)

---

## 12. Sources

Fourteen screenshots of `app.meetcampfire.com` supplied by Chris, 2026-08-08, from one demo org: dashboard; transactions list; income statement; tag groups; validation rules (+ create modal); Ramp connection settings; budget vs actual; reports catalog; agents catalog; AR agent settings; contracts list; contract detail; products & services (+ usage-tier popover); invoice detail.

Everything about ledger-core in this doc was checked against `main` at the time of writing — schema model list, route table, `NAV_SECTIONS`, `tailwind.config.ts` — not recalled. Where a Campfire behaviour is inferred rather than observed, it is marked. Re-verify before building against any inference.
