// Revenue Contract sub-ledger (ASC 606 / IFRS 15).
//
// v0.3 scope: contract + performance obligations + book-aware recognition
// basis. The actual recognition engine lives in the consumer repo
// `revenue-rec` — that's the project that demonstrates ASC 606 timing,
// variable consideration, contract modifications, and SSP allocation.
//
// What lives HERE: the data model + a minimal straight-line recognition
// runner adequate for the Northwind seed (Globex annual prepay).

import { PrismaClient } from "@prisma/client";
import { Decimal } from "@/lib/utils/decimal";
import { postJournalEntry } from "../post-journal";

function toDecimal(v: Decimal | string | number | null | undefined): Decimal {
  if (v === undefined || v === null) return new Decimal(0);
  if (v instanceof Decimal) return v;
  return new Decimal(v);
}

export interface PerformanceObligationSpec {
  sequenceNo: number;
  description: string;
  ssp: Decimal | string | number;
  recognitionPattern: "POINT_IN_TIME" | "OVER_TIME_STRAIGHT" | "OVER_TIME_USAGE" | "OVER_TIME_MILESTONE";
  startDate: Date;
  endDate?: Date;
  revenueAccountCode: string;
  deferredAccountCode: string;
}

export interface RevenueContractBookSpec {
  bookCode: string;
  recognitionBasis: "ACCRUAL" | "CASH";
}

export interface CreateRevenueContractInput {
  /**
   * Authoritative tenant scope. The entity lookup is scoped by this
   * tenantId so cross-tenant code collisions return "entity not found"
   * instead of mutating the wrong tenant's data.
   *
   * ⚠️ This is deficiency log #28, which was recorded as CLOSED on
   * 2026-06-12 having been fixed in `createFixedAsset` ONLY. The
   * identical unscoped lookup survived in four sibling sub-ledgers,
   * including this one, for two months. Required, not optional, exactly
   * as #28's remediation made it — an optional tenantId that callers may
   * omit reproduces the defect for every caller that omits it.
   */
  tenantId: string;
  entityCode: string;
  code: string;
  description: string;
  customerPartyCode: string;
  contractStartDate: Date;
  contractEndDate?: Date;
  totalContractValue: Decimal | string | number;
  currencyCode: string;
  performanceObligations: PerformanceObligationSpec[];
  books: RevenueContractBookSpec[];
  sourceSystem?: string;
  sourceRecordType?: string;
  sourceRecordId?: string;
  sourcePayload?: unknown;
}

export async function createRevenueContract(
  prisma: PrismaClient,
  input: CreateRevenueContractInput
): Promise<{ id: string }> {
  // Phase 4b: entity code unique per [tenantId, code]; use findFirst.
  const entity = await prisma.legalEntity.findFirstOrThrow({
    where: { tenantId: input.tenantId, code: input.entityCode },
    select: { id: true, tenantId: true },
  });
  const customer = await prisma.party.findFirstOrThrow({
    where: {
      tenantId: entity.tenantId,
      code: input.customerPartyCode,
      OR: [{ entityId: null }, { entityId: entity.id }],
    },
    select: { id: true },
  });
  const bookRows = await prisma.book.findMany({
    where: { code: { in: input.books.map((b) => b.bookCode) } },
    select: { id: true, code: true },
  });
  const bookIdByCode = new Map(bookRows.map((b) => [b.code, b.id]));

  return await prisma.revenueContract.create({
    data: {
      tenantId: entity.tenantId,
      entityId: entity.id,
      code: input.code,
      description: input.description,
      customerPartyId: customer.id,
      contractStartDate: input.contractStartDate,
      contractEndDate: input.contractEndDate,
      totalContractValue: toDecimal(input.totalContractValue).toFixed(4),
      currencyId: input.currencyCode,
      status: "ACTIVE",
      sourceSystem: input.sourceSystem,
      sourceRecordType: input.sourceRecordType,
      sourceRecordId: input.sourceRecordId,
      sourcePayload: (input.sourcePayload as any) ?? undefined,
      performanceObligations: {
        create: input.performanceObligations.map((po) => ({
          sequenceNo: po.sequenceNo,
          description: po.description,
          ssp: toDecimal(po.ssp).toFixed(4),
          recognitionPattern: po.recognitionPattern,
          startDate: po.startDate,
          endDate: po.endDate,
          revenueAccountCode: po.revenueAccountCode,
          deferredAccountCode: po.deferredAccountCode,
        })),
      },
      bookAttributes: {
        create: input.books.map((b) => {
          const bookId = bookIdByCode.get(b.bookCode);
          if (!bookId) throw new Error(`Book ${b.bookCode} not found`);
          return {
            bookId,
            recognitionBasis: b.recognitionBasis,
          };
        }),
      },
    },
    select: { id: true },
  });
}

// Minimal OVER_TIME_STRAIGHT recognition runner. For each accrual-basis
// book × contract × performance obligation, recognize the share of ssp
// allocated to the period [start, through] minus what's been recognized.
//
// Cash-basis books (recognitionBasis=CASH) get nothing from this runner —
// their revenue moves only when cash is collected.
export async function runStraightLineRecognition(
  prisma: PrismaClient,
  input: {
    entityCode: string;
    bookCode: string;
    throughDate: Date;
    source?: "MANUAL" | "SEED" | "SYSTEM" | "AI_APPROVED" | "IMPORT";
  }
): Promise<{ entriesPosted: number; totalRecognized: Decimal }> {
  const book = await prisma.book.findUniqueOrThrow({
    where: { code: input.bookCode },
    select: { id: true, reportingCurrencyId: true },
  });

  const contracts = await prisma.revenueContract.findMany({
    where: {
      entity: { code: input.entityCode },
      status: "ACTIVE",
    },
    include: {
      performanceObligations: true,
      bookAttributes: { where: { bookId: book.id } },
    },
  });

  let entriesPosted = 0;
  let totalRecognized = new Decimal(0);

  for (const contract of contracts) {
    const bookAttrs = contract.bookAttributes[0];
    if (!bookAttrs || bookAttrs.recognitionBasis !== "ACCRUAL") continue;

    for (const po of contract.performanceObligations) {
      if (po.recognitionPattern !== "OVER_TIME_STRAIGHT") continue;
      if (!po.endDate) continue;

      const start = po.startDate;
      const end = po.endDate;
      const through = input.throughDate < end ? input.throughDate : end;
      if (through < start) continue;

      // Month-based ratable recognition. SaaS subscription practice: each
      // month delivered counts as 1/N of the service. Day-based math drifts
      // by a few pennies per period and breaks clean BTD demos.
      const totalMonths = Math.max(
        1,
        (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
          (end.getUTCMonth() - start.getUTCMonth()) +
          1
      );
      const elapsedMonths = Math.min(
        totalMonths,
        (through.getUTCFullYear() - start.getUTCFullYear()) * 12 +
          (through.getUTCMonth() - start.getUTCMonth()) +
          1
      );
      const ssp = toDecimal(po.ssp);
      const targetRecognized = ssp.times(elapsedMonths).div(totalMonths);
      const already = toDecimal(po.recognizedToDate);
      const incremental = targetRecognized.minus(already);
      if (incremental.lessThanOrEqualTo(0)) continue;

      await postJournalEntry(prisma, {
        entityCode: input.entityCode,
        bookCode: input.bookCode,
        currencyCode: book.reportingCurrencyId,
        documentDate: through,
        memo: `Revenue recognition thru ${through.toISOString().slice(0, 10)} — ${contract.code} PO #${po.sequenceNo}`,
        source: input.source ?? "SYSTEM",
        sourceRecordType: "RevenueRecognition",
        sourceRecordId: po.id,
        extensions: {
          contractCode: contract.code,
          performanceObligationId: po.id,
          recognitionPattern: po.recognitionPattern,
        },
        lines: [
          {
            accountCode: po.deferredAccountCode,
            debit: incremental.toFixed(4),
            description: `Release deferred — ${contract.code}`,
          },
          {
            accountCode: po.revenueAccountCode,
            credit: incremental.toFixed(4),
            description: `Revenue recognized — ${contract.code}`,
          },
        ],
      });

      await prisma.performanceObligation.update({
        where: { id: po.id },
        data: { recognizedToDate: targetRecognized.toFixed(4) },
      });
      await prisma.revenueContractBookAttributes.update({
        where: { contractId_bookId: { contractId: contract.id, bookId: book.id } },
        data: {
          cumulativeRecognized: toDecimal(bookAttrs.cumulativeRecognized).plus(incremental).toFixed(4),
        },
      });

      entriesPosted += 1;
      totalRecognized = totalRecognized.plus(incremental);
    }
  }

  return { entriesPosted, totalRecognized };
}
