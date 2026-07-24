// POST /api/cron/assertion-check
//
// Cron-only route. Re-checks every stored balance assertion against the books
// and refreshes the result cache (lastCheckedAt / lastObservedAmount /
// lastStatus) that the close-alerts aggregator reads.
//
// This is what makes assertions PUSH rather than PULL. Without it the
// /assertions page is the only thing that ever evaluates them, so drift only
// surfaces if someone thinks to look — and the whole argument for assertions
// is that they catch what nobody thought to look for.
//
// Read-only with respect to the ledger: it posts nothing and corrects nothing.
// A FAIL becomes a high-severity close alert; acting on it stays a human,
// explicit decision (pad, or a real correcting entry). "AI suggests; humans
// approve; the system posts" applies to machines too — this machine reports.
//
// Auth: `Authorization: Bearer <CRON_SECRET>` header (Vercel cron default) or
// `?cron_secret=<...>` query param (manual trigger).
//
// Schedule: vercel.json fires this daily at 03:00 UTC — after the 02:00
// recurring-JE run, so the day's posted entries are already in the books when
// the assertions are evaluated. Checking before that would report drift that
// the recurring run was about to resolve.
//
// SOC 2:
//   CC6.3  cron-secret auth via timing-safe compare
//   CC6.1  every check is scoped to one (tenant, entity, book); the sweep
//          enumerates scopes from the DB rather than accepting any override
//   CC7.2  one aggregate audit_log row per tick, carrying pass/fail counts
//          but NOT the asserted or observed figures (financial values stay
//          out of logs — the assertion rows themselves are the record)

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isAuthorizedCronRequest } from "@/lib/auth/cron";
import { logAuditEvent } from "@/lib/audit/log";
import { checkBalanceAssertions } from "@/lib/accounting/balance-assertions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = new Date();

  // Enumerate the distinct (tenant, entity, book) scopes that actually have
  // assertions. Walking every entity × book instead would run a trial balance
  // for combinations nobody ever asserted against.
  const scopes = await prisma.balanceAssertion.findMany({
    distinct: ["tenantId", "entityId", "bookId"],
    select: {
      tenantId: true,
      entity: { select: { code: true } },
      book: { select: { code: true } },
    },
  });

  let checked = 0;
  let failed = 0;
  const errors: Array<{ entityCode: string; bookCode: string; error: string }> = [];

  for (const s of scopes) {
    try {
      const results = await checkBalanceAssertions(
        prisma,
        {
          tenantId: s.tenantId,
          entityCode: s.entity.code,
          bookCode: s.book.code,
        },
        { persist: true }
      );
      checked += results.length;
      failed += results.filter((r) => r.status === "FAIL").length;
    } catch (e) {
      // One bad scope must not abort the sweep — the remaining tenants still
      // need their tripwires refreshed. A scope that throws keeps its previous
      // cached status, which the aggregator surfaces as stale rather than as a
      // false PASS.
      errors.push({
        entityCode: s.entity.code,
        bookCode: s.book.code,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  await logAuditEvent({
    eventType: "PRIVILEGED_ACTION",
    action: "assertion.cron.check",
    actorUserId: null,
    actorEmail: null,
    resource: "BalanceAssertion",
    outcome: errors.length > 0 ? "FAILURE" : "SUCCESS",
    metadata: {
      scopes: scopes.length,
      // Counts only — the asserted and observed amounts are financial values
      // and stay out of the log. The assertion rows carry them.
      assertionsChecked: checked,
      assertionsFailing: failed,
      scopeErrors: errors.length,
      durationMs: Date.now() - startedAt.getTime(),
    },
  });

  return NextResponse.json({
    ok: true,
    scopes: scopes.length,
    assertionsChecked: checked,
    assertionsFailing: failed,
    errors,
  });
}
