"use client";

// Sidebar navigation.
//
// Client component solely to read the active route (App Router layouts
// can't read the pathname server-side).
//
// Design history, honestly told: an earlier pass compressed each section
// to a Pareto set with the tail behind a "More (N)" disclosure (Hick's
// Law reasoning). The owner overruled it — in an accounting app, hiding
// Open AR/AP and half the close suite behind disclosures reads as
// missing features, and a controller wants the complete map the way
// NetSuite's menus give it to them. So this sidebar now shows EVERY
// destination, and the laws that survive are the ones that don't hide
// anything:
//
//   Jakob's Law — the section taxonomy mirrors NetSuite's Accounting
//     Center (Transactions / Sub-ledgers / Lists / Reports / Setup), so
//     users fluent in the reference system never translate.
//   Law of Common Region — each section is one KIND: things that post,
//     open-item registers, standing records, aggregations, close work.
//   Von Restorff — the single most-repeated action ("New entry") is
//     styled unlike its neighbours so it's found without reading.
//   Serial Position — Dashboard leads; the primary action sits directly
//     after it; admin setup is last.
//
// The full list is longer than a viewport on small screens; the nav
// scrolls independently of the content pane.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils/cn";
// The nav data lives in one place (catalog.ts) so the sidebar and the ⌘K
// command palette can't drift. This file owns rendering; the catalog owns
// the destinations and the taxonomy rationale.
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
        "flex items-center justify-between rounded-md px-2 py-1 text-sm",
        active ? "bg-ink-900 text-white" : "text-ink-700 hover:bg-ink-100"
      )}
    >
      <span className="truncate">{item.label}</span>
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
        <span className="ml-2 shrink-0 text-[10px] uppercase tracking-wide opacity-60">
          {item.hint}
        </span>
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
    <nav className="flex h-screen flex-col gap-5 overflow-y-auto p-5">
      <div>
        <Link href="/" className="block">
          <div className="font-display text-base font-semibold tracking-tight text-ink-900">
            ledger-core
          </div>
          <div className="text-[11px] uppercase tracking-wider text-ink-500">
            universal accounting substrate
          </div>
        </Link>
      </div>

      <div className="flex flex-col gap-5">
        {visibleSections.map((section) => (
          <div key={section.label}>
            <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.1em] text-ink-400">
              {section.label}
            </div>
            <ul className="flex flex-col gap-px">
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
                  "mt-2 flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium",
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
          </div>
        ))}
      </div>
    </nav>
  );
}
