# Design: Campfire's product surface, and what we take from it

**Status:** study + build spec. No code committed.
**Author:** Chris (screenshots + direction) + Claude (study + design), 2026-08-08.
**One line:** Fourteen screenshots of Campfire's running product, read against what `ledger-core` already ships, converted into a copy-this / don't-copy-this list with a build order.
**Contents:** §0–2 evidence and gap · §3–7 the surface contracts (URL, chrome, detail, list, accountability) · §8 the agent console · §9–11 reports, settings, revenue · §12–13 details and their defects · §14–16 what we skip, build order, decisions · §17 screen-by-screen inventory.

**Companions — read these first, this doc does not repeat them:**
- [`competitive-landscape-campfire-rillet.md`](./competitive-landscape-campfire-rillet.md) (2026-07-16) — *should* we compete, and where. Strategic read stands unchanged.
- [`automation-library.md`](./automation-library.md) (2026-07-16) — the governance thesis for standing approvals. §8 below is that thesis with Campfire's shipped control surface attached to it.
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
| **Filter state carried in the URL** | not systematic | **Missing — foundational, §3** |
| **Line-level transactions list** | `/journal-entries` is header-level | **Missing — the drill-down target, §6** |
| Detail-page field-grid contract | bespoke per entity | Missing, §5 |
| Agent runs / actions / usage (cost) surface | none | Missing, §7 |
| Account rollup toggle on statements | not found | Missing, §9 |
| Per-product GL account mapping | posting rules, not on `Item` | Different approach, §11 |
| Usage groups + tiers | `Item` only | Missing, §11 |
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
| **Agent console** (catalog, approval routing, confidence bands, runs) | none — `automation-library.md` is design-only | **Missing; §8** |
| Contract detail w/ 9 sub-object tabs | `RevenueContract` model | Missing UI |
| Products & usage tiers | `Item` model | Partial |
| Budget vs Actual report | no `Budget` model | Missing |
| Departments / Payment Terms / Tax Rates / Prepaids / Payees / Product Bundles / Cost Allocations / Contract Templates | **no models** | Missing |

Nothing in the "missing" column is architecturally hard. Most of it is a table component and a settings shell.

---

## 3. The URL and state contract — the architectural finding

Easy to miss, and the most structural thing in the screenshots. Every filterable surface carries its **entire state in the query string**:

```
/v2/accounting/transactions?account=2001&accountName=Usage-BasedRevenue
    &account_rollup=true&start_date=2026-04-01&end_date=2026-06-30

/v2/reporting/income-statement/v2?startDate=2026-01-01&endDate=2026-08-18
    &cadence=quarterly
```

Four consequences follow, and they are the reason several later sections are cheap rather than hard:

1. **Drill-down is just a link.** A report cell knows its account and its period; the transactions list reads both from the URL. §9's drill-down needs no modal, no shared client store, no new endpoint — it needs an `<a href>`. This is why it is the highest-value/lowest-cost item in the whole document.
2. **Views are shareable and bookmarkable.** "Look at this" between a controller and a reviewer is a pasted link, not a screen-share. For a close process that is a real workflow improvement.
3. **Saved views become almost trivial.** If state already round-trips through the URL, a `SavedView` is a stored query string plus a name (§6). Build the URL contract *first* and the saved-view feature mostly falls out.
4. **The back button works**, including out of a drill-down.

⚠️ **Two things their scheme gets wrong that we should not replicate.** `accountName=Usage-BasedRevenue` duplicates data derivable from `account=2001` — two sources of truth in one URL, and the display name is the one that will drift. And the params are inconsistently cased in the same product: `start_date` / `end_date` on transactions, `startDate` / `endDate` on the income statement. Pick one convention repo-wide and pin it in a test.

**Also note the `/v2/` prefix on every route**, and `/income-statement/v2` — a second `v2` on the report itself. They version the app surface *and* individual screens in the path. That buys a parallel-run migration (old and new report side by side) at the cost of a permanent URL scar. Worth knowing the trade exists; not worth adopting pre-emptively for a product with one customer.

---

## 4. The chrome — copy wholesale

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

## 5. The detail-page contract

Contract detail and invoice detail are the same object, which means it is a contract and not a one-off. Ours are bespoke per entity.

**Shape:** a dense read-only **three-column field grid**, label above value, small muted label, larger value. Roughly 30 fields on a contract, 30 on an invoice. Then a horizontal rule, then a **tab strip of related objects**, then the selected tab's content.

Rules the screenshots enforce consistently:

| Rule | Evidence |
|---|---|
| **Empty is `-`, never blank** | `Minimum Monthly Commitment -`, `Department -`, `Paid Date -` |
| **Every field shows, even when null** | Whole rows of `-` are present rather than collapsed. The reader learns the field exists. |
| **Foreign keys are links, with their id beneath** | `Customer / Abacum` (underlined) / `CUST-0000191 ⧉` |
| **Ids carry a copy-to-clipboard icon** | `CUST-0000191 ⧉` — reference numbers exist to be pasted elsewhere |
| **Cross-object jumps are explicit** | `View Transaction ↗` under the invoice title; `Contract: Ro Studios` as a link |
| **Status is a pill beside the title** | `Invoice #INV-0004347` + `Not Sent` |
| **Lineage is a visible field** | `Source: MANUAL` on the contract — ⚠️ see the correction below |

⚠️ **CORRECTION (#382): "ours shows none of it" was wrong.** The journal-entry detail page rendered four of the five lineage fields — `sourceSystem` and `sourceRecordType` in a header badge, `sourceRecordId` and `mappingVersion` in the field grid — plus the frozen `sourcePayload` in a panel below. What it did wrong was **collapse** them: all three places were behind `{x && …}`, so the lineage was invisible on a manual entry and split across three parts of the page on an imported one. No single view of the quintuple existed. Written from the screenshots without checking the page, this row overstated a real problem into a different one. The fix was the rule below, not new fields.

**Copy the "every field shows, even when null" rule specifically.** A CPA reading a contract needs to know that `Auto Renew` is a field that exists and is empty, not wonder whether the screen omitted it. Collapsing empty fields is a consumer-app instinct and it is wrong here.

⚠️ **We had already discovered this rule and not shared it.** Three `Field` components existed, one per detail page, with three signatures and three visual treatments — and the never-blank behaviour was built into exactly one of them (`admin/audit-log/[id]`, `{valueNode ?? value ?? "—"}`), while `recurring-entries/[id]` implemented it by hand at every call site and `journal-entries/[id]` did not implement it at all. The contract was not missing; it was written three times and agreed on nothing. `src/components/ui/field-grid.tsx` is the merge, and `tests/detail-page-contract.test.ts` fails if a page defines its own again.

**Two FX fields, deliberately distinct:** `Exchange Rate Book (USD to USD)` and `Exchange Rate (USD to USD)`. Book rate vs transaction rate as separate stored values. We have the same distinction in `resolveFxRate`'s CLOSE/AVG curves and surface neither on a document.

**Three date concepts on the invoice, all separate:** `Accounting Date` (the GL date), `Invoice Date` (the document date), `Period Start` / `Period End` (the service window), plus `Due Date` and `Paid Date`. Conflating any two of these is a classic accounting-software error and they have not made it.

**The tab strip** on the contract: `Revenue | Subscriptions | Usage | Milestones | Invoices | Credit Memos | Sales Commissions | Attachments | Journal Entries`. Nine related collections under one parent, no route explosion. `Journal Entries` as a tab on a business document is the pattern worth stealing hardest — it is the "show me the accounting behind this" affordance, and it is exactly what a reviewer asks for.

---

## 6. The list contract — the highest-leverage copy

Every Campfire list is the same object. Ours are each hand-rolled. **One `<DataTable>` contract, adopted everywhere, is worth more than any single feature in this document.**

⚠️ **First, a finding that changes what the transactions list *is*.** In the screenshot, transaction `0010521` appears on **twelve consecutive rows**, each with a different description and credit amount, all against `4010 - Usage-Based Revenue`. So their transactions list is **line-level, not header-level** — one row per `JournalLine`, with the entry number repeated and hyperlinked.

That is the right choice for the surface a report cell drills into (§3): you clicked a number in a cell, so you want the *lines* that make it up, not the entries that contain them. Our `/journal-entries` is header-level. **We need both**, and they are different screens with different columns:

| | Header-level (`/journal-entries`) | Line-level (a new `/transactions`) |
|---|---|---|
| Row | one `JournalEntry` | one `JournalLine` |
| Columns | date, number, memo, source, status, total | date, entry #, account, debit, credit, description, dimensions |
| Answers | "what did we post" | "what is in this account" |
| Drill target | no | **yes** — this is where §9's cell links land |

The line-level list is the missing half, and §3 makes it the drill-down destination.

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

## 7. Runs, actions, and usage — the accountability surface

Three sibling tabs sit beside the agent list — `Chat | Agents | Actions | Usage | Settings` — and each agent additionally has `Settings | Runs | Actions`. That is a two-level accountability model and it is more considered than it first looks:

- **Runs** — execution history per agent. When it fired, what it looked at, what it concluded.
- **Actions** — the queue of things agents want to do or have done, both per-agent and globally. This is where an approval queue lives.
- **Usage** — cost. The dashboard tile reads `Ember chats 120 / 68M input tokens and 536.3K output tokens`, so token spend is surfaced on the *home screen*, not buried in billing.

**Take all three, and take the cost transparency especially.** An accounting product whose AI spend is invisible is a product a CFO will not trust. Putting tokens on the dashboard is a confident, correct decision.

`Runs` is also the audit answer. When someone asks "why did the system do this in March", the reply must be a record, not a reconstruction — which is the same argument as persisting the confidence score in §8.3.

A browser tab in one screenshot reads **`New | Ember Studio`** — an agent *authoring* surface we never see the inside of. Combined with 100 custom agents and snake_case names like `accrual_pattern_discovery_v2`, the inference is that customers write their own agents in a dedicated editor with hand-rolled versioning. Flagging it as an unknown worth knowing about, not as something to build.

---

## 8. The agent console — the important one

This is the gap the July doc called "category-defining… and uniquely cheap to close here, because it's Claude" (§B.1), and `automation-library.md` already wrote our governance thesis: *an automation library relocates approval from per-transaction to per-policy, explicitly, logged and revocable.*

**Campfire has shipped the control surface that thesis specified.** That is the single most valuable thing in these screenshots, and we should take its structure almost verbatim.

### 8.1 The catalog

Agents are **cards in a filterable grid**: `All 109 · Continuous 7 · On-Demand 2 · Custom 100`. Each card is icon + name + optional `Inactive` pill + one-line description. Built-ins read as capabilities (`Continuous Close` — "Identifies uncategorized items and proposes actions"; `Accounts Receivable` — "Cash application, payment matching, and AR aging analysis"; `Fixed Asset Capitalization` — "Reviews expenses for items that should be capitalized per your policy"). Custom agents carry **creator attribution** (avatar + "Created by William Tu").

Three things to take:
- **The continuous / on-demand split.** A standing watcher is a different governance object from a thing you run once. Our automation library should carry the same distinction.
- **Inactive is a visible state on the card**, not a hidden setting. Seven of the observed built-ins ship off.
- **Creator attribution on custom agents.** Provenance is the Puzzle-bar problem `automation-library.md` §7 already flagged; this is a cheap piece of it.

### 8.2 The governance control — copy this exactly

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

### 8.3 Where we must diverge — and it is not optional

**`CLAUDE.md` non-negotiable #3: AI suggests; humans approve; the system posts.**

Campfire's third band **auto-applies cash application**, which is a ledger write. Adopting that band as-shown would violate our canon. Two honest options, and this is a **decision for Chris, not a thing to infer**:

- **(a) Two bands for anything that posts.** `Not shown | Needs review`, with the auto-apply band available only for non-posting actions (categorisation suggestions, draft creation, flagging, notification). The canon stays absolute.
- **(b) Three bands, where auto-apply is redefined as a *standing* approval** — exactly the relocation `automation-library.md` §2 argues for — provided that: the policy itself was approved by a human with the authority to approve that dollar amount; every auto-applied action writes `source: "AI_APPROVED"` plus an `audit_log` row naming the policy and the confidence score; and the policy is revocable with one click and the revocation is logged.

(b) is defensible and is what the automation-library doc already argues for. It is still a **change in what non-negotiable #3 means in practice**, and that is Chris's call to make explicitly rather than something that arrives inside a feature.

Whichever is chosen: **the confidence score must be persisted on the action**, not just used at runtime. An auditor asking "why did this post itself" needs a number, a policy id and a timestamp, not a shrug.

---

## 9. Reports — a catalog, and one control contract

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

**Account rollup — the structure under the tree.** The income statement nests accounts *inside a parent of the same code*: `⌄ 4000 - Service Revenue` contains `4000 - Service Revenue`, `4002 - Service Revenue [ADJUSTING]`, `4003 - Subscription Revenue`, `4010 - Usage-Based Revenue`, then a named subtotal `Total for Service Revenue`. The transactions URL carries `account_rollup=true`, so rollup is a *parameter*, not a fixed hierarchy — the same account list renders flat or grouped.

Two things follow. **`[ADJUSTING]` is a first-class marker in the account name**, matching their `Primary vs Adjusting` report — adjusting entries are separable at the account level, which is the thing a reviewer wants during close. And **rollup must be a toggle**, because a controller reading and an auditor tying out want different granularities from the same statement.

**Two details worth stealing precisely:**
- **Negatives in parentheses**, `($406,499.47)`. Accounting convention, not a minus sign. **`formatMoney()` already does this** (`src/lib/utils/format.ts`) — the gap is that not every report renders through it.
- **The selected cell has a focus ring** — `$293,632.84` is boxed. A report cell is a **drill-down affordance**: cell → the transactions behind it. That is the single most-requested thing in any close tool and we have every part needed to build it (the transactions list, the filter chips, the account and period are both known at the cell).

**Budget vs Actual** needs a `Budget` model we do not have: budget rows keyed `(tenantId, entityId?, departmentId?, accountId, periodId, amount)`, then the report is `Budget | Actual | Difference | Percentage` per period band. Note their header block prints the budget's *own* metadata (name, breakdown type, cadence, start/end) above the table — good practice for a report whose meaning depends on which budget it ran against.

---

## 10. Objects & Automations — the settings hub

Campfire's settings is a **three-column shell**: nav ▸ settings-nav ▸ content, grouped `Your Account` / `Objects` / `Automations` / `Developer`. Roughly eighteen master-data CRUDs sit under Objects, each the same table + `Create X` + search + column-picker + export.

### 10.1 Tag Groups → our dimension engine

The best find in the screenshots. Campfire has **Tag Groups** (`Region`, `Project`, `Location`) — a named group, each holding values, applied to transactions and contracts. The contract detail shows `Department / Tag / Location / Project / Region` as first-class fields; the contracts list shows them as columns.

**That is our dimension engine.** `Dimension` = tag group, `DimensionValue` = tag, `DimensionSet` = the deduplicated combination on a line. The engine is built, canonical (`getOrCreateDimensionSet`), and `CLAUDE.md` describes it as *"an empty table seam since v0.2"*. Campfire shows exactly what the seam is for.

**Build the UI over the existing engine. Do not add a parallel `Tag` model.** A second dimensioning concept would be an anti-pattern against a LOCKED schema and would fragment reporting forever.

### 10.2 Validation Rules

A two-step builder: **Conditions** → **Requirements**. Their own example is the giveaway:

> "To require a department on all operating expense transactions, select 'Account Type is one of' → 'Operating Expense', then proceed to the next page."

So validation rules exist primarily to **make dimensions mandatory conditionally** — which is what turns a dimension engine from optional metadata into data you can actually report on. Rules are `(name, conditions[], requirements[])`, conditions are `field / operator / value` with `is empty | is filled | contains | excludes | is one of`.

This is **not** our posting-rules engine — that derives *lines* from a source event. Validation rules gate *field completeness* before a write. Different job, different table, and worth saying out loud so nobody tries to overload the `$.path` DSL, whose minimalism is deliberate.

Enforcement point: inside `postJournalEntry`, alongside the existing balance/period/account checks, so it cannot be bypassed by a caller.

### 10.3 Connections

Per-integration config (`Ramp` observed): title, last-synced timestamp, pull-from date, `Refresh Token / Exit / Save`, sync-settings tabs (`General / Card Transaction / Reimbursement / Bill Pay`), labelled toggles each with a description line, and an **entity-mapping table** — `Ramp Entity → Campfire Entity → Ramp Card Account → Reimbursement Liability`. The mapping table is the important part: the integration is *configured*, not assumed, and the mapping is visible.

We have QBO and NetSuite mappers with no configuration surface at all. The entity-mapping table is the shape to build. ⚠️ **Any connection UI touches stored credentials** — tokens stay encrypted at rest, are never rendered, and `Refresh Token` must be an action that never displays the value.

---

## 11. Revenue — contracts, products, usage tiers

The detail-page shape is §5; this section is what is *specific* to the revenue surface.

**Contracts list.** Columns: `Name | Customer | Consultant | Department | Tag | Location | Project | Region | Status | date | Edit`. Five of eleven columns are **dimensions** (§10.1) — which is the argument for the tag-group UI stated as a screenshot rather than an opinion. Name renders as a bordered chip, customer as a two-line cell (link over muted id), status as a dot + word (`Active`, `Pending ●`).

**The contract field grid** carries commercial terms our `RevenueContract` does not model: `Minimum Monthly Commitment` and its `Quantity`, `Evergreen`, `Auto Renew` + `Auto-renewed Term (months)` + `Auto Renew Invoices`, `Skip Evergreen Invoice Generation`, `Price Increase Percentage`, `Billing Frequency`, plus CRM lineage (`CRM ID`, `CRM Link`, `Contract Link`, `Purchase Order Number`). Evergreen + auto-renew + price escalation are the three that change *revenue schedules*, so they are not cosmetic fields — they are ASC 606 inputs. Worth a gap review of `RevenueContract` against this list before building any contract UI.

**Products carry their own GL mapping.** Each product row maps to a **deferred** account, a **revenue** account, and an **AR** account (`2100 - Deferred Revenue`, `4003 - Subscription Revenue`, `10035 - Account Receivable`). That is per-product posting configuration living on master data rather than in code — the same job our posting-rules engine does, reached from the other end. Note two different AR accounts in use across products (`10035` and `1100 - Accounts Receiva…`), so it is genuinely per-product, not a default.

**Usage tiers.** A `groups` link opens a hover popover with `Usage Group | Tier | Type | Range | Price`:

```
API Overage        1       Fixed   0 – 9999          0
                   Tier 2  Fixed   10000 – No limit  2.5
Number of Sessions         Fixed   0 – 15            0
                   Tier 2  Fixed   16 – 30           100
                   Tier 3  Fixed   31 – No limit     150
Seat Overage       1       Fixed   0 – 9             0
                   Tier 2  Fixed   10 – No limit     100
```

Reading the model out of it: a product has *many* usage groups; a group has *many* ordered tiers; a tier is a half-open integer band with a price and a `Type`. `Type: Fixed` implies at least one sibling type (per-unit or percentage). Bands are contiguous and the last is open-ended.

A first-cut shape, deliberately mirroring the dimension engine's discipline of one concept per table:

```
UsageGroup { id, tenantId, itemId, code, name }
UsageTier  { id, tenantId, usageGroupId, ordinal Int,
             fromQty Int, toQty Int?,        // null = no limit
             type "FIXED" | …, price Decimal
             @@unique([usageGroupId, ordinal]) }
```

⚠️ `ordinal` is an **integer**, and the label is rendered from it. Their own popover shows `1`, `Tier 2`, `Tier 1`, `tier 1` in one table because the tier name is free text (§13). Bands must also be validated contiguous and non-overlapping at write time — a gap between tiers is silent under-billing, and an overlap is ambiguous pricing.

Usage-based revenue is a real ASC 606 surface and our `Item` model is thin next to this. **It needs its own design doc**; this section exists to record the observed model, not to specify ours.

## 12. Charts, empty states, and the small stuff

**The cash-flow chart** (dashboard) is worth specifying because the encoding is a deliberate choice, not a default:

- Paired bars per month: **Cash In** above the axis (sage), **Cash Out** *below* the axis (near-black), **Net Cash Flow** as a third, paler, narrower bar to the right of the pair.
- Signed encoding — outflow is drawn negative rather than as a second positive series. You read direction from geometry before you read the legend.
- Axis `$40M / $20M / $0 / -$20M / -$40M`, symmetric about zero.
- Controls above the plot: date range, entity, and a `Weekly | Monthly | Quarterly` segmented control with the active segment filled.
- Legend as dot + label under the plot.

Against our `dataviz` guidance: three series, one categorical axis, signed values — a grouped bar with a zero baseline is the right form. Reuse the tone tokens (`positive` / `ink` / a muted third) rather than inventing chart colours.

**Empty states are stated, not hidden:**

| Observed | Why it is right |
|---|---|
| `Runway n/a` | The KPI still renders with its label. A missing tile makes the reader wonder if it broke. |
| `No usage revenue.` in a bordered box | Bounded, centred, muted — the container is visible so the tab is clearly *empty*, not *broken* |
| Notifications: a bell glyph, centred | Iconic empty state for a panel with no rows |
| `-` everywhere in field grids | §5 |

**Small details worth lifting verbatim:**

- **Search placeholders say what is searched** — `By number or description`, `Search tag groups`, `Search agents…`. Not "Search".
- **Toggle rows are label + description + control**, never a bare switch. Every toggle in the Ramp connection explains its consequence in one sentence at the point of use.
- **Counts live on the filter itself** — `All 109 · Continuous 7 · On-Demand 2 · Custom 100`. You see the distribution before you click.
- **The period is inside the metric label** — `Revenue (Jul)`, not a caption elsewhere.
- **Deltas carry direction and base** — `↗ 208.4% vs Jun 2026`. Arrow, magnitude, and comparison period in one line.
- **Section-level totals are named** — `Total for Service Revenue`, not a bare bold row.
- **`No limit` is spelled out** as a tier's upper bound rather than left blank.

---

## 13. What their own product gets wrong — the anti-checklist

"Copy it wholesale" cuts both ways: several things visible in fourteen screenshots are defects, and copying uncritically would import them. Each of these is cheap to avoid at the start and expensive to fix later.

| Defect | Evidence | What we do instead |
|---|---|---|
| **Two pagination vocabularies** | Transactions: `Page Size 20 ▾ · 1 to 20 of 42 · Page 1 of 3`. Products: `Show 50 per page · 247 products · Page 1 of 5` | One component, one wording, everywhere. Pin it in the `<DataTable>` contract (§6). |
| **Slider label ≠ card label** | The confidence slider's middle zone reads `Needs review`; the explainer card beneath it reads `Sent for review` | One name per concept. A governance control is the *last* place to be loose with vocabulary. |
| **Free-text tier ordinals** | In one popover: `1`, `Tier 2`, `Tier 1`, `tier 1` — four spellings of a tier number in a single table | Tier is an integer with a rendered label, never typed. See §11. |
| **snake_case leaking into a Title Case UI** | `Reference_ID` on the invoice, beside `Purchase Order Number` | Field labels are presentation. Never render a column name. |
| **Redundant, drift-prone URL params** | `account=2001&accountName=Usage-BasedRevenue` | Ids in the URL; resolve names server-side (§3). |
| **Mixed param casing in one app** | `start_date` vs `startDate` | One convention, enforced by a test. |
| **Engineering test data in the customer-facing demo** | Contracts list shows `E2E PR3 review-fixes verification 2026-08-14`, `E2E PR3 partial-config`, `E2E PR3 order-fidelity`, all `Pending`, alongside real-looking rows | ⚠️ **We have had precisely this failure**, which is what #366–#369 were about: nine test suites writing into shared Northwind. Their demo org shows what it looks like when nobody closes that loop. Our `seeded-company` foreign-entry check and the `rls-*` cleanup work exist to prevent exactly this screenshot. |
| **Nav label ≠ page title** | Nav says `Products & Services`; the page says `Products` | Same string in both places, from one source. |
| **A 109-item agent catalog** | 100 of 109 are user-created; several first-party ones ship `Inactive` | Quantity is not a feature. Ship six that work. |

The test-data one deserves emphasis. It is the only defect here that is *invisible to the vendor* and *visible to every customer*, and it is the one we have already paid to fix. Keeping it fixed is a maintained property, not a completed task.

---

## 14. What we deliberately do not copy

| Not copying | Why |
|---|---|
| Their nav taxonomy | Ours is CPA-shaped; theirs is SaaS-controller-shaped. Deliberate divergence (§4). |
| "Ember", their icons, their copy verbatim | Not ours to take (§0). |
| A 109-agent catalog | 100 of 109 are user-created. The *platform* is the product; a shipped catalog of 109 is a vanity count. Ship ~6 that work. |
| Auto-apply on ledger writes, as-shown | Non-negotiable #3. See §8.3 — needs an explicit decision, not a default. |
| Vanity KPI tiles | Their dashboard leads with **work queues** (overdue AR, uncategorized, approvals) — 3 of the top 4 cards are problems, not achievements. That is the *right* instinct for an operate surface and is the thing to copy; the specific tiles are not. |
| Their demo magnitudes | §0. Demo data. |

**One dashboard detail that *is* worth copying:** every KPI carries a denominator sub-line — `$558M` / *"across 1,804 invoices"*, `$107,286,465.47` / *"8 cash accounts"*, `$118M` / *"806 active contracts"*. **A number is never alone.** Cheap rule, and it kills the "big number, no idea what it means" failure mode.

---

## 15. Build order

Sequenced so each phase makes the next cheaper. Every phase is independently shippable.

| Phase | What | Why here |
|---|---|---|
| **0** | **URL/state contract** — every filterable surface reads and writes its state to the query string | §3. Foundational: phases 1, 2 and 2b all get cheaper, and drill-down becomes an `<a href>` |
| **0b** | Chrome: breadcrumbs, title/action row, org anchor, demo banner | Pure layout; unblocks every page below |
| **1** | `<DataTable>` contract + `SavedView` + filter chips + column picker + one pagination component | The compounding one. Every list and report consumes it. Trivial after phase 0. |
| **2** | Reports catalog + report control contract + zero-balance toggle + rollup toggle | Shell over reports that already exist |
| **2b** | **Line-level `/transactions` list, and drill-down from a report cell into it** | §6's finding + §9's affordance. The single highest value/cost ratio in the document, and it needs 0, 1 and 2 first. |
| **3** | Detail-page contract; apply to JE, invoice, contract, asset | §5. Independent of 1–2; pairs well with 2b (drill from a line to its document) |
| **4** | Tag-group UI over the **existing dimension engine** + dimension columns on lists | Wakes a seam empty since v0.2; five of eleven contract-list columns are dimensions |
| **5** | Validation Rules, enforced inside `postJournalEntry` | Only useful once dimensions are enterable (phase 4) |
| **6** | Objects settings hub; migrate scattered admin screens into it | Mechanical once 1 and 4 exist |
| **7** | Agent console — catalog, per-agent settings, **runs, actions, usage** | **Gated on the §8.3 decision.** Do not start before it. Runs/actions/usage are not optional extras — they are the audit answer. |
| **8** | Connections config + entity mapping | Independent; slot where convenient |
| later | Budgets + Budget vs Actual; contract tab strip; usage groups & tiers | Each needs its own design doc. §11 records the observed usage model; it does not specify ours. |

**Phases 0 through 2b are, on the evidence here, most of the perceived distance between the two products** — and none of them is an accounting feature. That is the whole finding of §1 restated as a schedule.

---

## 16. Open decisions — for Chris

1. **§8.3 is the big one.** Two bands or three? If three, does a standing policy approved by an authorised human satisfy non-negotiable #3? This changes what the product is allowed to do on its own and should be decided in words before it is decided in code.
2. **Does auto-apply, if adopted, need its own approval authority** — may only someone who can approve $50k set a $50k auto-apply threshold? (Recommend yes; it is the same authority, relocated.)
3. **Saved views: private, shared, or both?** Shared views are a small permissions surface — who may edit a view other people depend on.
4. **Departments** — Campfire treats them as a first-class object *separate* from tags. Do we add a `Department` model, or is department just another dimension? (Recommend: another dimension. One dimensioning concept, per §10.1.)
5. **Two transaction lists, or one?** §6 argues header-level and line-level are different screens. Confirm we want both `/journal-entries` and a new line-level `/transactions`, rather than one list with a toggle.
6. **Drill-down target** — report cell opens the line-level list pre-filtered, or a modal? (Recommend the list: it is a real URL, shareable and back-button-able — which is the point of §3.)
7. **URL param convention** — `snake_case` or `camelCase`? Pick one and pin it in a test, so we do not end up with Campfire's `start_date` / `startDate` split (§13).
8. **Budgets** — real model, or defer until someone asks?
9. **Does `RevenueContract` need the commercial terms in §11** (evergreen, auto-renew, price escalation, minimum commitment)? Those three change revenue *schedules*, so this is an ASC 606 question, not a UI one.

---

## 17. Appendix — screen-by-screen inventory

Recorded so the doc stands without the images. Ordered as supplied.

**1 · Dashboard** (`/v2/dashboard`) — Time-aware greeting ("Good morning, Brad!"). Header: search, `Ask Ember`, `?`. **Row 1, four large cards, all work queues**: Overdue AR `$558M` / "across 1,804 invoices"; Uncategorized Transactions `1,388` / "need a category"; Approvals needed `156` / "items need approval"; Ember chats `120` / "68M input tokens and 536.3K output tokens". **Row 2, five denser cards, financial state**: Cash `$107,286,465.47` / "8 cash accounts"; Revenue (Jul) `$52M` / `↗ 208.4% vs Jun 2026`; ARR `$118M` / "806 active contracts"; Burn Rate `-$6.4M` / "Runway n/a"; Overdue AP `$14M` / "across 456 bills". Cash-flow chart (§12). Right rail: `Quick links` (user-configurable, `+` to add) — Entities, Balance Sheet, Contracts, Amortizations, Checklist, Budgets, Cash Flow, Consolidation, Reports; then Notifications with a bell empty state.

**2 · Transactions** (`/v2/accounting/transactions?…`) — §3 URL, §6 list contract. Control bar labelled above each control: Date Range, Transaction Type, Filters (`1 Applied ×`), Transaction View (`Select a view` + 💾 + 🗑), Report Currency (`Consolidation Currency (USD)`), Search (`By number or description`). Sage filter chips + `Clear all`. Line-level rows; `Actions ▾` per row; right-edge `Columns` tab. Accounting sub-nav: New Journal Entry, New Intercompany Journal Entry, Invoices, Bills, Vendors, Credit Memos, Debit Memos, Amortizations, Fixed Assets, Leases, Transactions, General Ledger — note **creating a JE is a nav destination, not a button**.

**3 · Income Statement** (`/v2/reporting/income-statement/v2?…`) — Subtitle defines the report. Controls: Report Range, Cadence (`Quarterly (Calendar)`), Entity (`All entities`), `Show Zero Balance Accounts` toggle; right: View + 💾 + Download; below: Group By, Filter, collapse/expand. Columns Q1/Q2/Q3/Total. Account rollup tree with named subtotals; `[ADJUSTING]` accounts; negatives in parens; **one cell carries a focus ring** — the drill-down affordance. Reporting sub-nav: Income Statement, Balance Sheet, Cash Flow, Trial Balance, Primary vs Adjusting, Budgets, Reports, Consolidation, IC Reconciliation.

**4 · Tag Groups** (`/v2/settings/tag-groups`) — Magenta dismissible demo banner. Three-column settings shell. Table `Name | Created At` + Edit/Delete; rows Region, Project, Location. `Create Tag Group`, search, column-picker + download icons.

**5 · Validation Rules** (`/v2/settings/validation-rules`) — Table `Description | Conditions | Requirements`. Modal is a two-step wizard: Conditions → Requirements, with an explanatory paragraph and a worked example in the modal body. Condition row `[Select field] [Select operator] [Select field first ×]` — **the value control is disabled until a field is chosen** and says so. `+ Add Condition`, `Next`. Settings nav also shows `Tags` **and** `Tag Groups` as separate items, confirming group-vs-value.

**6 · Ramp connection** (`/v2/settings/ramp/7446`) — §10.3. Title = connection instance name, `Last Synced June 18, 2026 14:48`, `Refresh Token / Exit / Save`. `Pull From Date`. Sync tabs `General | Card Transaction | Reimbursement | Bill Pay`. Three labelled toggles with descriptions. Entity-mapping table with clearable comboboxes across four columns.

**7 · Budget vs Actual — Income Statement** — Metadata header printing the budget's own identity: Budget `2026 Budget by Department`, Entity, Department, Breakdown Type `Department-based`, Cadence `Quarterly`, Start `1/1/2026`, End `12/31/2026`, Description. Controls: Group By, Filters, `Consolidate` toggle, `Use Entity Currency` toggle. Per-quarter column groups `Budget | Actual | Difference | Percentage`. **ALL-CAPS section rows carry chevrons; ALL-CAPS computed rows (GROSS PROFIT, OPERATING INCOME, NET INCOME) do not** — expandability signals derivation.

**8 · Reports catalog** (`/v2/reporting/reports`) — Tabs `All Reports | Favorites | General | Revenue | Expenses | Cash | Receivables | Payables | Tax | Custom`. Cards: title, ☆, `Campfire` provenance badge, one-line description; variable height. General: Comparative Income Statement, Comparative Balance Sheet, Fixed Asset Waterfall, Fixed Asset Rollforward, Fixed Asset Reconciliation. Revenue: Revenue By Customer, Unearned Revenue By Customer, Deferred Revenue By Customer, Deferred Revenue Waterfall (Non-Contract), Contract Deferred Revenue Waterfall, Contract Deferred Revenue Rollforward, Contract Recurring Revenue Waterfall.

**9 · Agents** — `Chat | Agents | Actions | Usage | Settings`. `All 109 · Continuous 7 · On-Demand 2 · Custom 100`. First-party agents have distinct glyphs; custom agents use a robot glyph, snake_case names, and creator attribution. Several first-party agents ship `Inactive`. One is scheduled ("Runs every January 1st").

**10 · AR agent settings** — `Settings | Runs | Actions`. Features (`Payment Matching`, on). Approval Routing `Threshold` + `$10,000.00`. Two-handle confidence slider over a red→amber→green gradient with three explainer cards. Notification Settings below.

**11 · Contracts** (`/v2/revenue/contracts`) — §11. `1 to 20 of 1,429`, Page 1 of 72. Revenue sub-nav: Dashboard, Contracts, Customers, Transactions, Demo Revenue, Snowflake Revenue — the last two look like usage-data sources.

**12 · Contract detail** — §5 + §11. Tab strip of nine related collections; `Usage` tab selected, `Create Usage Data`, empty state "No usage revenue."

**13 · Products & Services** — §11. `Show 50 per page · 247 products`. Hover popover with the tier table.

**14 · Invoice detail** (`/v2/accounting/invoices/13502582`) — §5. `Not Sent` pill, `View Transaction ↗`. `Message On Invoice` holds full remittance instructions (bank name, address, SWIFT/BIC, account number and type, account name) plus a `[Download W9]` link — i.e. **the invoice carries a reusable remittance/compliance template**, which is a real feature hiding in a text field. Browser tabs in this shot also reveal `Ember Studio` (§7).

---

## 18. Sources

Fourteen screenshots of `app.meetcampfire.com` supplied by Chris, 2026-08-08, from one demo org: dashboard; transactions list; income statement; tag groups; validation rules (+ create modal); Ramp connection settings; budget vs actual; reports catalog; agents catalog; AR agent settings; contracts list; contract detail; products & services (+ usage-tier popover); invoice detail.

Everything about ledger-core in this doc was checked against `main` at the time of writing — schema model list, route table, `NAV_SECTIONS`, `tailwind.config.ts` — not recalled. Where a Campfire behaviour is inferred rather than observed, it is marked. Re-verify before building against any inference.
