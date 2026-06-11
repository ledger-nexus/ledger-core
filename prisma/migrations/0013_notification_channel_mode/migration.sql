-- Add cadence selector to notification_channel.
--
-- IMMEDIATE preserves existing behavior: the per-alert cron (every 15m
-- during business hours) writes one NotificationDispatch row per new
-- alert and posts one Slack message per row.
--
-- DIGEST_DAILY routes the channel through a second cron (once daily
-- 09:00 UTC) that batches every NEW alert since the last successful
-- digest into ONE Slack message. The dedupe key in
-- notification_dispatch (channelId, alertFingerprint) still pins each
-- alert to at-most-one send across both cadences for a given channel.
--
-- Backfill: every existing channel goes to IMMEDIATE so live behavior
-- is unchanged at deploy. Operators flip to DIGEST_DAILY explicitly
-- from the admin UI.

CREATE TYPE "NotificationChannelMode" AS ENUM ('IMMEDIATE', 'DIGEST_DAILY');

ALTER TABLE "notification_channel"
  ADD COLUMN "mode" "NotificationChannelMode" NOT NULL DEFAULT 'IMMEDIATE';

CREATE INDEX "notification_channel_mode_enabled_idx"
  ON "notification_channel" ("mode", "enabled");
