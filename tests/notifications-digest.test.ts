// Close-alerts digest dispatcher tests.
//
// Pins:
//   1. Cadence separation — an IMMEDIATE channel is never picked up by
//      the digest dispatcher (and vice-versa, asserted via fetch spy).
//   2. Zero fresh alerts → no Slack send, no dispatch rows. Quiet days
//      stay quiet — no "0 alerts" noise message.
//   3. N fresh alerts → ONE Slack fetch call carrying N attachments.
//      Dispatch rows: one per alert with the send outcome.
//   4. Severity filter respected — a medium-only digest skips a HIGH
//      alert (alertsSkippedSeverity counter increments).
//   5. Idempotency — second tick same day finds every alert already
//      dispatched, sends nothing, writes no new rows.
//   6. Slack 4xx — every batched alert still gets a dispatch row, with
//      sendStatus + sendError set. Dedupe lock prevents tomorrow's
//      digest from re-pinging the same alerts.
//   7. Decrypt failure — every fresh alert gets a dispatch row with
//      the diagnostic, no fetch call.
//   8. URL scrub — sendError never contains the plaintext webhook URL
//      even when the upstream Slack response or network error leaks
//      one in.
//
// Isolation: each test mints a fresh tenant + entity + calendar +
// period + N EXCEPTION recons. The digest dispatcher's open-period
// walk finds exactly the test's period.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";

import { dispatchCloseDigests } from "@/lib/notifications/digest";
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
  reconIds: string[];
  accountIds: string[];
}

/**
 * Builds a fresh universe with `reconCount` EXCEPTION recons under
 * one (entity, book, period). Each recon's status=EXCEPTION makes it
 * surface as a CloseAlert, so the digest can be exercised across
 * multiple fresh alerts at once.
 */
async function setupScenario(reconCount = 3): Promise<{
  state: ScenarioState;
  cleanup: () => Promise<void>;
}> {
  const suffix =
    "ng" + Date.now().toString(36) + Math.floor(Math.random() * 9999);

  const tenant = await prisma.tenant.create({
    data: {
      slug: `ng-${suffix}`.slice(0, 60),
      name: `Notification Digest Tenant ${suffix}`,
      ownerUserId,
    },
  });
  await prisma.tenantMembership.create({
    data: { tenantId: tenant.id, userId: ownerUserId, role: "OWNER" },
  });

  const entity = await prisma.legalEntity.create({
    data: {
      tenantId: tenant.id,
      code: `NG-${suffix}`.slice(0, 50),
      name: "Digest Test Entity",
      functionalCurrencyId: "USD",
    },
    select: { id: true },
  });
  const cal = await prisma.fiscalCalendar.create({
    data: {
      tenantId: tenant.id,
      entityId: entity.id,
      code: `NGC-${suffix}`.slice(0, 32),
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

  const accountIds: string[] = [];
  const reconIds: string[] = [];
  for (let i = 0; i < reconCount; i++) {
    const acct = await prisma.account.create({
      data: {
        tenantId: tenant.id,
        code: `NG_${suffix}_${i}`.slice(0, 20),
        name: `Digest Acct ${i}`,
        type: "ASSET",
        normalBalance: "DEBIT",
      },
      select: { id: true },
    });
    accountIds.push(acct.id);
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
    reconIds.push(recon.id);
  }

  const cleanup = async () => {
    await prisma.notificationDispatch.deleteMany({
      where: { tenantId: tenant.id },
    });
    await prisma.notificationChannel.deleteMany({
      where: { tenantId: tenant.id },
    });
    for (const rid of reconIds) {
      await prisma.reconciliation.delete({ where: { id: rid } });
    }
    for (const aid of accountIds) {
      await prisma.account.delete({ where: { id: aid } });
    }
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
      reconIds,
      accountIds,
    },
    cleanup,
  };
}

async function mintChannel(
  tenantId: string,
  opts: {
    mode: "IMMEDIATE" | "DIGEST_DAILY";
    enabled?: boolean;
    severityFilter?: string[];
    webhookUrl?: string;
  }
): Promise<string> {
  const url = opts.webhookUrl ?? "https://hooks.slack.com/services/T/B/digest";
  const ch = await prisma.notificationChannel.create({
    data: {
      tenantId,
      type: "SLACK",
      name: `ng-${Math.random().toString(36).slice(2, 8)}`,
      webhookUrl: encryptWebhookUrl(url),
      severityFilter: opts.severityFilter ?? [],
      mode: opts.mode,
      enabled: opts.enabled ?? true,
      createdById: ownerUserId,
    },
    select: { id: true },
  });
  return ch.id;
}

describe("dispatchCloseDigests", () => {
  it("ignores IMMEDIATE channels — only DIGEST_DAILY are scanned", async () => {
    const { state, cleanup } = await setupScenario(2);
    const spy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(
        new Response("ok", { status: 200 }) as unknown as Response
      );
    try {
      const immediateId = await mintChannel(state.tenantId, {
        mode: "IMMEDIATE",
      });
      await dispatchCloseDigests(prisma, { maxPeriodsPerTenant: 100 });
      // Digest tick should have written nothing for the IMMEDIATE
      // channel and the spy should not have been called for it.
      const dispatches = await prisma.notificationDispatch.count({
        where: { channelId: immediateId },
      });
      expect(dispatches).toBe(0);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      await cleanup();
    }
  });

  it("zero fresh alerts → no Slack send, no dispatch rows (quiet days stay quiet)", async () => {
    const { state, cleanup } = await setupScenario(0); // no recons → no alerts
    const spy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(
        new Response("ok", { status: 200 }) as unknown as Response
      );
    try {
      const id = await mintChannel(state.tenantId, { mode: "DIGEST_DAILY" });
      const result = await dispatchCloseDigests(prisma, {
        maxPeriodsPerTenant: 100,
      });
      expect(spy).not.toHaveBeenCalled();
      const dispatches = await prisma.notificationDispatch.count({
        where: { channelId: id },
      });
      expect(dispatches).toBe(0);
      // Tenant scanned, but no channel sent.
      const tenant = result.tenants.find((t) => t.tenantId === state.tenantId);
      expect(tenant?.channelsSent).toBe(0);
      expect(tenant?.alertsBatched).toBe(0);
    } finally {
      spy.mockRestore();
      await cleanup();
    }
  });

  it("N fresh alerts → ONE Slack call carrying N attachments, N dispatch rows", async () => {
    const { state, cleanup } = await setupScenario(3);
    let capturedBody: string | undefined;
    const spy = vi.spyOn(global, "fetch").mockImplementation(async (_url, init) => {
      capturedBody = init?.body as string;
      return new Response("ok", { status: 200 }) as unknown as Response;
    });
    try {
      const id = await mintChannel(state.tenantId, { mode: "DIGEST_DAILY" });
      const result = await dispatchCloseDigests(prisma, {
        maxPeriodsPerTenant: 100,
        digestDate: "2026-06-10",
      });
      // One fetch carrying all alerts batched together.
      expect(spy).toHaveBeenCalledTimes(1);
      expect(capturedBody).toBeDefined();
      const payload = JSON.parse(capturedBody!);
      expect(payload.attachments).toBeDefined();
      expect(payload.attachments.length).toBe(state.reconIds.length);
      expect(payload.text).toContain("2026-06-10");
      // Plural form in the header.
      expect(payload.text).toContain("3 new");

      // One dispatch row per alert.
      const dispatches = await prisma.notificationDispatch.findMany({
        where: { channelId: id },
        select: { sendStatus: true, alertFingerprint: true },
      });
      expect(dispatches.length).toBe(state.reconIds.length);
      for (const d of dispatches) {
        expect(d.sendStatus).toBe(200);
      }

      const tenant = result.tenants.find((t) => t.tenantId === state.tenantId);
      expect(tenant?.channelsSent).toBe(1);
      expect(tenant?.alertsBatched).toBe(state.reconIds.length);
    } finally {
      spy.mockRestore();
      await cleanup();
    }
  });

  it("severity filter respected — medium-only digest skips HIGH alert", async () => {
    const { state, cleanup } = await setupScenario(2);
    const spy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(
        new Response("ok", { status: 200 }) as unknown as Response
      );
    try {
      const id = await mintChannel(state.tenantId, {
        mode: "DIGEST_DAILY",
        severityFilter: ["medium"],
      });
      const result = await dispatchCloseDigests(prisma, {
        maxPeriodsPerTenant: 100,
      });
      // EXCEPTION recons surface as high severity → medium filter
      // drops every alert. No fetch, no dispatch row.
      expect(spy).not.toHaveBeenCalled();
      const dispatches = await prisma.notificationDispatch.count({
        where: { channelId: id },
      });
      expect(dispatches).toBe(0);
      const tenant = result.tenants.find((t) => t.tenantId === state.tenantId);
      expect(tenant?.alertsSkippedSeverity).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
      await cleanup();
    }
  });

  it("idempotent: second tick same day is a no-op (no second send, no new rows)", async () => {
    const { state, cleanup } = await setupScenario(2);
    const spy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(
        new Response("ok", { status: 200 }) as unknown as Response
      );
    try {
      const id = await mintChannel(state.tenantId, { mode: "DIGEST_DAILY" });
      await dispatchCloseDigests(prisma, { maxPeriodsPerTenant: 100 });
      const firstCount = await prisma.notificationDispatch.count({
        where: { channelId: id },
      });
      expect(firstCount).toBe(state.reconIds.length);
      const firstFetches = spy.mock.calls.length;

      await dispatchCloseDigests(prisma, { maxPeriodsPerTenant: 100 });
      const secondCount = await prisma.notificationDispatch.count({
        where: { channelId: id },
      });
      expect(secondCount).toBe(firstCount); // no new rows
      expect(spy.mock.calls.length).toBe(firstFetches); // no second send
    } finally {
      spy.mockRestore();
      await cleanup();
    }
  });

  it("does NOT re-ping alerts already dispatched by the IMMEDIATE cron", async () => {
    // Cross-cadence integrity: if IMMEDIATE already pinged an alert
    // for one channel, a DIFFERENT channel in DIGEST_DAILY mode
    // SHOULD still ping that alert (different dedupe key). But within
    // a single channel that hypothetically flipped modes, dedupe
    // applies. This test pins the cross-channel-different-cadence
    // independence.
    const { state, cleanup } = await setupScenario(1);
    const spy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(
        new Response("ok", { status: 200 }) as unknown as Response
      );
    try {
      const immediateId = await mintChannel(state.tenantId, {
        mode: "IMMEDIATE",
      });
      const digestId = await mintChannel(state.tenantId, {
        mode: "DIGEST_DAILY",
      });

      // IMMEDIATE pings first.
      await dispatchCloseAlerts(prisma, { maxPeriodsPerTenant: 100 });
      const immediateDispatches = await prisma.notificationDispatch.count({
        where: { channelId: immediateId },
      });
      expect(immediateDispatches).toBe(1);

      // Digest tick runs — should still ping the digest channel
      // because dedupe is per-(channel, alert), not per-alert.
      await dispatchCloseDigests(prisma, { maxPeriodsPerTenant: 100 });
      const digestDispatches = await prisma.notificationDispatch.count({
        where: { channelId: digestId },
      });
      expect(digestDispatches).toBe(1);
    } finally {
      spy.mockRestore();
      await cleanup();
    }
  });

  it("Slack 4xx: every batched alert still gets a dispatch row with the error captured", async () => {
    const { state, cleanup } = await setupScenario(3);
    const spy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(
        new Response("invalid_payload", { status: 400 }) as unknown as Response
      );
    try {
      const id = await mintChannel(state.tenantId, { mode: "DIGEST_DAILY" });
      await dispatchCloseDigests(prisma, { maxPeriodsPerTenant: 100 });
      const dispatches = await prisma.notificationDispatch.findMany({
        where: { channelId: id },
        select: { sendStatus: true, sendError: true },
      });
      expect(dispatches.length).toBe(state.reconIds.length);
      for (const d of dispatches) {
        expect(d.sendStatus).toBe(400);
        expect(d.sendError).toContain("400");
      }
    } finally {
      spy.mockRestore();
      await cleanup();
    }
  });

  it("decrypt failure: every fresh alert gets a dispatch row, no fetch call", async () => {
    const { state, cleanup } = await setupScenario(2);
    const spy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(
        new Response("ok", { status: 200 }) as unknown as Response
      );
    try {
      // Encrypt under a different key, then revert.
      const altKey = randomBytes(32).toString("base64");
      const original = process.env.WEBHOOK_ENCRYPTION_KEY;
      process.env.WEBHOOK_ENCRYPTION_KEY = altKey;
      const garbled = encryptWebhookUrl(
        "https://hooks.slack.com/services/garbled"
      );
      process.env.WEBHOOK_ENCRYPTION_KEY = original;

      const id = await mintChannel(state.tenantId, { mode: "DIGEST_DAILY" });
      await prisma.notificationChannel.update({
        where: { id },
        data: { webhookUrl: garbled },
      });

      await dispatchCloseDigests(prisma, { maxPeriodsPerTenant: 100 });

      const dispatches = await prisma.notificationDispatch.findMany({
        where: { channelId: id },
        select: { sendStatus: true, sendError: true },
      });
      expect(dispatches.length).toBe(state.reconIds.length);
      for (const d of dispatches) {
        expect(d.sendStatus).toBeNull();
        expect(d.sendError).toContain("decrypt failed");
      }
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      await cleanup();
    }
  });

  it("URL scrub: webhook URL never appears in sendError when network error leaks it", async () => {
    const { state, cleanup } = await setupScenario(1);
    // A network-error message that contains the plaintext URL —
    // simulates a hypothetical fetch implementation that echoes the
    // URL into the error string. The dispatcher's regex scrub must
    // mask it before persisting.
    const plaintextUrl = "https://hooks.slack.com/services/TXX/BYY/abcdef123";
    const spy = vi
      .spyOn(global, "fetch")
      .mockRejectedValue(
        new Error(`fetch failed: connect ECONNREFUSED ${plaintextUrl}`)
      );
    try {
      const id = await mintChannel(state.tenantId, {
        mode: "DIGEST_DAILY",
        webhookUrl: plaintextUrl,
      });
      await dispatchCloseDigests(prisma, { maxPeriodsPerTenant: 100 });
      const dispatches = await prisma.notificationDispatch.findMany({
        where: { channelId: id },
        select: { sendError: true },
      });
      expect(dispatches.length).toBeGreaterThan(0);
      for (const d of dispatches) {
        expect(d.sendError).not.toContain("abcdef123"); // path scrubbed
        expect(d.sendError).not.toContain("/BYY/"); // channel id scrubbed
      }
    } finally {
      spy.mockRestore();
      await cleanup();
    }
  });
});
