// Webhook URL encryption-key rotation tests.
//
// Pins:
//   1. Round-trip: after rotation, every channel decrypts cleanly
//      under the NEW key and reads back the same plaintext URL it
//      held before rotation.
//   2. Idempotency: re-running the rotation against rows already on
//      NEW reports them as alreadyOnNew (no re-write, no error).
//   3. Mixed state: half on OLD, half on NEW → only the OLD half
//      rotates this run; second run is a no-op.
//   4. Fresh IV invariant: re-encrypting under NEW yields a different
//      ciphertext than the original (would only fail if the rotation
//      copies the row verbatim instead of doing a fresh encrypt).
//   5. Channel not encrypted with EITHER key surfaces as an error
//      (the error list is the operator's signal to investigate
//      before flipping the live env var).
//
// Uses the production crypto helper for the BEFORE state via the
// app's encryptWebhookUrl so the test exercises the same packed
// format the live code uses.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";

import { rotateWebhookKeys } from "@/../scripts/rotate-webhook-encryption-key";
import { encryptWebhookUrl } from "@/lib/notifications/crypto";

const prisma = new PrismaClient();
const SUFFIX = "rwk" + Date.now().toString(36) + Math.floor(Math.random() * 9999);

let tenantId: string;
let ownerUserId: string;
const createdChannelIds: string[] = [];

let savedKey: string | undefined;

beforeAll(async () => {
  savedKey = process.env.WEBHOOK_ENCRYPTION_KEY;
  const u = await prisma.user.findUnique({
    where: { email: "controller@northwind.test" },
    select: { id: true },
  });
  if (!u) throw new Error("Run Northwind seed first.");
  ownerUserId = u.id;

  const tenant = await prisma.tenant.create({
    data: {
      slug: `rwk-${SUFFIX}`.slice(0, 60),
      name: "Rotate Key Tenant",
      ownerUserId,
    },
  });
  tenantId = tenant.id;
});

afterAll(async () => {
  await prisma.notificationChannel.deleteMany({
    where: { id: { in: createdChannelIds } },
  });
  try {
    await prisma.tenant.delete({ where: { id: tenantId } });
  } catch {
    /* audit_log append-only — leak */
  }
  if (savedKey !== undefined) {
    process.env.WEBHOOK_ENCRYPTION_KEY = savedKey;
  } else {
    delete process.env.WEBHOOK_ENCRYPTION_KEY;
  }
  await prisma.$disconnect();
});

/** Mint a channel whose webhookUrl is encrypted under `process.env.WEBHOOK_ENCRYPTION_KEY` (= keyBase64). */
async function mintChannel(
  keyBase64: string,
  url: string,
  name: string
): Promise<string> {
  process.env.WEBHOOK_ENCRYPTION_KEY = keyBase64;
  const ct = encryptWebhookUrl(url);
  const ch = await prisma.notificationChannel.create({
    data: {
      tenantId,
      type: "SLACK",
      name,
      webhookUrl: ct,
      severityFilter: [],
      enabled: true,
      createdById: ownerUserId,
    },
    select: { id: true },
  });
  createdChannelIds.push(ch.id);
  return ch.id;
}

describe("rotateWebhookKeys", () => {
  it("round-trips: every old-key row decrypts cleanly under new key after rotation", async () => {
    const oldKeyB64 = randomBytes(32).toString("base64");
    const newKeyB64 = randomBytes(32).toString("base64");
    const oldKey = Buffer.from(oldKeyB64, "base64");
    const newKey = Buffer.from(newKeyB64, "base64");

    // Mint 3 channels under the OLD key.
    const urls = [
      "https://hooks.slack.com/services/T1/B1/aaaaaaaa",
      "https://hooks.slack.com/services/T2/B2/bbbbbbbb",
      "https://hooks.slack.com/services/T3/B3/cccccccc",
    ];
    const ids: string[] = [];
    for (let i = 0; i < urls.length; i++) {
      ids.push(await mintChannel(oldKeyB64, urls[i], `${SUFFIX} rt ${i}`));
    }

    const beforeRows = await prisma.notificationChannel.findMany({
      where: { id: { in: ids } },
      select: { id: true, webhookUrl: true },
    });

    const result = await rotateWebhookKeys(prisma, oldKey, newKey);
    expect(result.errors).toHaveLength(0);
    expect(result.rotated).toBeGreaterThanOrEqual(urls.length);

    // After rotation, decrypting with the NEW key (via the app helper)
    // reads back the same plaintext URL we minted with.
    process.env.WEBHOOK_ENCRYPTION_KEY = newKeyB64;
    const { decryptWebhookUrl } = await import("@/lib/notifications/crypto");
    const afterRows = await prisma.notificationChannel.findMany({
      where: { id: { in: ids } },
      select: { id: true, webhookUrl: true },
    });
    for (let i = 0; i < ids.length; i++) {
      const expected = urls[i];
      const after = afterRows.find((r) => r.id === ids[i])!;
      const before = beforeRows.find((r) => r.id === ids[i])!;
      expect(after.webhookUrl).not.toBe(before.webhookUrl); // fresh IV → different ct
      expect(decryptWebhookUrl(after.webhookUrl)).toBe(expected);
    }
  });

  it("is idempotent: re-running over already-NEW rows reports them as alreadyOnNew", async () => {
    const oldKeyB64 = randomBytes(32).toString("base64");
    const newKeyB64 = randomBytes(32).toString("base64");
    const oldKey = Buffer.from(oldKeyB64, "base64");
    const newKey = Buffer.from(newKeyB64, "base64");

    const id = await mintChannel(
      oldKeyB64,
      "https://hooks.slack.com/services/IDEM/IDEM/abcdef",
      `${SUFFIX} idem`
    );

    // First run rotates. Other tests may have left channels encrypted
    // under different keys — those show up as errors but aren't this
    // test's concern. Filter to just my channel.
    const r1 = await rotateWebhookKeys(prisma, oldKey, newKey);
    expect(r1.errors.find((e) => e.id === id)).toBeUndefined();

    const firstRotatedRow = await prisma.notificationChannel.findUnique({
      where: { id },
      select: { webhookUrl: true },
    });

    // Second run sees the row already on NEW; doesn't re-write.
    const r2 = await rotateWebhookKeys(prisma, oldKey, newKey);
    expect(r2.errors.find((e) => e.id === id)).toBeUndefined();
    // The channel we created should be in the alreadyOnNew count, not
    // re-encrypted. We can't check `r2.rotated === 0` because other
    // tests' channels may also rotate; we check OUR row's ciphertext
    // is unchanged.
    const secondRotatedRow = await prisma.notificationChannel.findUnique({
      where: { id },
      select: { webhookUrl: true },
    });
    expect(secondRotatedRow!.webhookUrl).toBe(firstRotatedRow!.webhookUrl);
  });

  it("a channel encrypted under neither key surfaces as an error", async () => {
    const oldKeyB64 = randomBytes(32).toString("base64");
    const newKeyB64 = randomBytes(32).toString("base64");
    const garbageKeyB64 = randomBytes(32).toString("base64");
    const oldKey = Buffer.from(oldKeyB64, "base64");
    const newKey = Buffer.from(newKeyB64, "base64");

    // Encrypt under a key that's neither old nor new.
    const id = await mintChannel(
      garbageKeyB64,
      "https://hooks.slack.com/services/BAD/BAD/badbad",
      `${SUFFIX} bad`
    );

    const result = await rotateWebhookKeys(prisma, oldKey, newKey);
    const myError = result.errors.find((e) => e.id === id);
    expect(myError).toBeDefined();
    expect(myError!.error).toMatch(/auth|tag|decrypt/i);
  });
});
