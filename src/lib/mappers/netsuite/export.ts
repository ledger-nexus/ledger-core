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
  NsSubsidiary,
} from "./types";

export interface ExportToNsInput {
  /**
   * Single-sub backward compat. Reconstructs the NS export from a single
   * ledger-core entity. Equivalent to `entityResolution: { mode: "single",
   * entityCode }`.
   */
  entityCode?: string;
  /**
   * Multi-sub mode: discovers every LegalEntity with NS lineage
   * (`extensions.nsIsImported === true`) whose code matches the
   * resolution prefix, and reconstructs the Subsidiary array + routes
   * each transaction back to its origin subsidiary.
   */
  entityResolution?:
    | { mode: "single"; entityCode: string }
    | { mode: "multi"; entityCodePrefix: string };
  bookCode?: string;
  exportedAt?: Date;
}

export async function exportToNs(
  prisma: PrismaClient,
  input: ExportToNsInput
): Promise<NsExport> {
  const bookCode = input.bookCode ?? "US_GAAP";

  // Resolve the exporter strategy. Single mode keeps the v0.6 behavior;
  // multi mode discovers every NS-imported entity matching the prefix.
  const resolution =
    input.entityResolution ??
    (input.entityCode
      ? ({ mode: "single", entityCode: input.entityCode } as const)
      : (() => {
          throw new Error(
            "exportToNs requires either `entityCode` (single mode) or " +
              "`entityResolution` (single or multi mode)."
          );
        })());

  // Discover the entity codes to query against.
  //   - single: just the named entity (v0.6 path)
  //   - multi: every LegalEntity with extensions.nsIsImported === true
  //            AND code starts with the prefix (so we don't drag in
  //            another tenant's NS-imported entities)
  let entityCodes: string[];
  let subsidiariesReconstructed: NsSubsidiary[] = [];
  if (resolution.mode === "single") {
    entityCodes = [resolution.entityCode];
  } else {
    const prefix = resolution.entityCodePrefix + "_NS";
    // path() helps the Postgres planner use the GIN index on extensions.
    const candidates = await prisma.legalEntity.findMany({
      where: {
        code: { startsWith: prefix },
        extensions: { path: ["nsIsImported"], equals: true },
      },
      select: {
        code: true,
        extensions: true,
      },
      orderBy: { code: "asc" },
    });
    entityCodes = candidates.map((e) => e.code);
    // Reconstruct Subsidiary array from frozen sourcePayload in
    // extensions. Matches the lineage-replay pattern used by every
    // other entity below — frozen original wins, never re-derive.
    subsidiariesReconstructed = candidates
      .map((e) => {
        const ext = (e.extensions ?? {}) as Record<string, unknown>;
        return (ext.nsSourcePayload as NsSubsidiary | undefined) ?? null;
      })
      .filter((s): s is NsSubsidiary => s !== null)
      // NS conventionally orders Subsidiary by internalid ascending —
      // the natural order of "parent created before child" in OneWorld.
      .sort((a, b) => Number(a.internalid) - Number(b.internalid));
  }

  // Accounts/Parties/Items: in multi mode they're on the global chart
  // (entityId: null per Phase 3 chart-of-accounts decision). In single
  // mode they're scoped to the entity. Build the right `where` for each.
  const masterRowEntityFilter =
    resolution.mode === "single"
      ? ({ entity: { code: resolution.entityCode } } as const)
      : ({ entityId: null } as const);

  const accounts = await prisma.account.findMany({
    where: {
      sourceSystem: "NETSUITE",
      sourceRecordType: "Account",
      ...masterRowEntityFilter,
    },
    select: { sourcePayload: true },
    orderBy: { sourceRecordId: "asc" },
  });
  const customers = await prisma.party.findMany({
    where: {
      sourceSystem: "NETSUITE",
      sourceRecordType: "Customer",
      ...masterRowEntityFilter,
    },
    select: { sourcePayload: true },
    orderBy: { sourceRecordId: "asc" },
  });
  const vendors = await prisma.party.findMany({
    where: {
      sourceSystem: "NETSUITE",
      sourceRecordType: "Vendor",
      ...masterRowEntityFilter,
    },
    select: { sourcePayload: true },
    orderBy: { sourceRecordId: "asc" },
  });
  const items = await prisma.item.findMany({
    where: {
      sourceSystem: "NETSUITE",
      sourceRecordType: "Item",
      ...masterRowEntityFilter,
    },
    select: { sourcePayload: true },
    orderBy: { sourceRecordId: "asc" },
  });

  // JEs are always entity-scoped — they post to a specific entity even
  // when the chart is global. In multi mode we want JEs from every
  // discovered entity; in single mode just the one.
  const entries = await prisma.journalEntry.findMany({
    where: {
      sourceSystem: "NETSUITE",
      entity: { code: { in: entityCodes } },
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
  const customSegments: NsCustomSegment[] = customDimensions.map((d) => {
    const seg: NsCustomSegment = {
      internalid: d.code.toLowerCase(),
      name: d.name,
      values: d.values.map((v) => ({ internalid: v.code, name: v.name })),
    };
    // Preserve roundtrip-relevant metadata when present. Skipping
    // undefined keeps the canonical-compare from emitting noise on
    // input fixtures that don't carry a description.
    if (d.description) seg.description = d.description;
    return seg;
  });

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
    // Subsidiary array: only emitted in multi mode (reconstructed from
    // LegalEntity.extensions.nsSourcePayload). Single mode keeps the v0.6
    // exporter shape — no Subsidiary key, matching the v0.6 fixture.
    Subsidiary: subsidiariesReconstructed.length ? subsidiariesReconstructed : undefined,
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

  // Key-order-agnostic stringifier. Two records with identical key/value
  // pairs but different declaration order should compare equal — the
  // roundtrip preserves SEMANTICS, not lexical key order. Recursively
  // sorts object keys before serializing.
  //
  // Skips keys whose value is `undefined` so that `{a, b}` and
  // `{a, b, c: undefined}` canonicalize to the same string — this mirrors
  // JSON.stringify's behavior (which already drops undefined values) and
  // keeps "key absent" semantically equal to "key explicitly undefined."
  function canonical(value: unknown): string {
    if (value === undefined) return "undefined";
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) {
      return "[" + value.map(canonical).join(",") + "]";
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return (
      "{" +
      keys.map((k) => JSON.stringify(k) + ":" + canonical(obj[k])).join(",") +
      "}"
    );
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
      const aStr = canonical(aArr[i]);
      const bStr = canonical(bArr[i]);
      if (aStr !== bStr) {
        return `${key}[${aArr[i].internalid}]: payload differs\n  a=${aStr}\n  b=${bStr}`;
      }
    }
  }
  return null;
}
