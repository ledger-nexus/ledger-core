// Sidebar navigation. Static client-rendered (no interactive state) so it
// can sit in the root layout without a 'use client' boundary.

import Link from "next/link";
import { cn } from "@/lib/utils/cn";

const sections: { label: string; items: { href: string; label: string; hint?: string }[] }[] = [
  {
    label: "Overview",
    items: [
      { href: "/", label: "Dashboard" },
    ],
  },
  {
    label: "Master data",
    items: [
      { href: "/accounts", label: "Chart of accounts" },
      { href: "/import/netsuite", label: "Import from NetSuite", hint: "single / multi-sub" },
    ],
  },
  {
    label: "Transactions",
    items: [
      { href: "/journal-entries", label: "Journal entries" },
      { href: "/journal-entries/new", label: "+ New entry", hint: "manual" },
      { href: "/journal-entries/paste", label: "+ Paste from Excel", hint: "bulk lines" },
      { href: "/recurring-entries", label: "Recurring", hint: "templates" },
      { href: "/ar", label: "Open AR" },
      { href: "/ap", label: "Open AP" },
    ],
  },
  {
    label: "Close",
    items: [
      { href: "/periods", label: "Periods", hint: "open / closed" },
      { href: "/reports/month-end", label: "Month-end review", hint: "TB + IS + BS" },
    ],
  },
  {
    label: "Reports",
    items: [
      { href: "/reports/trial-balance", label: "Trial balance" },
      { href: "/reports/income-statement", label: "Income statement" },
      { href: "/reports/balance-sheet", label: "Balance sheet" },
      { href: "/reports/cash-flow", label: "Cash flow", hint: "indirect" },
      { href: "/reports/book-tax-difference", label: "Book-tax difference", hint: "ASC 740" },
      { href: "/reports/m3-detail", label: "M-3 detail", hint: "Form 1120" },
      { href: "/reports/ar-aging", label: "AR aging" },
      { href: "/reports/ap-aging", label: "AP aging" },
      { href: "/reports/consolidation", label: "Consolidation", hint: "multi-entity" },
    ],
  },
];

const ADMIN_SECTION = {
  label: "Admin",
  items: [
    { href: "/admin/users", label: "Users", hint: "lifecycle" },
    { href: "/admin/orphans", label: "Orphan records", hint: "ownership" },
    { href: "/admin/audit-log", label: "Audit log", hint: "SOC 2" },
  ],
} as const;

export function Sidebar({
  currentPath,
  isAdmin = false,
}: {
  currentPath?: string;
  isAdmin?: boolean;
}) {
  const visibleSections = isAdmin ? [...sections, ADMIN_SECTION] : sections;
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
        {visibleSections.map((section) => (
          <div key={section.label}>
            <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-400">
              {section.label}
            </div>
            <ul className="flex flex-col gap-0.5">
              {section.items.map((item) => {
                const active = currentPath === item.href;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={cn(
                        "flex items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors",
                        active
                          ? "bg-ink-900 text-white"
                          : "text-ink-700 hover:bg-ink-100"
                      )}
                    >
                      <span>{item.label}</span>
                      {item.hint && (
                        <span className="text-[10px] uppercase tracking-wide opacity-70">
                          {item.hint}
                        </span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}
