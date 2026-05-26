"use server";

// Onboarding step 2: set up the first LegalEntity, Book, FiscalCalendar,
// and optional starter chart of accounts within the user's new Tenant.
//
// Preconditions (all enforced):
//   - User must be signed in.
//   - User must have a single TenantMembership (their newly-created
//     workspace). Multi-tenant users won't reach this page because the
//     onboarding gate only fires when memberships.length === 0 OR === 1
//     without entities.
//   - The tenant must have zero LegalEntity rows. Re-running on a
//     populated tenant is a no-op (returns ok with a "already set up"
//     message) — supports browser refresh after a partial flow.
//
// On success: tenant has one entity, one book (US_GAAP), one calendar
// with 12 monthly periods for the current calendar year, and either
// the standard chart (12 accounts) or no chart (the user will build
// their own).

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import {
  requireCurrentUser,
  NotAuthenticatedError,
} from "@/lib/auth/current-user";
import { requireCurrentTenant } from "@/lib/auth/tenant";
import { auditPrivilegedAction } from "@/lib/audit/log";

export type ChartChoice = "standard" | "empty";

export interface SetupFirstEntityInput {
  entityName: string;     // human-readable, e.g. "Acme Co"
  entityCode: string;     // upper-case slug, e.g. "ACME"
  chartType: ChartChoice;
}

export interface SetupFirstEntityState {
  ok: boolean;
  message?: string;
  entityCode?: string;
}

// Slug rules for entity code: 2-30 chars, A-Z 0-9 _ -. Upper-cased.
// Matches the convention used by NORTHWIND / DEMO_CO / ACME_GROUP.
const ENTITY_CODE_RE = /^[A-Z0-9](?:[A-Z0-9]|[-_](?![-_]))*[A-Z0-9]$/;

// Standard chart of accounts. Small, opinionated, covers the basics
// every business needs out of the gate. Users can add codes later.
// Designed to mirror Northwind's coding scheme so cross-reference is
// natural for any CPA who looked at the demo first.
const STANDARD_CHART: Array<{
  code: string;
  name: string;
  type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
  normalBalance: "DEBIT" | "CREDIT";
  isContra?: boolean;
  isBank?: boolean;
  isControlAccount?: boolean;
  subtype?: string;
}> = [
  { code: "1000", name: "Cash — Operating", type: "ASSET", normalBalance: "DEBIT", isBank: true, subtype: "CASH" },
  { code: "1200", name: "Accounts Receivable", type: "ASSET", normalBalance: "DEBIT", isControlAccount: true, subtype: "AR_TRADE" },
  { code: "1500", name: "Equipment", type: "ASSET", normalBalance: "DEBIT" },
  { code: "1510", name: "Accumulated Depreciation — Equipment", type: "ASSET", normalBalance: "CREDIT", isContra: true },
  { code: "2000", name: "Accounts Payable", type: "LIABILITY", normalBalance: "CREDIT", isControlAccount: true, subtype: "AP_TRADE" },
  { code: "2200", name: "Deferred Revenue", type: "LIABILITY", normalBalance: "CREDIT" },
  { code: "3000", name: "Common Stock", type: "EQUITY", normalBalance: "CREDIT" },
  { code: "3100", name: "Retained Earnings", type: "EQUITY", normalBalance: "CREDIT" },
  { code: "4000", name: "Revenue", type: "REVENUE", normalBalance: "CREDIT" },
  { code: "5000", name: "Cost of Revenue", type: "EXPENSE", normalBalance: "DEBIT" },
  { code: "6000", name: "Operating Expenses", type: "EXPENSE", normalBalance: "DEBIT" },
  { code: "8000", name: "Depreciation Expense", type: "EXPENSE", normalBalance: "DEBIT" },
];

export async function setupFirstEntityAction(
  input: SetupFirstEntityInput
): Promise<SetupFirstEntityState> {
  let user;
  try {
    user = await requireCurrentUser();
  } catch {
    return { ok: false, message: new NotAuthenticatedError().message };
  }

  let tenant;
  try {
    tenant = await requireCurrentTenant();
  } catch {
    return { ok: false, message: "No active tenant. Create one first via /onboarding." };
  }

  // ─── Input validation ────────────────────────────────────────────────
  const name = input.entityName?.trim() ?? "";
  const code = input.entityCode?.trim().toUpperCase() ?? "";
  if (name.length < 1 || name.length > 100) {
    return { ok: false, message: "Entity name must be 1–100 chars." };
  }
  if (code.length < 2 || code.length > 30 || !ENTITY_CODE_RE.test(code)) {
    return {
      ok: false,
      message: "Entity code must be 2–30 chars: uppercase letters, digits, single hyphens/underscores. No double separators.",
    };
  }
  if (input.chartType !== "standard" && input.chartType !== "empty") {
    return { ok: false, message: "Invalid chartType — must be 'standard' or 'empty'." };
  }

  // ─── Idempotency: refresh-safe check for already-set-up tenant ──────
  const existingEntityCount = await prisma.legalEntity.count({
    where: { tenantId: tenant.id },
  });
  if (existingEntityCount > 0) {
    // Tenant already has entities. Return early without modifying anything.
    // The caller's UI bounces the user to / where they can continue.
    return {
      ok: true,
      message: "Workspace already set up; redirecting to dashboard.",
    };
  }

  // Phase 4b complete: LegalEntity.code is unique per [tenantId, code].
  // Cross-tenant collisions are no longer possible. The idempotency
  // check above (existingEntityCount > 0) guarantees the calling tenant
  // has no entities yet, so the upcoming create can't collide within
  // its own namespace either.

  // ─── Ensure USD currency + US_GAAP book exist ────────────────────────
  // These are platform-level (shared across tenants) and may already
  // exist from the Phase 1 migration / seeds. Idempotent upserts.
  await prisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    update: {},
  });
  const usGaap = await prisma.book.upsert({
    where: { code: "US_GAAP" },
    create: {
      code: "US_GAAP",
      name: "US GAAP",
      basis: "US_GAAP",
      reportingCurrencyId: "USD",
    },
    update: {},
    select: { id: true, code: true },
  });

  // ─── Create the entity, calendar, periods, optional chart ────────────
  // Done as a single transaction so a failure mid-flow leaves nothing
  // partially set up.
  const currentYear = new Date().getFullYear();
  const tenantId = tenant.id;

  const result = await prisma.$transaction(async (tx) => {
    const entity = await tx.legalEntity.create({
      data: {
        tenantId,
        code,
        name,
        functionalCurrencyId: "USD",
      },
    });

    const calendar = await tx.fiscalCalendar.create({
      data: {
        tenantId,
        entityId: entity.id,
        code: `STANDARD_${currentYear}`,
        name: `${currentYear} Standard Calendar`,
        periodFrequency: "MONTHLY",
      },
    });

    // 12 monthly periods for the current calendar year.
    for (let m = 1; m <= 12; m++) {
      await tx.period.create({
        data: {
          tenantId,
          calendarId: calendar.id,
          code: `${currentYear}-${String(m).padStart(2, "0")}`,
          ordinal: m,
          startsOn: new Date(Date.UTC(currentYear, m - 1, 1)),
          endsOn: new Date(Date.UTC(currentYear, m, 0)),
        },
      });
    }

    // Chart of accounts: ENTITY-scoped (not shared). The user can
    // delete/edit later; entity-scoped is the safe default that won't
    // leak into other entities if they add more.
    if (input.chartType === "standard") {
      for (const a of STANDARD_CHART) {
        await tx.account.create({
          data: {
            tenantId,
            entityId: entity.id,
            code: a.code,
            name: a.name,
            type: a.type,
            normalBalance: a.normalBalance,
            isContra: a.isContra ?? false,
            isBank: a.isBank ?? false,
            isControlAccount: a.isControlAccount ?? false,
            subtype: a.subtype,
          },
        });
      }
    }

    return { entityId: entity.id, entityCode: entity.code };
  });

  // Audit the setup as a privileged action — it's a one-time
  // workspace bootstrap and reviewers want to see when each tenant
  // was provisioned.
  await auditPrivilegedAction({
    actor: { id: user.id, email: user.email },
    action: "setup-first-entity",
    resource: "LegalEntity",
    resourceId: result.entityId,
    tenantId,
    metadata: {
      entityCode: result.entityCode,
      chartType: input.chartType,
      accountsCreated:
        input.chartType === "standard" ? STANDARD_CHART.length : 0,
      bookCode: usGaap.code,
      year: currentYear,
    },
  });

  revalidatePath("/", "layout");

  return {
    ok: true,
    entityCode: result.entityCode,
    message: `Workspace ready: entity ${result.entityCode}, ${input.chartType === "standard" ? STANDARD_CHART.length : 0} accounts, 12 monthly periods.`,
  };
}
