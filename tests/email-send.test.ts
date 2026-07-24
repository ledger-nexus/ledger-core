// Transactional email seam (src/lib/email/send.ts + EmailDelivery).
//
// The contract under test:
//   - sendEmail NEVER throws to its caller — every outcome, including a
//     provider outage, lands as an EmailDelivery row + structured result
//   - no RESEND_API_KEY → LOGGED_ONLY (row persisted, nothing sent, and
//     the console line contains NO recipient/subject/body — email bodies
//     carry invite tokens and names; CC7.2 says they stay out of logs)
//   - key set but no EMAIL_FROM_ADDRESS → FAILED without touching the
//     network (Resend rejects sender-less posts anyway; fail fast)
//   - provider 2xx → DELIVERED with providerId; non-2xx / network error
//     → FAILED with the provider detail on the ROW, not in stdout
//   - toEmail/subject/bodies are in the encryption registry from day
//     one (this table has never held a plaintext row)
//
// Provider calls are stubbed at global.fetch — no network in tests.

import {
  describe,
  it,
  expect,
  afterAll,
  afterEach,
  beforeEach,
  vi,
} from "vitest";
import { PrismaClient } from "@prisma/client";

import { sendEmail } from "@/lib/email/send";
import { ENCRYPTED_COLUMNS } from "@/lib/db/encrypted-fields-extension";
import { prisma as appPrisma } from "@/lib/db";

const rawPrisma = new PrismaClient();
const createdIds: string[] = [];
const SUFFIX = "eml" + Date.now().toString(36) + Math.floor(Math.random() * 9999);

let testTenantId: string | null = null;

async function ensureTenant(): Promise<string> {
  if (testTenantId) return testTenantId;
  // Owner can be any existing user — the seed's bootstrap user is stable.
  const anyUser = await rawPrisma.user.findFirst({ select: { id: true } });
  if (!anyUser) throw new Error("No users in test DB — run the seed first.");
  const t = await rawPrisma.tenant.create({
    data: { slug: `eml-${SUFFIX}`, name: "Email Test", ownerUserId: anyUser.id },
    select: { id: true },
  });
  testTenantId = t.id;
  return t.id;
}

beforeEach(() => {
  // Isolate env per test — the surrounding .env may or may not carry
  // RESEND_API_KEY; every test states its own assumption.
  vi.stubEnv("RESEND_API_KEY", "");
  vi.stubEnv("EMAIL_FROM_ADDRESS", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (createdIds.length > 0) {
    await rawPrisma.emailDelivery.deleteMany({
      where: { id: { in: createdIds } },
    });
  }
  if (testTenantId) {
    await rawPrisma.tenant.delete({ where: { id: testTenantId } });
  }
  await rawPrisma.$disconnect();
  await appPrisma.$disconnect();
});

function baseInput() {
  return {
    to: `recipient-${SUFFIX}@example.test`,
    subject: `Secret subject ${SUFFIX}`,
    text: `Body with a secret token invite-token-${SUFFIX}`,
    template: "test_template",
  };
}

describe("encryption registry", () => {
  it("registers toEmail (with search hash), subject, and both bodies", () => {
    const entries = ENCRYPTED_COLUMNS.filter((c) => c.model === "EmailDelivery");
    const fields = entries.map((e) => e.field).sort();
    expect(fields).toEqual(["bodyHtml", "bodyText", "subject", "toEmail"]);
    const toEmail = entries.find((e) => e.field === "toEmail");
    expect(toEmail?.searchHash).toEqual({
      hashColumn: "toEmailHash",
      domain: "EmailDelivery.toEmail",
      normalize: "emailLowercase",
    });
  });
});

describe("sendEmail — LOGGED_ONLY path (no provider key)", () => {
  it("persists the row, returns ok, and leaks nothing to stdout", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const input = baseInput();

    const res = await sendEmail(input);
    createdIds.push(res.deliveryId);

    expect(res.ok).toBe(true);
    expect(res.status).toBe("LOGGED_ONLY");

    // Row round-trips through the app client (decrypts, or passthrough
    // when no key is configured — both must read back the plaintext).
    const row = await appPrisma.emailDelivery.findUnique({
      where: { id: res.deliveryId },
    });
    expect(row?.toEmail).toBe(input.to);
    expect(row?.subject).toBe(input.subject);
    expect(row?.bodyText).toBe(input.text);
    expect(row?.template).toBe("test_template");
    expect(row?.tenantId).toBeNull();

    // The redaction pin: whatever was logged, none of it is the
    // recipient, the subject, or the body.
    const logged = logSpy.mock.calls.flat().join(" ");
    expect(logged).toContain(res.deliveryId);
    expect(logged).toContain("test_template");
    expect(logged).not.toContain(input.to);
    expect(logged).not.toContain(input.subject);
    expect(logged).not.toContain(`invite-token-${SUFFIX}`);
  });

  it("persists tenantId when the send is on a tenant's behalf", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const tenantId = await ensureTenant();
    const res = await sendEmail({ ...baseInput(), tenantId });
    createdIds.push(res.deliveryId);
    const row = await appPrisma.emailDelivery.findUnique({
      where: { id: res.deliveryId },
      select: { tenantId: true, status: true },
    });
    expect(row?.tenantId).toBe(tenantId);
    expect(row?.status).toBe("LOGGED_ONLY");
  });
});

describe("sendEmail — provider paths (fetch stubbed)", () => {
  it("FAILED without touching the network when EMAIL_FROM_ADDRESS is unset", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key_1234567890");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const res = await sendEmail(baseInput());
    createdIds.push(res.deliveryId);

    expect(res.ok).toBe(false);
    expect(res.status).toBe("FAILED");
    expect(fetchSpy).not.toHaveBeenCalled();

    const row = await appPrisma.emailDelivery.findUnique({
      where: { id: res.deliveryId },
      select: { errorMessage: true },
    });
    expect(row?.errorMessage).toContain("EMAIL_FROM_ADDRESS");
  });

  it("DELIVERED with providerId on provider 2xx", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key_1234567890");
    vi.stubEnv("EMAIL_FROM_ADDRESS", "books@example.test");
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ id: "re_msg_123" }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchSpy);

    const input = baseInput();
    const res = await sendEmail(input);
    createdIds.push(res.deliveryId);

    expect(res.ok).toBe(true);
    expect(res.status).toBe("DELIVERED");
    expect(res.providerId).toBe("re_msg_123");

    // The provider got the real strings; the authorization header got
    // the key.
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    const sentBody = JSON.parse(String(init.body));
    expect(sentBody.to).toEqual([input.to]);
    expect(sentBody.subject).toBe(input.subject);
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer re_test_key_1234567890"
    );
  });

  it("FAILED with provider detail on the row for non-2xx", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key_1234567890");
    vi.stubEnv("EMAIL_FROM_ADDRESS", "books@example.test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("rate limited", { status: 429 }))
    );

    const res = await sendEmail(baseInput());
    createdIds.push(res.deliveryId);

    expect(res.ok).toBe(false);
    expect(res.status).toBe("FAILED");
    expect(res.errorMessage).toContain("Resend 429");
  });

  it("never throws to the caller on a network failure", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key_1234567890");
    vi.stubEnv("EMAIL_FROM_ADDRESS", "books@example.test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNRESET");
      })
    );

    const res = await sendEmail(baseInput());
    createdIds.push(res.deliveryId);

    expect(res.ok).toBe(false);
    expect(res.status).toBe("FAILED");
    expect(res.errorMessage).toContain("ECONNRESET");
  });
});
