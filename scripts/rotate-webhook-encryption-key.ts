// Webhook URL encryption-key rotation.
//
// Re-encrypts every `notification_channel.webhookUrl` row from the
// OLD key to the NEW key. Idempotent: rows that already decrypt
// cleanly under the NEW key (re-runs after a partial failure) are
// skipped without re-writing.
//
// Usage:
//   WEBHOOK_ENCRYPTION_KEY_OLD=<base64-32-bytes> \
//   WEBHOOK_ENCRYPTION_KEY_NEW=<base64-32-bytes> \
//   npx tsx scripts/rotate-webhook-encryption-key.ts
//
// After every row reports SUCCESS, switch the live env var:
//   WEBHOOK_ENCRYPTION_KEY := <the NEW key>
//
// Then redeploy. The OLD key can be wiped from your secret store
// once you've confirmed the cron + admin UI still work post-deploy.
//
// What it does NOT do:
//   - It does not modify env vars (do that in your hosting platform's
//     secret store after the script reports success).
//   - It does not handle key versioning at the column level — single-
//     version model. Larger deployments would want a versioned KMS
//     scheme; not in v1.
//   - It does not re-encrypt other column-level encrypted fields
//     (those use a separate key managed by the PrismaExtension stack).
//
// SOC 2 CC6.7: every row's old + new ciphertexts are different by
// construction (fresh IV per encrypt), so a side-channel observer
// can't compare ciphertext-before to ciphertext-after to detect
// "this row wasn't rotated". The script logs only the channel id
// (UUID), never the plaintext URL.

import { PrismaClient } from "@prisma/client";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "crypto";

const ALGO = "aes-256-gcm";
const KEY_LENGTH_BYTES = 32;
const IV_LENGTH_BYTES = 12;
const TAG_LENGTH_BYTES = 16;

function loadKey(envName: string): Buffer {
  const raw = process.env[envName];
  if (!raw) {
    throw new Error(`${envName} is not set`);
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new Error(
      `${envName} must decode to ${KEY_LENGTH_BYTES} bytes (got ${key.length})`
    );
  }
  return key;
}

function encryptWith(key: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

function decryptWith(key: Buffer, encoded: string): string {
  const buf = Buffer.from(encoded, "base64");
  const minLength = IV_LENGTH_BYTES + TAG_LENGTH_BYTES + 1;
  if (buf.length < minLength) {
    throw new Error(`ciphertext too short: ${buf.length} < ${minLength}`);
  }
  const iv = buf.subarray(0, IV_LENGTH_BYTES);
  const tag = buf.subarray(IV_LENGTH_BYTES, IV_LENGTH_BYTES + TAG_LENGTH_BYTES);
  const ct = buf.subarray(IV_LENGTH_BYTES + TAG_LENGTH_BYTES);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

interface RotateResult {
  total: number;
  rotated: number;
  alreadyOnNew: number;
  errors: Array<{ id: string; error: string }>;
}

/**
 * Run the rotation against an open Prisma client. Exposed for tests.
 * Caller closes the client.
 */
export async function rotateWebhookKeys(
  prisma: PrismaClient,
  oldKey: Buffer,
  newKey: Buffer
): Promise<RotateResult> {
  const result: RotateResult = {
    total: 0,
    rotated: 0,
    alreadyOnNew: 0,
    errors: [],
  };

  const channels = await prisma.notificationChannel.findMany({
    select: { id: true, webhookUrl: true },
  });
  result.total = channels.length;

  for (const ch of channels) {
    try {
      // Try decrypting with the NEW key first — if it succeeds the row
      // was already rotated (re-run after partial failure / idempotency).
      try {
        decryptWith(newKey, ch.webhookUrl);
        result.alreadyOnNew += 1;
        continue;
      } catch {
        // Expected: still on old key. Fall through.
      }

      const plaintext = decryptWith(oldKey, ch.webhookUrl);
      const reEncrypted = encryptWith(newKey, plaintext);
      await prisma.notificationChannel.update({
        where: { id: ch.id },
        data: { webhookUrl: reEncrypted },
      });
      result.rotated += 1;
    } catch (e) {
      result.errors.push({
        id: ch.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return result;
}

async function main(): Promise<void> {
  const oldKey = loadKey("WEBHOOK_ENCRYPTION_KEY_OLD");
  const newKey = loadKey("WEBHOOK_ENCRYPTION_KEY_NEW");
  if (oldKey.equals(newKey)) {
    throw new Error("OLD and NEW keys are identical — nothing to rotate");
  }

  const prisma = new PrismaClient();
  try {
    const startedAt = Date.now();
    const result = await rotateWebhookKeys(prisma, oldKey, newKey);
    const durationMs = Date.now() - startedAt;

    console.log(
      JSON.stringify(
        {
          ok: result.errors.length === 0,
          durationMs,
          ...result,
        },
        null,
        2
      )
    );

    if (result.errors.length > 0) {
      console.error(
        `${result.errors.length} row(s) failed — investigate above before switching the live env var`
      );
      process.exit(1);
    }
  } finally {
    await prisma.$disconnect();
  }
}

// Only run main when invoked as a script (not when imported by tests).
if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
