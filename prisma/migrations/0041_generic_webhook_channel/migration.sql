-- Generic outbound webhook channels.
--
-- Two additive changes:
--   1. WEBHOOK_GENERIC joins the channel-type enum. Postgres cannot add
--      an enum value inside a transaction block that also uses it, but
--      adding alone is fine and IF NOT EXISTS makes the re-run safe.
--   2. notification_channel.signingSecret — the HMAC key the receiver
--      verifies against, encrypted at rest by the same AES-256-GCM path
--      as webhookUrl. Nullable: an unsigned endpoint is allowed for
--      receivers behind their own network controls.
--
-- No backfill. Existing rows are SLACK and keep a null secret, which is
-- the Slack path's behaviour anyway (the URL is the bearer token).
--
-- Rollback: DROP COLUMN is safe; the enum value cannot be removed
-- without recreating the type, so a revert leaves WEBHOOK_GENERIC
-- present-but-unused. That is inert — nothing reads it unless a
-- channel row carries it.

ALTER TYPE "NotificationChannelType" ADD VALUE IF NOT EXISTS 'WEBHOOK_GENERIC';

ALTER TABLE "notification_channel"
  ADD COLUMN IF NOT EXISTS "signingSecret" TEXT;
