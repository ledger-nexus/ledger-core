// Recurring journal entries — the engine.
//
// A RecurringEntry is a TEMPLATE: a fixed shape (lines) + a cadence
// (monthly / quarterly / annually) + a start date. The runner walks
// active templates, computes every cadence step from (lastPostedDate
// OR startDate) up through the requested throughDate, and posts a
// fresh JournalEntry for each step via postJournalEntry — the same
// substrate boundary every other ledger write goes through.
//
// Idempotency: every produced JE carries
//   sourceSystem     = "SUBSTRATE"
//   sourceRecordType = "RecurringEntry"
//   sourceRecordId   = "<templateId>:<docDateISO>"
// which uniquely identifies the (template, period) pair. ledger-core's
// existing partial unique index on (sourceSystem, sourceRecordType,
// sourceRecordId) means a repeated run with the same throughDate is
// a no-op — the second post hits the dedup branch in postJournalEntry
// and returns the existing entry's id.
//
// Edge cases handled:
//   - Inactive template:   skipped, no work done.
//   - endDate passed:      runner stops once nextDocDate > endDate.
//   - Period close:        postJournalEntry refuses the write; the
//                          runner surfaces the error and continues
//                          with the next template (one bad template
//                          doesn't halt the whole run).
//   - Same throughDate:    re-run produces zero new entries (dedup).
//
// Date math: monthly cadence anchors to startDate's day-of-month.
// If the target month has fewer days (Feb after starting Jan 31), the
// step falls back to the LAST DAY of the target month — the accountant-
// expected behavior. Quarterly and annual cadences use whole-month /
// whole-year offsets.

import type { PrismaClient, Cadence } from "@prisma/client";
import { Decimal } from "decimal.js";
import { postJournalEntry } from "./post-journal";
import { computeAllocationLines, resolveSourceActivity } from "./allocation";
import { withTenantContext } from "../tenant-context";

export interface RunRecurringInput {
  /** Inclusive upper bound. All cadence steps with docDate <= throughDate get posted. */
  throughDate: Date;
  /** Optional: only run templates for this tenant. Defaults to all active tenants. */
  tenantId?: string;
  /** Optional: only run a single template (e.g. from the "Run now" button). */
  templateId?: string;
  /** Who triggered the run. Threaded into the produced JEs' createdBy field. */
  triggeredBy?: string;
}

export interface RunRecurringResult {
  /** Number of JEs successfully posted across all templates. */
  entriesPosted: number;
  /** Templates skipped because they were already current (nothing due). */
  templatesIdle: number;
  /** Per-template summary: what got posted + any errors. */
  templates: Array<{
    id: string;
    code: string;
    posted: number;
    errors: Array<{ docDate: string; message: string }>;
  }>;
}

/**
 * Add `months` whole months to `from`, anchoring at the anchor's day of month
 * but clamping to the last day of the target month when the target month is shorter.
 *
 * Example: addMonthsAnchored(2026-01-31, 1, 31) → 2026-02-28
 *          addMonthsAnchored(2026-02-28, 1, 31) → 2026-03-31  (re-anchors!)
 */
export function addMonthsAnchored(from: Date, months: number, anchorDay: number): Date {
  // Work in UTC to avoid DST surprises.
  const year = from.getUTCFullYear();
  const month = from.getUTCMonth();
  const targetMonthIdx = month + months;
  const targetYear = year + Math.floor(targetMonthIdx / 12);
  const targetMonth = ((targetMonthIdx % 12) + 12) % 12;
  // Days in target month: day 0 of (targetMonth+1) is the last day of targetMonth.
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const day = Math.min(anchorDay, lastDay);
  return new Date(Date.UTC(targetYear, targetMonth, day));
}

/**
 * Compute the next docDate for a template given (cadence, startDate, lastPostedDate).
 * Returns startDate if lastPostedDate is null (first run).
 */
export function nextDocDate(
  cadence: Cadence,
  startDate: Date,
  lastPostedDate: Date | null
): Date {
  if (lastPostedDate == null) return startDate;
  const anchorDay = startDate.getUTCDate();
  switch (cadence) {
    case "MONTHLY":
      return addMonthsAnchored(lastPostedDate, 1, anchorDay);
    case "QUARTERLY":
      return addMonthsAnchored(lastPostedDate, 3, anchorDay);
    case "ANNUALLY":
      return addMonthsAnchored(lastPostedDate, 12, anchorDay);
  }
}

/**
 * Enumerate every cadence step from (lastPostedDate, startDate) UP TO AND
 * INCLUDING throughDate (and not past endDate). Returns dates in ascending order.
 *
 * Pure function — no DB. Used by `runRecurringEntries` to compute the
 * schedule, and exposed for tests + the UI projection.
 */
export function enumerateDueDates(input: {
  cadence: Cadence;
  startDate: Date;
  lastPostedDate: Date | null;
  endDate: Date | null;
  throughDate: Date;
}): Date[] {
  const { cadence, startDate, lastPostedDate, endDate, throughDate } = input;
  const out: Date[] = [];
  let cursor = nextDocDate(cadence, startDate, lastPostedDate);
  const stopAt = endDate && endDate < throughDate ? endDate : throughDate;
  // Safety: cap at 1000 iterations so a misconfigured template can't
  // hang the runner. Real cadences hit this only after centuries.
  for (let i = 0; i < 1000 && cursor <= stopAt; i++) {
    out.push(cursor);
    cursor = nextDocDate(cadence, startDate, cursor);
  }
  return out;
}

/**
 * Format a Date as "YYYY-MM-DD" in UTC. Used for the lineage triple's
 * sourceRecordId so re-runs produce the identical string and hit dedup.
 */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The runner. Walks active templates (filtered per input), posts JEs for
 * every cadence step up to throughDate, updates lastPostedDate.
 */
export async function runRecurringEntries(
  prisma: PrismaClient,
  input: RunRecurringInput
): Promise<RunRecurringResult> {
  const templates = await prisma.recurringEntry.findMany({
    where: {
      isActive: true,
      ...(input.tenantId ? { tenantId: input.tenantId } : {}),
      ...(input.templateId ? { id: input.templateId } : {}),
    },
    include: {
      entity: { select: { code: true } },
      book: { select: { code: true } },
      lines: { orderBy: { lineNo: "asc" } },
    },
  });

  const result: RunRecurringResult = {
    entriesPosted: 0,
    templatesIdle: 0,
    templates: [],
  };

  for (const template of templates) {
    const dueDates = enumerateDueDates({
      cadence: template.cadence,
      startDate: template.startDate,
      lastPostedDate: template.lastPostedDate,
      endDate: template.endDate,
      throughDate: input.throughDate,
    });

    if (dueDates.length === 0) {
      result.templatesIdle += 1;
      continue;
    }

    const summary = {
      id: template.id,
      code: template.code,
      posted: 0,
      errors: [] as Array<{ docDate: string; message: string }>,
    };

    let lastSuccessfulDocDate: Date | null = null;
    for (const docDate of dueDates) {
      try {
        // RLS Phase 2b — per-iteration GUC: each postJournalEntry runs
        // in its OWN withTenantContext tx so a bad period doesn't roll
        // back already-posted ones. This is the substrate-contract for
        // the runner — "all-or-NONE within a template's batch, but
        // per-period atomicity across the batch." Per-template
        // lastPostedDate advances to the highest SUCCEEDED docDate.
        const didPost = await withTenantContext(prisma, template.tenantId, async (tx) => {
          // ALLOCATION templates compute their lines per run from the
          // source account's window activity; zero activity is a
          // completed no-op (advance the bookmark, post nothing) — NOT
          // an error, or a quiet month would wedge the template forever.
          let lines: {
            accountCode: string;
            debit: string;
            credit: string;
            description?: string;
            partyCode?: string;
            itemCode?: string;
          }[];
          if (template.kind === "ALLOCATION") {
            const activity = await resolveSourceActivity(tx, {
              tenantId: template.tenantId,
              entityId: template.entityId,
              bookId: template.bookId,
              sourceAccountCode: template.allocationSourceAccountCode!,
              docDate,
            });
            const computed = computeAllocationLines({
              sourceAccountCode: template.allocationSourceAccountCode!,
              sourceActivity: activity,
              targets: template.lines.map((l) => ({
                accountCode: l.accountCode,
                percent: new Decimal(l.allocationPercent?.toString() ?? "0"),
                description: l.description,
              })),
            });
            if (computed.length === 0) return false; // nothing to allocate
            lines = computed.map((l) => ({
              accountCode: l.accountCode,
              debit: l.debit.toString(),
              credit: l.credit.toString(),
              description: l.description,
            }));
          } else {
            lines = template.lines.map((l) => ({
              accountCode: l.accountCode,
              debit: l.debit.toString(),
              credit: l.credit.toString(),
              description: l.description ?? undefined,
              partyCode: l.partyCode ?? undefined,
              itemCode: l.itemCode ?? undefined,
            }));
          }
          await postJournalEntry(tx, {
            tenantId: template.tenantId,
            entityCode: template.entity.code,
            bookCode: template.book.code,
            documentDate: docDate,
            // Posting date == doc date for recurrings. They're predictable;
            // there's no "I forgot to enter this last month" backdating gap.
            postingDate: docDate,
            memo: template.memo,
            currencyCode: template.currencyId,
            source: "SYSTEM",
            createdBy: input.triggeredBy,
            sourceSystem: "SUBSTRATE",
            sourceRecordType: "RecurringEntry",
            sourceRecordId: `${template.id}:${isoDate(docDate)}`,
            lines,
          });
          return true;
        });
        if (didPost) {
          summary.posted += 1;
          result.entriesPosted += 1;
        }
        // A zero-activity allocation run still completes its docDate —
        // the bookmark advances so a quiet month never wedges the
        // template.
        lastSuccessfulDocDate = docDate;
      } catch (e) {
        // Don't abort the whole template on one bad period — record it,
        // advance lastPostedDate only up to the last SUCCESS, and stop
        // this template (later periods would also fail).
        summary.errors.push({
          docDate: isoDate(docDate),
          message: e instanceof Error ? e.message : String(e),
        });
        break;
      }
    }

    if (lastSuccessfulDocDate != null) {
      // RLS Phase 2b: lastPostedDate update gets the GUC too. Separate
      // withTenantContext (not bundled with the per-iteration posts) so
      // a late-iteration post failure still allows the advancement
      // through the prior successes.
      await withTenantContext(prisma, template.tenantId, async (tx) =>
        tx.recurringEntry.update({
          where: { id: template.id },
          data: { lastPostedDate: lastSuccessfulDocDate },
        })
      );
    }

    result.templates.push(summary);
  }

  return result;
}
