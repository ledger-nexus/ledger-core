"use client";

// Sidebar navigation.
//
// Client component solely to read the active route. It was previously a
// Server Component taking a `currentPath` prop — but the root layout never
// passed one (App Router layouts can't read the pathname), so every
// active-state branch was dead and the nav never highlighted the current
// page. usePathname fixes that; there's no server data here to lose.
// Progressive disclosure still uses native <details>/<summary>.
//
// Structure follows a few Laws of UX, because a 25-item flat nav was
// costing every user real time:
//
//   Hick's Law / Choice Overload — decision time scales with the number
//     of choices. The nav now shows the handful of destinations that
//     carry the daily workload; the long tail sits one disclosure away
//     instead of competing for attention on every page load.
//   Miller's Law / Chunking — working memory holds ~7±2 *chunks*, not
//     items. Five labelled groups of 1–4 beats one list of 25.
//   Law of Similarity / Common Region — a bounded region reads as "these
//     things are alike", so the things inside it had better be alike.
//     Groups are one KIND each, along the split every accounting system
//     eventually arrives at: events that post to the ledger
//     (Transactions), the standing records those events point at (Master
//     data), and aggregations over the events (Reports). NetSuite draws
//     the same line — a journal entry lives under Transactions, the chart
//     of accounts under Lists — because an account is a noun and an entry
//     is something that happened. An earlier pass here folded Master data
//     into Transactions to save a group; that traded a real distinction
//     for a smaller number, and Miller's was never the constraint at five
//     chunks. Restored.
//   Jakob's Law — users arrive fluent in NetSuite/QBO. Matching the
//     grouping they already carry costs us nothing and saves them the
//     translation. This is why we follow NetSuite's ontology while
//     declining its density: the taxonomy is 25 years of domain evidence;
//     the hover-menus and click-depth are the toll it pays for it.
//   Pareto — the ~20% of surfaces (post an entry, read the ledger, run
//     TB/IS/BS, close a period) that serve ~80% of sessions are primary.
//     Nothing is removed: advanced/ERP/multi-entity surfaces stay a
//     click away for the installs that live in them.
//   Von Restorff (isolation effect) — the single most-repeated action
//     ("New entry") is styled unlike its neighbours so it's found
//     without reading.
//   Serial Position Effect — first and last items are best recalled, so
//     Dashboard leads and the primary action sits immediately after it.
//   Selective Attention — the uppercase micro-hints ("ALL PILLARS",
//     "CROSS-PILLAR", "BS TIE-OUT", "VARIANCE") read as banner noise and
//     were skipped anyway. They survive only inside the disclosures,
//     where they genuinely disambiguate.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils/cn";

interface NavItem {
  href: string;
  label: string;
  hint?: string;
}

interface NavSection {
  label: string;
  /** Always visible — the Pareto set. */
  items: NavItem[];
  /** Behind a <details> disclosure. Full-featured installs still reach these. */
  more?: NavItem[];
}

const sections: NavSection[] = [
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
    ],
  },
  {
    // Standing records the postings point at. An account isn't something
    // that happened — it's a noun transactions reference, so it doesn't
    // belong in the list above.
    label: "Master data",
    items: [{ href: "/accounts", label: "Chart of accounts" }],
    more: [
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
      { href: "/close/alerts", label: "Alerts", hint: "cross-pillar" },
      { href: "/close/flux", label: "Flux analysis", hint: "variance" },
      { href: "/close/retrospective", label: "Retrospective", hint: "trend" },
    ],
  },
];

const ADMIN_SECTION: NavSection = {
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
const PRIMARY_ACTION: NavItem = { href: "/journal-entries/new", label: "New entry" };

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors",
        active ? "bg-ink-900 text-white" : "text-ink-700 hover:bg-ink-100"
      )}
    >
      <span>{item.label}</span>
      {item.hint && (
        <span className="text-[10px] uppercase tracking-wide opacity-70">{item.hint}</span>
      )}
    </Link>
  );
}

export function Sidebar({
  /** Test/override hook. Normal renders resolve the route themselves. */
  currentPath,
  isAdmin = false,
}: {
  currentPath?: string;
  isAdmin?: boolean;
}) {
  const pathname = usePathname();
  const activePath = currentPath ?? pathname;
  const visibleSections = isAdmin ? [...sections, ADMIN_SECTION] : sections;
  const actionActive = activePath === PRIMARY_ACTION.href;

  return (
    <nav className="flex h-full flex-col gap-6 p-5">
      <div>
        <Link href="/" className="block">
          <div className="text-base font-semibold tracking-tight text-ink-900">ledger-core</div>
          <div className="text-[11px] uppercase tracking-wider text-ink-500">
            universal accounting substrate
          </div>
        </Link>
      </div>

      <div className="flex flex-col gap-5">
        {visibleSections.map((section) => {
          // Keep the disclosure open when the current page lives inside it,
          // so the user is never "lost" behind a collapsed group.
          const moreHasActive = section.more?.some((i) => i.href === activePath) ?? false;

          return (
            <div key={section.label}>
              <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-400">
                {section.label}
              </div>
              <ul className="flex flex-col gap-0.5">
                {section.items.map((item) => (
                  <li key={item.href}>
                    <NavLink item={item} active={activePath === item.href} />
                  </li>
                ))}
              </ul>

              {/* Primary action sits directly under Dashboard: earliest
                  serial position a *doing* link can occupy, and visually
                  isolated from the plain text links around it. */}
              {section.label === "Overview" && (
                <Link
                  href={PRIMARY_ACTION.href}
                  aria-current={actionActive ? "page" : undefined}
                  className={cn(
                    "mt-2 flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-sm font-medium transition-colors",
                    actionActive
                      ? "border-ink-900 bg-ink-900 text-white"
                      : "border-ink-300 bg-white text-ink-900 hover:border-ink-900 hover:bg-ink-50"
                  )}
                >
                  <span aria-hidden="true" className="text-base leading-none">
                    +
                  </span>
                  <span>{PRIMARY_ACTION.label}</span>
                </Link>
              )}

              {section.more && section.more.length > 0 && (
                <details open={moreHasActive} className="group mt-1">
                  <summary className="flex cursor-pointer list-none items-center gap-1 rounded-md px-2 py-1.5 text-xs text-ink-500 transition-colors hover:bg-ink-100 hover:text-ink-700">
                    <span
                      aria-hidden="true"
                      className="inline-block transition-transform group-open:rotate-90"
                    >
                      ›
                    </span>
                    <span>More</span>
                    <span className="text-ink-400">({section.more.length})</span>
                  </summary>
                  <ul className="mt-0.5 flex flex-col gap-0.5">
                    {section.more.map((item) => (
                      <li key={item.href}>
                        <NavLink item={item} active={activePath === item.href} />
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          );
        })}
      </div>
    </nav>
  );
}
