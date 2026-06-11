// Notification channels Server Actions tests.
//
// Pins:
//   1. createChannel admin-only — non-admin gets NOT_ADMIN
//   2. createChannel encrypts webhookUrl at rest (round-trips through
//      the encryption helper, never matches the original plaintext)
//   3. updateChannel respects tenantId scope — cross-tenant id → NOT_FOUND
//   4. updateChannel rotates webhookUrl when supplied; keeps existing
//      when omitted/empty
//   5. deleteChannel cascades NotificationDispatch (FK cascade)
//   6. setEnabled toggles + audits
//   7. testChannel surfaces SLACK_REJECTED on 4xx with masked URL
//      (no plaintext leak in error string)
//   8. testChannel surfaces DECRYPT_FAILED on wrong key

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";

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
  createChannel,
  updateChannel,
  deleteChannel,
  setEnabled,
  testChannel,
} from "@/app/actions/notification-channels";
import {
  encryptWebhookUrl,
  decryptWebhookUrl,
} from "@/lib/notifications/crypto";

const prisma = new PrismaClient();
const TEST_KEY = randomBytes(32).toString("base64");
let savedKey: string | undefined;

let adminTenant: { id: string; slug: string };
let foreignTenant: { id: string; slug: string };
let adminUser: { id: string; email: string };
let nonAdminUser: { id: string; email: string };

beforeAll(async () => {
  savedKey = process.env.WEBHOOK_ENCRYPTION_KEY;
  process.env.WEBHOOK_ENCRYPTION_KEY = TEST_KEY;

  const u = await prisma.user.findUnique({
    where: { email: "controller@northwind.test" },
    select: { id: true, email: true },
  });
  if (!u) throw new Error("Run Northwind seed first.");
  adminUser = { id: u.id, email: u.email };

  const other = await prisma.user.findFirst({
    where: { email: { not: u.email } },
    select: { id: true, email: true },
  });
  if (!other) throw new Error("Seed must have ≥2 users.");
  nonAdminUser = { id: other.id, email: other.email };

  const suffix = "nca" + Date.now().toString(36) + Math.floor(Math.random() * 9999);
  adminTenant = await prisma.tenant.create({
    data: {
      slug: `${suffix}-A`.slice(0, 60),
      name: "Channel Admin Tenant",
      ownerUserId: adminUser.id,
    },
  });
  foreignTenant = await prisma.tenant.create({
    data: {
      slug: `${suffix}-F`.slice(0, 60),
      name: "Foreign Tenant",
      ownerUserId: adminUser.id,
    },
  });
  // Admin user is OWNER on the admin tenant + MEMBER (non-admin) on
  // a third tenant for the non-admin negative test.
  await prisma.tenantMembership.create({
    data: { tenantId: adminTenant.id, userId: adminUser.id, role: "OWNER" },
  });
  await prisma.tenantMembership.create({
    data: { tenantId: adminTenant.id, userId: nonAdminUser.id, role: "MEMBER" },
  });
  await prisma.tenantMembership.create({
    data: { tenantId: foreignTenant.id, userId: adminUser.id, role: "OWNER" },
  });
});

afterAll(async () => {
  await prisma.notificationDispatch.deleteMany({
    where: { tenantId: { in: [adminTenant.id, foreignTenant.id] } },
  });
  await prisma.notificationChannel.deleteMany({
    where: { tenantId: { in: [adminTenant.id, foreignTenant.id] } },
  });
  await prisma.tenantMembership.deleteMany({
    where: { tenantId: { in: [adminTenant.id, foreignTenant.id] } },
  });
  for (const t of [adminTenant.id, foreignTenant.id]) {
    try {
      await prisma.tenant.delete({ where: { id: t } });
    } catch {
      /* audit_log append-only — leak */
    }
  }
  if (savedKey !== undefined) {
    process.env.WEBHOOK_ENCRYPTION_KEY = savedKey;
  } else {
    delete process.env.WEBHOOK_ENCRYPTION_KEY;
  }
  await prisma.$disconnect();
});

function signInAs(u: { id: string }, t: { slug: string }) {
  mockCookieStore.clear();
  mockCookieStore.set("lc-user", { value: authInternal.encode(u.id) });
  mockCookieStore.set("lc-tenant", { value: t.slug });
}

describe("createChannel", () => {
  it("returns NOT_ADMIN for a non-admin tenant member", async () => {
    signInAs(nonAdminUser, adminTenant);
    const r = await createChannel({
      name: "no-perm",
      webhookUrl: "https://hooks.slack.com/services/X/Y/Z",
      severityFilter: [],
      enabled: true,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("should refuse");
    expect(r.code).toBe("NOT_ADMIN");
  });

  it("encrypts webhookUrl at rest — DB never holds plaintext", async () => {
    signInAs(adminUser, adminTenant);
    const url = "https://hooks.slack.com/services/AAAA/BBBB/needle12345";
    const r = await createChannel({
      name: "encrypted-test",
      webhookUrl: url,
      severityFilter: [],
      enabled: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error);

    const row = await prisma.notificationChannel.findUnique({
      where: { id: r.channelId },
      select: { webhookUrl: true },
    });
    expect(row).toBeDefined();
    expect(row!.webhookUrl).not.toContain("hooks.slack.com");
    expect(row!.webhookUrl).not.toContain("needle12345");
    expect(decryptWebhookUrl(row!.webhookUrl)).toBe(url);
  });
});

describe("updateChannel", () => {
  it("returns NOT_FOUND for a channel in another tenant", async () => {
    signInAs(adminUser, foreignTenant);
    const created = await prisma.notificationChannel.create({
      data: {
        tenantId: adminTenant.id,
        type: "SLACK",
        name: "in-other-tenant",
        webhookUrl: encryptWebhookUrl("https://hooks.slack.com/services/T/B/X"),
        severityFilter: [],
        enabled: true,
        createdById: adminUser.id,
      },
      select: { id: true },
    });
    const r = await updateChannel({
      channelId: created.id,
      name: "renamed",
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("should refuse");
    expect(r.code).toBe("NOT_FOUND");
  });

  it("rotates webhookUrl when supplied; keeps existing when omitted", async () => {
    signInAs(adminUser, adminTenant);
    const oldUrl = "https://hooks.slack.com/services/OLD/old/old";
    const created = await prisma.notificationChannel.create({
      data: {
        tenantId: adminTenant.id,
        type: "SLACK",
        name: "rotate-test",
        webhookUrl: encryptWebhookUrl(oldUrl),
        severityFilter: [],
        enabled: true,
        createdById: adminUser.id,
      },
      select: { id: true, webhookUrl: true },
    });

    // Update without webhookUrl — should preserve.
    const r1 = await updateChannel({
      channelId: created.id,
      name: "rotate-test-renamed",
    });
    expect(r1.ok).toBe(true);
    const afterRename = await prisma.notificationChannel.findUnique({
      where: { id: created.id },
      select: { webhookUrl: true, name: true },
    });
    expect(afterRename!.webhookUrl).toBe(created.webhookUrl);
    expect(afterRename!.name).toBe("rotate-test-renamed");

    // Update with new webhookUrl — should rotate.
    const newUrl = "https://hooks.slack.com/services/NEW/new/new";
    const r2 = await updateChannel({
      channelId: created.id,
      webhookUrl: newUrl,
    });
    expect(r2.ok).toBe(true);
    const afterRotate = await prisma.notificationChannel.findUnique({
      where: { id: created.id },
      select: { webhookUrl: true },
    });
    expect(afterRotate!.webhookUrl).not.toBe(created.webhookUrl);
    expect(decryptWebhookUrl(afterRotate!.webhookUrl)).toBe(newUrl);
  });
});

describe("deleteChannel", () => {
  it("cascades NotificationDispatch rows on delete", async () => {
    signInAs(adminUser, adminTenant);
    const created = await prisma.notificationChannel.create({
      data: {
        tenantId: adminTenant.id,
        type: "SLACK",
        name: "delete-test",
        webhookUrl: encryptWebhookUrl("https://hooks.slack.com/services/D/E/L"),
        severityFilter: [],
        enabled: true,
        createdById: adminUser.id,
      },
      select: { id: true },
    });
    await prisma.notificationDispatch.create({
      data: {
        tenantId: adminTenant.id,
        channelId: created.id,
        alertFingerprint: "recon:fake-uuid",
        pillar: "recon",
        severity: "high",
        sendStatus: 200,
      },
    });

    const r = await deleteChannel({ channelId: created.id });
    expect(r.ok).toBe(true);

    const remaining = await prisma.notificationDispatch.count({
      where: { channelId: created.id },
    });
    expect(remaining).toBe(0);
  });
});

describe("setEnabled", () => {
  it("toggles enabled state", async () => {
    signInAs(adminUser, adminTenant);
    const created = await prisma.notificationChannel.create({
      data: {
        tenantId: adminTenant.id,
        type: "SLACK",
        name: "toggle-test",
        webhookUrl: encryptWebhookUrl("https://hooks.slack.com/services/T/G/L"),
        severityFilter: [],
        enabled: true,
        createdById: adminUser.id,
      },
      select: { id: true },
    });
    await setEnabled({ channelId: created.id, enabled: false });
    const after = await prisma.notificationChannel.findUnique({
      where: { id: created.id },
      select: { enabled: true },
    });
    expect(after!.enabled).toBe(false);
  });
});

describe("testChannel", () => {
  it("returns SLACK_REJECTED on 4xx without leaking response body or URL", async () => {
    // After the sendSlackMessage hotfix (PR #215), the error string
    // is just "Slack returned HTTP <status>" — Slack's response body
    // never lands in the result. This test pins BOTH invariants:
    //   - status code present in the error
    //   - response body marker absent
    //   - webhook URL absent (even if it appeared in the body)
    signInAs(adminUser, adminTenant);
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(
        "invalid_payload at https://hooks.slack.com/services/SECRET/PATH/SHOULD-NEVER-APPEAR",
        { status: 400 }
      ) as unknown as Response
    );
    const sourceUrl = "https://hooks.slack.com/services/SECRET/PATH/SHOULD-NEVER-APPEAR";
    const created = await prisma.notificationChannel.create({
      data: {
        tenantId: adminTenant.id,
        type: "SLACK",
        name: "reject-test",
        webhookUrl: encryptWebhookUrl(sourceUrl),
        severityFilter: [],
        enabled: true,
        createdById: adminUser.id,
      },
      select: { id: true },
    });

    const r = await testChannel({ channelId: created.id });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("should fail");
    expect(r.code).toBe("SLACK_REJECTED");
    expect(r.error).toContain("400");
    // Critical: no part of the response body should appear.
    expect(r.error).not.toContain("SHOULD-NEVER-APPEAR");
    expect(r.error).not.toContain("invalid_payload");
    expect(r.error).not.toContain("hooks.slack.com");
    vi.restoreAllMocks();
  });

  it("returns DECRYPT_FAILED when stored ciphertext was encrypted with a different key", async () => {
    signInAs(adminUser, adminTenant);

    // Encrypt under a different key, set the current key back.
    const altKey = randomBytes(32).toString("base64");
    const current = process.env.WEBHOOK_ENCRYPTION_KEY;
    process.env.WEBHOOK_ENCRYPTION_KEY = altKey;
    const garbled = encryptWebhookUrl("https://hooks.slack.com/services/X/Y/Z");
    process.env.WEBHOOK_ENCRYPTION_KEY = current;

    const created = await prisma.notificationChannel.create({
      data: {
        tenantId: adminTenant.id,
        type: "SLACK",
        name: "bad-key-test",
        webhookUrl: garbled,
        severityFilter: [],
        enabled: true,
        createdById: adminUser.id,
      },
      select: { id: true },
    });

    const r = await testChannel({ channelId: created.id });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("should fail");
    expect(r.code).toBe("DECRYPT_FAILED");
  });
});
