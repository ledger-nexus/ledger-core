// Close-task state-history follow-on — PR 1/3 tests.
//
// Pins migration 0011 + Server Action wiring:
//   1. instantiateCalendarForPeriod writes one INITIAL row per new task
//      (fromStatus=null, toStatus=NOT_STARTED, changedById=actor)
//   2. startTask writes a row (fromStatus=NOT_STARTED, toStatus=IN_PROGRESS)
//   3. blockTask writes a row with the reason captured
//   4. unblockTask writes a row (fromStatus=BLOCKED, toStatus=IN_PROGRESS)
//   5. completeTask writes a row (fromStatus=IN_PROGRESS, toStatus=DONE)
//   6. waiveTask writes a row with the reason captured (admin path)
//   7. tenantId carried through on every row
//   8. Append-only DB trigger refuses UPDATE
//   9. Append-only DB trigger refuses DELETE (except via cascade on
//      close-task delete — that's expected and not covered here)

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
  startTask,
  completeTask,
  blockTask,
  unblockTask,
  waiveTask,
  instantiateCalendarForPeriod,
} from "@/app/actions/close-tasks";

const prisma = new PrismaClient();

const SUFFIX =
  "csh" + Date.now().toString(36) + Math.floor(Math.random() * 9999);

let tenant: { id: string; slug: string };
let owner: { id: string; email: string };
let admin: { id: string; email: string };
let periodId: string;

beforeAll(async () => {
  const c = await prisma.user.findUnique({
    where: { email: "controller@northwind.test" },
    select: { id: true, email: true },
  });
  if (!c) throw new Error("Run Northwind seed first.");
  owner = { id: c.id, email: c.email };

  const a = await prisma.user.findFirst({
    where: { email: { not: c.email } },
    select: { id: true, email: true },
  });
  if (!a) throw new Error("Seed must have ≥2 users.");
  admin = { id: a.id, email: a.email };

  await prisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    update: {},
  });
  tenant = await prisma.tenant.create({
    data: {
      slug: `csh-${SUFFIX}`.slice(0, 60),
      name: "Close-Task State-History Tenant",
      ownerUserId: owner.id,
    },
  });
  await prisma.tenantMembership.create({
    data: { tenantId: tenant.id, userId: owner.id, role: "OWNER" },
  });
  await prisma.tenantMembership.create({
    data: { tenantId: tenant.id, userId: admin.id, role: "ADMIN" },
  });

  const entity = await prisma.legalEntity.create({
    data: {
      tenantId: tenant.id,
      code: `CSHE-${SUFFIX}`.slice(0, 50),
      name: "Entity",
      functionalCurrencyId: "USD",
    },
    select: { id: true },
  });
  const cal = await prisma.fiscalCalendar.create({
    data: {
      tenantId: tenant.id,
      entityId: entity.id,
      code: `CSHC-${SUFFIX}`.slice(0, 32),
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
  // close-task cascade-deletes its state-change rows automatically.
  await prisma.closeTask.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.closeTaskTemplate.deleteMany({
    where: { tenantId: tenant.id },
  });
  await prisma.periodClose.deleteMany({ where: { tenantId: tenant.id } });
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
    /* audit_log append-only blocks tenant delete — leak */
  }
  await prisma.$disconnect();
});

function signInAs(u: { id: string }) {
  mockCookieStore.clear();
  mockCookieStore.set("lc-user", { value: authInternal.encode(u.id) });
  mockCookieStore.set("lc-tenant", { value: tenant.slug });
}

async function mintTask(name: string): Promise<string> {
  const t = await prisma.closeTask.create({
    data: {
      tenantId: tenant.id,
      periodId,
      name,
      category: "ADMIN",
      requiredForClose: true,
      dependsOnIds: [],
    },
    select: { id: true },
  });
  return t.id;
}

async function readHistory(taskId: string) {
  return prisma.closeTaskStateChange.findMany({
    where: { closeTaskId: taskId },
    orderBy: { changedAt: "asc" },
    select: {
      fromStatus: true,
      toStatus: true,
      reason: true,
      changedById: true,
      tenantId: true,
    },
  });
}

describe("state-history wiring — single-task transitions", () => {
  it("startTask records NOT_STARTED → IN_PROGRESS", async () => {
    signInAs(owner);
    const id = await mintTask("start test");
    const r = await startTask({ taskId: id });
    expect(r.ok).toBe(true);
    const history = await readHistory(id);
    // mintTask doesn't go through the action layer, so no INITIAL row.
    // The action layer's transition is the only row.
    expect(history).toHaveLength(1);
    expect(history[0].fromStatus).toBe("NOT_STARTED");
    expect(history[0].toStatus).toBe("IN_PROGRESS");
    expect(history[0].reason).toBeNull();
    expect(history[0].changedById).toBe(owner.id);
    expect(history[0].tenantId).toBe(tenant.id);
  });

  it("completeTask records IN_PROGRESS → DONE", async () => {
    signInAs(owner);
    const id = await mintTask("complete test");
    await startTask({ taskId: id });
    await completeTask({ taskId: id });
    const history = await readHistory(id);
    expect(history).toHaveLength(2);
    expect(history[1].fromStatus).toBe("IN_PROGRESS");
    expect(history[1].toStatus).toBe("DONE");
    expect(history[1].changedById).toBe(owner.id);
  });

  it("blockTask records BLOCKED with reason captured", async () => {
    signInAs(owner);
    const id = await mintTask("block test");
    await startTask({ taskId: id });
    const r = await blockTask({
      taskId: id,
      reason: "Waiting on auditor PBC list",
    });
    expect(r.ok).toBe(true);
    const history = await readHistory(id);
    expect(history).toHaveLength(2);
    const blockRow = history[1];
    expect(blockRow.fromStatus).toBe("IN_PROGRESS");
    expect(blockRow.toStatus).toBe("BLOCKED");
    expect(blockRow.reason).toBe("Waiting on auditor PBC list");
  });

  it("unblockTask records BLOCKED → IN_PROGRESS", async () => {
    signInAs(owner);
    const id = await mintTask("unblock test");
    await startTask({ taskId: id });
    await blockTask({ taskId: id, reason: "PBC delay" });
    await unblockTask({ taskId: id });
    const history = await readHistory(id);
    expect(history).toHaveLength(3);
    expect(history[2].fromStatus).toBe("BLOCKED");
    expect(history[2].toStatus).toBe("IN_PROGRESS");
    expect(history[2].reason).toBeNull();
  });

  it("waiveTask records WAIVED with reason captured (admin path)", async () => {
    signInAs(admin);
    const id = await mintTask("waive test");
    const r = await waiveTask({
      taskId: id,
      reason: "Not applicable this period",
    });
    expect(r.ok).toBe(true);
    const history = await readHistory(id);
    expect(history).toHaveLength(1);
    expect(history[0].fromStatus).toBe("NOT_STARTED");
    expect(history[0].toStatus).toBe("WAIVED");
    expect(history[0].reason).toBe("Not applicable this period");
    expect(history[0].changedById).toBe(admin.id);
  });
});

describe("state-history wiring — instantiate-calendar bulk", () => {
  it("writes one INITIAL row per newly-created task", async () => {
    signInAs(owner);
    // Mint three templates.
    const tmpl1 = await prisma.closeTaskTemplate.create({
      data: {
        tenantId: tenant.id,
        key: `${SUFFIX}_T1`,
        name: "Template 1",
        category: "ADMIN",
        defaultDependsOnKeys: [],
      },
      select: { id: true },
    });
    const tmpl2 = await prisma.closeTaskTemplate.create({
      data: {
        tenantId: tenant.id,
        key: `${SUFFIX}_T2`,
        name: "Template 2",
        category: "ACCRUAL",
        defaultDependsOnKeys: [],
      },
      select: { id: true },
    });

    // Mint a fresh period so the instantiation has a clean target.
    const period2 = await prisma.period.create({
      data: {
        tenantId: tenant.id,
        calendarId: (await prisma.fiscalCalendar.findFirst({
          where: { tenantId: tenant.id },
          select: { id: true },
        }))!.id,
        code: `${SUFFIX.slice(0, 6)}-02`,
        ordinal: 2,
        startsOn: new Date("2026-07-01"),
        endsOn: new Date("2026-07-31"),
      },
      select: { id: true },
    });

    const r = await instantiateCalendarForPeriod({ periodId: period2.id });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("instantiate failed");

    const tasksJustMinted = await prisma.closeTask.findMany({
      where: { tenantId: tenant.id, periodId: period2.id },
      select: { id: true },
    });
    expect(tasksJustMinted.length).toBeGreaterThanOrEqual(2);

    // Every just-minted task carries exactly one INITIAL state-change.
    for (const t of tasksJustMinted) {
      const history = await readHistory(t.id);
      expect(history).toHaveLength(1);
      expect(history[0].fromStatus).toBeNull();
      expect(history[0].toStatus).toBe("NOT_STARTED");
      expect(history[0].changedById).toBe(owner.id);
    }
  });
});

describe("append-only DB trigger", () => {
  it("refuses UPDATE on close_task_state_change", async () => {
    signInAs(owner);
    const id = await mintTask("trigger update test");
    await startTask({ taskId: id });
    const row = await prisma.closeTaskStateChange.findFirst({
      where: { closeTaskId: id },
      select: { id: true },
    });
    expect(row).toBeDefined();
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE close_task_state_change SET reason='hacked' WHERE id = $1::uuid`,
        row!.id
      )
    ).rejects.toThrow(/append-only/);
  });

  it("refuses DELETE on close_task_state_change", async () => {
    signInAs(owner);
    const id = await mintTask("trigger delete test");
    await startTask({ taskId: id });
    const row = await prisma.closeTaskStateChange.findFirst({
      where: { closeTaskId: id },
      select: { id: true },
    });
    expect(row).toBeDefined();
    await expect(
      prisma.$executeRawUnsafe(
        `DELETE FROM close_task_state_change WHERE id = $1::uuid`,
        row!.id
      )
    ).rejects.toThrow(/append-only/);
  });
});
