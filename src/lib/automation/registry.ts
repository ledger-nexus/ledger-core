// Automation registry — the declared list of things the system can do on
// the user's behalf, plus a resolver for their live status in a scope.
//
// This is Phase 0 of the automation library (docs/design/automation-library.md):
// READ-ONLY. It surfaces the automations that already run — nothing here
// enables, disables, or posts. The value is visibility: today no single
// place shows everything acting on your behalf.
//
// governanceLevel is the load-bearing field:
//   SUGGEST — pre-fills a choice; a human still acts. Never posts unattended.
//   REVIEW  — acts, but the result is collected + flagged, never silently final.
//   AUTO    — posts unattended (recurring entries today).
// Per the constitutional line in the design doc, only DETERMINISTIC,
// human-authored automations may be AUTO; AI-driven ones stay SUGGEST/REVIEW.

import type { PrismaClient } from "@prisma/client";

export type GovernanceLevel = "SUGGEST" | "REVIEW" | "AUTO";
export type AutomationCategory =
  | "recurring"
  | "categorization"
  | "matching"
  | "notification";

export interface AutomationDef {
  id: string;
  name: string;
  category: AutomationCategory;
  /** One plain sentence: what it does, in the user's language. */
  description: string;
  governanceLevel: GovernanceLevel;
  /**
   * If it posts, the source it stamps — so an entry it creates is never
   * mistaken for one you typed. Absent for automations that don't post.
   */
  provenance?: string;
  /** Where the user goes to work with it today. */
  href?: string;
}

export const AUTOMATIONS: AutomationDef[] = [
  {
    id: "recurring-je",
    name: "Recurring entries",
    category: "recurring",
    description:
      "Posts a saved entry on a schedule — rent, a subscription, monthly depreciation — without asking each time.",
    governanceLevel: "AUTO",
    provenance: "Stamped SYSTEM; visible in the register as a scheduled post.",
    href: "/recurring-entries",
  },
  {
    id: "bank-learned-rules",
    name: "Learned categories",
    category: "categorization",
    description:
      "Remembers how you categorize a merchant and pre-selects it the next time that merchant appears in the bank feed.",
    governanceLevel: "SUGGEST",
    href: "/banking",
  },
  {
    id: "bank-match",
    name: "Match to existing",
    category: "matching",
    description:
      "Spots when a bank line is already in your books and offers to link it, so the same money is never posted twice.",
    governanceLevel: "SUGGEST",
    href: "/banking",
  },
  {
    id: "close-notifications",
    name: "Close alerts",
    category: "notification",
    description:
      "Watches the month-end close and sends alerts — immediately or as a daily digest — to your connected channels.",
    governanceLevel: "AUTO",
    provenance: "Sends notifications only; never posts to the ledger.",
    href: "/admin/notification-channels",
  },
];

export interface AutomationStatus {
  /** True when the automation is actually doing something in this scope. */
  active: boolean;
  /** Honest one-liner: what's on, or why it's dormant. */
  detail: string;
}

interface StatusScope {
  tenantId: string;
  entityCode: string;
  bookCode: string;
}

/**
 * Resolve each automation's live status from real data — no config table
 * yet (that's Phase 1), so "active" is derived from what exists: are there
 * templates, learned rules, matched lines, notification channels.
 */
export async function resolveAutomationStatuses(
  prisma: PrismaClient,
  scope: StatusScope
): Promise<Record<string, AutomationStatus>> {
  const scoped = {
    entity: { code: scope.entityCode },
    book: { code: scope.bookCode },
  };

  const [recurringActive, learnedRules, matched, channels] = await Promise.all([
    prisma.recurringEntry.count({
      where: { tenantId: scope.tenantId, isActive: true, ...scoped },
    }),
    prisma.bankRule.count({ where: { tenantId: scope.tenantId } }),
    prisma.bankTransaction.count({
      where: { tenantId: scope.tenantId, status: "MATCHED", ...scoped },
    }),
    prisma.notificationChannel.count({
      where: { tenantId: scope.tenantId, enabled: true },
    }),
  ]);

  return {
    "recurring-je": {
      active: recurringActive > 0,
      detail:
        recurringActive > 0
          ? `${recurringActive} active template${recurringActive === 1 ? "" : "s"} posting on schedule`
          : "No active templates — nothing posts automatically",
    },
    "bank-learned-rules": {
      active: learnedRules > 0,
      detail:
        learnedRules > 0
          ? `${learnedRules} merchant${learnedRules === 1 ? "" : "s"} learned`
          : "Nothing learned yet — categorize a few bank lines to teach it",
    },
    "bank-match": {
      // Always on — it's an offer, not a stored rule. "Active" reflects use.
      active: true,
      detail:
        matched > 0
          ? `${matched} bank line${matched === 1 ? "" : "s"} linked to existing entries`
          : "Ready — offers a link whenever a bank line is already in your books",
    },
    "close-notifications": {
      active: channels > 0,
      detail:
        channels > 0
          ? `${channels} channel${channels === 1 ? "" : "s"} connected`
          : "Not configured — no channels connected, so no alerts are sent",
    },
  };
}
