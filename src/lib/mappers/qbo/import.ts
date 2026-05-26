// QBO import orchestrator.
//
// Reads a QBO export JSON, dispatches each object to the appropriate
// mapper, and writes results to the database with full lineage. Idempotent:
// re-running the same import does not produce duplicate rows. Idempotency
// is determined by the (sourceSystem, sourceRecordType, sourceRecordId)
// tuple already existing in lineage columns.

import { PrismaClient } from "@prisma/client";
import { Decimal } from "decimal.js";
import { postJournalEntry } from "../../accounting/post-journal";
import { openArItem, applyArPayment } from "../../accounting/sub-ledgers/ar";
import { openApItem, applyApPayment } from "../../accounting/sub-ledgers/ap";
import {
  mapAccount,
  mapCustomer,
  mapVendor,
  mapInvoice,
  mapBill,
  mapPayment,
  mapBillPayment,
  mapJournalEntry,
} from "./mappers";
import type { QboExport } from "./types";

export interface ImportFromQboInput {
  entityCode: string;          // ledger-core LegalEntity to load into
  bookCode?: string;           // default "US_GAAP"
  export: QboExport;
  mappingVersion?: string;     // default "qbo-v1"
  source?: "MANUAL" | "SEED" | "SYSTEM" | "AI_APPROVED" | "IMPORT";
}

export interface ImportFromQboResult {
  accountsImported: number;
  accountsSkipped: number;
  partiesImported: number;
  partiesSkipped: number;
  journalEntriesImported: number;
  journalEntriesSkipped: number;
  arOpenItemsOpened: number;
  apOpenItemsOpened: number;
  paymentsApplied: number;
  errors: string[];
}

export async function importFromQbo(
  prisma: PrismaClient,
  input: ImportFromQboInput
): Promise<ImportFromQboResult> {
  const bookCode = input.bookCode ?? "US_GAAP";
  const mappingVersion = input.mappingVersion ?? "qbo-v1";
  const source = input.source ?? "IMPORT";

  // Phase 4b: entity code unique per [tenantId, code]; use findFirst.
  const entity = await prisma.legalEntity.findFirstOrThrow({
    where: { code: input.entityCode },
    select: { id: true, code: true, tenantId: true },
  });

  const result: ImportFromQboResult = {
    accountsImported: 0,
    accountsSkipped: 0,
    partiesImported: 0,
    partiesSkipped: 0,
    journalEntriesImported: 0,
    journalEntriesSkipped: 0,
    arOpenItemsOpened: 0,
    apOpenItemsOpened: 0,
    paymentsApplied: 0,
    errors: [],
  };

  // ---- 1. Accounts ----------------------------------------------------

  for (const qboAcct of input.export.Account ?? []) {
    const m = mapAccount(qboAcct, mappingVersion);
    const existing = await prisma.account.findFirst({
      where: {
        sourceSystem: "QBO",
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
        entityId: entity.id,
        code: m.code,
        name: m.name,
        type: m.type,
        normalBalance: m.normalBalance,
        isContra: m.isContra,
        isControlAccount: m.isControlAccount,
        isBank: m.isBank,
        subtype: m.subtype,
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

  // ---- 2. Parties (customers + vendors) ------------------------------

  for (const qboCust of input.export.Customer ?? []) {
    const m = mapCustomer(qboCust, mappingVersion);
    const existing = await prisma.party.findFirst({
      where: {
        sourceSystem: "QBO",
        sourceRecordType: "Customer",
        sourceRecordId: m.sourceRecordId,
      },
      select: { id: true },
    });
    if (existing) {
      result.partiesSkipped += 1;
      continue;
    }
    const party = await prisma.party.create({
      data: {
        tenantId: entity.tenantId,
        entityId: entity.id,
        code: m.code,
        displayName: m.displayName,
        sourceSystem: m.sourceSystem,
        sourceRecordType: m.sourceRecordType,
        sourceRecordId: m.sourceRecordId,
        sourcePayload: m.sourcePayload as unknown as any,
        mappingVersion: m.mappingVersion,
      },
    });
    await prisma.partyRole.upsert({
      where: { partyId_role: { partyId: party.id, role: "CUSTOMER" } },
      create: { tenantId: entity.tenantId, partyId: party.id, role: "CUSTOMER" },
      update: {},
    });
    result.partiesImported += 1;
  }

  for (const qboVend of input.export.Vendor ?? []) {
    const m = mapVendor(qboVend, mappingVersion);
    const existing = await prisma.party.findFirst({
      where: {
        sourceSystem: "QBO",
        sourceRecordType: "Vendor",
        sourceRecordId: m.sourceRecordId,
      },
      select: { id: true },
    });
    if (existing) {
      result.partiesSkipped += 1;
      continue;
    }
    const party = await prisma.party.create({
      data: {
        tenantId: entity.tenantId,
        entityId: entity.id,
        code: m.code,
        displayName: m.displayName,
        sourceSystem: m.sourceSystem,
        sourceRecordType: m.sourceRecordType,
        sourceRecordId: m.sourceRecordId,
        sourcePayload: m.sourcePayload as unknown as any,
        mappingVersion: m.mappingVersion,
      },
    });
    await prisma.partyRole.upsert({
      where: { partyId_role: { partyId: party.id, role: "VENDOR" } },
      create: { tenantId: entity.tenantId, partyId: party.id, role: "VENDOR" },
      update: {},
    });
    result.partiesImported += 1;
  }

  // Helper: has a journal entry with this (sourceSystem, type, id) been imported?
  async function alreadyImported(sourceRecordType: string, sourceRecordId: string): Promise<string | null> {
    const existing = await prisma.journalEntry.findFirst({
      where: {
        sourceSystem: "QBO",
        sourceRecordType,
        sourceRecordId,
      },
      select: { id: true },
    });
    return existing?.id ?? null;
  }

  // ---- 3. Standalone JEs (post first — payments/invoices might reference them) ----

  for (const qboJe of input.export.JournalEntry ?? []) {
    if (await alreadyImported("JournalEntry", qboJe.Id)) {
      result.journalEntriesSkipped += 1;
      continue;
    }
    const m = mapJournalEntry(qboJe, mappingVersion);
    await postJournalEntry(prisma, {
      entityCode: input.entityCode,
      bookCode,
      currencyCode: m.currencyCode,
      documentDate: m.documentDate,
      postingDate: m.postingDate,
      memo: m.memo,
      source,
      sourceSystem: "QBO",
      sourceRecordType: "JournalEntry",
      sourceRecordId: qboJe.Id,
      sourcePayload: m.sourcePayload as any,
      mappingVersion,
      lines: m.lines,
    });
    result.journalEntriesImported += 1;
  }

  // ---- 4. Invoices (each opens an AR open item) ---------------------

  const arOpenByQboInvoiceId = new Map<string, string>(); // QBO id → ledger-core open item id
  for (const qboInv of input.export.Invoice ?? []) {
    if (await alreadyImported("Invoice", qboInv.Id)) {
      result.journalEntriesSkipped += 1;
      // Look up the existing AR open item so payments can apply.
      const existing = await prisma.arOpenItem.findFirst({
        where: { sourceSystem: "QBO", sourceRecordType: "Invoice", sourceRecordId: qboInv.Id },
        select: { id: true },
      });
      if (existing) arOpenByQboInvoiceId.set(qboInv.Id, existing.id);
      continue;
    }
    const { entry: m, arOpening } = mapInvoice(qboInv, mappingVersion);
    const je = await postJournalEntry(prisma, {
      entityCode: input.entityCode,
      bookCode,
      currencyCode: m.currencyCode,
      documentDate: m.documentDate,
      postingDate: m.postingDate,
      memo: m.memo,
      source,
      sourceSystem: "QBO",
      sourceRecordType: "Invoice",
      sourceRecordId: qboInv.Id,
      sourcePayload: m.sourcePayload as any,
      mappingVersion,
      lines: m.lines,
    });
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
      sourceSystem: "QBO",
      sourceRecordType: arOpening.sourceRecordType,
      sourceRecordId: arOpening.sourceRecordId,
      sourcePayload: arOpening.sourcePayload as any,
    });
    arOpenByQboInvoiceId.set(qboInv.Id, openItem.id);
    result.journalEntriesImported += 1;
    result.arOpenItemsOpened += 1;
  }

  // ---- 5. Bills (each opens an AP open item) -----------------------

  const apOpenByQboBillId = new Map<string, string>();
  for (const qboBill of input.export.Bill ?? []) {
    if (await alreadyImported("Bill", qboBill.Id)) {
      result.journalEntriesSkipped += 1;
      const existing = await prisma.apOpenItem.findFirst({
        where: { sourceSystem: "QBO", sourceRecordType: "Bill", sourceRecordId: qboBill.Id },
        select: { id: true },
      });
      if (existing) apOpenByQboBillId.set(qboBill.Id, existing.id);
      continue;
    }
    const { entry: m, apOpening } = mapBill(qboBill, mappingVersion);
    const je = await postJournalEntry(prisma, {
      entityCode: input.entityCode,
      bookCode,
      currencyCode: m.currencyCode,
      documentDate: m.documentDate,
      postingDate: m.postingDate,
      memo: m.memo,
      source,
      sourceSystem: "QBO",
      sourceRecordType: "Bill",
      sourceRecordId: qboBill.Id,
      sourcePayload: m.sourcePayload as any,
      mappingVersion,
      lines: m.lines,
    });
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
      sourceSystem: "QBO",
      sourceRecordType: apOpening.sourceRecordType,
      sourceRecordId: apOpening.sourceRecordId,
      sourcePayload: apOpening.sourcePayload as any,
    });
    apOpenByQboBillId.set(qboBill.Id, openItem.id);
    result.journalEntriesImported += 1;
    result.apOpenItemsOpened += 1;
  }

  // ---- 6. Payments + BillPayments (apply against open items) ----

  for (const qboPmt of input.export.Payment ?? []) {
    if (await alreadyImported("Payment", qboPmt.Id)) {
      result.journalEntriesSkipped += 1;
      continue;
    }
    const { entry: m, application } = mapPayment(qboPmt, mappingVersion);
    const je = await postJournalEntry(prisma, {
      entityCode: input.entityCode,
      bookCode,
      currencyCode: m.currencyCode,
      documentDate: m.documentDate,
      postingDate: m.postingDate,
      memo: m.memo,
      source,
      sourceSystem: "QBO",
      sourceRecordType: "Payment",
      sourceRecordId: qboPmt.Id,
      sourcePayload: m.sourcePayload as any,
      mappingVersion,
      lines: m.lines,
    });
    // Apply against linked invoices. QBO doesn't split the payment across
    // invoices in our minimal model — first match wins.
    for (const linkedId of application.linkedInvoiceQboIds) {
      const openItemId = arOpenByQboInvoiceId.get(linkedId);
      if (!openItemId) {
        result.errors.push(`Payment ${qboPmt.Id} references unknown invoice ${linkedId}`);
        continue;
      }
      await applyArPayment(prisma, {
        openItemId,
        appliedByEntryId: je.id,
        appliedAmount: application.appliedAmount,
        appliedDate: application.appliedDate,
      });
      result.paymentsApplied += 1;
    }
    result.journalEntriesImported += 1;
  }

  for (const qboBp of input.export.BillPayment ?? []) {
    if (await alreadyImported("BillPayment", qboBp.Id)) {
      result.journalEntriesSkipped += 1;
      continue;
    }
    const { entry: m, application } = mapBillPayment(qboBp, mappingVersion);
    const je = await postJournalEntry(prisma, {
      entityCode: input.entityCode,
      bookCode,
      currencyCode: m.currencyCode,
      documentDate: m.documentDate,
      postingDate: m.postingDate,
      memo: m.memo,
      source,
      sourceSystem: "QBO",
      sourceRecordType: "BillPayment",
      sourceRecordId: qboBp.Id,
      sourcePayload: m.sourcePayload as any,
      mappingVersion,
      lines: m.lines,
    });
    for (const linkedId of application.linkedBillQboIds) {
      const openItemId = apOpenByQboBillId.get(linkedId);
      if (!openItemId) {
        result.errors.push(`BillPayment ${qboBp.Id} references unknown bill ${linkedId}`);
        continue;
      }
      await applyApPayment(prisma, {
        openItemId,
        appliedByEntryId: je.id,
        appliedAmount: application.appliedAmount,
        appliedDate: application.appliedDate,
      });
      result.paymentsApplied += 1;
    }
    result.journalEntriesImported += 1;
  }

  return result;
}
