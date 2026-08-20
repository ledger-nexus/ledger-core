// The single source of truth for navigation destinations.
//
// Both the sidebar and the ⌘K command palette consume this. Before the
// palette existed, this data lived inline in sidebar.tsx; extracting it
// here keeps the two surfaces from drifting — a page added to the nav is
// automatically reachable from the palette, and vice versa.
//
// Organization follows NetSuite's Accounting Center taxonomy, translated
// from hover-menus to a sidebar. The owner's ruling on the earlier
// Pareto-compressed design ("top items + More (N)") was that hiding
// destinations costs more than it saves: a controller wants the complete
// map. So EVERY destination is visible, grouped by the domains an
// accountant already carries — Transactions (things that post),
// Sub-ledgers (open-item registers), Lists (standing records the posts
// point at — NetSuite's own word), Reports (every report enumerated, the
// way NetSuite's Reports menu does it), Period & close (this product's
// deepest suite, shown in full), and Setup (admin).

export interface NavItem {
  href: string;
  label: string;
  hint?: string;
}

export interface NavSection {
  label: string;
  items: NavItem[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    label: "Overview",
    items: [
      { href: "/", label: "Dashboard" },
      // Plain-English query surface, not a ledger page — an entry point,
      // so it sits beside Dashboard rather than under a data group.
      { href: "/ask", label: "Ask your ledger" },
    ],
  },
  {
    // Things that post (or become postings) — NetSuite's Transactions >
    // Financial neighborhood.
    label: "Transactions",
    items: [
      { href: "/journal-entries", label: "Journal entries" },
      // Line-level companion to the entry list above. Two destinations, not
      // one with a toggle: "what did we post" and "what is in this account"
      // are different questions with different columns, and this one is where
      // a report cell's drill-down lands.
      { href: "/transactions", label: "Transactions", hint: "by line" },
      { href: "/journal-entries/pending", label: "Pending approval", hint: "queue" },
      { href: "/banking", label: "Bank transactions" },
      { href: "/recurring-entries", label: "Recurring", hint: "templates" },
      { href: "/journal-entries/paste", label: "Paste from Excel", hint: "bulk" },
    ],
  },
  {
    // Open-item registers. NetSuite files these under Transactions >
    // Receivables / Payables; at sidebar depth they earn their own
    // region — burying AR/AP behind a disclosure in an accounting app
    // was the core of the owner's complaint. Holdings is the third
    // open-item register (positions at cost), so it lives here too.
    label: "Sub-ledgers",
    items: [
      { href: "/ar", label: "Open AR", hint: "receivables" },
      { href: "/ap", label: "Open AP", hint: "payables" },
      { href: "/holdings", label: "Holdings", hint: "investments" },
      { href: "/fixed-assets", label: "Fixed assets", hint: "register" },
    ],
  },
  {
    // Standing records the postings point at. "Lists" is NetSuite's own
    // word for exactly this drawer (Jakob's Law — users arrive fluent).
    label: "Lists",
    items: [
      { href: "/accounts", label: "Chart of accounts" },
      // The Layer 3 tagging engine, visible for the first time. Campfire calls
      // these Tag Groups; ours are Dimensions and the model is richer.
      { href: "/dimensions", label: "Dimensions", hint: "tag groups" },
      { href: "/commodities", label: "Commodities", hint: "securities" },
    ],
  },
  {
    // Every report, enumerated — the way NetSuite's Reports menu lists
    // all of them. Order: financial statements, sub-ledger agings, tax,
    // then multi-entity/FX.
    label: "Reports",
    items: [
      // The catalog itself, first in the group — a front door for the twelve
      // below, which until now were reachable only from this sidebar or by
      // knowing the URL.
      { href: "/reports", label: "All reports", hint: "catalog" },
      { href: "/reports/trial-balance", label: "Trial balance" },
      { href: "/reports/income-statement", label: "Income statement" },
      { href: "/reports/balance-sheet", label: "Balance sheet" },
      { href: "/reports/cash-flow", label: "Cash flow" },
      { href: "/reports/ar-aging", label: "AR aging" },
      { href: "/reports/ap-aging", label: "AP aging" },
      { href: "/reports/book-tax-difference", label: "Book-tax difference", hint: "ASC 740" },
      { href: "/reports/m3-detail", label: "M-3 detail", hint: "Form 1120" },
      { href: "/reports/fx-revaluation", label: "FX revaluation", hint: "ASC 830" },
      { href: "/reports/consolidation", label: "Consolidation", hint: "multi-entity" },
      { href: "/reports/builder", label: "Report builder", hint: "custom statements" },
    ],
  },
  {
    // The close suite is this product's deepest differentiator — shown
    // in FULL. NetSuite scatters this across Setup > Accounting Periods
    // + the period close checklist; pulling it into one region is
    // deliberate divergence from the reference taxonomy.
    label: "Period & close",
    items: [
      { href: "/periods", label: "Periods" },
      { href: "/close", label: "Close dashboard", hint: "all pillars" },
      { href: "/close/tasks", label: "Close tasks" },
      { href: "/close/reconciliations", label: "Reconciliations", hint: "tie-out" },
      // Beside Reconciliations on purpose: same question — does the
      // balance agree with something outside the ledger — but the cheap
      // machine half, run after any import rather than once a period.
      { href: "/assertions", label: "Balance assertions", hint: "tripwire" },
      { href: "/close/flux", label: "Flux analysis", hint: "variance" },
      { href: "/close/alerts", label: "Alerts" },
      { href: "/close/retrospective", label: "Retrospective", hint: "trend" },
      { href: "/reports/month-end", label: "Month-end review", hint: "packet" },
    ],
  },
  {
    // Cross-cutting governance visible to every member — the register of
    // everything acting on your behalf. Admin-only setup is ADMIN_SECTION.
    label: "Automation",
    items: [{ href: "/automations", label: "Automations" }],
  },
];

// "Setup" is NetSuite's word for the admin drawer. Rendered only for
// ADMIN+ (canViewAdminPages). Import lives here, not under Lists — it
// rewrites the chart of accounts and posts entries wholesale, which is
// setup work, and the page itself is gated canRunErpImports.
export const ADMIN_SECTION: NavSection = {
  label: "Setup",
  items: [
    { href: "/admin/team", label: "Team", hint: "invites + roles" },
    { href: "/admin/users", label: "Users", hint: "lifecycle" },
    { href: "/admin/audit-log", label: "Audit log", hint: "SOC 2" },
    { href: "/admin/data-subject-requests", label: "Data requests", hint: "GDPR" },
    { href: "/admin/billing", label: "Billing", hint: "plan + caps" },
    { href: "/admin/orphans", label: "Orphan records" },
    { href: "/admin/notification-channels", label: "Slack channels" },
    { href: "/import/netsuite", label: "Import from NetSuite", hint: "ERP" },
  ],
};

/** The one action repeated most; isolated on purpose (Von Restorff). */
export const PRIMARY_ACTION: NavItem = { href: "/journal-entries/new", label: "New entry" };

/** A flat, palette-ready command with the group it came from for context. */
export interface CommandItem extends NavItem {
  /** Section label, shown as a muted tag in the palette. */
  group: string;
  /** True for the primary "New entry" action — styled/ranked ahead of navigation. */
  isAction?: boolean;
}

/**
 * Flatten the nav into one searchable command list for the palette.
 * Order = the primary action first (it's what a user reaches for most),
 * then every destination in sidebar order, admin last and only when the
 * viewer is an admin. Deduped on href so a page listed twice can't appear
 * twice.
 */
export function flattenCommands(opts: { isAdmin: boolean }): CommandItem[] {
  const out: CommandItem[] = [
    { ...PRIMARY_ACTION, group: "Actions", isAction: true },
  ];
  const push = (section: NavSection) => {
    for (const item of section.items) {
      out.push({ ...item, group: section.label });
    }
  };
  for (const section of NAV_SECTIONS) push(section);
  if (opts.isAdmin) push(ADMIN_SECTION);

  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.href) ? false : (seen.add(c.href), true)));
}
