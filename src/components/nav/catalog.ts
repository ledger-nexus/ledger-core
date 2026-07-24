// The single source of truth for navigation destinations.
//
// Both the sidebar and the ⌘K command palette consume this. Before the
// palette existed, this data lived inline in sidebar.tsx; extracting it
// here keeps the two surfaces from drifting — a page added to the nav is
// automatically reachable from the palette, and vice versa.
//
// The grouping and ordering rationale (Hick's / Miller's / Similarity /
// Jakob's / Pareto / Von Restorff / Serial Position) lives with the
// sidebar that renders it; this module is just the data.

export interface NavItem {
  href: string;
  label: string;
  hint?: string;
}

export interface NavSection {
  label: string;
  /** Always visible in the sidebar — the Pareto set. */
  items: NavItem[];
  /** Behind a <details> disclosure in the sidebar. Full-featured installs reach these. */
  more?: NavItem[];
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
    // Events that post to the ledger. Everything here either is a posting
    // or is a template/queue that becomes one.
    label: "Transactions",
    items: [
      { href: "/banking", label: "Bank transactions" },
      { href: "/journal-entries", label: "Journal entries" },
    ],
    more: [
      { href: "/journal-entries/paste", label: "Paste from Excel", hint: "bulk lines" },
      { href: "/recurring-entries", label: "Recurring", hint: "templates" },
      { href: "/ar", label: "Open AR" },
      { href: "/ap", label: "Open AP" },
      // The third open-item sub-ledger view: positions still held, with the
      // cost basis behind them. Sits with AR/AP rather than in the Pareto set
      // because most installs never hold securities.
      { href: "/holdings", label: "Holdings", hint: "investments" },
    ],
  },
  {
    // Standing records the postings point at. An account isn't something
    // that happened — it's a noun transactions reference, so it doesn't
    // belong in the list above.
    label: "Master data",
    items: [{ href: "/accounts", label: "Chart of accounts" }],
    more: [
      // Securities master + the prices that mark them. Master data, not
      // positions — those are Transactions → Holdings.
      { href: "/commodities", label: "Commodities", hint: "securities + prices" },
      { href: "/import/netsuite", label: "Import from NetSuite", hint: "single / multi-sub" },
    ],
  },
  {
    // Cross-cutting controls that aren't a ledger surface. "Automations"
    // is the governance view for everything acting on your behalf.
    label: "Settings",
    items: [{ href: "/automations", label: "Automations" }],
  },
  {
    label: "Reports",
    items: [
      { href: "/reports/trial-balance", label: "Trial balance" },
      { href: "/reports/income-statement", label: "Income statement" },
      { href: "/reports/balance-sheet", label: "Balance sheet" },
      { href: "/reports/cash-flow", label: "Cash flow" },
    ],
    more: [
      { href: "/reports/book-tax-difference", label: "Book-tax difference", hint: "ASC 740" },
      { href: "/reports/m3-detail", label: "M-3 detail", hint: "Form 1120" },
      { href: "/reports/ar-aging", label: "AR aging" },
      { href: "/reports/ap-aging", label: "AP aging" },
      { href: "/reports/fx-revaluation", label: "FX revaluation", hint: "ASC 830" },
      { href: "/reports/consolidation", label: "Consolidation", hint: "multi-entity" },
    ],
  },
  {
    label: "Close",
    items: [
      { href: "/periods", label: "Periods" },
      { href: "/close/tasks", label: "Close tasks" },
      { href: "/reports/month-end", label: "Month-end review" },
    ],
    more: [
      { href: "/close", label: "Close dashboard", hint: "all pillars" },
      { href: "/close/reconciliations", label: "Reconciliations", hint: "BS tie-out" },
      // Beside Reconciliations on purpose: same job — does the balance agree
      // with something outside the ledger — but the cheap machine half, run
      // after any import rather than once a period with a sign-off.
      { href: "/assertions", label: "Balance assertions", hint: "drift tripwire" },
      { href: "/close/alerts", label: "Alerts", hint: "cross-pillar" },
      { href: "/close/flux", label: "Flux analysis", hint: "variance" },
      { href: "/close/retrospective", label: "Retrospective", hint: "trend" },
    ],
  },
];

export const ADMIN_SECTION: NavSection = {
  label: "Admin",
  items: [
    { href: "/admin/users", label: "Users" },
    { href: "/admin/audit-log", label: "Audit log", hint: "SOC 2" },
  ],
  more: [
    { href: "/admin/orphans", label: "Orphan records", hint: "ownership" },
    { href: "/admin/notification-channels", label: "Slack channels", hint: "alerts" },
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
    for (const item of [...section.items, ...(section.more ?? [])]) {
      out.push({ ...item, group: section.label });
    }
  };
  for (const section of NAV_SECTIONS) push(section);
  if (opts.isAdmin) push(ADMIN_SECTION);

  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.href) ? false : (seen.add(c.href), true)));
}
