// Server Actions for /admin/notification-channels.
//
// Five operations:
//   createChannel    — admin-only. Encrypts webhookUrl at write time.
//   updateChannel    — admin-only. Webhook URL is optional (omit to keep
//                      existing); name + severityFilter + enabled freely
//                      editable.
//   deleteChannel    — admin-only. Cascade-deletes NotificationDispatch
//                      history for the channel.
//   testChannel      — admin-only. Sends a tiny "test message" payload
//                      to verify the webhook works, WITHOUT touching the
//                      dispatch dedupe table (no NotificationDispatch
//                      row written — test calls are operational, not
//                      audited as alerts).
//   setEnabled       — admin-only quick toggle that doesn't require
//                      reloading the full edit form.
//
// SOC 2:
//   CC6.1  every read/write filtered by tenantId
//   CC6.3  every action calls requireTenantAdmin; non-admins get
//          structured NOT_ADMIN error
//   CC6.7  webhookUrl encrypted via encryptWebhookUrl at every write;
//          UI never reads the plaintext back, never echoes it
//   CC6.8  Zod validates every input; URL field validated as a URL
//   CC7.2  every mutation writes a PRIVILEGED_ACTION audit row
//          (action = "notificationChannel.{create,update,delete,test,setEnabled}")

"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { requireCurrentUser } from "@/lib/auth/current-user";
import { requireCurrentTenant, requireTenantAdmin } from "@/lib/auth/tenant";
import { auditPrivilegedAction } from "@/lib/audit/log";
import {
  encryptWebhookUrl,
  decryptWebhookUrl,
  maskWebhookUrl,
} from "@/lib/notifications/crypto";
import { sendSlackMessage } from "@/lib/notifications/slack";

const uuid = z.string().uuid();

const SEVERITY = z.enum(["high", "medium", "low"]);
const MODE = z.enum(["IMMEDIATE", "DIGEST_DAILY"]);

const CreateInput = z.object({
  name: z.string().min(1).max(120),
  webhookUrl: z.string().url().max(500),
  severityFilter: z.array(SEVERITY).max(3),
  mode: MODE.default("IMMEDIATE"),
  enabled: z.boolean().default(true),
});

const UpdateInput = z.object({
  channelId: uuid,
  name: z.string().min(1).max(120).optional(),
  // Pass to rotate. Omit (or send empty string) to keep existing.
  webhookUrl: z.string().url().max(500).optional(),
  severityFilter: z.array(SEVERITY).max(3).optional(),
  mode: MODE.optional(),
  enabled: z.boolean().optional(),
});

const DeleteInput = z.object({ channelId: uuid });
const TestInput = z.object({ channelId: uuid });
const ToggleInput = z.object({ channelId: uuid, enabled: z.boolean() });

export type ChannelResult =
  | { ok: true; channelId: string; maskedUrl?: string }
  | { ok: false; code: string; error: string };

function fail(code: string, error: string): ChannelResult {
  return { ok: false, code, error };
}

async function requireAdminContext(): Promise<
  | { ok: true; user: { id: string; email: string }; tenantId: string }
  | { ok: false; result: ChannelResult }
> {
  try {
    const user = await requireCurrentUser();
    const tenant = await requireCurrentTenant();
    try {
      await requireTenantAdmin();
    } catch {
      return {
        ok: false,
        result: fail("NOT_ADMIN", "Only a tenant admin can manage notification channels"),
      };
    }
    return { ok: true, user, tenantId: tenant.id };
  } catch {
    return { ok: false, result: fail("UNAUTHENTICATED", "Sign in required") };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// createChannel
// ─────────────────────────────────────────────────────────────────────────
export async function createChannel(
  input: z.input<typeof CreateInput>
): Promise<ChannelResult> {
  const parsed = CreateInput.safeParse(input);
  if (!parsed.success) {
    return fail("VALIDATION_FAILED", parsed.error.errors[0]?.message ?? "Invalid input");
  }
  const ctx = await requireAdminContext();
  if (!ctx.ok) return ctx.result;

  const ch = await prisma.notificationChannel.create({
    data: {
      tenantId: ctx.tenantId,
      type: "SLACK",
      name: parsed.data.name.trim(),
      webhookUrl: encryptWebhookUrl(parsed.data.webhookUrl),
      severityFilter: parsed.data.severityFilter,
      mode: parsed.data.mode,
      enabled: parsed.data.enabled,
      createdById: ctx.user.id,
    },
    select: { id: true },
  });

  await auditPrivilegedAction({
    actor: { id: ctx.user.id, email: ctx.user.email },
    action: "notificationChannel.create",
    resource: "NotificationChannel",
    resourceId: ch.id,
    tenantId: ctx.tenantId,
    metadata: {
      name: parsed.data.name.trim(),
      severityFilter: parsed.data.severityFilter,
      mode: parsed.data.mode,
      maskedUrl: maskWebhookUrl(parsed.data.webhookUrl),
    },
  });

  revalidatePath("/admin/notification-channels");
  return { ok: true, channelId: ch.id, maskedUrl: maskWebhookUrl(parsed.data.webhookUrl) };
}

// ─────────────────────────────────────────────────────────────────────────
// updateChannel
// ─────────────────────────────────────────────────────────────────────────
export async function updateChannel(
  input: z.input<typeof UpdateInput>
): Promise<ChannelResult> {
  const parsed = UpdateInput.safeParse(input);
  if (!parsed.success) {
    return fail("VALIDATION_FAILED", parsed.error.errors[0]?.message ?? "Invalid input");
  }
  const ctx = await requireAdminContext();
  if (!ctx.ok) return ctx.result;

  // Verify the channel belongs to this tenant before any update.
  const existing = await prisma.notificationChannel.findFirst({
    where: { id: parsed.data.channelId, tenantId: ctx.tenantId },
    select: { id: true, name: true, severityFilter: true, enabled: true },
  });
  if (!existing) return fail("NOT_FOUND", "Channel not in this tenant");

  const data: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) data.name = parsed.data.name.trim();
  if (parsed.data.severityFilter !== undefined) {
    data.severityFilter = parsed.data.severityFilter;
  }
  if (parsed.data.mode !== undefined) data.mode = parsed.data.mode;
  if (parsed.data.enabled !== undefined) data.enabled = parsed.data.enabled;
  // Only rotate webhookUrl if a non-empty string came in.
  let rotatedMaskedUrl: string | undefined;
  if (parsed.data.webhookUrl && parsed.data.webhookUrl.length > 0) {
    data.webhookUrl = encryptWebhookUrl(parsed.data.webhookUrl);
    rotatedMaskedUrl = maskWebhookUrl(parsed.data.webhookUrl);
  }

  await prisma.notificationChannel.update({
    where: { id: existing.id },
    data,
  });

  await auditPrivilegedAction({
    actor: { id: ctx.user.id, email: ctx.user.email },
    action: "notificationChannel.update",
    resource: "NotificationChannel",
    resourceId: existing.id,
    tenantId: ctx.tenantId,
    metadata: {
      changed: Object.keys(data),
      rotatedUrl: rotatedMaskedUrl !== undefined,
      ...(rotatedMaskedUrl ? { maskedUrl: rotatedMaskedUrl } : {}),
    },
  });

  revalidatePath("/admin/notification-channels");
  return { ok: true, channelId: existing.id, maskedUrl: rotatedMaskedUrl };
}

// ─────────────────────────────────────────────────────────────────────────
// deleteChannel
// ─────────────────────────────────────────────────────────────────────────
export async function deleteChannel(
  input: z.input<typeof DeleteInput>
): Promise<ChannelResult> {
  const parsed = DeleteInput.safeParse(input);
  if (!parsed.success) {
    return fail("VALIDATION_FAILED", parsed.error.errors[0]?.message ?? "Invalid input");
  }
  const ctx = await requireAdminContext();
  if (!ctx.ok) return ctx.result;

  const existing = await prisma.notificationChannel.findFirst({
    where: { id: parsed.data.channelId, tenantId: ctx.tenantId },
    select: { id: true, name: true },
  });
  if (!existing) return fail("NOT_FOUND", "Channel not in this tenant");

  // CASCADE on the FK wipes NotificationDispatch rows automatically.
  await prisma.notificationChannel.delete({ where: { id: existing.id } });

  await auditPrivilegedAction({
    actor: { id: ctx.user.id, email: ctx.user.email },
    action: "notificationChannel.delete",
    resource: "NotificationChannel",
    resourceId: existing.id,
    tenantId: ctx.tenantId,
    metadata: { name: existing.name },
  });

  revalidatePath("/admin/notification-channels");
  return { ok: true, channelId: existing.id };
}

// ─────────────────────────────────────────────────────────────────────────
// testChannel
//
// Decrypts the webhook URL and POSTs a tiny diagnostic message. We do
// NOT write a NotificationDispatch row — test sends are operational
// confirmations, not audit-tracked alerts. We DO write an audit_log row
// so quarterly access reviews see who tested when (and the result).
// ─────────────────────────────────────────────────────────────────────────
export async function testChannel(
  input: z.input<typeof TestInput>
): Promise<ChannelResult> {
  const parsed = TestInput.safeParse(input);
  if (!parsed.success) {
    return fail("VALIDATION_FAILED", parsed.error.errors[0]?.message ?? "Invalid input");
  }
  const ctx = await requireAdminContext();
  if (!ctx.ok) return ctx.result;

  const existing = await prisma.notificationChannel.findFirst({
    where: { id: parsed.data.channelId, tenantId: ctx.tenantId },
    select: { id: true, name: true, webhookUrl: true },
  });
  if (!existing) return fail("NOT_FOUND", "Channel not in this tenant");

  let plaintextUrl: string;
  try {
    plaintextUrl = decryptWebhookUrl(existing.webhookUrl);
  } catch (err) {
    await auditPrivilegedAction({
      actor: { id: ctx.user.id, email: ctx.user.email },
      action: "notificationChannel.test",
      resource: "NotificationChannel",
      resourceId: existing.id,
      tenantId: ctx.tenantId,
      metadata: {
        outcome: "decrypt_failed",
        error: err instanceof Error ? err.message : "unknown",
      },
    });
    return fail(
      "DECRYPT_FAILED",
      "Stored webhook URL could not be decrypted — re-enter it or check WEBHOOK_ENCRYPTION_KEY"
    );
  }

  const result = await sendSlackMessage(plaintextUrl, {
    text: `Test message from ledger-core notification channel "${existing.name}".`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:wrench: *Test message* — channel \`${existing.name}\`\nIf you see this, your webhook is wired correctly.`,
        },
      },
    ],
  });

  // Defense-in-depth URL scrub. After the upstream sendSlackMessage
  // fix landed on main, result.error no longer contains response-body
  // content (only "Slack returned HTTP <status>" + AbortError/network
  // strings), so in practice the regex never matches. We keep it
  // defensive against future changes that might re-introduce body
  // echo. The regex is the authoritative scrub — no pre-gate with
  // .includes() (CodeQL flags that as incomplete-URL-substring-
  // sanitization, and the regex is a no-op when there's no match).
  const scrubbedError = result.ok
    ? null
    : result.error.replace(
        /https?:\/\/hooks\.slack\.com\/services\/[^\s)]+/g,
        maskWebhookUrl(plaintextUrl)
      );

  await auditPrivilegedAction({
    actor: { id: ctx.user.id, email: ctx.user.email },
    action: "notificationChannel.test",
    resource: "NotificationChannel",
    resourceId: existing.id,
    tenantId: ctx.tenantId,
    metadata: {
      outcome: result.ok ? "sent" : "failed",
      status: result.ok ? result.status : (result.status ?? null),
      ...(result.ok ? {} : { error: scrubbedError }),
    },
  });

  if (!result.ok && scrubbedError !== null) {
    return fail("SLACK_REJECTED", scrubbedError);
  }
  return { ok: true, channelId: existing.id };
}

// ─────────────────────────────────────────────────────────────────────────
// setEnabled — quick toggle without rendering the full edit form
// ─────────────────────────────────────────────────────────────────────────
export async function setEnabled(
  input: z.input<typeof ToggleInput>
): Promise<ChannelResult> {
  const parsed = ToggleInput.safeParse(input);
  if (!parsed.success) {
    return fail("VALIDATION_FAILED", parsed.error.errors[0]?.message ?? "Invalid input");
  }
  const ctx = await requireAdminContext();
  if (!ctx.ok) return ctx.result;

  const existing = await prisma.notificationChannel.findFirst({
    where: { id: parsed.data.channelId, tenantId: ctx.tenantId },
    select: { id: true, enabled: true },
  });
  if (!existing) return fail("NOT_FOUND", "Channel not in this tenant");
  if (existing.enabled === parsed.data.enabled) {
    return { ok: true, channelId: existing.id };
  }

  await prisma.notificationChannel.update({
    where: { id: existing.id },
    data: { enabled: parsed.data.enabled },
  });

  await auditPrivilegedAction({
    actor: { id: ctx.user.id, email: ctx.user.email },
    action: "notificationChannel.setEnabled",
    resource: "NotificationChannel",
    resourceId: existing.id,
    tenantId: ctx.tenantId,
    metadata: { from: existing.enabled, to: parsed.data.enabled },
  });

  revalidatePath("/admin/notification-channels");
  return { ok: true, channelId: existing.id };
}
