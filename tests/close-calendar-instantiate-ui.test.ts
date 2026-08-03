// Close-calendar UI entry point.
//
// `instantiateCalendarForPeriod` shipped fully tested but with ZERO UI
// callers — the 50-template catalog could never become a period's
// checklist through the product. The Close dashboard compounded it by
// reading "no CloseTask rows for this period" as "no CloseTaskTemplate
// rows for this tenant" and telling controllers to re-seed a catalog
// they had already seeded.
//
// Coverage:
//   1. resolveCloseCalendarState picks the right branch from
//      (templateCount, taskCount, periodClosed) — including the exact
//      reported case: 50 templates + 0 tasks is NOT "not seeded"
//   2. against real Postgres: the counts the pages feed the resolver
//      produce the right branch, and instantiate-from-empty flips
//      NOT_INSTANTIATED → INSTANTIATED with dependencies resolved
//   3. the action has at least one client-component caller — the
//      structural regression that let it ship unreachable
//
// Skips (not fails) without DATABASE_URL for the DB-backed block; the
// pure-resolver and reachability blocks always run.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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

import { resolveCloseCalendarState } from "@/lib/close-tasks/calendar-state";
import { getCloseTaskRollup } from "@/lib/close-tasks/rollup";
import { _internal as authInternal } from "@/lib/auth/current-user";
import { instantiateCalendarForPeriod } from "@/app/actions/close-tasks";

// ═══════════════════════════════════════════════════════════════════════
// 1. Pure branch selection
// ═══════════════════════════════════════════════════════════════════════
describe("resolveCloseCalendarState", () => {
  it("50 templates + 0 tasks is NOT_INSTANTIATED, never NO_TEMPLATES", () => {
    // The reported defect verbatim: the tenant HAS its catalog; what's
    // missing is instantiation for this period.
    const s = resolveCloseCalendarState({ templateCount: 50, taskCount: 0 });
    expect(s.kind).toBe("NOT_INSTANTIATED");
    if (s.kind !== "NOT_INSTANTIATED") throw new Error("wrong branch");
    expect(s.templateCount).toBe(50);
  });

  it("0 templates + 0 tasks is NO_TEMPLATES — seeding is the missing step", () => {
    expect(
      resolveCloseCalendarState({ templateCount: 0, taskCount: 0 }).kind
    ).toBe("NO_TEMPLATES");
  });

  it("any tasks means INSTANTIATED regardless of catalog size", () => {
    expect(
      resolveCloseCalendarState({ templateCount: 50, taskCount: 50 }).kind
    ).toBe("INSTANTIATED");
    // Templates can be deactivated after instantiation; the period's
    // existing checklist still governs the display.
    expect(
      resolveCloseCalendarState({ templateCount: 0, taskCount: 12 }).kind
    ).toBe("INSTANTIATED");
  });

  it("a closed, never-instantiated period is PERIOD_CLOSED, not a CTA", () => {
    // instantiateCalendarForPeriod refuses a period with any
    // PeriodClose row, so offering the button here would guarantee an
    // error.
    expect(
      resolveCloseCalendarState({
        templateCount: 50,
        taskCount: 0,
        periodClosed: true,
      }).kind
    ).toBe("PERIOD_CLOSED");
  });

  it("a closed period that WAS instantiated still shows its progress", () => {
    expect(
      resolveCloseCalendarState({
        templateCount: 50,
        taskCount: 50,
        periodClosed: true,
      }).kind
    ).toBe("INSTANTIATED");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. Reachability — the defect class, not just this instance
// ═══════════════════════════════════════════════════════════════════════
describe("instantiateCalendarForPeriod reachability", () => {
  const SRC = join(process.cwd(), "src");

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...walk(p));
      else if (e.name.endsWith(".tsx")) out.push(p);
    }
    return out;
  }

  it("is imported by at least one client component", () => {
    const callers = walk(SRC).filter((f) => {
      const body = readFileSync(f, "utf8");
      return (
        body.includes("instantiateCalendarForPeriod") &&
        body.includes('"use client"')
      );
    });
    expect(
      callers.length,
      "instantiateCalendarForPeriod has no client-component caller — the close-task calendar is unreachable from the UI again"
    ).toBeGreaterThan(0);
  });

  it("that caller is mounted on the close surfaces", () => {
    for (const page of [
      join(SRC, "app", "close", "page.tsx"),
      join(SRC, "app", "close", "tasks", "page.tsx"),
    ]) {
      const body = readFileSync(page, "utf8");
      expect(body, `${page} does not mount the instantiate affordance`).toContain(
        "InstantiateCalendarButton"
      );
    }
  });

  it("no user-facing copy references internal PR numbers", () => {
    // The /close/tasks empty state used to tell operators about "the
    // Server Action wired in PR 5".
    for (const page of [
      join(SRC, "app", "close", "page.tsx"),
      join(SRC, "app", "close", "tasks", "page.tsx"),
    ]) {
      const body = readFileSync(page, "utf8");
      // Strip comments — the header block legitimately narrates history.
      const code = body
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("//"))
        .join("\n");
      expect(code).not.toMatch(/\bPR \d+\b/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. DB-backed branch selection + instantiate-from-empty
// ═══════════════════════════════════════════════════════════════════════
const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb("close-calendar state against real counts", () => {
  const prisma = new PrismaClient();
  const PREFIX = "CCINST_";
  const SUFFIX =
    "cci" + Date.now().toString(36) + Math.floor(Math.random() * 9999);

  let owner: { id: string; email: string };
  let tenant: { id: string; slug: string };
  let emptyTenant: { id: string; slug: string };
  let periodId: string;
  let closedPeriodId: string;
  let bookId: string;

  // Self-healing: a killed vitest run skips afterAll and leaves rows
  // that poison the next run's counts. Scrub by prefix BEFORE seeding.
  async function scrubPrefix() {
    const stale = await prisma.tenant.findMany({
      where: { slug: { startsWith: "ccinst-" } },
      select: { id: true },
    });
    const ids = stale.map((t) => t.id);
    if (ids.length === 0) return;
    const where = { tenantId: { in: ids } };
    await prisma.closeTaskComment.deleteMany({ where });
    await prisma.closeTask.deleteMany({ where });
    await prisma.closeTaskTemplate.deleteMany({ where });
    await prisma.periodClose.deleteMany({ where });
    await prisma.period.deleteMany({ where });
    await prisma.fiscalCalendar.deleteMany({ where });
    await prisma.legalEntity.deleteMany({ where });
    await prisma.tenantMembership.deleteMany({ where });
    for (const id of ids) {
      try {
        await prisma.tenant.delete({ where: { id } });
      } catch {
        /* audit_log FK — append-only, tenant row stays */
      }
    }
  }

  beforeAll(async () => {
    await scrubPrefix();

    const c = await prisma.user.findUnique({
      where: { email: "controller@northwind.test" },
      select: { id: true, email: true },
    });
    if (!c) throw new Error("Run Northwind seed first.");
    owner = c;

    await prisma.currency.upsert({
      where: { code: "USD" },
      create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
      update: {},
    });
    const book = await prisma.book.findUnique({
      where: { code: "US_GAAP" },
      select: { id: true },
    });
    if (!book) throw new Error("Missing US_GAAP book — run the seed.");
    bookId = book.id;

    tenant = await prisma.tenant.create({
      data: {
        slug: `ccinst-${SUFFIX}`.slice(0, 60),
        name: "Close Calendar Tenant",
        ownerUserId: owner.id,
      },
      select: { id: true, slug: true },
    });
    emptyTenant = await prisma.tenant.create({
      data: {
        slug: `ccinst-empty-${SUFFIX}`.slice(0, 60),
        name: "Close Calendar Tenant (no catalog)",
        ownerUserId: owner.id,
      },
      select: { id: true, slug: true },
    });
    for (const t of [tenant, emptyTenant]) {
      await prisma.tenantMembership.create({
        data: { tenantId: t.id, userId: owner.id, role: "OWNER" },
      });
    }

    const entity = await prisma.legalEntity.create({
      data: {
        tenantId: tenant.id,
        code: `${PREFIX}E${SUFFIX}`.slice(0, 50),
        name: "Close Calendar Entity",
        functionalCurrencyId: "USD",
      },
      select: { id: true },
    });
    const cal = await prisma.fiscalCalendar.create({
      data: {
        tenantId: tenant.id,
        entityId: entity.id,
        code: `${PREFIX}C${SUFFIX}`.slice(0, 32),
        name: "Cal",
        periodFrequency: "MONTHLY",
      },
      select: { id: true },
    });
    const open = await prisma.period.create({
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
    periodId = open.id;
    const closed = await prisma.period.create({
      data: {
        tenantId: tenant.id,
        calendarId: cal.id,
        code: `${SUFFIX.slice(0, 6)}-02`,
        ordinal: 2,
        startsOn: new Date("2026-07-01"),
        endsOn: new Date("2026-07-31"),
      },
      select: { id: true },
    });
    closedPeriodId = closed.id;
    await prisma.periodClose.create({
      data: {
        tenantId: tenant.id,
        entityId: entity.id,
        bookId,
        periodId: closedPeriodId,
        closedBy: owner.id,
      },
    });

    // Two templates, B depending on A, so the instantiate assertion can
    // check dependency resolution and not just row count.
    await prisma.closeTaskTemplate.create({
      data: {
        tenantId: tenant.id,
        key: `${PREFIX}A`,
        name: "Accrue payroll",
        category: "ACCRUAL",
        active: true,
        defaultDependsOnKeys: [],
        requiredForClose: true,
      },
    });
    await prisma.closeTaskTemplate.create({
      data: {
        tenantId: tenant.id,
        key: `${PREFIX}B`,
        name: "Review accruals",
        category: "REPORTING",
        active: true,
        defaultDependsOnKeys: [`${PREFIX}A`],
        defaultDueOffsetDays: -1,
        requiredForClose: true,
      },
    });
  });

  afterAll(async () => {
    for (const t of [tenant, emptyTenant]) {
      if (!t) continue;
      const where = { tenantId: t.id };
        await prisma.closeTaskComment.deleteMany({ where });
      await prisma.closeTask.deleteMany({ where });
      await prisma.closeTaskTemplate.deleteMany({ where });
      await prisma.periodClose.deleteMany({ where });
      await prisma.period.deleteMany({ where });
      await prisma.fiscalCalendar.deleteMany({ where });
      await prisma.legalEntity.deleteMany({ where });
      await prisma.tenantMembership.deleteMany({ where });
      try {
        await prisma.tenant.delete({ where: { id: t.id } });
      } catch {
        /* audit_log FK — append-only */
      }
    }
    await prisma.$disconnect();
  });

  function signInAs(u: { id: string }, t: { slug: string }) {
    mockCookieStore.clear();
    mockCookieStore.set("lc-user", { value: authInternal.encode(u.id) });
    mockCookieStore.set("lc-tenant", { value: t.slug });
  }

  // The three counts the pages read, gathered the same way they do.
  async function pageCounts(tenantId: string, pid: string) {
    const [templateCount, rollup, anyClose] = await Promise.all([
      prisma.closeTaskTemplate.count({ where: { tenantId, active: true } }),
      getCloseTaskRollup(prisma, { tenantId, periodId: pid }),
      prisma.periodClose.findFirst({
        where: { tenantId, periodId: pid },
        select: { id: true },
      }),
    ]);
    return {
      templateCount,
      taskCount: rollup.total,
      periodClosed: !!anyClose,
    };
  }

  it("(a) tenant with no catalog resolves NO_TEMPLATES", async () => {
    // Reuse this tenant's period id — the resolver only reads counts,
    // and the empty tenant legitimately has zero of everything.
    const counts = await pageCounts(emptyTenant.id, periodId);
    expect(counts.templateCount).toBe(0);
    expect(counts.taskCount).toBe(0);
    expect(resolveCloseCalendarState(counts).kind).toBe("NO_TEMPLATES");
  });

  it("(b) catalog present, period empty resolves NOT_INSTANTIATED", async () => {
    const counts = await pageCounts(tenant.id, periodId);
    expect(counts.templateCount).toBe(2);
    expect(counts.taskCount).toBe(0);
    expect(resolveCloseCalendarState(counts).kind).toBe("NOT_INSTANTIATED");
  });

  it("(d) closed period with no checklist resolves PERIOD_CLOSED", async () => {
    const counts = await pageCounts(tenant.id, closedPeriodId);
    expect(counts.periodClosed).toBe(true);
    expect(resolveCloseCalendarState(counts).kind).toBe("PERIOD_CLOSED");
    // ...and the action would indeed have refused, which is why the
    // CTA is withheld rather than rendered-and-failing.
    signInAs(owner, tenant);
    const r = await instantiateCalendarForPeriod({ periodId: closedPeriodId });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected refusal");
    expect(r.code).toBe("PERIOD_CLOSED");
  });

  it("(c) instantiating from empty flips the branch and keeps deps intact", async () => {
    signInAs(owner, tenant);

    const before = await pageCounts(tenant.id, periodId);
    expect(resolveCloseCalendarState(before).kind).toBe("NOT_INSTANTIATED");

    // This is what the button does — nothing more.
    const r = await instantiateCalendarForPeriod({ periodId });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error);
    expect(r.created).toBe(2);

    const after = await pageCounts(tenant.id, periodId);
    expect(after.taskCount).toBe(2);
    expect(resolveCloseCalendarState(after).kind).toBe("INSTANTIATED");

    const tasks = await prisma.closeTask.findMany({
      where: { tenantId: tenant.id, periodId },
      select: { id: true, templateKey: true, dependsOnIds: true, status: true },
    });
    const a = tasks.find((t) => t.templateKey === `${PREFIX}A`);
    const b = tasks.find((t) => t.templateKey === `${PREFIX}B`);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(b!.dependsOnIds).toEqual([a!.id]);
    expect(tasks.every((t) => t.status === "NOT_STARTED")).toBe(true);

    // Re-click is a no-op, so a double-click can't duplicate the
    // checklist and the branch stays INSTANTIATED.
    const again = await instantiateCalendarForPeriod({ periodId });
    expect(again.ok).toBe(true);
    if (!again.ok) throw new Error(again.error);
    expect(again.created).toBe(0);
    expect(again.skipped).toBe(2);
    const settled = await pageCounts(tenant.id, periodId);
    expect(settled.taskCount).toBe(2);
    expect(resolveCloseCalendarState(settled).kind).toBe("INSTANTIATED");
  });
});
