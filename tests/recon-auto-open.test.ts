// BlackLine arc — Phase 1 PR 6 integration tests.
//
// Pins the auto-instantiation contract:
//   1. Creates one OPEN recon per BS account (ASSET/LIABILITY/EQUITY),
//      skips revenue/expense accounts.
//   2. GL balance snapshotted equals signed period-end balance.
//   3. Per-account cascade resolution: Account override wins over
//      ReconciliationConfig wins over BlackLine fallback.
//   4. Idempotent: re-running yields zero new rows.
//   5. PERIOD_CLOSED rejection: refuses on a closed period.
//   6. ONE audit row per invocation regardless of N accounts.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { Decimal } from "decimal.js";

const mockCookieStore = new Map<string, { value: string }>();
vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) => mockCookieStore.get(name),
    set: (
      opts: { name: string; value: string } | string,
      maybeValue?: string
    ) => {
      if (typeof opts === "string") {
        mockCookieStore.set(opts, { value: maybeValue ?? "" });
      } else {
        mockCookieStore.set(opts.name, { value: opts.value });
      }
    },
    delete: (name: string) => mockCookieStore.delete(name),
  }),
  headers: () => ({ get: () => null }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { _internal as authInternal } from "@/lib/auth/current-user";
import { openPeriodReconciliations } from "@/app/actions/recon-auto-open";

const prisma = new PrismaClient();

const SUFFIX =
  "rcn6" + Date.now().toString(36) + Math.floor(Math.random() * 9999);

let tenant: { id: string; slug: string };
let user: { id: string; email: string };
let entity: { id: string; code: string };
let book: { id: string };
let period: { id: string; code: string };
const accountIds = {
  bsAssetA: "",
  bsAssetB: "",
  bsLiability: "",
  bsEquity: "",
  revenue: "", // should NOT get auto-opened
  expense: "", // should NOT get auto-opened
  bsAssetWithOverride: "",
};

beforeAll(async () => {
  const u = await prisma.user.findUnique({
    where: { email: "controller@northwind.test" },
    select: { id: true, email: true },
  });
  if (!u) throw new Error("Run Northwind seed first.");
  user = { id: u.id, email: u.email };

  await prisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    update: {},
  });

  tenant = await prisma.tenant.create({
    data: {
      slug: `rcn6-${SUFFIX}`.slice(0, 60),
      name: "Recon Auto-Open Tenant",
      ownerUserId: user.id,
    },
  });
  await prisma.tenantMembership.create({
    data: { tenantId: tenant.id, userId: user.id, role: "OWNER" },
  });

  const e = await prisma.legalEntity.create({
    data: {
      tenantId: tenant.id,
      code: `R6E-${SUFFIX}`.slice(0, 50),
      name: "Recon Auto-Open Entity",
      functionalCurrencyId: "USD",
    },
    select: { id: true, code: true },
  });
  entity = e;

  const b = await prisma.book.findUnique({
    where: { code: "US_GAAP" },
    select: { id: true },
  });
  if (!b) throw new Error("Missing US_GAAP book");
  book = b;

  const cal = await prisma.fiscalCalendar.create({
    data: {
      tenantId: tenant.id,
      entityId: entity.id,
      code: `R6C-${SUFFIX}`.slice(0, 32),
      name: "Cal",
      periodFrequency: "MONTHLY",
    },
  });
  const p = await prisma.period.create({
    data: {
      tenantId: tenant.id,
      calendarId: cal.id,
      code: `${SUFFIX.slice(0, 6)}-01`,
      ordinal: 1,
      startsOn: new Date("2026-06-01"),
      endsOn: new Date("2026-06-30"),
    },
    select: { id: true, code: true },
  });
  period = p;

  // Accounts spanning all 5 types so we can prove BS-only filtering.
  // Use tenant-scoped accounts (entityId=null is the shared bucket).
  async function mintAccount(
    code: string,
    type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE",
    overrides?: {
      requiresReconReview?: boolean | null;
      reconTolerance?: string | null;
    }
  ): Promise<string> {
    const isDebit = type === "ASSET" || type === "EXPENSE";
    const a = await prisma.account.create({
      data: {
        tenantId: tenant.id,
        code,
        name: `${code} test`,
        type,
        normalBalance: isDebit ? "DEBIT" : "CREDIT",
        requiresReconReview: overrides?.requiresReconReview ?? null,
        reconTolerance: (overrides?.reconTolerance ?? null) as never,
      },
      select: { id: true },
    });
    return a.id;
  }
  accountIds.bsAssetA = await mintAccount(`A1-${SUFFIX}`.slice(0, 20), "ASSET");
  accountIds.bsAssetB = await mintAccount(`A2-${SUFFIX}`.slice(0, 20), "ASSET");
  accountIds.bsLiability = await mintAccount(
    `L1-${SUFFIX}`.slice(0, 20),
    "LIABILITY"
  );
  accountIds.bsEquity = await mintAccount(`E1-${SUFFIX}`.slice(0, 20), "EQUITY");
  accountIds.revenue = await mintAccount(`R1-${SUFFIX}`.slice(0, 20), "REVENUE");
  accountIds.expense = await mintAccount(`X1-${SUFFIX}`.slice(0, 20), "EXPENSE");
  // BS account with Account-level overrides — pins the cascade win path.
  accountIds.bsAssetWithOverride = await mintAccount(
    `A3-${SUFFIX}`.slice(0, 20),
    "ASSET",
    { requiresReconReview: false, reconTolerance: "5.00" }
  );

  // Post one JE to give bsAssetA a non-zero GL balance — proves the
  // snapshot reads the trial-balance correctly.
  // Need a balancing entry; use bsLiability for the credit side.
  const je = await prisma.journalEntry.create({
    data: {
      tenantId: tenant.id,
      entityId: entity.id,
      bookId: book.id,
      periodId: period.id,
      documentDate: new Date("2026-06-15"),
      postingDate: new Date("2026-06-15"),
      currencyId: "USD",
      memo: "test",
      status: "POSTED",
      source: "MANUAL",
      entryNumber: `JE-${SUFFIX}`.slice(0, 30),
      lines: {
        create: [
          {
            tenantId: tenant.id,
            lineNo: 1,
            accountId: accountIds.bsAssetA,
            debit: "12345.67" as never,
            credit: "0" as never,
          },
          {
            tenantId: tenant.id,
            lineNo: 2,
            accountId: accountIds.bsLiability,
            debit: "0" as never,
            credit: "12345.67" as never,
          },
        ],
      },
    },
    select: { id: true },
  });
  expect(je.id).toBeTruthy();
});

afterAll(async () => {
  await prisma.journalLine.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.journalEntry.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.reconciliation.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.account.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.period.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.periodClose.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.fiscalCalendar.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.legalEntity.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.tenantMembership.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.reconciliationConfig.deleteMany({ where: { tenantId: tenant.id } });
  try {
    await prisma.tenant.delete({ where: { id: tenant.id } });
  } catch {
    /* audit_log FK */
  }
  await prisma.$disconnect();
});

function signIn() {
  mockCookieStore.clear();
  mockCookieStore.set("lc-user", { value: authInternal.encode(user.id) });
  mockCookieStore.set("lc-tenant", { value: tenant.slug });
}

describe("openPeriodReconciliations — auto-instantiation", () => {
  it("creates one OPEN recon per BS account, skips IS accounts, snapshots GL balance", async () => {
    signIn();
    const r = await openPeriodReconciliations({
      entityId: entity.id,
      bookId: book.id,
      periodId: period.id,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("auto-open failed");

    // 5 BS accounts (bsAssetA, bsAssetB, bsLiability, bsEquity,
    // bsAssetWithOverride). Revenue + expense MUST NOT show up.
    expect(r.created).toBe(5);
    expect(r.total).toBe(5);

    // Confirm: no recon row for revenue or expense.
    const revenueRecon = await prisma.reconciliation.findFirst({
      where: { accountId: accountIds.revenue, periodId: period.id },
    });
    expect(revenueRecon).toBeNull();
    const expenseRecon = await prisma.reconciliation.findFirst({
      where: { accountId: accountIds.expense, periodId: period.id },
    });
    expect(expenseRecon).toBeNull();

    // Confirm: bsAssetA's GL balance = +12345.67 (debit normal-side
    // signed). Pins the trial-balance integration.
    const assetA = await prisma.reconciliation.findFirst({
      where: { accountId: accountIds.bsAssetA, periodId: period.id },
      select: { glBalance: true, status: true },
    });
    expect(assetA).not.toBeNull();
    expect(assetA!.status).toBe("OPEN");
    expect(new Decimal(assetA!.glBalance.toString()).toString()).toBe(
      "12345.67"
    );

    // Confirm: bsLiability's GL balance = +12345.67 (credit normal-side
    // signed, so credit-debit flips positive).
    const liab = await prisma.reconciliation.findFirst({
      where: { accountId: accountIds.bsLiability, periodId: period.id },
      select: { glBalance: true },
    });
    expect(new Decimal(liab!.glBalance.toString()).toString()).toBe("12345.67");
  });

  it("cascade resolution: Account override wins over tenant config", async () => {
    signIn();
    // Set a tenant config that says requiresReview=true, tolerance=2.50.
    await prisma.reconciliationConfig.create({
      data: {
        tenantId: tenant.id,
        defaultRequiresReview: true,
        defaultTolerance: "2.50" as never,
      },
    });

    // Recons already exist from the prior test. Re-running shouldn't
    // touch the existing rows (idempotent), so the override account's
    // stored values reflect the resolution at INITIAL create time.
    // To test the cascade, wipe just the override account's recon and
    // re-run.
    await prisma.reconciliation.deleteMany({
      where: { accountId: accountIds.bsAssetWithOverride, periodId: period.id },
    });

    const r = await openPeriodReconciliations({
      entityId: entity.id,
      bookId: book.id,
      periodId: period.id,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("auto-open failed");
    expect(r.created).toBe(1); // only the deleted one
    expect(r.skipped).toBe(4);

    const override = await prisma.reconciliation.findFirst({
      where: {
        accountId: accountIds.bsAssetWithOverride,
        periodId: period.id,
      },
      select: { requiresReview: true, tolerance: true },
    });
    expect(override).not.toBeNull();
    // Account override beats tenant config.
    expect(override!.requiresReview).toBe(false);
    expect(new Decimal(override!.tolerance.toString()).toString()).toBe(
      "5"
    );

    // Spot-check that a non-override account picked up the tenant
    // default tolerance, NOT the BlackLine fallback. We deleted only
    // the override account's row, so we need to wipe + recreate a
    // non-override one to see the tenant default applied at create
    // time.
    await prisma.reconciliation.deleteMany({
      where: { accountId: accountIds.bsAssetB, periodId: period.id },
    });
    const r2 = await openPeriodReconciliations({
      entityId: entity.id,
      bookId: book.id,
      periodId: period.id,
    });
    if (!r2.ok) throw new Error("re-run failed");
    expect(r2.created).toBe(1);
    const reB = await prisma.reconciliation.findFirst({
      where: { accountId: accountIds.bsAssetB, periodId: period.id },
      select: { requiresReview: true, tolerance: true },
    });
    expect(reB!.requiresReview).toBe(true); // from tenant config
    expect(new Decimal(reB!.tolerance.toString()).toString()).toBe("2.5");
  });

  it("idempotent: re-running creates zero new rows", async () => {
    signIn();
    const r = await openPeriodReconciliations({
      entityId: entity.id,
      bookId: book.id,
      periodId: period.id,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("auto-open failed");
    expect(r.created).toBe(0);
    expect(r.skipped).toBe(5);
    expect(r.total).toBe(5);
  });

  it("refuses on a CLOSED period", async () => {
    signIn();
    await prisma.periodClose.create({
      data: {
        tenantId: tenant.id,
        entityId: entity.id,
        bookId: book.id,
        periodId: period.id,
        closedBy: user.id,
      },
    });
    const r = await openPeriodReconciliations({
      entityId: entity.id,
      bookId: book.id,
      periodId: period.id,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("should reject");
    expect(r.code).toBe("PERIOD_CLOSED");
    // Cleanup so other tests stay deterministic.
    await prisma.periodClose.deleteMany({
      where: { entityId: entity.id, bookId: book.id, periodId: period.id },
    });
  });

  it("ONE audit row per invocation regardless of N accounts", async () => {
    signIn();
    const before = await prisma.auditLog.count({
      where: {
        tenantId: tenant.id,
        action: "recon.period.auto-open",
      },
    });
    // Wipe so the call has work to do. Use a fresh period to avoid
    // colliding with the now-populated test period.
    const cal2 = await prisma.fiscalCalendar.findFirst({
      where: { entityId: entity.id },
      select: { id: true },
    });
    if (!cal2) throw new Error("missing cal");
    const period2 = await prisma.period.create({
      data: {
        tenantId: tenant.id,
        calendarId: cal2.id,
        code: `${SUFFIX.slice(0, 6)}-02`,
        ordinal: 2,
        startsOn: new Date("2026-07-01"),
        endsOn: new Date("2026-07-31"),
      },
      select: { id: true },
    });
    const r = await openPeriodReconciliations({
      entityId: entity.id,
      bookId: book.id,
      periodId: period2.id,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("auto-open failed");
    expect(r.created).toBe(5);
    const after = await prisma.auditLog.count({
      where: {
        tenantId: tenant.id,
        action: "recon.period.auto-open",
      },
    });
    // ONE row, not 5.
    expect(after).toBe(before + 1);

    // Audit metadata includes the count.
    const row = await prisma.auditLog.findFirst({
      where: {
        tenantId: tenant.id,
        action: "recon.period.auto-open",
      },
      orderBy: { occurredAt: "desc" },
      select: { metadata: true },
    });
    const meta = row!.metadata as Record<string, unknown>;
    expect(meta.created).toBe(5);
    expect(meta.total).toBe(5);
  });
});
