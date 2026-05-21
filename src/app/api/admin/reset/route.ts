// POST /api/admin/reset
//
// Clears all NORTHWIND-scoped transactional data + sub-ledger records,
// then re-runs the Northwind seed. Gated by an ADMIN_TOKEN environment
// variable so random visitors of the public demo can't reset it.
//
// Usage:
//   curl -X POST https://your-demo.vercel.app/api/admin/reset \
//        -H "Authorization: Bearer $ADMIN_TOKEN"
//
// If ADMIN_TOKEN is unset, the endpoint refuses to run (fail closed).

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { resetAndReseedNorthwind } from "@/lib/seed/northwind";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const token = process.env.ADMIN_TOKEN;
  if (!token) {
    return NextResponse.json(
      {
        ok: false,
        error: "ADMIN_TOKEN env var is not set — endpoint disabled. Set it in the deployment env to enable.",
      },
      { status: 503 }
    );
  }

  const authHeader = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${token}`;
  if (authHeader !== expected) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const started = Date.now();
    const result = await resetAndReseedNorthwind(prisma);
    const elapsedMs = Date.now() - started;
    return NextResponse.json({
      ok: true,
      cleared: result.cleared,
      entriesAfter: result.entriesAfter,
      elapsedMs,
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : "Unknown error during reset",
      },
      { status: 500 }
    );
  }
}

export async function GET(): Promise<NextResponse> {
  // Make accidental GETs easier to debug than a 405.
  return NextResponse.json(
    {
      ok: false,
      error:
        "This endpoint accepts POST only. Include `Authorization: Bearer $ADMIN_TOKEN`. See docs/deployment.md.",
    },
    { status: 405 }
  );
}
