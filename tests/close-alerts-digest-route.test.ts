// Cron route test for /api/cron/close-alerts-digest.
//
// Pins the auth + audit contract. The dispatcher itself is covered by
// notifications-digest.test.ts; this test verifies:
//   1. Missing/bad CRON_SECRET → 401, no run
//   2. Valid CRON_SECRET via Authorization header → 200, summary returned
//   3. Valid CRON_SECRET via query param (manual trigger) → 200
//   4. GET returns 405 (no accidental browser fires)
//   5. Audit row is written with action=notifications.cron.digest + null actorUserId

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";

import { POST, GET } from "@/app/api/cron/close-alerts-digest/route";

const prisma = new PrismaClient();
const TEST_CRON_SECRET = randomBytes(16).toString("hex");
let savedSecret: string | undefined;

beforeAll(() => {
  savedSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = TEST_CRON_SECRET;
});

afterAll(async () => {
  if (savedSecret !== undefined) {
    process.env.CRON_SECRET = savedSecret;
  } else {
    delete process.env.CRON_SECRET;
  }
  await prisma.$disconnect();
});

describe("POST /api/cron/close-alerts-digest", () => {
  it("returns 401 without Authorization or query secret", async () => {
    const req = new NextRequest(
      "http://localhost/api/cron/close-alerts-digest",
      { method: "POST" }
    );
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 401 with wrong secret", async () => {
    const req = new NextRequest(
      "http://localhost/api/cron/close-alerts-digest",
      {
        method: "POST",
        headers: { authorization: "Bearer wrong-secret-value" },
      }
    );
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 200 with Authorization: Bearer <CRON_SECRET> and writes an audit row", async () => {
    const before = await prisma.auditLog.count({
      where: {
        eventType: "PRIVILEGED_ACTION",
        action: "notifications.cron.digest",
      },
    });
    const req = new NextRequest(
      "http://localhost/api/cron/close-alerts-digest",
      {
        method: "POST",
        headers: { authorization: `Bearer ${TEST_CRON_SECRET}` },
      }
    );
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.summary).toBeDefined();
    expect(typeof body.summary.tenantsScanned).toBe("number");
    expect(typeof body.summary.channelsSent).toBe("number");
    expect(typeof body.summary.alertsBatched).toBe("number");

    const after = await prisma.auditLog.count({
      where: {
        eventType: "PRIVILEGED_ACTION",
        action: "notifications.cron.digest",
      },
    });
    expect(after).toBe(before + 1);
  });

  it("returns 200 with ?cron_secret= query param (manual trigger)", async () => {
    const req = new NextRequest(
      `http://localhost/api/cron/close-alerts-digest?cron_secret=${TEST_CRON_SECRET}`,
      { method: "POST" }
    );
    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it("audit row has null actorUserId + system:cron email", async () => {
    const req = new NextRequest(
      "http://localhost/api/cron/close-alerts-digest",
      {
        method: "POST",
        headers: { authorization: `Bearer ${TEST_CRON_SECRET}` },
      }
    );
    await POST(req);

    const row = await prisma.auditLog.findFirst({
      where: {
        eventType: "PRIVILEGED_ACTION",
        action: "notifications.cron.digest",
      },
      orderBy: { occurredAt: "desc" },
      select: { actorUserId: true, actorEmail: true, tenantId: true },
    });
    expect(row).toBeDefined();
    expect(row!.actorUserId).toBeNull();
    expect(row!.actorEmail).toBe("system:cron");
    expect(row!.tenantId).toBeNull();
  });
});

describe("GET /api/cron/close-alerts-digest", () => {
  it("returns 405 (no accidental browser fires)", () => {
    const res = GET();
    expect(res.status).toBe(405);
  });
});
