// NetSuite import orchestrator.
//
// The big architectural exercise: actually populating the dimension
// engine. For each invoice/bill/JE line that carries dimension fields
// (class / department / location / custom segments), the orchestrator
// resolves them through getOrCreateDimensionSet and attaches the
// resulting set id to the JournalLine.
//
// Order of operations:
//   1. CustomFieldDefinition rows for each custom field declared
//   2. Dimensions + DimensionValues (must exist before sets reference them)
//   3. Accounts + Parties + Items
//   4. Standalone JournalEntries (may be referenced by other transactions)
//   5. Invoices → JE + AR open item
//   6. Bills → JE + AP open item
//   7. Customer + Vendor payments → JE + apply against open items
//
// Idempotent: every row checks (sourceSystem, sourceRecordType,
// sourceRecordId) before creating. Re-runs produce zero new rows.

import { PrismaClient } from "@prisma/client";
import { Decimal } from "@/lib/utils/decimal";
import { postJournalEntry } from "../../accounting/post-journal";
import { resolveFxRate } from "../../accounting/fx";
import { getDefaultTenantId } from "../../seed/default-tenant";
import {
  resolveBookResolution,
  setupBooks,
  type BookResolution,
} from "./books";
import { openArItem, applyArPayment } from "../../accounting/sub-ledgers/ar";
import { openApItem, applyApPayment } from "../../accounting/sub-ledgers/ap";
import {
  setupDimension,
  setupDimensionValue,
  getOrCreateDimensionSet,
} from "./dimensions";
import {
  mapNsAccount,
  mapNsCustomer,
  mapNsVendor,
  mapNsItem,
  mapNsInvoice,
  mapNsVendorBill,
  mapNsCustomerPayment,
  mapNsVendorPayment,
  mapNsJournalEntry,
  customSegmentCodes,
  nsAccountCode,
} from "./mappers";
import type { NsExport, NsCustomFieldDefinition } from "./types";
import {
  resolveEntityResolution,
  resolveEntityCode,
  setupSubsidiaries,
  type EntityResolution,
} from "./subsidiaries";

export interface ImportFromNsInput {
  /**
   * Single-sub backward compat. Every transaction lands in the entity
   * with this code. Equivalent to `entityResolution: { mode: "single",
   * entityCode }`.
   */
  entityCode?: string;
  /**
   * Multi-sub mode: each NS Subsidiary becomes its own LegalEntity.
   * In multi mode, accounts are imported with `entityId: null`
   * (global chart of accounts, matching NS's "accounts global to
   * the company" convention) and each transaction routes to the
   * entity derived from its `subsidiary` field.
   */
  entityResolution?: EntityResolution;
  bookCode?: string;
  /**
   * v0.8 NS Accounting Books Phase 3 — multi-book resolution.
   *
   * Single mode (default, backward compat): every transaction posts
   * to ONE ledger-core book — either `bookCode` or "US_GAAP".
   *
   * Multi mode: each NS AccountingBook maps to a ledger-core book.
   * For each transaction declared in the NS export, the JournalEntry
   * path posts ONE JE per mapped book. The other 4 NS paths
   * (Invoice/Bill/CustomerPayment/VendorPayment) still post to a
   * single "primary" book in Phase 3 — sub-ledger multi-book lands
   * in Phase 3.5+.
   *
   * `bookResolution` takes precedence over `bookCode` when both are set.
   */
  bookResolution?: BookResolution;
  export: NsExport;
  mappingVersion?: string;
  source?: "MANUAL" | "SEED" | "SYSTEM" | "AI_APPROVED" | "IMPORT";
}

export interface ImportFromNsResult {
  customFieldsRegistered: number;
  dimensionsCreated: number;
  dimensionValuesCreated: number;
  dimensionSetsCreated: number;
  /** v0.7 multi-sub: subsidiaries upserted as LegalEntities. 0 in single mode. */
  subsidiariesUpserted: number;
  accountsImported: number;
  accountsSkipped: number;
  partiesImported: number;
  partiesSkipped: number;
  itemsImported: number;
  itemsSkipped: number;
  journalEntriesImported: number;
  journalEntriesSkipped: number;
  arOpenItemsOpened: number;
  apOpenItemsOpened: number;
  paymentsApplied: number;
  /** v0.7 multi-sub: non-fatal warnings from setupSubsidiaries + per-tx routing. */
  warnings: string[];
  errors: string[];
}

// Map NS custom field type → ledger-core CustomFieldType enum.
function mapNsFieldType(
  ns: NsCustomFieldDefinition["fieldtype"]
): "STRING" | "NUMBER" | "BOOLEAN" | "DATE" | "ENUM" {
  return ns;
}

// Map NS appliesto to the targetEntityType string used by
// CustomFieldDefinition.
function mapNsAppliesTo(ns: NsCustomFieldDefinition["appliesto"]): string {
  switch (ns) {
    case "transaction":
      return "gl_entry_header";
    case "customer":
      return "party";
    case "vendor":
      return "party";
    case "item":
      return "item";
    case "account":
      return "account";
  }
}

export async function importFromNs(
  prisma: PrismaClient,
  input: ImportFromNsInput
): Promise<ImportFromNsResult> {
  const bookCode = input.bookCode ?? "US_GAAP";
  const mappingVersion = input.mappingVersion ?? "ns-v1";
  const source = input.source ?? "IMPORT";

  // v0.8 NS Books Phase 3 — resolve the book strategy. Single mode
  // (backward compat) maps everything to one bookCode. Multi mode
  // declares which ledger-core book each NS AccountingBook maps to.
  //
  // In multi mode we run setupBooks first to validate the mapping
  // and verify every ledger-core target book exists. The result map
  // (NS internalid → ledger-core book code) drives per-tx routing on
  // the JournalEntry path. Sub-ledger paths use `primaryBookCode` —
  // either the named bookCode in single mode, or the first mapped
  // book in multi mode (sub-ledger multi-book lands in Phase 3.5+).
  const bookResolution = resolveBookResolution({
    bookCode: input.bookCode,
    bookResolution: input.bookResolution,
  });
  const booksSetup = await setupBooks(prisma, {
    books: input.export.AccountingBook ?? [],
    resolution: bookResolution,
  });
  // Surface any setupBooks warnings to the caller's result.
  // (`result.warnings.push(...)` happens after `result` is initialized
  // below; defer to that point.)
  const primaryBookCode =
    bookResolution.mode === "single"
      ? bookResolution.bookCode
      : // Multi mode: pick the first mapped ledger-core book as the
        // "primary" book for sub-ledger paths. Operators get a
        // deterministic primary; multi-book sub-ledger arrives in Phase 3.5.
        (Object.values(bookResolution.bookMapping)[0] ?? bookCode);
  // The distinct list of book codes the JournalEntry path posts to.
  // In single mode this is `[primaryBookCode]`. In multi mode this is
  // every distinct target in the mapping (de-duplicated).
  const journalEntryBookCodes: string[] =
    bookResolution.mode === "single"
      ? [primaryBookCode]
      : Array.from(new Set(Object.values(bookResolution.bookMapping)));

  // FX Phase 1.5 — look up the book's reporting currency ONCE so
  // every per-tx FX rate lookup knows the target currency. Without
  // this, the importer was passing GBP-denominated debit/credit pairs
  // and they got stored as if they were USD — the v1.26 disclosure
  // banner's root cause.
  // Anchored to primaryBookCode: in multi mode without a legacy
  // bookCode input, the default "US_GAAP" may not even be a mapped
  // book. Per-book currency divergence is Phase 4's problem.
  const bookForFx = await prisma.book.findUniqueOrThrow({
    where: { code: primaryBookCode },
    select: { reportingCurrencyId: true },
  });
  const bookReportingCurrencyId = bookForFx.reportingCurrencyId;

  // Per-tx helper: look up the rate for (txCurrency → bookReporting)
  // on the transaction's documentDate, multiply line debit/credit by
  // it, and add transactionAmount = original signed (= debit - credit
  // in transaction currency) per line. Same-currency case short-
  // circuits to {fxRate: 1, lines unchanged}.
  //
  // The mapper layer already populates each transaction's
  // `currencyCode` (NS transaction.currency). When that equals the
  // book's reporting currency, the helper returns the input lines
  // unchanged — no rate lookup, no overhead, no behavior change for
  // single-currency callers (the v0.6 backward-compat path).
  async function convertLinesForFx<L extends {
    accountCode: string;
    debit?: Decimal | string;
    credit?: Decimal | string;
    description?: string;
    partyCode?: string;
    itemCode?: string;
  }>(input: {
    transactionCurrencyId: string;
    documentDate: Date;
    lines: L[];
    /**
     * v0.8 FX Phase 2 — NS-supplied transaction-time exchangerate.
     * When present (a number or a string like "1.27000"), this rate is
     * used directly. The seeded FxRate is the fallback for older NS
     * exports that omit the field. The fallback path is also what the
     * test fixtures (which don't carry exchangerate) exercise — this
     * keeps the FX wiring usable end-to-end without operators having to
     * load synthetic rates into NS first.
     */
    nsExchangeRate?: number | string;
  }): Promise<{
    fxRate: Decimal;
    /** Where the rate came from — useful for tests + audit-log telemetry. */
    fxRateSource: "ns_exchangerate" | "seeded_fx_rate" | "same_currency";
    lines: Array<L & {
      debit: Decimal;
      credit: Decimal;
      transactionAmount: Decimal;
      reportingAmount: Decimal;
    }>;
  }> {
    let fxRate: Decimal;
    let fxRateSource: "ns_exchangerate" | "seeded_fx_rate" | "same_currency";
    if (input.transactionCurrencyId === bookReportingCurrencyId) {
      fxRate = new Decimal(1);
      fxRateSource = "same_currency";
    } else if (
      input.nsExchangeRate !== undefined &&
      input.nsExchangeRate !== null &&
      String(input.nsExchangeRate).trim() !== ""
    ) {
      // Trust NS's posting-time rate. ASC 830 requires recording at
      // the rate in effect at the transaction date; that's what NS
      // recorded. The seeded FxRate is a fallback, not a check.
      fxRate = new Decimal(String(input.nsExchangeRate));
      if (fxRate.lte(0)) {
        // A zero/negative NS rate would zero out (or flip) every line
        // amount — malformed export data fails loud, never posts.
        throw new Error(
          `NS exchangerate "${String(input.nsExchangeRate)}" is not a positive rate`
        );
      }
      fxRateSource = "ns_exchangerate";
    } else {
      // CLOSE on-or-before the document date — the daily-close proxy
      // for the transaction-date spot rate. resolveFxRate throws
      // FxRateNotFoundError when unseeded (fail loud, never silently 1)
      // and inverts the opposite-direction row if needed.
      const resolved = await resolveFxRate(prisma, {
        fromCurrency: input.transactionCurrencyId,
        toCurrency: bookReportingCurrencyId,
        asOf: input.documentDate,
      });
      fxRate = resolved.rate;
      fxRateSource = "seeded_fx_rate";
    }
    return {
      fxRate,
      fxRateSource,
      lines: input.lines.map((l) => {
        // Coerce mapper-output (string | Decimal | undefined) to Decimal.
        // Mapper layer produces strings; we need Decimal for arithmetic.
        const d = l.debit instanceof Decimal
          ? l.debit
          : new Decimal(l.debit ?? "0");
        const c = l.credit instanceof Decimal
          ? l.credit
          : new Decimal(l.credit ?? "0");
        // transactionAmount = signed original (debit positive, credit
        // negative) IN TRANSACTION CURRENCY. The original line debit/
        // credit are NS-native; we preserve them in transactionAmount.
        const signedTxn = d.minus(c);
        // Scale debit/credit + reportingAmount to BOOK REPORTING currency
        // by multiplying by fxRate. debit and credit can't both be
        // non-zero on the same line (XOR enforced at DB level), so
        // multiplying both is safe — one side is always zero.
        return {
          ...l,
          debit: d.times(fxRate),
          credit: c.times(fxRate),
          transactionAmount: signedTxn,
          reportingAmount: signedTxn.times(fxRate),
        };
      }),
    };
  }

  // FX Phase 3 — ensure account 8310 (Realized FX Gain/Loss) exists
  // in the scope the importer will post to. In multi-sub mode, it
  // lives on the global chart (entityId: null) where all NS-imported
  // accounts live. In single mode, it lives on the resolved entity.
  // Idempotent: re-running is safe; the [tenantId, entityId, code]
  // unique constraint catches existing rows.
  // 8310 per main's v1.25 convention: 8300 = UNREALIZED (period-end
  // remeasurement, reversed next period), 8310 = REALIZED (settlement).
  let fxGainLossAccountCode = "8310";
  async function ensureFxGainLossAccount(
    entityIdForCreate: string | null
  ): Promise<void> {
    // Tenant-scoped lookup (CC6.1): [entityId, code] unique treats
    // NULL entityId as distinct per row, so an unscoped findFirst could
    // match another tenant's global 8310 and skip creating ours.
    const tenantId = await getDefaultTenantId(prisma);
    const existing = await prisma.account.findFirst({
      where: {
        tenantId,
        code: fxGainLossAccountCode,
        entityId: entityIdForCreate,
      },
      select: { id: true },
    });
    if (existing) return;
    await prisma.account.create({
      data: {
        tenantId,
        entityId: entityIdForCreate,
        code: fxGainLossAccountCode,
        name: "Realized FX Gain/Loss",
        type: "EXPENSE",
        normalBalance: "DEBIT",
        subtype: "FX_GAIN_LOSS_REALIZED",
        // FX gain/loss is the translation plug's OUTPUT — never
        // re-translated itself (chart override: EXCLUDED).
        translationCategory: "EXCLUDED",
        // Native account; lineage stays null even when imported NS
        // transactions reference it. FX_GAIN_LOSS is a ledger-core
        // ASC 830 mechanic, not an NS-sourced concept.
      },
    });
  }

  // v0.8 FX Phase 3 — realized FX gain/loss on AR/AP application.
  //
  // When a foreign-currency invoice is collected at a rate different
  // from the rate at which it was originally booked, ASC 830 requires
  // recognizing the rate-delta as a realized FX gain or loss. Example:
  //
  //   Invoice posts at 1.27:  AR Cr 1,270 USD (= 1,000 GBP × 1.27)
  //   Payment posts at 1.30:  Cash Dr 1,300 USD (= 1,000 GBP × 1.30)
  //
  // The Phase 1.5 wiring would post Cash Dr 1300 / AR Cr 1300 — but
  // that overstates the AR clearing because the AR balance was
  // originally only 1270. The correct entry is:
  //
  //   Cash       Dr 1,300
  //     AR       Cr 1,270 (= invoice rate × txn amount, matching booking)
  //     FX Gain  Cr    30 (= the realized FX gain)
  //
  // This helper computes the cumulative delta across all applied
  // invoices and returns adjusted lines.
  //
  // Same-currency case (no foreign-currency invoices applied) returns
  // the input lines unchanged. Single-currency callers see zero
  // behavior change.
  async function injectFxGainLossAdjustment(input: {
    /** Lines after convertLinesForFx (already in reporting currency). */
    lines: Array<{
      accountCode: string;
      debit: Decimal;
      credit: Decimal;
      transactionAmount: Decimal;
      reportingAmount: Decimal;
      description?: string;
      partyCode?: string;
    }>;
    /** Payment-time FX rate. */
    paymentFxRate: Decimal;
    /** Side: "AR" for customer payments, "AP" for vendor payments. */
    side: "AR" | "AP";
    /** Applications resolved to LOCAL ids. */
    applications: { openItemId: string; appliedAmount: Decimal | string }[];
  }): Promise<{
    lines: typeof input.lines;
    fxGainLossUsd: Decimal;
  }> {
    if (input.applications.length === 0) {
      return { lines: input.lines, fxGainLossUsd: new Decimal(0) };
    }
    // Look up each open item's original-invoice JE fxRate.
    const openItems =
      input.side === "AR"
        ? await prisma.arOpenItem.findMany({
            where: { id: { in: input.applications.map((a) => a.openItemId) } },
            select: {
              id: true,
              controlAccountCode: true,
              openedByEntry: { select: { fxRate: true } },
            },
          })
        : await prisma.apOpenItem.findMany({
            where: { id: { in: input.applications.map((a) => a.openItemId) } },
            select: {
              id: true,
              controlAccountCode: true,
              openedByEntry: { select: { fxRate: true } },
            },
          });
    if (openItems.length === 0) {
      return { lines: input.lines, fxGainLossUsd: new Decimal(0) };
    }
    const controlCode = openItems[0].controlAccountCode;
    const rateByOpenItem = new Map(
      openItems.map((o) => [o.id, new Decimal(o.openedByEntry.fxRate.toString())])
    );

    // Cumulative delta = Σ (payment rate − invoice rate) × applied txn amount
    let cumulativeDeltaUsd = new Decimal(0);
    for (const app of input.applications) {
      const invoiceRate = rateByOpenItem.get(app.openItemId);
      if (!invoiceRate) continue;
      const appliedTxn = new Decimal(app.appliedAmount.toString());
      const rateDelta = input.paymentFxRate.minus(invoiceRate);
      cumulativeDeltaUsd = cumulativeDeltaUsd.plus(rateDelta.times(appliedTxn));
    }

    if (cumulativeDeltaUsd.isZero()) {
      return { lines: input.lines, fxGainLossUsd: cumulativeDeltaUsd };
    }

    // Find the AR/AP control-account line in the JE.
    // For AR: it's the credit-side line.
    // For AP: it's the debit-side line.
    const adjustedLines = input.lines.map((l) => {
      if (l.accountCode !== controlCode) return l;
      if (input.side === "AR") {
        // Reduce AR Cr by cumulativeDeltaUsd. New AR Cr = invoice-rate × txn.
        return {
          ...l,
          credit: l.credit.minus(cumulativeDeltaUsd),
          reportingAmount: l.reportingAmount.plus(cumulativeDeltaUsd),
        };
      } else {
        // For AP, the control line is a Dr. New AP Dr = invoice-rate × txn.
        // delta = (pmt_rate - inv_rate) × txn; if delta > 0, payment rate
        // is higher (we pay MORE USD than booked); we owe more USD =
        // realized FX LOSS.
        // AP Dr was at pmt_rate; reduce by delta to get inv_rate × txn.
        return {
          ...l,
          debit: l.debit.minus(cumulativeDeltaUsd),
          reportingAmount: l.reportingAmount.minus(cumulativeDeltaUsd),
        };
      }
    });

    // Add the FX_GAIN_LOSS plug line.
    // AR + delta > 0 = gain → credit FX Gain/Loss (reduces expense, =
    //   posting against a debit-normal expense account credit-side)
    // AR + delta < 0 = loss → debit FX Gain/Loss
    // AP mirrors: AP + delta > 0 = loss → debit; AP + delta < 0 = gain → credit
    const isGainForUs =
      input.side === "AR" ? cumulativeDeltaUsd.gt(0) : cumulativeDeltaUsd.lt(0);
    const absDelta = cumulativeDeltaUsd.abs();
    adjustedLines.push({
      accountCode: fxGainLossAccountCode,
      debit: isGainForUs ? new Decimal(0) : absDelta,
      credit: isGainForUs ? absDelta : new Decimal(0),
      // Transaction-amount on the FX line is zero — this is a
      // reporting-currency-only adjustment with no transaction-currency
      // counterpart. The XOR constraint on debit/credit is still
      // satisfied (one side is the delta, the other 0).
      transactionAmount: new Decimal(0),
      // reportingAmount uses the same sign convention as transactionAmount
      // (positive = debit, negative = credit).
      reportingAmount: isGainForUs ? absDelta.negated() : absDelta,
      description: `Realized FX ${isGainForUs ? "gain" : "loss"} on ${input.side} settlement`,
    });

    return { lines: adjustedLines, fxGainLossUsd: cumulativeDeltaUsd };
  }

  // v0.7 — resolve entity strategy. Single mode keeps the v0.6 behavior;
  // multi mode runs setupSubsidiaries first and routes each transaction
  // to its NS-declared subsidiary.
  const resolution = resolveEntityResolution({
    entityCode: input.entityCode,
    entityResolution: input.entityResolution,
  });

  // The "primary entity" for things that aren't transaction-scoped:
  //   - In single mode → the one entity the caller named.
  //   - In multi mode → the entity that owns CustomFieldDefinitions +
  //     Dimensions + DimensionValues (these are tenant-wide via the
  //     existing schema, but we still need an entityCode for the
  //     legacy lookup paths that haven't been rewritten yet).
  // We resolve it after subsidiary upserts in multi mode.

  // The "primary entity" for things that aren't transaction-scoped:
  //   - In single mode → the one entity the caller named.
  //   - In multi mode → the entity that owns CustomFieldDefinitions +
  //     Dimensions + DimensionValues (these are tenant-wide via the
  //     existing schema, but we still need an entityCode for the
  //     legacy lookup paths that haven't been rewritten yet).
  // We resolve it after subsidiary upserts in multi mode.

  const result: ImportFromNsResult = {
    customFieldsRegistered: 0,
    dimensionsCreated: 0,
    dimensionValuesCreated: 0,
    dimensionSetsCreated: 0,
    subsidiariesUpserted: 0,
    accountsImported: 0,
    accountsSkipped: 0,
    partiesImported: 0,
    partiesSkipped: 0,
    itemsImported: 0,
    itemsSkipped: 0,
    journalEntriesImported: 0,
    journalEntriesSkipped: 0,
    arOpenItemsOpened: 0,
    apOpenItemsOpened: 0,
    paymentsApplied: 0,
    warnings: [],
    errors: [],
  };

  // setupBooks ran before `result` existed; surface its warnings now
  // (e.g. single-book mode flattening a multi-book NS export).
  result.warnings.push(...booksSetup.warnings);

  // Multi mode: upsert subsidiaries → LegalEntity hierarchy BEFORE any
  // other work (accounts/transactions reference these entities).
  let subsidiaryEntityCodeByInternalid: Map<string, string> | null = null;
  if (resolution.mode === "multi") {
    const subs = input.export.Subsidiary ?? [];
    if (subs.length === 0) {
      throw new Error(
        "Multi-sub mode requires the NS export to include a Subsidiary array. " +
          "The fixture or upstream export is malformed."
      );
    }
    const subResult = await setupSubsidiaries(prisma, {
      subsidiaries: subs,
      resolution,
    });
    result.subsidiariesUpserted = subResult.subsidiariesUpserted;
    result.warnings.push(...subResult.warnings);
    // Build internalid → entityCode (the code, not id — postJournalEntry
    // and openArItem both take code).
    subsidiaryEntityCodeByInternalid = new Map(
      subs.map((s) => [s.internalid, resolveEntityCode(s.internalid, resolution)])
    );
  }

  // Resolve the "primary entity" used for:
  //   - Account creation in SINGLE mode (entityId = primary.id).
  //     In MULTI mode, accounts are created with entityId = null (global
  //     chart) per Phase 3 chart-of-accounts decision; the schema's
  //     `Account.entityId String?` already documents this as "shared
  //     across all entities (consolidated chart)".
  //   - Lookup-by-code paths for CustomFieldDefinitions + Dimensions
  //     which are tenant-scoped (the entity arg is vestigial there).
  // In multi mode the primary is the FIRST subsidiary in input order —
  // typically the parent in a well-formed NS export.
  const primaryEntityCode =
    resolution.mode === "single"
      ? resolution.entityCode
      : resolveEntityCode(
          (input.export.Subsidiary ?? [])[0]!.internalid,
          resolution
        );
  const entity = await prisma.legalEntity.findFirstOrThrow({
    where: { code: primaryEntityCode },
    select: { id: true, code: true, tenantId: true },
  });

  // Per-transaction entity-code resolver. In single mode, every
  // transaction lands in the named entity. In multi mode, look up the
  // entity from the transaction's `subsidiary` field via the map built
  // above.
  const resolveEntityCodeForTransaction = (
    nsSubsidiaryInternalid: string | undefined,
    txKind: string,
    txId: string
  ): string => {
    if (resolution.mode === "single") return resolution.entityCode;
    if (!nsSubsidiaryInternalid) {
      throw new Error(
        `Multi-sub mode requires every transaction to have a 'subsidiary' field; ` +
          `${txKind} ${txId} has none.`
      );
    }
    const code = subsidiaryEntityCodeByInternalid!.get(nsSubsidiaryInternalid);
    if (!code) {
      throw new Error(
        `Multi-sub mode: ${txKind} ${txId} references subsidiary "${nsSubsidiaryInternalid}" ` +
          `which is not in the export's Subsidiary array.`
      );
    }
    return code;
  };

  // In multi mode, accounts go on the global chart (entityId: null).
  // In single mode, accounts stay on the named entity (legacy).
  const accountEntityIdForCreate: string | null =
    resolution.mode === "multi" ? null : entity.id;

  // FX Phase 3 — ensure account 8310 exists in the scope the
  // importer posts to. Idempotent. Called even when no foreign-currency
  // payments are imported (cheap; an extra row on first import is OK,
  // and it means the FX gain/loss line can ALWAYS post if needed).
  await ensureFxGainLossAccount(accountEntityIdForCreate);

  // ---- 1. Custom field definitions ---------------------------------

  for (const fd of input.export.CustomFieldDefinition ?? []) {
    await prisma.customFieldDefinition.upsert({
      where: {
        targetEntityType_fieldKey: {
          targetEntityType: mapNsAppliesTo(fd.appliesto),
          fieldKey: fd.internalid,
        },
      },
      create: {
        tenantId: entity.tenantId,
        targetEntityType: mapNsAppliesTo(fd.appliesto),
        fieldKey: fd.internalid,
        label: fd.label,
        fieldType: mapNsFieldType(fd.fieldtype),
        validation: fd.options ? ({ enum: fd.options } as unknown as any) : undefined,
        sourceErpField: fd.internalid,
      },
      update: { tenantId: entity.tenantId, label: fd.label },
    });
    result.customFieldsRegistered += 1;
  }

  // ---- 2. Dimensions + values --------------------------------------
  // Built-in: CLASS, DEPARTMENT, LOCATION. Plus each custom segment's
  // internalid (e.g. custcol_region) uppercased.

  const dimensionSetups: Array<{
    code: string;
    name: string;
    description?: string;
    values: { code: string; name: string }[];
  }> = [];

  if (input.export.Class?.length) {
    dimensionSetups.push({
      code: "CLASS",
      name: "Class",
      values: input.export.Class.map((c) => ({ code: c.internalid, name: c.name })),
    });
  }
  if (input.export.Department?.length) {
    dimensionSetups.push({
      code: "DEPARTMENT",
      name: "Department",
      values: input.export.Department.map((d) => ({ code: d.internalid, name: d.name })),
    });
  }
  if (input.export.Location?.length) {
    dimensionSetups.push({
      code: "LOCATION",
      name: "Location",
      values: input.export.Location.map((l) => ({ code: l.internalid, name: l.name })),
    });
  }
  for (const seg of input.export.CustomSegment ?? []) {
    dimensionSetups.push({
      code: seg.internalid.toUpperCase(),
      name: seg.name,
      description: seg.description,
      values: seg.values.map((v) => ({ code: v.internalid, name: v.name })),
    });
  }

  for (const dimSetup of dimensionSetups) {
    // Phase 4b: dimension.code unique per [tenantId, code]; use findFirst.
    const dimensionExisted = await prisma.dimension.findFirst({
      where: { code: dimSetup.code },
      select: { id: true },
    });
    await setupDimension(prisma, {
      code: dimSetup.code,
      name: dimSetup.name,
      description: dimSetup.description,
    });
    if (!dimensionExisted) result.dimensionsCreated += 1;
    for (const v of dimSetup.values) {
      const valueExisted = await prisma.dimensionValue.findFirst({
        where: { dimension: { code: dimSetup.code }, code: v.code },
        select: { id: true },
      });
      await setupDimensionValue(prisma, {
        dimensionCode: dimSetup.code,
        code: v.code,
        name: v.name,
      });
      if (!valueExisted) result.dimensionValuesCreated += 1;
    }
  }

  // ---- 3. Accounts ------------------------------------------------

  for (const nsAcct of input.export.Account ?? []) {
    const m = mapNsAccount(nsAcct, mappingVersion);
    const existing = await prisma.account.findFirst({
      where: {
        sourceSystem: "NETSUITE",
        sourceRecordType: "Account",
        sourceRecordId: m.sourceRecordId,
      },
      select: { id: true },
    });
    if (existing) {
      result.accountsSkipped += 1;
      continue;
    }
    // ADOPT before create: a row may already occupy (entityId, code)
    // WITHOUT a lineage triple — e.g. a neutralized residue row from a
    // test cleanup, or a hand-created account that predates the import.
    // Same code on the same scope IS the same account; re-attach the
    // lineage instead of failing the (entityId, code) unique.
    const adoptable = await prisma.account.findFirst({
      where: {
        tenantId: entity.tenantId,
        entityId: accountEntityIdForCreate,
        code: m.code,
        sourceSystem: null,
      },
      select: { id: true },
    });
    if (adoptable) {
      await prisma.account.update({
        where: { id: adoptable.id },
        data: {
          sourceSystem: "NETSUITE",
          sourceRecordType: "Account",
          sourceRecordId: m.sourceRecordId,
          sourcePayload: m.sourcePayload as unknown as object,
          mappingVersion,
        },
      });
      // Adopted = newly NS-attached, so it counts as imported (skipped
      // is reserved for rows whose lineage already matched).
      result.accountsImported += 1;
      continue;
    }
    await prisma.account.create({
      data: {
        tenantId: entity.tenantId,
        entityId: accountEntityIdForCreate,
        code: m.code,
        name: m.name,
        type: m.type,
        normalBalance: m.normalBalance,
        isContra: m.isContra,
        isControlAccount: m.isControlAccount,
        isBank: m.isBank,
        active: m.active,
        sourceSystem: m.sourceSystem,
        sourceRecordType: m.sourceRecordType,
        sourceRecordId: m.sourceRecordId,
        sourcePayload: m.sourcePayload as unknown as any,
        mappingVersion: m.mappingVersion,
      },
    });
    result.accountsImported += 1;
  }

  // ---- 4. Parties (Customers + Vendors) ---------------------------

  async function createPartyWithRole(
    code: string,
    displayName: string,
    customFields: Record<string, unknown>,
    role: "CUSTOMER" | "VENDOR",
    sourceRecordType: string,
    sourceRecordId: string,
    sourcePayload: unknown
  ): Promise<boolean> {
    const existing = await prisma.party.findFirst({
      where: {
        sourceSystem: "NETSUITE",
        sourceRecordType,
        sourceRecordId,
      },
      select: { id: true },
    });
    if (existing) return false;

    const party = await prisma.party.create({
      data: {
        tenantId: entity.tenantId,
        entityId: accountEntityIdForCreate,
        code,
        displayName,
        extensions:
          Object.keys(customFields).length > 0
            ? (customFields as unknown as any)
            : undefined,
        sourceSystem: "NETSUITE",
        sourceRecordType,
        sourceRecordId,
        sourcePayload: sourcePayload as unknown as any,
        mappingVersion,
      },
    });
    await prisma.partyRole.upsert({
      where: { partyId_role: { partyId: party.id, role } },
      create: { tenantId: entity.tenantId, partyId: party.id, role },
      update: {},
    });
    return true;
  }

  for (const c of input.export.Customer ?? []) {
    const m = mapNsCustomer(c, mappingVersion);
    const created = await createPartyWithRole(
      m.code,
      m.displayName,
      m.customFields,
      "CUSTOMER",
      "Customer",
      m.sourceRecordId,
      m.sourcePayload
    );
    if (created) result.partiesImported += 1;
    else result.partiesSkipped += 1;
  }
  for (const v of input.export.Vendor ?? []) {
    const m = mapNsVendor(v, mappingVersion);
    const created = await createPartyWithRole(
      m.code,
      m.displayName,
      m.customFields,
      "VENDOR",
      "Vendor",
      m.sourceRecordId,
      m.sourcePayload
    );
    if (created) result.partiesImported += 1;
    else result.partiesSkipped += 1;
  }

  // ---- 5. Items ---------------------------------------------------

  for (const it of input.export.Item ?? []) {
    const m = mapNsItem(it, mappingVersion);
    const existing = await prisma.item.findFirst({
      where: {
        sourceSystem: "NETSUITE",
        sourceRecordType: "Item",
        sourceRecordId: m.sourceRecordId,
      },
      select: { id: true },
    });
    if (existing) {
      result.itemsSkipped += 1;
      continue;
    }
    await prisma.item.create({
      data: {
        tenantId: entity.tenantId,
        entityId: accountEntityIdForCreate,
        code: m.code,
        name: m.name,
        itemType: m.itemType,
        defaultIncomeAccountCode: m.defaultIncomeAccountCode,
        defaultExpenseAccountCode: m.defaultExpenseAccountCode,
        sourceSystem: "NETSUITE",
        sourceRecordType: "Item",
        sourceRecordId: m.sourceRecordId,
        sourcePayload: m.sourcePayload as unknown as any,
        mappingVersion,
      },
    });
    result.itemsImported += 1;
  }

  // Resolve the import's tenant once for the lineage dedupe checks
  // (CC6.1): an unscoped triple lookup would let one tenant's imported
  // record block another tenant importing the same NS internalid.
  const importTenantId = await getDefaultTenantId(prisma);

  // Helper: which ledger-core books already carry a JE with this
  // lineage? Tenant-scoped and per-book so a partially-completed
  // multi-book import resumes the missing books on re-run instead of
  // skipping the whole record.
  async function importedBookCodes(
    sourceRecordType: string,
    sourceRecordId: string
  ): Promise<Set<string>> {
    const existing = await prisma.journalEntry.findMany({
      where: {
        tenantId: importTenantId,
        sourceSystem: "NETSUITE",
        sourceRecordType,
        sourceRecordId,
      },
      select: { book: { select: { code: true } } },
    });
    return new Set(existing.map((e) => e.book.code));
  }


  // Track set creation count by trying to find before each
  // getOrCreateDimensionSet call. We're not in a hot loop so the extra
  // lookup is fine for the counters.
  async function resolveDimSet(
    assignments: { dimensionCode: string; valueCode: string }[]
  ): Promise<string | undefined> {
    if (assignments.length === 0) return undefined;
    const hash = assignments
      .slice()
      .sort((a, b) => a.dimensionCode.localeCompare(b.dimensionCode))
      .map((a) => `${a.dimensionCode}:${a.valueCode}`)
      .join("|");
    // Phase 4b: dimension_set.hash unique per [tenantId, hash]; findFirst.
    const existed = await prisma.dimensionSet.findFirst({
      where: { hash },
      select: { id: true },
    });
    const setId = await getOrCreateDimensionSet(prisma, assignments);
    if (!existed) result.dimensionSetsCreated += 1;
    return setId;
  }

  const segCodes = customSegmentCodes(input.export.CustomSegment);

  // ---- 6. Standalone Journal Entries ------------------------------

  for (const nsJe of input.export.JournalEntry ?? []) {
    // Per-book dedupe: post only to books that don't carry this
    // lineage yet, so a crashed multi-book import completes on re-run.
    const existingJeBooks = await importedBookCodes(
      "JournalEntry",
      nsJe.internalid
    );
    const missingBookCodes = journalEntryBookCodes.filter(
      (b) => !existingJeBooks.has(b)
    );
    if (missingBookCodes.length === 0) {
      result.journalEntriesSkipped += 1;
      continue;
    }
    const m = mapNsJournalEntry(nsJe, segCodes, mappingVersion);
    // Resolve dimension-set ids per line up front.
    const resolvedLines = await Promise.all(
      m.lines.map(async (l) => {
        const dimensionSetId = await resolveDimSet(l.dimensionAssignments);
        return { ...l, dimensionSetId };
      })
    );

    const { fxRate, lines: fxLines } = await convertLinesForFx({
      transactionCurrencyId: m.currencyCode,
      documentDate: m.documentDate,
      lines: resolvedLines,
      nsExchangeRate: nsJe.exchangerate,
    });

    // v0.8 NS Books Phase 3 — post the JE to every book in the
    // resolution. Single mode: one iteration with the named book.
    // Multi mode: one iteration per distinct mapped ledger-core book.
    // Each iteration uses the same lineage triple — the Phase 2
    // (tenantId, bookId) scope on the lineage unique index lets the
    // per-book posts coexist.
    for (const perBookCode of missingBookCodes) {
      await postJournalEntry(prisma, {
        entityCode: resolveEntityCodeForTransaction(nsJe.subsidiary, "JournalEntry", nsJe.internalid),
        bookCode: perBookCode,
        currencyCode: m.currencyCode,
        fxRate,
        documentDate: m.documentDate,
        memo: m.memo,
        source,
        sourceSystem: "NETSUITE",
        sourceRecordType: "JournalEntry",
        sourceRecordId: nsJe.internalid,
        sourcePayload: m.sourcePayload as any,
        mappingVersion,
        lines: fxLines.map((l, idx) => ({
          accountCode: l.accountCode,
          debit: l.debit,
          credit: l.credit,
          transactionAmount: l.transactionAmount,
          reportingAmount: l.reportingAmount,
          description: l.description,
          partyCode: l.partyCode,
          itemCode: l.itemCode,
          extensions: resolvedLines[idx].dimensionSetId
            ? ({ dimensionSetId: resolvedLines[idx].dimensionSetId } as any)
            : undefined,
        })),
      });
      result.journalEntriesImported += 1;
    }

    // Attach dimensionSetId to the line rows post-creation. Same as
    // before — this hits ALL JE rows for this sourceRecordId regardless
    // of book, so it's a single call that covers every per-book post.
    await attachDimensionSets(prisma, nsJe.internalid, resolvedLines);
  }

  // ---- 7. Invoices → JE + AR open item ---------------------------
  //
  // v0.9 Phase 3.5.B — per-book sub-ledger loop. One JE + one AR open
  // item per mapped book (mirrors the JE-only loop from Phase 3, and
  // depends on the ar_open_item_lineage_uniq index added in Phase
  // 3.5.A). The shared lineage triple with distinct (entity, book)
  // scope makes per-book rows unique under the index.
  //
  // arOpenByNsInvoiceId becomes a nested map: NS Invoice ID → bookCode
  // → AR OpenItem ID. The payment path below looks up per-book.

  const arOpenByNsInvoiceId = new Map<string, Map<string, string>>();
  for (const inv of input.export.Invoice ?? []) {
    // Per-book resume (same treatment the JE path got in Phase 3):
    // post only to books missing this lineage, so a partially-failed
    // prior import completes on re-run instead of skipping or
    // colliding with the 3.5.A lineage uniq.
    const existingInvBooks = await importedBookCodes(
      "Invoice",
      inv.internalid
    );
    const missingInvBooks = journalEntryBookCodes.filter(
      (b) => !existingInvBooks.has(b)
    );
    // Rebuild the per-book OpenItem map from existing rows in either
    // case — the payment path's per-book lookup needs ALL books.
    const seededArMap = new Map<string, string>();
    if (existingInvBooks.size > 0) {
      const existing = await prisma.arOpenItem.findMany({
        where: {
          sourceSystem: "NETSUITE",
          sourceRecordType: "Invoice",
          sourceRecordId: inv.internalid,
        },
        select: { id: true, book: { select: { code: true } } },
      });
      for (const e of existing) seededArMap.set(e.book.code, e.id);
    }
    if (missingInvBooks.length === 0) {
      result.journalEntriesSkipped += 1;
      if (seededArMap.size > 0) {
        arOpenByNsInvoiceId.set(inv.internalid, seededArMap);
      }
      continue;
    }
    const { entry: m, arOpening } = mapNsInvoice(inv, segCodes, mappingVersion);
    const resolvedLines = await Promise.all(
      m.lines.map(async (l) => {
        const dimensionSetId = await resolveDimSet(l.dimensionAssignments);
        return { ...l, dimensionSetId };
      })
    );

    const { fxRate: invFxRate, lines: invFxLines } = await convertLinesForFx({
      transactionCurrencyId: m.currencyCode,
      documentDate: m.documentDate,
      lines: resolvedLines,
      nsExchangeRate: inv.exchangerate,
    });

    const invEntityCode = resolveEntityCodeForTransaction(
      inv.subsidiary,
      "Invoice",
      inv.internalid
    );
    const bookMap = seededArMap;
    for (const perBookCode of missingInvBooks) {
      const je = await postJournalEntry(prisma, {
        entityCode: invEntityCode,
        bookCode: perBookCode,
        currencyCode: m.currencyCode,
        fxRate: invFxRate,
        documentDate: m.documentDate,
        memo: m.memo,
        source,
        sourceSystem: "NETSUITE",
        sourceRecordType: "Invoice",
        sourceRecordId: inv.internalid,
        sourcePayload: m.sourcePayload as any,
        mappingVersion,
        extensions:
          Object.keys(m.customFields).length > 0 ? (m.customFields as any) : undefined,
        lines: invFxLines.map((l) => ({
          accountCode: l.accountCode,
          debit: l.debit,
          credit: l.credit,
          transactionAmount: l.transactionAmount,
          reportingAmount: l.reportingAmount,
          description: l.description,
          partyCode: l.partyCode,
          itemCode: l.itemCode,
        })),
      });

      const openItem = await openArItem(prisma, {
        entityCode: invEntityCode,
        bookCode: perBookCode,
        partyCode: arOpening.customerCode,
        openedByEntryId: je.id,
        referenceNumber: arOpening.referenceNumber,
        openedDate: arOpening.openedDate,
        dueDate: arOpening.dueDate ?? undefined,
        amount: arOpening.amount,
        currencyCode: arOpening.currencyCode,
        controlAccountCode: arOpening.controlAccountCode,
        sourceSystem: "NETSUITE",
        sourceRecordType: arOpening.sourceRecordType,
        sourceRecordId: arOpening.sourceRecordId,
        sourcePayload: arOpening.sourcePayload as any,
      });
      bookMap.set(perBookCode, openItem.id);
      result.journalEntriesImported += 1;
      result.arOpenItemsOpened += 1;
    }
    arOpenByNsInvoiceId.set(inv.internalid, bookMap);
    // attachDimensionSets is called once outside the loop — it attaches
    // dimensions to a single JE matched by source ID. Under multi-book
    // this finds one of N (a pre-existing Phase 3 limitation; not
    // addressed here).
    await attachDimensionSets(prisma, inv.internalid, resolvedLines);
  }

  // ---- 8. Vendor Bills → JE + AP open item ----------------------

  // v0.9 Phase 3.5.B — VendorBill per-book sub-ledger loop. Mirror of
  // the Invoice path. AP OpenItem ID lookup is per (NS Bill ID, book).
  const apOpenByNsBillId = new Map<string, Map<string, string>>();
  for (const bill of input.export.VendorBill ?? []) {
    const existingBillBooks = await importedBookCodes(
      "VendorBill",
      bill.internalid
    );
    const missingBillBooks = journalEntryBookCodes.filter(
      (b) => !existingBillBooks.has(b)
    );
    const seededApMap = new Map<string, string>();
    if (existingBillBooks.size > 0) {
      const existing = await prisma.apOpenItem.findMany({
        where: {
          sourceSystem: "NETSUITE",
          sourceRecordType: "VendorBill",
          sourceRecordId: bill.internalid,
        },
        select: { id: true, book: { select: { code: true } } },
      });
      for (const e of existing) seededApMap.set(e.book.code, e.id);
    }
    if (missingBillBooks.length === 0) {
      result.journalEntriesSkipped += 1;
      if (seededApMap.size > 0) {
        apOpenByNsBillId.set(bill.internalid, seededApMap);
      }
      continue;
    }
    const { entry: m, apOpening } = mapNsVendorBill(bill, segCodes, mappingVersion);
    const resolvedLines = await Promise.all(
      m.lines.map(async (l) => {
        const dimensionSetId = await resolveDimSet(l.dimensionAssignments);
        return { ...l, dimensionSetId };
      })
    );
    const { fxRate: billFxRate, lines: billFxLines } = await convertLinesForFx({
      transactionCurrencyId: m.currencyCode,
      documentDate: m.documentDate,
      lines: resolvedLines,
      nsExchangeRate: bill.exchangerate,
    });

    const billEntityCode = resolveEntityCodeForTransaction(
      bill.subsidiary,
      "VendorBill",
      bill.internalid
    );
    const bookMap = seededApMap;
    for (const perBookCode of missingBillBooks) {
      const je = await postJournalEntry(prisma, {
        entityCode: billEntityCode,
        bookCode: perBookCode,
        currencyCode: m.currencyCode,
        fxRate: billFxRate,
        documentDate: m.documentDate,
        memo: m.memo,
        source,
        sourceSystem: "NETSUITE",
        sourceRecordType: "VendorBill",
        sourceRecordId: bill.internalid,
        sourcePayload: m.sourcePayload as any,
        mappingVersion,
        lines: billFxLines.map((l) => ({
          accountCode: l.accountCode,
          debit: l.debit,
          credit: l.credit,
          transactionAmount: l.transactionAmount,
          reportingAmount: l.reportingAmount,
          description: l.description,
          partyCode: l.partyCode,
          itemCode: l.itemCode,
        })),
      });

      const openItem = await openApItem(prisma, {
        entityCode: billEntityCode,
        bookCode: perBookCode,
        partyCode: apOpening.vendorCode,
        openedByEntryId: je.id,
        referenceNumber: apOpening.referenceNumber,
        openedDate: apOpening.openedDate,
        dueDate: apOpening.dueDate ?? undefined,
        amount: apOpening.amount,
        currencyCode: apOpening.currencyCode,
        controlAccountCode: apOpening.controlAccountCode,
        sourceSystem: "NETSUITE",
        sourceRecordType: apOpening.sourceRecordType,
        sourceRecordId: apOpening.sourceRecordId,
        sourcePayload: apOpening.sourcePayload as any,
      });
      bookMap.set(perBookCode, openItem.id);
      result.journalEntriesImported += 1;
      result.apOpenItemsOpened += 1;
    }
    apOpenByNsBillId.set(bill.internalid, bookMap);
    await attachDimensionSets(prisma, bill.internalid, resolvedLines);
  }

  // ---- 9. Customer Payments + Vendor Payments → applications ----

  // v0.9 Phase 3.5.B — CustomerPayment per-book sub-ledger loop. Each
  // iteration: resolve THIS book's invoice open items, run per-book FX
  // gain/loss adjustment, post a payment JE, apply to this book's
  // open items. Per-book FX is correct: each book's invoice JE has its
  // own fxRate, so the helper picks up the right historical rate.
  for (const pmt of input.export.CustomerPayment ?? []) {
    const existingCpBooks = await importedBookCodes(
      "CustomerPayment",
      pmt.internalid
    );
    const missingCpBooks = journalEntryBookCodes.filter(
      (b) => !existingCpBooks.has(b)
    );
    if (missingCpBooks.length === 0) {
      result.journalEntriesSkipped += 1;
      continue;
    }
    const { entry: m, application } = mapNsCustomerPayment(pmt, mappingVersion);
    const { fxRate: pmtFxRate, lines: pmtFxLines } = await convertLinesForFx({
      transactionCurrencyId: m.currencyCode,
      documentDate: m.documentDate,
      lines: m.lines,
      nsExchangeRate: pmt.exchangerate,
    });

    const pmtEntityCode = resolveEntityCodeForTransaction(
      pmt.subsidiary,
      "CustomerPayment",
      pmt.internalid
    );
    for (const perBookCode of missingCpBooks) {
      // Per-book resolved applications: look up THIS book's open
      // items. Under multi-book, the same NS Invoice has N AR
      // OpenItem rows; each book's payment applies to its own row.
      const resolvedApplications = application.applications
        .map((app) => ({
          openItemId: arOpenByNsInvoiceId.get(app.linkedInvoiceId)?.get(perBookCode),
          appliedAmount: app.amount,
        }))
        .filter(
          (a): a is { openItemId: string; appliedAmount: typeof a.appliedAmount } =>
            a.openItemId !== undefined
        );
      const { lines: pmtAdjustedLines, fxGainLossUsd: pmtFxGainLossUsd } =
        await injectFxGainLossAdjustment({
          lines: pmtFxLines,
          paymentFxRate: pmtFxRate,
          side: "AR",
          applications: resolvedApplications,
        });
      if (!pmtFxGainLossUsd.isZero()) {
        result.warnings.push(
          `CustomerPayment ${pmt.internalid} [${perBookCode}]: realized FX ${
            pmtFxGainLossUsd.gt(0) ? "gain" : "loss"
          } of ${pmtFxGainLossUsd.abs().toFixed(4)} USD posted to account ${fxGainLossAccountCode}.`
        );
      }

      const je = await postJournalEntry(prisma, {
        entityCode: pmtEntityCode,
        bookCode: perBookCode,
        currencyCode: m.currencyCode,
        fxRate: pmtFxRate,
        documentDate: m.documentDate,
        memo: m.memo,
        source,
        sourceSystem: "NETSUITE",
        sourceRecordType: "CustomerPayment",
        sourceRecordId: pmt.internalid,
        sourcePayload: m.sourcePayload as any,
        mappingVersion,
        lines: pmtAdjustedLines.map((l) => ({
          accountCode: l.accountCode,
          debit: l.debit,
          credit: l.credit,
          transactionAmount: l.transactionAmount,
          reportingAmount: l.reportingAmount,
          description: l.description,
          partyCode: l.partyCode,
        })),
      });
      for (const app of application.applications) {
        const openItemId = arOpenByNsInvoiceId.get(app.linkedInvoiceId)?.get(perBookCode);
        if (!openItemId) {
          result.errors.push(
            `CustomerPayment ${pmt.internalid} [${perBookCode}] references unknown invoice ${app.linkedInvoiceId}`
          );
          continue;
        }
        await applyArPayment(prisma, {
          openItemId,
          appliedByEntryId: je.id,
          appliedAmount: app.amount,
          appliedDate: application.appliedDate,
        });
        result.paymentsApplied += 1;
      }
      result.journalEntriesImported += 1;
    }
  }

  // v0.9 Phase 3.5.B — VendorPayment per-book sub-ledger loop. Mirror
  // of the CustomerPayment path. side: "AP" tells injectFxGainLossAdjustment
  // to adjust the DEBIT side (the AP control line) instead of the credit
  // side, since AP open items get DEBITED when bills are paid.
  for (const pmt of input.export.VendorPayment ?? []) {
    const existingVpBooks = await importedBookCodes(
      "VendorPayment",
      pmt.internalid
    );
    const missingVpBooks = journalEntryBookCodes.filter(
      (b) => !existingVpBooks.has(b)
    );
    if (missingVpBooks.length === 0) {
      result.journalEntriesSkipped += 1;
      continue;
    }
    const { entry: m, application } = mapNsVendorPayment(pmt, mappingVersion);
    const { fxRate: vpFxRate, lines: vpFxLines } = await convertLinesForFx({
      transactionCurrencyId: m.currencyCode,
      documentDate: m.documentDate,
      lines: m.lines,
      nsExchangeRate: pmt.exchangerate,
    });

    const vpEntityCode = resolveEntityCodeForTransaction(
      pmt.subsidiary,
      "VendorPayment",
      pmt.internalid
    );
    for (const perBookCode of missingVpBooks) {
      const vpResolvedApplications = application.applications
        .map((app) => ({
          openItemId: apOpenByNsBillId.get(app.linkedBillId)?.get(perBookCode),
          appliedAmount: app.amount,
        }))
        .filter(
          (a): a is { openItemId: string; appliedAmount: typeof a.appliedAmount } =>
            a.openItemId !== undefined
        );
      const { lines: vpAdjustedLines, fxGainLossUsd: vpFxGainLossUsd } =
        await injectFxGainLossAdjustment({
          lines: vpFxLines,
          paymentFxRate: vpFxRate,
          side: "AP",
          applications: vpResolvedApplications,
        });
      if (!vpFxGainLossUsd.isZero()) {
        result.warnings.push(
          `VendorPayment ${pmt.internalid} [${perBookCode}]: realized FX ${
            vpFxGainLossUsd.lt(0) ? "gain" : "loss"
          } of ${vpFxGainLossUsd.abs().toFixed(4)} USD posted to account ${fxGainLossAccountCode}.`
        );
      }

      const je = await postJournalEntry(prisma, {
        entityCode: vpEntityCode,
        bookCode: perBookCode,
        currencyCode: m.currencyCode,
        fxRate: vpFxRate,
        documentDate: m.documentDate,
        memo: m.memo,
        source,
        sourceSystem: "NETSUITE",
        sourceRecordType: "VendorPayment",
        sourceRecordId: pmt.internalid,
        sourcePayload: m.sourcePayload as any,
        mappingVersion,
        lines: vpAdjustedLines.map((l) => ({
          accountCode: l.accountCode,
          debit: l.debit,
          credit: l.credit,
          transactionAmount: l.transactionAmount,
          reportingAmount: l.reportingAmount,
          description: l.description,
          partyCode: l.partyCode,
        })),
      });
      for (const app of application.applications) {
        const openItemId = apOpenByNsBillId.get(app.linkedBillId)?.get(perBookCode);
        if (!openItemId) {
          result.errors.push(
            `VendorPayment ${pmt.internalid} [${perBookCode}] references unknown bill ${app.linkedBillId}`
          );
          continue;
        }
        await applyApPayment(prisma, {
          openItemId,
          appliedByEntryId: je.id,
          appliedAmount: app.amount,
          appliedDate: application.appliedDate,
        });
        result.paymentsApplied += 1;
      }
      result.journalEntriesImported += 1;
    }
  }

  return result;
}

// Patches dimensionSetId onto each JournalLine of a freshly-posted entry,
// matched by line number. postJournalEntry doesn't accept dimensionSetId
// in its input shape yet (v0.7 enhancement); until it does, the NS
// orchestrator attaches dimension assignments here.
async function attachDimensionSets(
  prisma: PrismaClient,
  nsSourceRecordId: string,
  resolvedLines: { dimensionSetId?: string }[]
): Promise<void> {
  const entry = await prisma.journalEntry.findFirstOrThrow({
    where: { sourceSystem: "NETSUITE", sourceRecordId: nsSourceRecordId },
    select: { id: true, lines: { select: { id: true, lineNo: true }, orderBy: { lineNo: "asc" } } },
  });
  for (let i = 0; i < entry.lines.length; i++) {
    const dimSetId = resolvedLines[i]?.dimensionSetId;
    if (!dimSetId) continue;
    await prisma.journalLine.update({
      where: { id: entry.lines[i].id },
      data: { dimensionSetId: dimSetId },
    });
  }
}
