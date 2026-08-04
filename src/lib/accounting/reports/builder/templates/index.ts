// System-template registry.
//
// The 4 GAAP financial statements ship as code constants. Per-tenant
// copies persist as ReportTemplate rows on tenant creation (via
// seedSystemTemplates in ../seed.ts).
//
// Adding a new system template:
//   1. Create templates/<code>.ts exporting a ReportTemplate const
//   2. Add it to SYSTEM_TEMPLATES below
//   3. Re-run seedSystemTemplates(prisma, tenantId) for affected tenants
//      OR bump the version and let PR 6's UI handle re-seed-on-upgrade

import type { ReportTemplate } from "../types";

import { INCOME_STATEMENT_TEMPLATE } from "./income-statement";
import { BALANCE_SHEET_TEMPLATE } from "./balance-sheet";
import { CASH_FLOW_TEMPLATE } from "./cash-flow";
import { EQUITY_TEMPLATE } from "./equity";

export const SYSTEM_TEMPLATES: ReportTemplate[] = [
  INCOME_STATEMENT_TEMPLATE,
  BALANCE_SHEET_TEMPLATE,
  CASH_FLOW_TEMPLATE,
  EQUITY_TEMPLATE,
];

export {
  INCOME_STATEMENT_TEMPLATE,
  BALANCE_SHEET_TEMPLATE,
  CASH_FLOW_TEMPLATE,
  EQUITY_TEMPLATE,
};
