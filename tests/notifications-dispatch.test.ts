// Close-alerts cron dispatcher tests.
//
// Pins the end-to-end flow against a real Postgres + a mocked fetch:
//   1. Disabled channel is skipped (no dispatch row written)
//   2. Severity filter is respected (medium-only channel skips high)
//   3. Empty severityFilter means "all severities"
//   4. Dedupe: a second cron tick for the same alert is a no-op
//   5. Slack 4xx writes a dispatch row with sendError + sendStatus=400
//   6. Network error writes a dispatch row with sendStatus=null + error
//   7. Decrypt failure writes a dispatch row with sendError, no fetch call
//
// Isolation strategy: each test mints a brand-new tenant + entity +
// calendar + period + recon, so the dispatcher's "latest open period
// per (entity, book)" walk returns exactly the period the test planted.
// Sharing the Northwind tenant doesn't work — Northwind has many
// periods and the dispatcher picks the most-recent open one, which
// is not the same period as the test's recon.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";

import { dispatchCloseAlerts } from "@/lib/notifications/dispatch";
import { encryptWebhookUrl } from "@/lib/notifications/crypto";

const prisma = new PrismaClient();
const TEST_KEY = randomBytes(32).toString("base64");
let savedKey: string | undefined;

let ownerUserId: string;
let bookId: string;

beforeAll(async () => {
  savedKey = process.env.WEBHOOK_ENCRYPTION_KEY;
  process.env.WEBHOOK_ENCRYPTION_KEY = TEST_KEY;

  const u = await prisma.user.findUnique({
    where: { email: "controller@northwind.test" },
    select: { id: true },
  });
  if (!u) throw new Error("Run Northwind seed first.");
  ownerUserId = u.id;

  await prisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    update: {},
  });

  const book = await prisma.book.findUnique({
    where: { code: "US_GAAP" },
    select: { id: true },
  });
  if (!book) throw new Error("Northwind seed missing US_GAAP book.");
  bookId = book.id;
});

afterAll(async () => {
  if (savedKey !== undefined) {
    process.env.WEBHOOK_ENCRYPTION_KEY = savedKey;
  } else {
    delete process.env.WEBHOOK_ENCRYPTION_KEY;
  }
  await prisma.$disconnect();
});

interface ScenarioState {
  tenantId: string;
  entityId: string;
  periodId: string;
  accountId: string;
  reconId: string;
}

/**
 * Builds a complete fresh universe (tenant + entity + calendar + period +
 * EXCEPTION recon). Each test calls this so the dispatcher's
 * "latest open period per (entity, book)" walk finds exactly this
 * period (it's the only one for this entity).
 *
 * Returns a cleanup function that the test invokes on completion.
 */
async function setupScenario(): Promise<{
  state: ScenarioState;
  cleanup: () => Promise<void>;
}> {
  const suffix =
    "nd" + Date.now().toString(36) + Math.floor(Math.random() * 9999);

  const tenant = await prisma.tenant.create({
    data: {
      slug: `nd-${suffix}`.slice(0, 60),
      name: `Notification Dispatch Tenant ${suffix}`,
      ownerUserId,
    },
  });
  await prisma.tenantMembership.create({
    data: { tenantId: tenant.id, userId: ownerUserId, role: "OWNER" },
  });

  const entity = await prisma.legalEntity.create({
    data: {
      tenantId: tenant.id,
      code: `ND-${suffix}`.slice(0, 50),
      name: "Dispatch Test Entity",
      functionalCurrencyId: "USD",
    },
    select: { id: true },
  });
  const cal = await prisma.fiscalCalendar.create({
    data: {
      tenantId: tenant.id,
      entityId: entity.id,
      code: `NDC-${suffix}`.slice(0, 32),
      name: "Cal",
      periodFrequency: "MONTHLY",
    },
    select: { id: true },
  });
  const period = await prisma.period.create({
    data: {
      tenantId: tenant.id,
      calendarId: cal.id,
      code: `${suffix.slice(0, 8)}-01`,
      ordinal: 1,
      startsOn: new Date("2026-06-01"),
      endsOn: new Date("2026-06-30"),
    },
    select: { id: true },
  });
  const acct = await prisma.account.create({
    data: {
      tenantId: tenant.id,
      code: `ND_${suffix}`.slice(0, 20),
      name: "Dispatch Test Acct",
      type: "ASSET",
      normalBalance: "DEBIT",
    },
    select: { id: true },
  });
  const recon = await prisma.reconciliation.create({
    data: {
      tenantId: tenant.id,
      entityId: entity.id,
      bookId,
      periodId: period.id,
      accountId: acct.id,
      glBalance: "100" as never,
      tolerance: "0.5" as never,
      status: "EXCEPTION",
    },
    select: { id: true },
  });

  const cleanup = async () => {
    await prisma.notificationDispatch.deleteMany({
      where: { tenantId: tenant.id },
    });
    await prisma.notificationChannel.deleteMany({
      where: { tenantId: tenant.id },
    });
    await prisma.reconciliation.delete({ where: { id: recon.id } });
    await prisma.account.delete({ where: { id: acct.id } });
    await prisma.period.delete({ where: { id: period.id } });
    await prisma.fiscalCalendar.delete({ where: { id: cal.id } });
    await prisma.legalEntity.delete({ where: { id: entity.id } });
    await prisma.tenantMembership.deleteMany({
      where: { tenantId: tenant.id },
    });
    try {
      await prisma.tenant.delete({ where: { id: tenant.id } });
    } catch {
      /* audit_log append-only — leak */
    }
  };

  return {
    state: {
      tenantId: tenant.id,
      entityId: entity.id,
      periodId: period.id,
      accountId: acct.id,
      reconId: recon.id,
    },
    cleanup,
  };
}

async function mintChannel(
  tenantId: string,
  opts: {
    enabled?: boolean;
    severityFilter?: string[];
    webhookUrl?: string;
  }
): Promise<string> {
  const url = opts.webhookUrl ?? "https://hooks.slack.com/services/T/B/test";
  const ch = await prisma.notificationChannel.create({
    data: {
      tenantId,
      type: "SLACK",
      name: `nd-${Math.random().toString(36).slice(2, 8)}`,
      webhookUrl: encryptWebhookUrl(url),
      severityFilter: opts.severityFilter ?? [],
      enabled: opts.enabled ?? true,
      createdById: ownerUserId,
    },
    select: { id: true },
  });
  return ch.id;
}

describe("dispatchCloseAlerts", () => {
  it("disabled channel is skipped — no dispatch row, no fetch call", async () => {
    const { state, cleanup } = await setupScenario();
    const spy = vi.spyOn(global, "fetch");
    try {
      const id = await mintChannel(state.tenantId, { enabled: false });
      await dispatchCloseAlerts(prisma, { maxPeriodsPerTenant: 100 });
      const dispatches = await prisma.notificationDispatch.count({
        where: { channelId: id },
      });
      expect(dispatches).toBe(0);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      await cleanup();
    }
  });

  it("severity filter is respected (medium-only skips the high alert)", async () => {
    const { state, cleanup } = await setupScenario();
    const spy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(
        new Response("ok", { status: 200 }) as unknown as Response
      );
    try {
      const id = await mintChannel(state.tenantId, {
        severityFilter: ["medium"],
      });
      await dispatchCloseAlerts(prisma, { maxPeriodsPerTenant: 100 });
      const dispatches = await prisma.notificationDispatch.count({
        where: { channelId: id },
      });
      // High alert + medium-only filter = nothing dispatched.
      expect(dispatches).toBe(0);
    } finally {
      spy.mockRestore();
      await cleanup();
    }
  });

  it("empty severityFilter dispatches the high alert", async () => {
    const { state, cleanup } = await setupScenario();
    const spy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(
        new Response("ok", { status: 200 }) as unknown as Response
      );
    try {
      const id = await mintChannel(state.tenantId, { severityFilter: [] });
      await dispatchCloseAlerts(prisma, { maxPeriodsPerTenant: 100 });
      const dispatches = await prisma.notificationDispatch.findMany({
        where: { channelId: id },
        select: { sendStatus: true, severity: true },
      });
      expect(dispatches.length).toBe(1);
      expect(dispatches[0].severity).toBe("high");
      expect(dispatches[0].sendStatus).toBe(200);
    } finally {
      spy.mockRestore();
      await cleanup();
    }
  });

  it("dedupes: second cron tick is a no-op (no second send, no second row)", async () => {
    const { state, cleanup } = await setupScenario();
    const spy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(
        new Response("ok", { status: 200 }) as unknown as Response
      );
    try {
      const id = await mintChannel(state.tenantId, {});
      await dispatchCloseAlerts(prisma, { maxPeriodsPerTenant: 100 });
      const first = await prisma.notificationDispatch.count({
        where: { channelId: id },
      });
      expect(first).toBe(1);
      const fetchCallsAfterFirst = spy.mock.calls.length;

      await dispatchCloseAlerts(prisma, { maxPeriodsPerTenant: 100 });
      const second = await prisma.notificationDispatch.count({
        where: { channelId: id },
      });
      expect(second).toBe(1); // no new row
      expect(spy.mock.calls.length).toBe(fetchCallsAfterFirst); // no second fetch
    } finally {
      spy.mockRestore();
      await cleanup();
    }
  });

  it("Slack 4xx writes a dispatch row with sendStatus=400 + sendError", async () => {
    const { state, cleanup } = await setupScenario();
    const spy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(
        new Response("invalid_payload", { status: 400 }) as unknown as Response
      );
    try {
      const id = await mintChannel(state.tenantId, {});
      await dispatchCloseAlerts(prisma, { maxPeriodsPerTenant: 100 });
      const dispatches = await prisma.notificationDispatch.findMany({
        where: { channelId: id },
        select: { sendStatus: true, sendError: true },
      });
      expect(dispatches.length).toBe(1);
      expect(dispatches[0].sendStatus).toBe(400);
      expect(dispatches[0].sendError).toContain("400");
    } finally {
      spy.mockRestore();
      await cleanup();
    }
  });

  it("network error writes a dispatch row with sendStatus=null + error message", async () => {
    const { state, cleanup } = await setupScenario();
    const spy = vi
      .spyOn(global, "fetch")
      .mockRejectedValue(new Error("ECONNREFUSED"));
    try {
      const id = await mintChannel(state.tenantId, {});
      await dispatchCloseAlerts(prisma, { maxPeriodsPerTenant: 100 });
      const dispatches = await prisma.notificationDispatch.findMany({
        where: { channelId: id },
        select: { sendStatus: true, sendError: true },
      });
      expect(dispatches.length).toBe(1);
      expect(dispatches[0].sendStatus).toBeNull();
      expect(dispatches[0].sendError).toContain("ECONNREFUSED");
    } finally {
      spy.mockRestore();
      await cleanup();
    }
  });

  it("decrypt failure writes a dispatch row with sendError, no fetch call", async () => {
    const { state, cleanup } = await setupScenario();
    const spy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(
        new Response("ok", { status: 200 }) as unknown as Response
      );
    try {
      // Encrypt under a DIFFERENT key, then set the current key back.
      const altKey = randomBytes(32).toString("base64");
      const original = process.env.WEBHOOK_ENCRYPTION_KEY;
      process.env.WEBHOOK_ENCRYPTION_KEY = altKey;
      const garbled = encryptWebhookUrl(
        "https://hooks.slack.com/services/garbled"
      );
      process.env.WEBHOOK_ENCRYPTION_KEY = original;

      const id = await mintChannel(state.tenantId, {});
      await prisma.notificationChannel.update({
        where: { id },
        data: { webhookUrl: garbled },
      });

      await dispatchCloseAlerts(prisma, { maxPeriodsPerTenant: 100 });
      const dispatches = await prisma.notificationDispatch.findMany({
        where: { channelId: id },
        select: { sendStatus: true, sendError: true },
      });
      expect(dispatches.length).toBe(1);
      expect(dispatches[0].sendStatus).toBeNull();
      expect(dispatches[0].sendError).toContain("decrypt failed");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      await cleanup();
    }
  });
});
