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
import { postJournalEntry } from "../../accounting/post-journal";
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

export interface ImportFromNsInput {
  entityCode: string;
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

  const entity = await prisma.legalEntity.findUniqueOrThrow({
    where: { code: input.entityCode },
    select: { id: true, code: true },
  });

  const result: ImportFromNsResult = {
    customFieldsRegistered: 0,
    dimensionsCreated: 0,
    dimensionValuesCreated: 0,
    dimensionSetsCreated: 0,
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
    errors: [],
  };

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
        targetEntityType: mapNsAppliesTo(fd.appliesto),
        fieldKey: fd.internalid,
        label: fd.label,
        fieldType: mapNsFieldType(fd.fieldtype),
        validation: fd.options ? ({ enum: fd.options } as unknown as any) : undefined,
        sourceErpField: fd.internalid,
      },
      update: { label: fd.label },
    });
    result.customFieldsRegistered += 1;
  }

  // ---- 2. Dimensions + values --------------------------------------
  // Built-in: CLASS, DEPARTMENT, LOCATION. Plus each custom segment's
  // internalid (e.g. custcol_region) uppercased.

  const dimensionSetups: Array<{
    code: string;
    name: string;
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
      values: seg.values.map((v) => ({ code: v.internalid, name: v.name })),
    });
  }

  for (const dimSetup of dimensionSetups) {
    const dimensionExisted = await prisma.dimension.findUnique({
      where: { code: dimSetup.code },
      select: { id: true },
    });
    await setupDimension(prisma, { code: dimSetup.code, name: dimSetup.name });
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
        entityId: entity.id,
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
        entityId: entity.id,
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
      create: { partyId: party.id, role },
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
        entityId: entity.id,
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
    const existed = await prisma.dimensionSet.findUnique({
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

    await postJournalEntry(prisma, {
      entityCode: input.entityCode,
      bookCode,
      currencyCode: m.currencyCode,
      documentDate: m.documentDate,
      memo: m.memo,
      source,
      sourceSystem: "NETSUITE",
      sourceRecordType: "JournalEntry",
      sourceRecordId: nsJe.internalid,
      sourcePayload: m.sourcePayload as any,
      mappingVersion,
      lines: resolvedLines.map((l) => ({
        accountCode: l.accountCode,
        debit: l.debit,
        credit: l.credit,
        description: l.description,
        partyCode: l.partyCode,
        itemCode: l.itemCode,
        extensions: l.dimensionSetId ? ({ dimensionSetId: l.dimensionSetId } as any) : undefined,
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

    const je = await postJournalEntry(prisma, {
      entityCode: input.entityCode,
      bookCode,
      currencyCode: m.currencyCode,
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
      lines: resolvedLines.map((l) => ({
        accountCode: l.accountCode,
        debit: l.debit,
        credit: l.credit,
        description: l.description,
        partyCode: l.partyCode,
        itemCode: l.itemCode,
      })),
    });
    await attachDimensionSets(prisma, inv.internalid, resolvedLines);

    const openItem = await openArItem(prisma, {
      entityCode: input.entityCode,
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
    const je = await postJournalEntry(prisma, {
      entityCode: input.entityCode,
      bookCode,
      currencyCode: m.currencyCode,
      documentDate: m.documentDate,
      memo: m.memo,
      source,
      sourceSystem: "NETSUITE",
      sourceRecordType: "VendorBill",
      sourceRecordId: bill.internalid,
      sourcePayload: m.sourcePayload as any,
      mappingVersion,
      lines: resolvedLines.map((l) => ({
        accountCode: l.accountCode,
        debit: l.debit,
        credit: l.credit,
        description: l.description,
        partyCode: l.partyCode,
        itemCode: l.itemCode,
      })),
    });
    await attachDimensionSets(prisma, bill.internalid, resolvedLines);

    const openItem = await openApItem(prisma, {
      entityCode: input.entityCode,
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
    const je = await postJournalEntry(prisma, {
      entityCode: input.entityCode,
      bookCode,
      currencyCode: m.currencyCode,
      documentDate: m.documentDate,
      memo: m.memo,
      source,
      sourceSystem: "NETSUITE",
      sourceRecordType: "CustomerPayment",
      sourceRecordId: pmt.internalid,
      sourcePayload: m.sourcePayload as any,
      mappingVersion,
      lines: m.lines.map((l) => ({
        accountCode: l.accountCode,
        debit: l.debit,
        credit: l.credit,
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
    const je = await postJournalEntry(prisma, {
      entityCode: input.entityCode,
      bookCode,
      currencyCode: m.currencyCode,
      documentDate: m.documentDate,
      memo: m.memo,
      source,
      sourceSystem: "NETSUITE",
      sourceRecordType: "VendorPayment",
      sourceRecordId: pmt.internalid,
      sourcePayload: m.sourcePayload as any,
      mappingVersion,
      lines: m.lines.map((l) => ({
        accountCode: l.accountCode,
        debit: l.debit,
        credit: l.credit,
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
