// GET /api/cron/report-ai-usage
//
// Daily Stripe usage-meter cron. Iterates every active tenant and
// reports yesterday's Anthropic token spend (in cents) to Stripe as
// a billing-meter event. Stripe aggregates these events during the
// billing period and includes the total on the next invoice.
//
// See docs/billing-setup.md for the Stripe-side setup (Meter + Price
// + per-tenant subscription item).
//
// Wired to Vercel Cron via vercel.json — runs at 01:00 UTC daily,
// which is "yesterday is fully closed everywhere on Earth + 1 hour
// safety buffer for end-of-day events".
//
// Idempotency: (tenantId, usageDay) is unique on AiUsageReport.
// A retry of the same day is a no-op — the helper short-circuits on
// the existing row. The Stripe meter event itself also has an
// `identifier` we set to `<tenantId>-<usageDay>` so even an in-flight
// retry doesn't double-bill on the Stripe side.
//
// Auth: same CRON_SECRET pattern as the other cleanup crons.
// Production refuses without the secret; dev passes through for
// manual testing.
//
// Manual invocation (e.g. catching up a missed day):
//   curl -H "Authorization: Bearer $CRON_SECRET" \
//        "https://<your-domain>/api/cron/report-ai-usage?usageDay=2026-05-15"

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { reportYesterdayForAllTenants } from "@/lib/billing/usage-meter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

function isProd(): boolean {
  return process.env.NODE_ENV === "production";
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization") ?? "";

  if (!secret) {
    if (isProd()) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "CRON_SECRET env var is not set — endpoint disabled in production. Set it in the deployment env to enable Vercel Cron invocations.",
        },
        { status: 503 }
      );
    }
    // Dev convenience: no secret required when not in production.
  } else {
    const expected = `Bearer ${secret}`;
    if (!constantTimeEquals(authHeader, expected)) {
      return NextResponse.json(
        { ok: false, error: "Invalid or missing bearer token" },
        { status: 401 }
      );
    }
  }

  // Allow overriding the usageDay via query param for manual catch-up
  // on a missed day. Without it, the helper defaults to yesterday UTC.
  const url = new URL(req.url);
  const usageDay = url.searchParams.get("usageDay") ?? undefined;

  const outcome = await reportYesterdayForAllTenants({ usageDay });

  // Vercel function logs surface this — useful for daily progress
  // verification without leaving the platform UI.
  console.log("[cron] report-ai-usage", JSON.stringify({
    usageDay: outcome.usageDay,
    reported: outcome.reported,
    noUsage: outcome.noUsage,
    noSubscription: outcome.noSubscription,
    loggedOnly: outcome.loggedOnly,
    failed: outcome.failed,
  }));

  return NextResponse.json({
    ok: true,
    usageDay: outcome.usageDay,
    reported: outcome.reported,
    noUsage: outcome.noUsage,
    noSubscription: outcome.noSubscription,
    loggedOnly: outcome.loggedOnly,
    failed: outcome.failed,
    // Include per-tenant detail only when verbose=1 to keep response
    // size manageable in the daily case where this gets logged.
    ...(url.searchParams.get("verbose") === "1"
      ? { tenants: outcome.tenants }
      : {}),
  });
}
