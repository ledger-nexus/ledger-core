-- Reverse of 0041_generic_webhook_channel.
--
-- PARTIAL BY NATURE, and the part that does not reverse is the reason
-- this file says so out loud rather than pretending to be symmetric.
--
-- Postgres cannot remove a value from an enum type. Dropping
-- 'WEBHOOK_GENERIC' would mean recreating "NotificationChannelType" and
-- rewriting every column that depends on it — a rewrite that is far more
-- dangerous than the forward migration was. The value is therefore left
-- in place. That is inert: nothing reads it unless a channel row carries
-- it, and the guard below proves none does.
--
-- The guard is the substance here. Dropping "signingSecret" while a
-- WEBHOOK_GENERIC channel exists does not fail at rollback time — it
-- fails later, at send time, when the dispatcher reaches for a signing
-- key that is no longer there. A rollback that converts an obvious error
-- now into an obscure one next Tuesday is worse than one that refuses.
--
-- Apply with:  prisma db execute --file prisma/migrations/0041_generic_webhook_channel/down.sql

DO $$
DECLARE
  generic_count BIGINT;
BEGIN
  SELECT count(*) INTO generic_count
  FROM "notification_channel"
  WHERE "type" = 'WEBHOOK_GENERIC';

  IF generic_count > 0 THEN
    RAISE EXCEPTION
      'Refusing to roll back 0041: % WEBHOOK_GENERIC channel(s) still exist. Delete them or switch them to SLACK first, then re-run.',
      generic_count;
  END IF;
END $$;

ALTER TABLE "notification_channel"
  DROP COLUMN IF EXISTS "signingSecret";

-- NOT reversed, deliberately: ALTER TYPE "NotificationChannelType" keeps
-- 'WEBHOOK_GENERIC'. See the note at the top.
