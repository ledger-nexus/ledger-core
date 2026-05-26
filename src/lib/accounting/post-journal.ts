// postJournalEntry: the single entry point for writing to the ledger.
//
// This function is the most important code in the project. Everything else
// (rev rec engine, bank recon, manual entries, ERP imports) MUST go through
// here. The guarantees this function provides are the guarantees the whole
// system has.
//
// Guarantees:
//   1. Debits equal credits, summed across all lines (UnbalancedEntryError if not).
//   2. Each line has exactly one of debit/credit (InvalidLineError if not).
//   3. All amounts are non-negative.
//   4. All referenced accounts exist, are active, and are in scope for the book.
//   5. The (entity, book, period) tuple is not closed (PeriodClosedError if it is).
//   6. The write is atomic — partial entries are impossible.
//   7. entryNumber is auto-assigned, monotonically increasing per (entity, book).
//   8. Three currency amounts (transaction / functional / reporting) are
//      consistent with the header fxRate and the book's reporting currency.
//
// Multi-book note: each call posts to ONE (entity, book). To post the same
// source event to N books, the caller (or future posting-rules engine) invokes
// postJournalEntry N times with the same sourceRecordId in lineage.
//
// If you find yourself writing a feature that needs to bypass this function,
// stop. The feature is wrong.

import { PrismaClient, Prisma } from "@prisma/client";
import { Decimal } from "decimal.js";
import {
  JournalEntryInput,
  UnbalancedEntryError,
  InvalidLineError,
  UnknownAccountError,
  UnknownEntityError,
  UnknownBookError,
  PeriodClosedError,
  AccountBookScopeError,
  TenantScopeMismatchError,
  EntityMissingTenantError,
} from "./types";
import { fireInsertRules, type FireRulesResult } from "../rules/integration";

// Accepts either a full PrismaClient or an active TransactionClient so
// callers can nest postJournalEntry inside a larger transaction (e.g.
// the fixed-asset record-depreciation endpoint posts N JEs + advances
// FixedAssetBookAttributes in one atomic operation). When given a
// TransactionClient, the internal $transaction wrapper is skipped —
// the outer transaction provides atomicity.
export type DbClient = PrismaClient | Prisma.TransactionClient;

function hasTransaction(db: DbClient): db is PrismaClient {
  // TransactionClient is Omit<PrismaClient, "$transaction" | "$connect" | ...>.
  // Feature-detecting $transaction is the cheapest runtime discriminator.
  return typeof (db as PrismaClient).$transaction === "function";
}

// Configure Decimal.js for accounting:
//   - 28 digits of precision (way more than we'll ever need)
//   - ROUND_HALF_EVEN (banker's rounding — the GAAP-friendly default)
Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_EVEN });

const DEFAULT_BOOK = "US_GAAP";

function toDecimal(v: Decimal | string | number | undefined): Decimal {
  if (v === undefined || v === null) return new Decimal(0);
  if (v instanceof Decimal) return v;
  return new Decimal(v);
}

export async function postJournalEntry(
  prisma: DbClient,
  input: JournalEntryInput
): Promise<{
  id: string;
  entryNumber: string;
  bookCode: string;
  // Populated only when input.ownerUserId was set AND ON_INSERT rules
  // fired against the new entry. Undefined for seed / system / import
  // paths that leave ownerUserId null.
  rulesResult?: FireRulesResult;
}> {
  if (input.lines.length < 2) {
    throw new InvalidLineError(
      `Journal entry must have at least 2 lines (got ${input.lines.length})`
    );
  }

  // ---- 1. Resolve entity + book + currency by code -------------------------

  // Phase 4b: entity code is unique only per [tenantId, code]. When the
  // caller passes input.tenantId, scope the lookup so we deterministically
  // get THEIR entity (and not another tenant's same-coded one). When
  // tenantId is omitted (legacy seeds / single-tenant scripts), fall back
  // to findFirst by code — acceptable while only one tenant exists.
  const entity = await prisma.legalEntity.findFirst({
    where: input.tenantId
      ? { code: input.entityCode, tenantId: input.tenantId }
      : { code: input.entityCode },
    select: {
      id: true,
      code: true,
      functionalCurrencyId: true,
      // tenantId is denormalized onto JournalEntry + every JournalLine
      // so multi-tenant queries can filter without joining LegalEntity.
      // Required for Phase 4 of docs/multi-tenancy.md.
      tenantId: true,
    },
  });
  if (!entity) throw new UnknownEntityError(input.entityCode);

  // ---- 1a. Multi-tenancy scope check --------------------------------------
  //
  // Three states are valid:
  //   - entity.tenantId != null + input.tenantId omitted: trust the entity
  //     (legacy callers, seeds, default-tenant single-tenant world)
  //   - entity.tenantId != null + input.tenantId == entity.tenantId: caller
  //     asserted scope and it matches — preferred for Server Actions
  //   - entity.tenantId != null + input.tenantId != entity.tenantId: BUG —
  //     caller's session is for tenant X but trying to post to tenant Y's
  //     entity. Refuse.
  //
  // entity.tenantId == null indicates a row that escaped the Phase 1
  // backfill (shouldn't be possible in v1+) — refuse for safety.
  if (entity.tenantId == null) {
    throw new EntityMissingTenantError(entity.code);
  }
  if (input.tenantId != null && input.tenantId !== entity.tenantId) {
    throw new TenantScopeMismatchError(
      input.tenantId,
      entity.tenantId,
      entity.code
    );
  }
  const tenantId = entity.tenantId;

  const bookCode = input.bookCode ?? DEFAULT_BOOK;
  const book = await prisma.book.findUnique({
    where: { code: bookCode },
    select: { id: true, code: true, reportingCurrencyId: true, isActive: true },
  });
  if (!book || !book.isActive) throw new UnknownBookError(bookCode);

  const currencyCode = input.currencyCode ?? entity.functionalCurrencyId;
  const fxRate = toDecimal(input.fxRate ?? 1);

  // ---- 2. Validate lines + compute debit/credit totals ---------------------

  let debitTotal = new Decimal(0);
  let creditTotal = new Decimal(0);

  const normalizedLines = input.lines.map((line, idx) => {
    const debit = toDecimal(line.debit);
    const credit = toDecimal(line.credit);

    if (debit.isNegative() || credit.isNegative()) {
      throw new InvalidLineError(
        `Line ${idx}: amounts must be non-negative (got debit=${debit}, credit=${credit})`
      );
    }

    const debitPositive = debit.greaterThan(0);
    const creditPositive = credit.greaterThan(0);

    if (debitPositive && creditPositive) {
      throw new InvalidLineError(
        `Line ${idx}: cannot have both debit and credit non-zero`
      );
    }
    if (!debitPositive && !creditPositive) {
      throw new InvalidLineError(`Line ${idx}: must have either debit or credit`);
    }

    debitTotal = debitTotal.plus(debit);
    creditTotal = creditTotal.plus(credit);

    // Three-currency view. Signed = debit positive, credit negative.
    // In single-currency seed data, txn == functional == reporting.
    const signed = debit.minus(credit);
    const txnAmount = toDecimal(line.transactionAmount ?? signed);
    const reportingAmount = toDecimal(line.reportingAmount ?? signed.times(fxRate));

    return {
      lineNo: idx + 1,
      accountCode: line.accountCode,
      partyCode: line.partyCode,
      itemCode: line.itemCode,
      debit,
      credit,
      transactionAmount: txnAmount,
      reportingAmount,
      description: line.description,
      extensions: line.extensions,
    };
  });

  // The headline invariant: debits = credits.
  if (!debitTotal.equals(creditTotal)) {
    throw new UnbalancedEntryError(debitTotal, creditTotal);
  }

  // ---- 3. Resolve accounts (entity-specific OR shared chart) ---------------
  //
  // Tenant filter is non-negotiable. Without it, two tenants that each
  // have a shared-chart account with code "1000" (entityId=null) would
  // both match — Postgres treats NULL != NULL in unique constraints, so
  // the [entityId, code] unique allows the duplicate. The dedup map below
  // would then pick whichever row Postgres surfaced last, non-deterministic
  // across tenants. Found by tests/tenant-account-resolution.test.ts.

  const codes = Array.from(new Set(normalizedLines.map((l) => l.accountCode)));
  const accounts = await prisma.account.findMany({
    where: {
      tenantId,
      code: { in: codes },
      active: true,
      OR: [{ entityId: null }, { entityId: entity.id }],
    },
    select: { id: true, code: true, entityId: true, bookScope: true },
  });

  // Build code -> account map. Prefer entity-specific over shared if both exist.
  const codeToAccount = new Map<string, { id: string; bookScope: string[] }>();
  for (const a of accounts) {
    const existing = codeToAccount.get(a.code);
    if (!existing || (a.entityId !== null && existing && a.entityId === entity.id)) {
      codeToAccount.set(a.code, { id: a.id, bookScope: a.bookScope });
    }
  }

  for (const line of normalizedLines) {
    const acct = codeToAccount.get(line.accountCode);
    if (!acct) throw new UnknownAccountError(line.accountCode);
    if (acct.bookScope.length > 0 && !acct.bookScope.includes(book.code)) {
      throw new AccountBookScopeError(line.accountCode, book.code);
    }
  }

  // ---- 4. Resolve party / item codes if any -------------------------------

  const partyCodes = Array.from(
    new Set(normalizedLines.map((l) => l.partyCode).filter((c): c is string => !!c))
  );
  const partyMap = new Map<string, string>();
  if (partyCodes.length > 0) {
    // Same tenant filter as the account lookup above.
    const parties = await prisma.party.findMany({
      where: {
        tenantId,
        code: { in: partyCodes },
        OR: [{ entityId: null }, { entityId: entity.id }],
      },
      select: { id: true, code: true, entityId: true },
    });
    for (const p of parties) {
      const existing = partyMap.get(p.code);
      if (!existing || p.entityId === entity.id) partyMap.set(p.code, p.id);
    }
  }

  const itemCodes = Array.from(
    new Set(normalizedLines.map((l) => l.itemCode).filter((c): c is string => !!c))
  );
  const itemMap = new Map<string, string>();
  if (itemCodes.length > 0) {
    const items = await prisma.item.findMany({
      where: {
        tenantId,
        code: { in: itemCodes },
        OR: [{ entityId: null }, { entityId: entity.id }],
      },
      select: { id: true, code: true, entityId: true },
    });
    for (const it of items) {
      const existing = itemMap.get(it.code);
      if (!existing || it.entityId === entity.id) itemMap.set(it.code, it.id);
    }
  }

  // ---- 5. Resolve period from the document date ---------------------------

  const documentDate = input.documentDate;
  const postingDate = input.postingDate ?? documentDate;

  const period = await prisma.period.findFirst({
    where: {
      calendar: { entityId: entity.id },
      startsOn: { lte: documentDate },
      endsOn: { gte: documentDate },
    },
    select: { id: true, code: true },
  });

  // ---- 6. Check the (entity, book, period) close lock --------------------

  if (period) {
    const closed = await prisma.periodClose.findUnique({
      where: {
        entityId_bookId_periodId: {
          entityId: entity.id,
          bookId: book.id,
          periodId: period.id,
        },
      },
      select: { id: true },
    });
    if (closed) {
      throw new PeriodClosedError(entity.code, book.code, period.code);
    }
  }

  // ---- 7. Atomic write ---------------------------------------------------

  // Run the write inline if we're already inside an outer transaction;
  // otherwise open a fresh one. Either way `tx` below is a transaction
  // client, so the subsequent code is identical.
  const runWrite = async (tx: Prisma.TransactionClient) => {
    // entryNumber is sequential per (entity, book). Format: ENTITY-BOOK-NNNNN.
    // count() at portfolio scale is fine; production would use a sequence.
    const existingCount = await tx.journalEntry.count({
      where: { entityId: entity.id, bookId: book.id },
    });
    const entryNumber = `${entity.code}-${book.code}-${String(existingCount + 1).padStart(5, "0")}`;

    const entry = await tx.journalEntry.create({
      data: {
        entryNumber,
        // tenantId resolved at top of function; denormalized here for query
        // speed (every cross-tenant filter hits this column, not a JOIN).
        tenantId,
        entityId: entity.id,
        bookId: book.id,
        periodId: period?.id,
        documentDate,
        postingDate,
        memo: input.memo,
        currencyId: currencyCode,
        fxRate: fxRate.toFixed(10),
        source: input.source ?? "MANUAL",
        status: "POSTED",
        createdBy: input.createdBy,
        updatedBy: input.createdBy,
        ownerId: input.ownerUserId,
        // ownerType defaults to USER per the schema; explicit for clarity.
        ownerType: "USER",
        sourceSystem: input.sourceSystem,
        sourceRecordType: input.sourceRecordType,
        sourceRecordId: input.sourceRecordId,
        sourcePayload: (input.sourcePayload as any) ?? undefined,
        mappingVersion: input.mappingVersion,
        extensions: (input.extensions as any) ?? undefined,
        lines: {
          create: normalizedLines.map((l) => ({
            // Same tenantId on every line for query speed — JournalLine
            // queries filter by tenantId without traversing the JE FK.
            tenantId,
            lineNo: l.lineNo,
            accountId: codeToAccount.get(l.accountCode)!.id,
            partyId: l.partyCode ? partyMap.get(l.partyCode) ?? null : null,
            itemId: l.itemCode ? itemMap.get(l.itemCode) ?? null : null,
            debit: l.debit.toFixed(4),
            credit: l.credit.toFixed(4),
            transactionAmount: l.transactionAmount.toFixed(4),
            transactionCurrencyId: currencyCode,
            reportingAmount: l.reportingAmount.toFixed(4),
            reportingCurrencyId: book.reportingCurrencyId,
            description: l.description,
            extensions: (l.extensions as any) ?? undefined,
          })),
        },
      },
      select: { id: true, entryNumber: true },
    });

    return { id: entry.id, entryNumber: entry.entryNumber, bookCode: book.code };
  };

  const result = hasTransaction(prisma)
    ? await prisma.$transaction(runWrite)
    : await runWrite(prisma);

  // Fire ON_INSERT rules AFTER the transaction commits. The JE write is
  // the substrate guarantee — rule firing is post-hoc routing. A rule
  // failure must NOT roll back the entry. We only invoke when a real
  // user is on the hook (ownerUserId set) — seed/import paths skip.
  //
  // When called from inside an outer transaction (DbClient is a
  // TransactionClient), skip rule firing entirely. Rules must run AFTER
  // the outer transaction commits; the outer caller is responsible for
  // invoking fireInsertRules itself when it has a full PrismaClient.
  // This is also why the system/seed depreciation post (ownerUserId
  // null) is the typical caller for the tx path — no routing needed.
  let rulesResult: FireRulesResult | undefined;
  if (input.ownerUserId && hasTransaction(prisma)) {
    try {
      // Load the entry shape rules might match on (memo, source, etc.).
      const fullEntry = await prisma.journalEntry.findUniqueOrThrow({
        where: { id: result.id },
        select: {
          id: true,
          entryNumber: true,
          memo: true,
          source: true,
          status: true,
          documentDate: true,
          postingDate: true,
          currencyId: true,
          ownerId: true,
          ownerType: true,
          reassignmentLockedAt: true,
          createdBy: true,
          entity: { select: { code: true } },
          book: { select: { code: true } },
        },
      });
      // Total debits — derived from the lines we just wrote. Used by
      // rules that route large-amount entries to controller approval.
      const totalDebits = normalizedLines
        .reduce((acc, l) => acc.plus(l.debit), new Decimal(0))
        .toFixed(2);
      const recordForRules = {
        ...fullEntry,
        totalDebits,
        bookCode: fullEntry.book.code,
        entityCode: fullEntry.entity.code,
      };
      rulesResult = await fireInsertRules(
        prisma,
        "JournalEntry",
        result.id,
        recordForRules as unknown as Record<string, unknown>,
        input.ownerUserId
      );
    } catch (e) {
      // Non-fatal: log and continue. The JE exists; rule failure is a
      // routing issue, not a substrate write issue.
      console.error(
        `JE ${result.entryNumber} posted but ON_INSERT rules failed:`,
        e
      );
    }
  }

  return { ...result, rulesResult };
}
