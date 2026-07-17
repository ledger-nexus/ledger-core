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
// The nav data lives in one place (catalog.ts) so the sidebar and the ⌘K
// command palette can't drift. This file owns the rendering + the Laws-of-UX
// rationale above; the catalog owns the destinations.
import {
  ADMIN_SECTION,
  NAV_SECTIONS,
  PRIMARY_ACTION,
  type NavItem,
} from "@/components/nav/catalog";

function NavLink({
  item,
  active,
  count,
}: {
  item: NavItem;
  active: boolean;
  /** Optional live count pill (e.g. bank lines awaiting review). */
  count?: number;
}) {
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
      {count != null && count > 0 && (
        <span
          className={cn(
            "ml-auto rounded-full px-1.5 text-[11px] font-semibold tabular-nums",
            active ? "bg-white text-ink-900" : "bg-amber-100 text-amber-900"
          )}
        >
          {count}
        </span>
      )}
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
  reviewCount = 0,
}: {
  currentPath?: string;
  isAdmin?: boolean;
  /** Bank lines awaiting review — Zeigarnik pull on the daily loop. */
  reviewCount?: number;
}) {
  const pathname = usePathname();
  const activePath = currentPath ?? pathname;
  const visibleSections = isAdmin ? [...NAV_SECTIONS, ADMIN_SECTION] : NAV_SECTIONS;
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
                    <NavLink
                      item={item}
                      active={activePath === item.href}
                      count={item.href === "/banking" ? reviewCount : undefined}
                    />
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
