-- Notifications arc — Slack channel + dispatch idempotency.
--
-- Adds:
--   1. NotificationChannelType enum (SLACK for v1; future EMAIL/TEAMS)
--   2. notification_channel table — per-tenant outbound channel config
--      with AES-256-GCM-encrypted webhookUrl
--   3. notification_dispatch table — per-(channel, alert) idempotency
--      record so a given alert pings each channel at most once
--
-- Rollback:
--   DROP INDEX IF EXISTS "idx_notification_dispatch_tenant_sent_at";
--   DROP INDEX IF EXISTS "idx_notification_channel_tenant_enabled";
--   DROP TABLE IF EXISTS "notification_dispatch";
--   DROP TABLE IF EXISTS "notification_channel";
--   DROP TYPE IF EXISTS "NotificationChannelType";

DO $$ BEGIN
  CREATE TYPE "NotificationChannelType" AS ENUM ('SLACK');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE "notification_channel" (
  "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"        UUID NOT NULL,
  "type"            "NotificationChannelType" NOT NULL,
  "name"            TEXT NOT NULL,
  "webhookUrl"      TEXT NOT NULL,
  "severityFilter"  TEXT[] NOT NULL DEFAULT '{}',
  "enabled"         BOOLEAN NOT NULL DEFAULT TRUE,
  "createdById"     UUID,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,

  CONSTRAINT "notification_channel_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "notification_channel"
  ADD CONSTRAINT "notification_channel_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenant"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "notification_channel"
  ADD CONSTRAINT "notification_channel_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "app_user"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "idx_notification_channel_tenant_enabled"
  ON "notification_channel"("tenantId", "enabled");

CREATE TABLE "notification_dispatch" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"         UUID NOT NULL,
  "channelId"        UUID NOT NULL,
  "alertFingerprint" TEXT NOT NULL,
  "pillar"           TEXT NOT NULL,
  "severity"         TEXT NOT NULL,
  "sendStatus"       INTEGER,
  "sendError"        TEXT,
  "sentAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "notification_dispatch_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "notification_dispatch"
  ADD CONSTRAINT "notification_dispatch_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenant"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "notification_dispatch"
  ADD CONSTRAINT "notification_dispatch_channelId_fkey"
  FOREIGN KEY ("channelId") REFERENCES "notification_channel"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Idempotency: a given alert lands in a given channel at most once.
-- The cron dispatcher upserts; a duplicate is a no-op skip.
CREATE UNIQUE INDEX "notification_dispatch_channel_alert_unique"
  ON "notification_dispatch"("channelId", "alertFingerprint");

CREATE INDEX "idx_notification_dispatch_tenant_sent_at"
  ON "notification_dispatch"("tenantId", "sentAt");
