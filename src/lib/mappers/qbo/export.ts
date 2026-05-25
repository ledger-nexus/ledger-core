// QBO export (roundtrip proof).
//
// The hard half of "validate by mapping" — per the universal-schema spec —
// is proving the import is lossless. Loss test: does ledger-core have
// enough information to reconstruct the original QBO JSON?
//
// Answer: yes, trivially. Layer 6 lineage requires every imported row to
// carry `sourcePayload` — the frozen raw original. exportToQbo reads each
// row's sourcePayload and reassembles the export structure. This is the
// roundtrip guarantee.
//
// If lineage is missing (e.g. someone bypassed importFromQbo and inserted
// rows directly), the corresponding QBO object won't reappear in the export.
// That's a feature, not a bug — the export reflects exactly what was
// imported from QBO, no more.

import { PrismaClient } from "@prisma/client";
import type {
  QboAccount,
  QboCustomer,
  QboVendor,
  QboInvoice,
  QboBill,
  QboPayment,
  QboBillPayment,
  QboJournalEntry,
  QboExport,
} from "./types";

export interface ExportToQboInput {
  entityCode: string;
  bookCode?: string;          // default "US_GAAP"
  exportedAt?: Date;
}

export async function exportToQbo(
  prisma: PrismaClient,
  input: ExportToQboInput
): Promise<QboExport> {
  const bookCode = input.bookCode ?? "US_GAAP";

  // Master data lives at entity scope — sourceSystem=QBO rows scoped to the entity.
  const accounts = await prisma.account.findMany({
    where: {
      sourceSystem: "QBO",
      sourceRecordType: "Account",
      entity: { code: input.entityCode },
    },
    select: { sourcePayload: true },
    orderBy: { sourceRecordId: "asc" },
  });

  const customers = await prisma.party.findMany({
    where: {
      sourceSystem: "QBO",
      sourceRecordType: "Customer",
      entity: { code: input.entityCode },
    },
    select: { sourcePayload: true },
    orderBy: { sourceRecordId: "asc" },
  });

  const vendors = await prisma.party.findMany({
    where: {
      sourceSystem: "QBO",
      sourceRecordType: "Vendor",
      entity: { code: input.entityCode },
    },
    select: { sourcePayload: true },
    orderBy: { sourceRecordId: "asc" },
  });

  // Transactions are per-book; export from the specified book.
  const entries = await prisma.journalEntry.findMany({
    where: {
      sourceSystem: "QBO",
      entity: { code: input.entityCode },
      book: { code: bookCode },
    },
    select: { sourceRecordType: true, sourcePayload: true },
    orderBy: [{ sourceRecordType: "asc" }, { sourceRecordId: "asc" }],
  });

  // Bucket entries by type.
  const invoices: QboInvoice[] = [];
  const bills: QboBill[] = [];
  const payments: QboPayment[] = [];
  const billPayments: QboBillPayment[] = [];
  const journalEntries: QboJournalEntry[] = [];

  for (const entry of entries) {
    if (!entry.sourcePayload) continue;
    const payload = entry.sourcePayload as unknown;
    switch (entry.sourceRecordType) {
      case "Invoice":
        invoices.push(payload as QboInvoice);
        break;
      case "Bill":
        bills.push(payload as QboBill);
        break;
      case "Payment":
        payments.push(payload as QboPayment);
        break;
      case "BillPayment":
        billPayments.push(payload as QboBillPayment);
        break;
      case "JournalEntry":
        journalEntries.push(payload as QboJournalEntry);
        break;
    }
  }

  const result: QboExport = {
    _meta: {
      sourceSystem: "QBO",
      exportedAt: (input.exportedAt ?? new Date()).toISOString(),
      comment: "Roundtrip export from ledger-core. Reconstructed from sourcePayload lineage.",
    },
    Account: accounts
      .filter((a) => a.sourcePayload)
      .map((a) => a.sourcePayload as unknown as QboAccount),
    Customer: customers
      .filter((c) => c.sourcePayload)
      .map((c) => c.sourcePayload as unknown as QboCustomer),
    Vendor: vendors
      .filter((v) => v.sourcePayload)
      .map((v) => v.sourcePayload as unknown as QboVendor),
    Invoice: invoices.length ? invoices : undefined,
    Bill: bills.length ? bills : undefined,
    Payment: payments.length ? payments : undefined,
    BillPayment: billPayments.length ? billPayments : undefined,
    JournalEntry: journalEntries.length ? journalEntries : undefined,
  };

  return result;
}

// ---- Roundtrip equivalence helpers ----

// Compare two QBO exports for equivalence. Order-insensitive on arrays.
// Returns null if equivalent, or a description of the first difference.
//
// canonical() recursively sorts object keys before serializing so that
// the same record with keys in a different declaration order compares
// equal — the roundtrip preserves SEMANTICS, not lexical key order.
export function diffQboExports(a: QboExport, b: QboExport): string | null {
  function sortById<T extends { Id: string }>(arr: T[] | undefined): T[] {
    return [...(arr ?? [])].sort((x, y) => x.Id.localeCompare(y.Id));
  }

  function canonical(value: unknown): string {
    if (value === undefined) return "undefined";
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) {
      return "[" + value.map(canonical).join(",") + "]";
    }
    const obj = value as Record<string, unknown>;
    // Drop undefined-valued keys so "absent" and "explicitly undefined"
    // canonicalize the same way (mirrors JSON.stringify's semantics).
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return (
      "{" +
      keys.map((k) => JSON.stringify(k) + ":" + canonical(obj[k])).join(",") +
      "}"
    );
  }

  for (const key of ["Account", "Customer", "Vendor", "Invoice", "Bill", "Payment", "BillPayment", "JournalEntry"] as const) {
    const aArr = sortById<any>(a[key] as any);
    const bArr = sortById<any>(b[key] as any);
    if (aArr.length !== bArr.length) {
      return `${key}: count differs (a=${aArr.length}, b=${bArr.length})`;
    }
    for (let i = 0; i < aArr.length; i++) {
      const aStr = canonical(aArr[i]);
      const bStr = canonical(bArr[i]);
      if (aStr !== bStr) {
        return `${key}[${aArr[i].Id}]: payload differs\n  a=${aStr}\n  b=${bStr}`;
      }
    }
  }
  return null;
}
