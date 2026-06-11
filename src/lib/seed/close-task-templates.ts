// BlackLine arc — Phase 2 PR 5: 50-task BlackLine-standard seed.
//
// `seedCloseTaskTemplates(prisma, tenantId)` upserts the canonical
// month-end close checklist into the tenant's CloseTaskTemplate
// catalog. Idempotent on the @@unique([tenantId, key]) composite —
// re-running yields zero new rows.
//
// The 50 templates span the 9 categories from the design doc, with
// `defaultDependsOnKeys` wiring the canonical dependency graph:
//
//   Pre-close prep   → Accruals + sub-ledger cutoffs
//   Sub-ledgers close → Depreciation, amortization, lease, ASC 606
//   FX               → after sub-ledgers (uses sub-ledger balances)
//   Recons           → after all activity posts
//   Tax provision    → after recons (BTD inputs need clean numbers)
//   Reports (TB/IS/BS/CF/M-3) → after recons
//   Month-end packet → after reports
//   Send to leadership → after packet
//   GL close + admin wrap-up → after packet sent
//
// Due offsets are RELATIVE TO period.endsOn (negative = before period
// end, positive = after). Tuned against the typical month-end close
// timeline (most controllers target a 5-7 business day close after
// month-end, with prep starting 2-3 days before).
//
// All templates default to requiredForClose=true EXCEPT the post-
// mortem (ADMIN_POSTMORTEM) — useful but not blocking.

import type { PrismaClient, CloseTaskCategory } from "@prisma/client";

interface TemplateSpec {
  key: string;
  name: string;
  description: string;
  category: CloseTaskCategory;
  defaultDueOffsetDays: number;
  requiredForClose?: boolean; // default true
  defaultDependsOnKeys?: string[]; // default []
}

// ─────────────────────────────────────────────────────────────────────────
// The 50 templates. Order in this array doesn't affect dependency
// resolution (the instantiator walks defaultDependsOnKeys regardless
// of declaration order); we present them grouped by category here
// for human reading.
// ─────────────────────────────────────────────────────────────────────────
export const CLOSE_TASK_TEMPLATES: TemplateSpec[] = [
  // ─── ACCRUAL (8) ──────────────────────────────────────────────────────
  // Pre-close prep work — most accruals can run before period end.
  {
    key: "ACCRUE_PAYROLL",
    name: "Accrue payroll",
    description: "Estimate unpaid wages through period end (timesheets × rates).",
    category: "ACCRUAL",
    defaultDueOffsetDays: -2,
  },
  {
    key: "ACCRUE_BONUS",
    name: "Accrue bonus",
    description: "Quarterly + annual bonus pool accrual based on YTD performance.",
    category: "ACCRUAL",
    defaultDueOffsetDays: -2,
  },
  {
    key: "ACCRUE_VACATION",
    name: "Accrue vacation / PTO",
    description: "Roll forward unused PTO balance × current wage rates.",
    category: "ACCRUAL",
    defaultDueOffsetDays: -2,
  },
  {
    key: "ACCRUE_INTEREST",
    name: "Accrue interest expense",
    description: "Daily-rate × outstanding debt × days remaining in period.",
    category: "ACCRUAL",
    defaultDueOffsetDays: -1,
  },
  {
    key: "ACCRUE_RENT",
    name: "Accrue rent expense",
    description: "Straight-line rent (with deferred-rent true-up).",
    category: "ACCRUAL",
    defaultDueOffsetDays: -1,
  },
  {
    key: "ACCRUE_UTILITIES",
    name: "Accrue utilities",
    description: "Estimate unbilled gas/electric/water based on average daily usage.",
    category: "ACCRUAL",
    defaultDueOffsetDays: 0,
  },
  {
    key: "AP_CUTOFF",
    name: "AP cutoff — vendor invoice scan",
    description: "Pull invoices received but not yet entered; accrue if service date in period.",
    category: "ACCRUAL",
    defaultDueOffsetDays: 1,
  },
  {
    key: "EXPENSE_REPORTS_CUTOFF",
    name: "Expense report cutoff",
    description: "Collect employee expense reports through last business day of period.",
    category: "ACCRUAL",
    defaultDueOffsetDays: 1,
  },

  // ─── DEPRECIATION (3) ─────────────────────────────────────────────────
  // Runs after AP cutoff so any late asset additions are captured.
  {
    key: "RUN_DEPRECIATION",
    name: "Run monthly depreciation",
    description: "Calculate + post depreciation for all fixed assets in service.",
    category: "DEPRECIATION",
    defaultDueOffsetDays: 1,
    defaultDependsOnKeys: ["AP_CUTOFF"],
  },
  {
    key: "RUN_AMORTIZATION",
    name: "Run monthly amortization",
    description: "Calculate + post amortization on prepaids, intangibles, deferred costs.",
    category: "DEPRECIATION",
    defaultDueOffsetDays: 1,
    defaultDependsOnKeys: ["AP_CUTOFF"],
  },
  {
    key: "POST_FA_ADJUSTMENTS",
    name: "Post fixed-asset adjustments",
    description: "Disposals, impairments, transfers — anything not captured by routine dep.",
    category: "DEPRECIATION",
    defaultDueOffsetDays: 2,
    defaultDependsOnKeys: ["RUN_DEPRECIATION"],
  },

  // ─── REVENUE (6) ──────────────────────────────────────────────────────
  // ASC 606 recognition runs after sub-ledger close so all in-period
  // performance obligations are captured.
  {
    key: "RUN_ASC_606",
    name: "Run ASC 606 revenue recognition",
    description: "Run revenue recognition for all in-period performance obligations.",
    category: "REVENUE",
    defaultDueOffsetDays: 2,
    defaultDependsOnKeys: ["AP_CUTOFF"],
  },
  {
    key: "POST_DEFERRED_REVENUE",
    name: "Post deferred revenue adjustments",
    description: "Move recognized portion from deferred-rev liability to current-period revenue.",
    category: "REVENUE",
    defaultDueOffsetDays: 2,
    defaultDependsOnKeys: ["RUN_ASC_606"],
  },
  {
    key: "RUN_UNBILLED_AR",
    name: "Calculate unbilled AR",
    description: "Performance obligations satisfied but not yet invoiced — contract asset.",
    category: "REVENUE",
    defaultDueOffsetDays: 2,
    defaultDependsOnKeys: ["RUN_ASC_606"],
  },
  {
    key: "CLOSE_REVENUE_SUBLEDGER",
    name: "Close revenue sub-ledger",
    description: "Roll up all RevenueContract rows and tie to GL.",
    category: "REVENUE",
    defaultDueOffsetDays: 3,
    defaultDependsOnKeys: ["RUN_ASC_606", "POST_DEFERRED_REVENUE"],
  },
  {
    key: "POST_VARIABLE_CONSIDERATION",
    name: "Post variable consideration adjustments",
    description: "Updates to estimated discount/rebate accruals against expected value.",
    category: "REVENUE",
    defaultDueOffsetDays: 3,
    defaultDependsOnKeys: ["RUN_ASC_606"],
  },
  {
    key: "POST_REVENUE_TRUEUPS",
    name: "Post revenue true-ups",
    description: "Corrections to prior-period estimates as new information arrives.",
    category: "REVENUE",
    defaultDueOffsetDays: 3,
    defaultDependsOnKeys: ["RUN_ASC_606"],
  },

  // ─── INVENTORY (4) ────────────────────────────────────────────────────
  {
    key: "POST_INVENTORY_ADJUSTMENTS",
    name: "Post inventory adjustments",
    description: "Cycle-count variances, shrinkage, write-downs.",
    category: "INVENTORY",
    defaultDueOffsetDays: 1,
  },
  {
    key: "RUN_COGS_ALLOCATION",
    name: "Run COGS allocation",
    description: "Distribute period COGS across product lines per the standard cost allocation.",
    category: "INVENTORY",
    defaultDueOffsetDays: 2,
    defaultDependsOnKeys: ["POST_INVENTORY_ADJUSTMENTS"],
  },
  {
    key: "RECONCILE_CYCLE_COUNTS",
    name: "Reconcile cycle count results",
    description: "Investigate counts that didn't match book; document root cause.",
    category: "INVENTORY",
    defaultDueOffsetDays: 2,
    defaultDependsOnKeys: ["POST_INVENTORY_ADJUSTMENTS"],
  },
  {
    key: "POST_OBSOLESCENCE_RESERVE",
    name: "Post obsolescence reserve",
    description: "Update slow-moving inventory reserve based on aging buckets.",
    category: "INVENTORY",
    defaultDueOffsetDays: 3,
    defaultDependsOnKeys: ["POST_INVENTORY_ADJUSTMENTS"],
  },

  // ─── FX (3) ───────────────────────────────────────────────────────────
  // Runs after sub-ledgers close so all in-period FX-sensitive
  // transactions are posted.
  {
    key: "POST_FX_REVALUATION",
    name: "Post FX revaluation",
    description: "Revalue foreign-currency monetary balances at period-end spot rate.",
    category: "FX",
    defaultDueOffsetDays: 3,
    defaultDependsOnKeys: ["AP_CUTOFF", "CLOSE_REVENUE_SUBLEDGER"],
  },
  {
    key: "POST_CTA",
    name: "Post cumulative translation adjustment",
    description: "Translate foreign-entity P&L at avg rate, BS at period-end rate; post CTA to OCI.",
    category: "FX",
    defaultDueOffsetDays: 4,
    defaultDependsOnKeys: ["POST_FX_REVALUATION"],
  },
  {
    key: "RECONCILE_FX_GAIN_LOSS",
    name: "Reconcile FX gain/loss",
    description: "Tie FX gain/loss account to the sum of revaluations posted this period.",
    category: "FX",
    defaultDueOffsetDays: 4,
    defaultDependsOnKeys: ["POST_FX_REVALUATION", "POST_CTA"],
  },

  // ─── RECON (9) ────────────────────────────────────────────────────────
  // All recons depend on the relevant sub-ledger / accrual being posted.
  // These are the BS accounts the controller signs off on per period.
  {
    key: "RECON_CASH",
    name: "Reconcile cash",
    description: "Tie GL cash to bank statement; document any reconciling items.",
    category: "RECON",
    defaultDueOffsetDays: 4,
    defaultDependsOnKeys: ["AP_CUTOFF"],
  },
  {
    key: "RECON_AR",
    name: "Reconcile AR",
    description: "Tie GL AR control to sum of open AR items by aging bucket.",
    category: "RECON",
    defaultDueOffsetDays: 4,
    defaultDependsOnKeys: ["CLOSE_REVENUE_SUBLEDGER"],
  },
  {
    key: "RECON_AP",
    name: "Reconcile AP",
    description: "Tie GL AP control to sum of open AP items.",
    category: "RECON",
    defaultDueOffsetDays: 4,
    defaultDependsOnKeys: ["AP_CUTOFF", "EXPENSE_REPORTS_CUTOFF"],
  },
  {
    key: "RECON_PREPAID",
    name: "Reconcile prepaid expenses",
    description: "Tie prepaid balance to schedule of unamortized prepayments.",
    category: "RECON",
    defaultDueOffsetDays: 4,
    defaultDependsOnKeys: ["RUN_AMORTIZATION"],
  },
  {
    key: "RECON_FIXED_ASSETS",
    name: "Reconcile fixed assets",
    description: "Tie GL FA-cost accounts to fixed-asset register at acquisition cost.",
    category: "RECON",
    defaultDueOffsetDays: 4,
    defaultDependsOnKeys: ["POST_FA_ADJUSTMENTS"],
  },
  {
    key: "RECON_ACCUM_DEP",
    name: "Reconcile accumulated depreciation",
    description: "Tie accumulated depreciation to sum of FixedAssetBookAttributes.",
    category: "RECON",
    defaultDueOffsetDays: 4,
    defaultDependsOnKeys: ["RUN_DEPRECIATION"],
  },
  {
    key: "RECON_LEASE",
    name: "Reconcile lease ROU + lease liability",
    description: "ASC 842: tie ROU asset + lease liability to lease register.",
    category: "RECON",
    defaultDueOffsetDays: 4,
    defaultDependsOnKeys: ["RUN_AMORTIZATION"],
  },
  {
    key: "RECON_DEFERRED_REVENUE",
    name: "Reconcile deferred revenue",
    description: "Tie deferred-rev balance to sum of unsatisfied performance obligations.",
    category: "RECON",
    defaultDueOffsetDays: 4,
    defaultDependsOnKeys: ["CLOSE_REVENUE_SUBLEDGER"],
  },
  {
    key: "RECON_INTERCOMPANY",
    name: "Reconcile intercompany",
    description: "Tie due-from/due-to-affiliate accounts across all entities; investigate breaks.",
    category: "RECON",
    defaultDueOffsetDays: 5,
    defaultDependsOnKeys: ["RECON_AR", "RECON_AP"],
  },

  // ─── TAX (5) ──────────────────────────────────────────────────────────
  // Tax provision needs clean BS recons and clean P&L close as inputs.
  {
    key: "RUN_BTD_CALC",
    name: "Run book-tax difference calculation",
    description: "Compute period BTDs by Schedule M-3 line; reconcile to current/deferred tax movements.",
    category: "TAX",
    defaultDueOffsetDays: 5,
    defaultDependsOnKeys: [
      "RECON_FIXED_ASSETS",
      "RECON_ACCUM_DEP",
      "RECON_DEFERRED_REVENUE",
    ],
  },
  {
    key: "POST_TAX_PROVISION",
    name: "Post tax provision",
    description: "Current + deferred tax expense based on BTD calc and the rate by jurisdiction.",
    category: "TAX",
    defaultDueOffsetDays: 5,
    defaultDependsOnKeys: ["RUN_BTD_CALC"],
  },
  {
    key: "POST_DEFERRED_TAX",
    name: "Post deferred tax true-up",
    description: "Adjust deferred tax assets/liabilities for BTD movements + valuation allowance.",
    category: "TAX",
    defaultDueOffsetDays: 5,
    defaultDependsOnKeys: ["POST_TAX_PROVISION"],
  },
  {
    key: "RECON_TAX_PAYABLE",
    name: "Reconcile tax payable",
    description: "Tie current tax payable balance to estimated-payment schedule.",
    category: "RECON",
    defaultDueOffsetDays: 5,
    defaultDependsOnKeys: ["POST_TAX_PROVISION"],
  },
  {
    key: "FILE_ESTIMATED_PAYMENTS",
    name: "File estimated tax payments",
    description: "Federal + state estimated payments if quarter end.",
    category: "TAX",
    defaultDueOffsetDays: 7,
    requiredForClose: false,
    defaultDependsOnKeys: ["POST_TAX_PROVISION"],
  },

  // ─── REPORTING (7) ────────────────────────────────────────────────────
  // The financial statements roll up after all recons are signed off.
  {
    key: "RUN_TRIAL_BALANCE",
    name: "Run trial balance",
    description: "Produce TB; verify DR = CR; isolate any unposted entries.",
    category: "REPORTING",
    defaultDueOffsetDays: 5,
    defaultDependsOnKeys: [
      "RECON_CASH",
      "RECON_AR",
      "RECON_AP",
      "RECON_PREPAID",
      "RECON_FIXED_ASSETS",
      "RECON_ACCUM_DEP",
      "RECON_LEASE",
      "RECON_DEFERRED_REVENUE",
      "RECON_INTERCOMPANY",
    ],
  },
  {
    key: "RUN_INCOME_STATEMENT",
    name: "Run income statement",
    description: "Period IS; compare to forecast + prior-period; isolate unexpected variances.",
    category: "REPORTING",
    defaultDueOffsetDays: 6,
    defaultDependsOnKeys: ["RUN_TRIAL_BALANCE"],
  },
  {
    key: "RUN_BALANCE_SHEET",
    name: "Run balance sheet",
    description: "Period-end BS; verify A = L + E; verify all signed-off recons reflect on the BS.",
    category: "REPORTING",
    defaultDueOffsetDays: 6,
    defaultDependsOnKeys: ["RUN_TRIAL_BALANCE"],
  },
  {
    key: "RUN_CASH_FLOW",
    name: "Run cash flow statement",
    description: "Indirect-method CF; reconcile to net change in cash from the BS.",
    category: "REPORTING",
    defaultDueOffsetDays: 6,
    defaultDependsOnKeys: ["RUN_INCOME_STATEMENT", "RUN_BALANCE_SHEET"],
  },
  {
    key: "RUN_M3_DETAIL",
    name: "Run Schedule M-3 detail",
    description: "BTD breakdown by Form 1120 M-3 line for the tax-prep handoff.",
    category: "REPORTING",
    defaultDueOffsetDays: 6,
    defaultDependsOnKeys: ["RUN_BTD_CALC", "RUN_INCOME_STATEMENT"],
  },
  {
    key: "GENERATE_MONTHEND_PACKET",
    name: "Generate month-end packet",
    description: "Compile TB + IS + BS + CF + recon rollup into the close packet.",
    category: "REPORTING",
    defaultDueOffsetDays: 7,
    defaultDependsOnKeys: [
      "RUN_TRIAL_BALANCE",
      "RUN_INCOME_STATEMENT",
      "RUN_BALANCE_SHEET",
      "RUN_CASH_FLOW",
    ],
  },
  {
    key: "SEND_TO_LEADERSHIP",
    name: "Send packet to leadership",
    description: "Email the month-end packet to CEO/CFO/audit committee.",
    category: "REPORTING",
    defaultDueOffsetDays: 7,
    defaultDependsOnKeys: ["GENERATE_MONTHEND_PACKET"],
  },

  // ─── ADMIN (5) ────────────────────────────────────────────────────────
  // Wrap-up tasks. Close GL is the formal "books are closed" gate.
  {
    key: "CLOSE_GL",
    name: "Close period in GL",
    description: "Flip PeriodClose for (entity, book, period); postJournalEntry rejects writes after.",
    category: "ADMIN",
    defaultDueOffsetDays: 7,
    defaultDependsOnKeys: ["SEND_TO_LEADERSHIP"],
  },
  {
    key: "LOCK_SUBLEDGERS",
    name: "Lock sub-ledgers",
    description: "Freeze AR/AP/FA/Lease sub-ledgers for the period; no further posts permitted.",
    category: "ADMIN",
    defaultDueOffsetDays: 7,
    defaultDependsOnKeys: ["CLOSE_GL"],
  },
  {
    key: "SEND_CLOSE_NOTIFICATION",
    name: "Send close-complete notification",
    description: "Notify the org that books are closed for the period.",
    category: "ADMIN",
    defaultDueOffsetDays: 8,
    defaultDependsOnKeys: ["CLOSE_GL", "LOCK_SUBLEDGERS"],
  },
  {
    key: "ARCHIVE_EVIDENCE",
    name: "Archive close evidence",
    description: "Move recon attachments, workpapers, packets to long-term storage.",
    category: "ADMIN",
    defaultDueOffsetDays: 8,
    defaultDependsOnKeys: ["SEND_CLOSE_NOTIFICATION"],
  },
  {
    key: "ADMIN_POSTMORTEM",
    name: "Close-process retrospective",
    description: "What slowed us down this month? What to automate before next close?",
    category: "ADMIN",
    defaultDueOffsetDays: 10,
    requiredForClose: false,
    defaultDependsOnKeys: ["SEND_CLOSE_NOTIFICATION"],
  },
];

// Compile-time guard against drift. The design doc commits to 50
// templates; if a future commit edits the array without updating this
// constant, the test catches it.
export const EXPECTED_TEMPLATE_COUNT = 50;

/**
 * Idempotent upsert of the 50 BlackLine-standard templates into the
 * given tenant's CloseTaskTemplate catalog. Re-running yields zero
 * new rows (existing keys update name/description/deps in place).
 *
 * Returns the count actually written/updated for the audit row a
 * Server Action wrapper can attach.
 */
export async function seedCloseTaskTemplates(
  prisma: PrismaClient,
  tenantId: string
): Promise<{ upserted: number }> {
  let upserted = 0;
  for (const t of CLOSE_TASK_TEMPLATES) {
    await prisma.closeTaskTemplate.upsert({
      where: { tenantId_key: { tenantId, key: t.key } },
      create: {
        tenantId,
        key: t.key,
        name: t.name,
        description: t.description,
        category: t.category,
        defaultDueOffsetDays: t.defaultDueOffsetDays,
        requiredForClose: t.requiredForClose ?? true,
        defaultDependsOnKeys: t.defaultDependsOnKeys ?? [],
        active: true,
      },
      update: {
        name: t.name,
        description: t.description,
        category: t.category,
        defaultDueOffsetDays: t.defaultDueOffsetDays,
        requiredForClose: t.requiredForClose ?? true,
        defaultDependsOnKeys: t.defaultDependsOnKeys ?? [],
      },
    });
    upserted++;
  }
  return { upserted };
}
