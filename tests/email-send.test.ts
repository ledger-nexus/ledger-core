// Email-send tests — focused on the LOGGED_ONLY path which doesn't
// touch the network. Real Resend delivery is covered by manual smoke
// tests in dev.
//
// We mock prisma.emailDelivery.create to avoid needing a real DB for
// these tests. The persistence shape is the contract; the underlying
// table comes via schema-validated Prisma.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the prisma client BEFORE importing the module under test.
vi.mock("@/lib/db", () => ({
  prisma: {
    emailDelivery: {
      create: vi.fn().mockImplementation(async (args: { data: unknown }) => {
        const data = args.data as Record<string, unknown>;
        return {
          id: "00000000-0000-0000-0000-000000000001",
          providerId: (data.providerId as string | null) ?? null,
          errorMessage: (data.errorMessage as string | null) ?? null,
        };
      }),
    },
  },
}));

import { sendEmail } from "../src/lib/email/send";
import { prisma } from "@/lib/db";

const origKey = process.env.RESEND_API_KEY;
const origFrom = process.env.EMAIL_FROM_ADDRESS;

beforeEach(() => {
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM_ADDRESS;
  vi.clearAllMocks();
});

afterEach(() => {
  if (origKey != null) process.env.RESEND_API_KEY = origKey;
  if (origFrom != null) process.env.EMAIL_FROM_ADDRESS = origFrom;
});

describe("sendEmail: LOGGED_ONLY path (no API key)", () => {
  it("returns ok=true with status LOGGED_ONLY when no key is set", async () => {
    const result = await sendEmail({
      to: "alice@example.com",
      subject: "Hi",
      text: "body",
      template: "test",
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe("LOGGED_ONLY");
    expect(result.deliveryId).toBeTruthy();
  });

  it("persists the EmailDelivery row with the right shape", async () => {
    await sendEmail({
      to: "alice@example.com",
      subject: "Hi",
      text: "body text",
      html: "<p>body html</p>",
      template: "test",
      tenantId: "00000000-0000-0000-0000-000000000099",
      metadata: { foo: "bar" },
    });
    expect(prisma.emailDelivery.create).toHaveBeenCalledTimes(1);
    const callArg = vi.mocked(prisma.emailDelivery.create).mock.calls[0][0];
    expect(callArg.data).toMatchObject({
      toEmail: "alice@example.com",
      subject: "Hi",
      bodyText: "body text",
      bodyHtml: "<p>body html</p>",
      template: "test",
      status: "LOGGED_ONLY",
      tenantId: "00000000-0000-0000-0000-000000000099",
    });
  });

  it("omits metadata when none provided (column stays NULL)", async () => {
    await sendEmail({
      to: "alice@example.com",
      subject: "Hi",
      text: "body",
      template: "test",
    });
    const callArg = vi.mocked(prisma.emailDelivery.create).mock.calls[0][0];
    expect((callArg.data as Record<string, unknown>).metadata).toBeUndefined();
  });
});

describe("sendEmail: FAILED path when EMAIL_FROM_ADDRESS is unset", () => {
  it("returns FAILED when RESEND_API_KEY is set but EMAIL_FROM_ADDRESS is not", async () => {
    process.env.RESEND_API_KEY = "test-key";
    // EMAIL_FROM_ADDRESS deliberately not set.
    const result = await sendEmail({
      to: "alice@example.com",
      subject: "Hi",
      text: "body",
      template: "test",
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("FAILED");
    expect(result.errorMessage).toMatch(/EMAIL_FROM_ADDRESS/);
  });
});
