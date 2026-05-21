// NetSuite reverse exporter — same lineage-replay pattern as QBO.
//
// Reads sourcePayload from every NS-imported row and reassembles the
// NetSuite export structure. This is the roundtrip proof for the
// "expressive ceiling" mapping: even with dimensions on every line and
// custom fields on transactions, the lineage layer preserves enough to
// reconstruct the original.

import { PrismaClient } from "@prisma/client";
import type {
  NsAccount,
  NsCustomer,
  NsVendor,
  NsItem,
  NsInvoice,
  NsVendorBill,
  NsCustomerPayment,
  NsVendorPayment,
  NsJournalEntry,
  NsClassification,
  NsDepartment,
  NsLocation,
  NsCustomSegment,
  NsCustomFieldDefinition,
  NsExport,
} from "./types";

export interface ExportToNsInput {
  entityCode: string;
  bookCode?: string;
  exportedAt?: Date;
}

export async function exportToNs(
  prisma: PrismaClient,
  input: ExportToNsInput
): Promise<NsExport> {
  const bookCode = input.bookCode ?? "US_GAAP";

  const accounts = await prisma.account.findMany({
    where: {
      sourceSystem: "NETSUITE",
      sourceRecordType: "Account",
      entity: { code: input.entityCode },
    },
    select: { sourcePayload: true },
    orderBy: { sourceRecordId: "asc" },
  });
  const customers = await prisma.party.findMany({
    where: {
      sourceSystem: "NETSUITE",
      sourceRecordType: "Customer",
      entity: { code: input.entityCode },
    },
    select: { sourcePayload: true },
    orderBy: { sourceRecordId: "asc" },
  });
  const vendors = await prisma.party.findMany({
    where: {
      sourceSystem: "NETSUITE",
      sourceRecordType: "Vendor",
      entity: { code: input.entityCode },
    },
    select: { sourcePayload: true },
    orderBy: { sourceRecordId: "asc" },
  });
  const items = await prisma.item.findMany({
    where: {
      sourceSystem: "NETSUITE",
      sourceRecordType: "Item",
      entity: { code: input.entityCode },
    },
    select: { sourcePayload: true },
    orderBy: { sourceRecordId: "asc" },
  });

  const entries = await prisma.journalEntry.findMany({
    where: {
      sourceSystem: "NETSUITE",
      entity: { code: input.entityCode },
      book: { code: bookCode },
    },
    select: { sourceRecordType: true, sourcePayload: true },
    orderBy: [{ sourceRecordType: "asc" }, { sourceRecordId: "asc" }],
  });

  const invoices: NsInvoice[] = [];
  const bills: NsVendorBill[] = [];
  const customerPayments: NsCustomerPayment[] = [];
  const vendorPayments: NsVendorPayment[] = [];
  const journalEntries: NsJournalEntry[] = [];

  for (const e of entries) {
    if (!e.sourcePayload) continue;
    const p = e.sourcePayload as unknown;
    switch (e.sourceRecordType) {
      case "Invoice":
        invoices.push(p as NsInvoice);
        break;
      case "VendorBill":
        bills.push(p as NsVendorBill);
        break;
      case "CustomerPayment":
        customerPayments.push(p as NsCustomerPayment);
        break;
      case "VendorPayment":
        vendorPayments.push(p as NsVendorPayment);
        break;
      case "JournalEntry":
        journalEntries.push(p as NsJournalEntry);
        break;
    }
  }

  // Dimensions: re-derive Class / Department / Location / CustomSegment
  // from the engine tables. Names persist; original NS internalids are
  // the dimension value codes.
  const dimensionsByCode = await prisma.dimension.findMany({
    where: { code: { in: ["CLASS", "DEPARTMENT", "LOCATION"] } },
    include: { values: { orderBy: { code: "asc" } } },
  });
  const classes: NsClassification[] =
    dimensionsByCode.find((d) => d.code === "CLASS")?.values.map((v) => ({
      internalid: v.code,
      name: v.name,
      isinactive: false,
    })) ?? [];
  const departments: NsDepartment[] =
    dimensionsByCode.find((d) => d.code === "DEPARTMENT")?.values.map((v) => ({
      internalid: v.code,
      name: v.name,
      isinactive: false,
    })) ?? [];
  const locations: NsLocation[] =
    dimensionsByCode.find((d) => d.code === "LOCATION")?.values.map((v) => ({
      internalid: v.code,
      name: v.name,
      isinactive: false,
    })) ?? [];

  // Custom segments — anything not in the built-in three is custom.
  const customDimensions = await prisma.dimension.findMany({
    where: { code: { notIn: ["CLASS", "DEPARTMENT", "LOCATION"] } },
    include: { values: { orderBy: { code: "asc" } } },
  });
  const customSegments: NsCustomSegment[] = customDimensions.map((d) => ({
    internalid: d.code.toLowerCase(),
    name: d.name,
    values: d.values.map((v) => ({ internalid: v.code, name: v.name })),
  }));

  const customFieldDefs = await prisma.customFieldDefinition.findMany({
    where: { sourceErpField: { startsWith: "cust" } },
    orderBy: { fieldKey: "asc" },
  });
  const customFieldDefinitions: NsCustomFieldDefinition[] = customFieldDefs.map((f) => ({
    internalid: f.fieldKey,
    label: f.label,
    fieldtype: (f.fieldType === "JSON_VALUE" ? "STRING" : f.fieldType) as NsCustomFieldDefinition["fieldtype"],
    appliesto:
      f.targetEntityType === "party"
        ? "customer"
        : f.targetEntityType === "item"
          ? "item"
          : f.targetEntityType === "account"
            ? "account"
            : "transaction",
    options:
      (f.validation as Record<string, unknown> | null)?.enum
        ? ((f.validation as Record<string, unknown>).enum as string[])
        : undefined,
  }));

  return {
    _meta: {
      sourceSystem: "NETSUITE",
      exportedAt: (input.exportedAt ?? new Date()).toISOString(),
      comment: "Roundtrip export from ledger-core. Reconstructed from sourcePayload lineage.",
    },
    Account: accounts.filter((a) => a.sourcePayload).map((a) => a.sourcePayload as unknown as NsAccount),
    Class: classes,
    Department: departments,
    Location: locations,
    CustomSegment: customSegments.length ? customSegments : undefined,
    CustomFieldDefinition: customFieldDefinitions.length ? customFieldDefinitions : undefined,
    Customer: customers.filter((c) => c.sourcePayload).map((c) => c.sourcePayload as unknown as NsCustomer),
    Vendor: vendors.filter((v) => v.sourcePayload).map((v) => v.sourcePayload as unknown as NsVendor),
    Item: items.filter((i) => i.sourcePayload).map((i) => i.sourcePayload as unknown as NsItem),
    Invoice: invoices.length ? invoices : undefined,
    VendorBill: bills.length ? bills : undefined,
    CustomerPayment: customerPayments.length ? customerPayments : undefined,
    VendorPayment: vendorPayments.length ? vendorPayments : undefined,
    JournalEntry: journalEntries.length ? journalEntries : undefined,
  };
}

// Order-insensitive diff for NS exports. Returns null if equivalent.
export function diffNsExports(a: NsExport, b: NsExport): string | null {
  function sortByInternalId<T extends { internalid: string }>(arr: T[] | undefined): T[] {
    return [...(arr ?? [])].sort((x, y) => x.internalid.localeCompare(y.internalid));
  }

  const keys = [
    "Subsidiary",
    "Account",
    "Class",
    "Department",
    "Location",
    "CustomSegment",
    "CustomFieldDefinition",
    "Customer",
    "Vendor",
    "Item",
    "Invoice",
    "VendorBill",
    "CustomerPayment",
    "VendorPayment",
    "JournalEntry",
  ] as const;

  for (const key of keys) {
    const aArr = sortByInternalId<any>(a[key] as any);
    const bArr = sortByInternalId<any>(b[key] as any);
    if (aArr.length !== bArr.length) {
      return `${key}: count differs (a=${aArr.length}, b=${bArr.length})`;
    }
    for (let i = 0; i < aArr.length; i++) {
      const aStr = JSON.stringify(aArr[i]);
      const bStr = JSON.stringify(bArr[i]);
      if (aStr !== bStr) {
        return `${key}[${aArr[i].internalid}]: payload differs\n  a=${aStr}\n  b=${bStr}`;
      }
    }
  }
  return null;
}
