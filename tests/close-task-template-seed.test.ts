// BlackLine arc — Phase 2 PR 5 tests.
//
// Pins the 50-template canonical seed + round-trips against the
// instantiator from PR 2:
//
//   1. seedCloseTaskTemplates upserts EXACTLY 50 templates
//   2. category histogram matches the design-doc breakdown
//      (ACCRUAL 8 · DEPRECIATION 3 · REVENUE 6 · INVENTORY 4 · FX 3 ·
//       RECON 10 · TAX 4 · REPORTING 7 · ADMIN 5)
//      [RECON is 10 because RECON_TAX_PAYABLE lives in the TAX section
//       of the file but is taxonomically a RECON. The histogram below
//       reflects the actual category enum values.]
//   3. ALL defaultDependsOnKeys reference existing keys — no dangling
//      pointers in the canonical graph
//   4. instantiateCalendarForPeriod against a fresh tenant + period
//      creates 50 tasks with the dependency graph wired correctly
//   5. Re-running the seed is idempotent (still 50 templates, no dup)
//   6. seed → instantiate round-trip: every template key has a
//      matching task; dep arrays correctly reference task UUIDs

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

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
import {
  seedCloseTaskTemplates,
  CLOSE_TASK_TEMPLATES,
  EXPECTED_TEMPLATE_COUNT,
} from "@/lib/seed/close-task-templates";
import { instantiateCalendarForPeriod } from "@/app/actions/close-tasks";

const prisma = new PrismaClient();

const SUFFIX =
  "ct5" + Date.now().toString(36) + Math.floor(Math.random() * 9999);

let tenant: { id: string; slug: string };
let user: { id: string; email: string };
let periodId: string;

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
      slug: `ct5-${SUFFIX}`.slice(0, 60),
      name: "Template Seed Tenant",
      ownerUserId: user.id,
    },
  });
  await prisma.tenantMembership.create({
    data: { tenantId: tenant.id, userId: user.id, role: "OWNER" },
  });

  // Fresh entity + calendar + period (instantiator needs a period).
  const entity = await prisma.legalEntity.create({
    data: {
      tenantId: tenant.id,
      code: `CT5E-${SUFFIX}`.slice(0, 50),
      name: "Template Seed Entity",
      functionalCurrencyId: "USD",
    },
    select: { id: true },
  });
  const cal = await prisma.fiscalCalendar.create({
    data: {
      tenantId: tenant.id,
      entityId: entity.id,
      code: `CT5C-${SUFFIX}`.slice(0, 32),
      name: "Cal",
      periodFrequency: "MONTHLY",
    },
    select: { id: true },
  });
  const period = await prisma.period.create({
    data: {
      tenantId: tenant.id,
      calendarId: cal.id,
      code: `${SUFFIX.slice(0, 6)}-01`,
      ordinal: 1,
      startsOn: new Date("2026-06-01"),
      endsOn: new Date("2026-06-30"),
    },
    select: { id: true },
  });
  periodId = period.id;
});

afterAll(async () => {
  await prisma.closeTaskComment.deleteMany({
    where: { tenantId: tenant.id },
  });
  await prisma.closeTask.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.closeTaskTemplate.deleteMany({
    where: { tenantId: tenant.id },
  });
  await prisma.period.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.fiscalCalendar.deleteMany({
    where: { tenantId: tenant.id },
  });
  await prisma.legalEntity.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.tenantMembership.deleteMany({
    where: { tenantId: tenant.id },
  });
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

describe("CLOSE_TASK_TEMPLATES — canonical seed shape", () => {
  it("exports EXACTLY 50 templates", () => {
    expect(CLOSE_TASK_TEMPLATES).toHaveLength(EXPECTED_TEMPLATE_COUNT);
    expect(EXPECTED_TEMPLATE_COUNT).toBe(50);
  });

  it("every defaultDependsOnKeys entry references an existing template key", () => {
    const allKeys = new Set(CLOSE_TASK_TEMPLATES.map((t) => t.key));
    const dangling: { from: string; dep: string }[] = [];
    for (const t of CLOSE_TASK_TEMPLATES) {
      for (const dep of t.defaultDependsOnKeys ?? []) {
        if (!allKeys.has(dep)) {
          dangling.push({ from: t.key, dep });
        }
      }
    }
    expect(dangling).toEqual([]);
  });

  it("template keys are unique within the seed array", () => {
    const seen = new Set<string>();
    const dups: string[] = [];
    for (const t of CLOSE_TASK_TEMPLATES) {
      if (seen.has(t.key)) dups.push(t.key);
      seen.add(t.key);
    }
    expect(dups).toEqual([]);
  });

  it("no template depends on itself (would be a single-node cycle)", () => {
    const selfRefs = CLOSE_TASK_TEMPLATES.filter((t) =>
      (t.defaultDependsOnKeys ?? []).includes(t.key)
    );
    expect(selfRefs).toEqual([]);
  });
});

describe("seedCloseTaskTemplates — idempotent upsert", () => {
  it("seeds 50 templates on a fresh tenant", async () => {
    const r = await seedCloseTaskTemplates(prisma, tenant.id);
    expect(r.upserted).toBe(50);

    const dbCount = await prisma.closeTaskTemplate.count({
      where: { tenantId: tenant.id },
    });
    expect(dbCount).toBe(50);
  });

  it("idempotent: re-running upserts the same 50 with no duplicates", async () => {
    const r = await seedCloseTaskTemplates(prisma, tenant.id);
    expect(r.upserted).toBe(50);
    const dbCount = await prisma.closeTaskTemplate.count({
      where: { tenantId: tenant.id },
    });
    expect(dbCount).toBe(50); // not 100
  });
});

describe("seed → instantiate round-trip", () => {
  it("instantiator creates 50 tasks and wires the dependency graph correctly", async () => {
    signIn();
    // Templates already seeded by the previous describe block.
    const r = await instantiateCalendarForPeriod({ periodId });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("instantiator failed");
    expect(r.created).toBe(50);
    expect(r.total).toBe(50);

    const tasks = await prisma.closeTask.findMany({
      where: { tenantId: tenant.id, periodId },
      select: {
        id: true,
        templateKey: true,
        name: true,
        category: true,
        dependsOnIds: true,
        requiredForClose: true,
        dueAt: true,
      },
    });
    expect(tasks).toHaveLength(50);

    // Build the lookup map task.templateKey → task.id.
    const keyToId = new Map<string, string>();
    for (const t of tasks) {
      if (t.templateKey) keyToId.set(t.templateKey, t.id);
    }
    // Every template key maps to a task — 50/50 coverage.
    for (const t of CLOSE_TASK_TEMPLATES) {
      expect(keyToId.has(t.key)).toBe(true);
    }

    // For each template that declared deps, verify the corresponding
    // task's dependsOnIds resolves to the right predecessor task ids.
    for (const tmpl of CLOSE_TASK_TEMPLATES) {
      const expectedDepKeys = tmpl.defaultDependsOnKeys ?? [];
      if (expectedDepKeys.length === 0) continue;
      const task = tasks.find((x) => x.templateKey === tmpl.key);
      if (!task) throw new Error(`missing task for ${tmpl.key}`);
      const expectedIds = expectedDepKeys
        .map((k) => keyToId.get(k))
        .filter((x): x is string => !!x);
      expect(task.dependsOnIds).toHaveLength(expectedIds.length);
      for (const eid of expectedIds) {
        expect(task.dependsOnIds).toContain(eid);
      }
    }

    // Spot-check the optional flag: ADMIN_POSTMORTEM is the one
    // !requiredForClose template — pin that in the round-trip.
    const postmortem = tasks.find(
      (t) => t.templateKey === "ADMIN_POSTMORTEM"
    );
    expect(postmortem!.requiredForClose).toBe(false);
    // And a counter-example: ACCRUE_PAYROLL is required.
    const payroll = tasks.find((t) => t.templateKey === "ACCRUE_PAYROLL");
    expect(payroll!.requiredForClose).toBe(true);

    // Spot-check the due-date computation: ACCRUE_PAYROLL is -2 days
    // from period.endsOn (2026-06-30) → 2026-06-28.
    expect(payroll!.dueAt?.toISOString().slice(0, 10)).toBe("2026-06-28");
  });

  it("category histogram matches the design-doc breakdown", async () => {
    // From the seeded templates (NOT from the file order — categories
    // are determined by the template's `category` field).
    const histogram: Record<string, number> = {};
    for (const t of CLOSE_TASK_TEMPLATES) {
      histogram[t.category] = (histogram[t.category] ?? 0) + 1;
    }
    // Design-doc breakdown:
    //   ACCRUAL 8 · RECON 10 · DEPRECIATION 3 · FX 3 · REVENUE 6 ·
    //   INVENTORY 4 · TAX 4 · REPORTING 7 · ADMIN 5
    // RECON is 10 (not 9) because RECON_TAX_PAYABLE is taxonomically a
    // recon even though it's grouped near tax in the seed file. TAX
    // is 4 (not 5) for the same reason.
    expect(histogram).toEqual({
      ACCRUAL: 8,
      DEPRECIATION: 3,
      REVENUE: 6,
      INVENTORY: 4,
      FX: 3,
      RECON: 10,
      TAX: 4,
      REPORTING: 7,
      ADMIN: 5,
    });
    const total = Object.values(histogram).reduce((a, b) => a + b, 0);
    expect(total).toBe(50);
  });
});
