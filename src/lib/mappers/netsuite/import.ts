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
import { Decimal } from "decimal.js";
import { postJournalEntry } from "../../accounting/post-journal";
import { resolveFxRate } from "../../accounting/fx";
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

  // FX Phase 1.5 — look up the book's reporting currency ONCE so
  // every per-tx FX rate lookup knows the target currency. Without
  // this, the importer was passing GBP-denominated debit/credit pairs
  // and they got stored as if they were USD — the v1.26 disclosure
  // banner's root cause.
  const bookForFx = await prisma.book.findUniqueOrThrow({
    where: { code: bookCode },
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

  // Helper: has a journal entry with this lineage been imported?
  async function alreadyImported(
    sourceRecordType: string,
    sourceRecordId: string
  ): Promise<string | null> {
    const existing = await prisma.journalEntry.findFirst({
      where: {
        sourceSystem: "NETSUITE",
        sourceRecordType,
        sourceRecordId,
      },
      select: { id: true },
    });
    return existing?.id ?? null;
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
    if (await alreadyImported("JournalEntry", nsJe.internalid)) {
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

    await postJournalEntry(prisma, {
      entityCode: resolveEntityCodeForTransaction(nsJe.subsidiary, "JournalEntry", nsJe.internalid),
      bookCode,
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

    // Attach dimensionSetId to the line rows post-creation. The post-
    // journal API doesn't accept dimensionSetId in v0.6; we patch it on
    // each line by sourceRecordId + lineNo, immediately after posting.
    // (This is the one place where the NS mapper has to touch line rows
    // directly; a v0.7 enhancement is to add dimensionSetId support to
    // postJournalEntry input shape so this becomes unnecessary.)
    await attachDimensionSets(prisma, nsJe.internalid, resolvedLines);
  }

  // ---- 7. Invoices → JE + AR open item ---------------------------

  const arOpenByNsInvoiceId = new Map<string, string>();
  for (const inv of input.export.Invoice ?? []) {
    if (await alreadyImported("Invoice", inv.internalid)) {
      result.journalEntriesSkipped += 1;
      const existing = await prisma.arOpenItem.findFirst({
        where: {
          sourceSystem: "NETSUITE",
          sourceRecordType: "Invoice",
          sourceRecordId: inv.internalid,
        },
        select: { id: true },
      });
      if (existing) arOpenByNsInvoiceId.set(inv.internalid, existing.id);
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
    const je = await postJournalEntry(prisma, {
      entityCode: resolveEntityCodeForTransaction(inv.subsidiary, "Invoice", inv.internalid),
      bookCode,
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
    await attachDimensionSets(prisma, inv.internalid, resolvedLines);

    const openItem = await openArItem(prisma, {
      entityCode: resolveEntityCodeForTransaction(inv.subsidiary, "Invoice", inv.internalid),
      bookCode,
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
    arOpenByNsInvoiceId.set(inv.internalid, openItem.id);
    result.journalEntriesImported += 1;
    result.arOpenItemsOpened += 1;
  }

  // ---- 8. Vendor Bills → JE + AP open item ----------------------

  const apOpenByNsBillId = new Map<string, string>();
  for (const bill of input.export.VendorBill ?? []) {
    if (await alreadyImported("VendorBill", bill.internalid)) {
      result.journalEntriesSkipped += 1;
      const existing = await prisma.apOpenItem.findFirst({
        where: {
          sourceSystem: "NETSUITE",
          sourceRecordType: "VendorBill",
          sourceRecordId: bill.internalid,
        },
        select: { id: true },
      });
      if (existing) apOpenByNsBillId.set(bill.internalid, existing.id);
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
    const je = await postJournalEntry(prisma, {
      entityCode: resolveEntityCodeForTransaction(bill.subsidiary, "VendorBill", bill.internalid),
      bookCode,
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
    await attachDimensionSets(prisma, bill.internalid, resolvedLines);

    const openItem = await openApItem(prisma, {
      entityCode: resolveEntityCodeForTransaction(bill.subsidiary, "VendorBill", bill.internalid),
      bookCode,
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
    apOpenByNsBillId.set(bill.internalid, openItem.id);
    result.journalEntriesImported += 1;
    result.apOpenItemsOpened += 1;
  }

  // ---- 9. Customer Payments + Vendor Payments → applications ----

  for (const pmt of input.export.CustomerPayment ?? []) {
    if (await alreadyImported("CustomerPayment", pmt.internalid)) {
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
    const je = await postJournalEntry(prisma, {
      entityCode: resolveEntityCodeForTransaction(pmt.subsidiary, "CustomerPayment", pmt.internalid),
      bookCode,
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
      lines: pmtFxLines.map((l) => ({
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
      const openItemId = arOpenByNsInvoiceId.get(app.linkedInvoiceId);
      if (!openItemId) {
        result.errors.push(
          `CustomerPayment ${pmt.internalid} references unknown invoice ${app.linkedInvoiceId}`
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

  for (const pmt of input.export.VendorPayment ?? []) {
    if (await alreadyImported("VendorPayment", pmt.internalid)) {
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
    const je = await postJournalEntry(prisma, {
      entityCode: resolveEntityCodeForTransaction(pmt.subsidiary, "VendorPayment", pmt.internalid),
      bookCode,
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
      lines: vpFxLines.map((l) => ({
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
      const openItemId = apOpenByNsBillId.get(app.linkedBillId);
      if (!openItemId) {
        result.errors.push(
          `VendorPayment ${pmt.internalid} references unknown bill ${app.linkedBillId}`
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
