// NetSuite reverse exporter — same lineage-replay pattern as QBO.
//
// Reads sourcePayload from every NS-imported row and reassembles the
// NetSuite export structure. This is the roundtrip proof for the
// "expressive ceiling" mapping: even with dimensions on every line and
// custom fields on transactions, the lineage layer preserves enough to
// reconstruct the original.

import { PrismaClient } from "@prisma/client";
import { getDefaultTenantId } from "../../seed/default-tenant";
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
  NsAccountingBook,
  NsSubsidiary,
  NsOpenItemState,
  NsOpenItemStatus,
} from "./types";

export interface ExportToNsInput {
  /**
   * The tenant whose data this export may read. Defaults to the dev/default
   * tenant, matching what `importFromNs` already does on the way in.
   *
   * ⚠️ Before this existed, NOTHING in this file filtered on tenant. Entities
   * are unique on `(tenantId, code)`, not on `code`, so every query here was
   * bounded only by an entity code that another tenant may also use — and the
   * two `Dimension` reads below were bounded by nothing at all. A single
   * dimension row planted on an unrelated tenant showed up in this exporter's
   * output (`CustomSegment: count differs (a=1, b=2)`), which is a
   * cross-tenant read of customer data.
   *
   * It went unnoticed because `netsuite-mapping.test.ts` deleted every
   * dimension row on the database in its `beforeAll` — so at assert time only
   * one tenant could possibly have any. Scoping that cleanup is what exposed
   * this.
   */
  tenantId?: string;
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
  /**
   * v0.9 NS Accounting Books Phase 4 — multi-book reverse export.
   *
   * Single mode (default, backward compat with v0.6 + Phase 3 single):
   * exports JEs from ONE ledger-core book. Equivalent to `bookCode`.
   *
   * Multi mode: discovers JEs across EVERY mapped ledger-core book,
   * groups them by source record id, reconstructs the AccountingBook
   * array from the book mapping, and merges per-book JEs back into
   * the source NS transaction. The frozen `sourcePayload` is identical
   * across all per-book JE rows (it's the original NS transaction);
   * the reverse exporter reads it from any one of them.
   *
   * `bookResolution` takes precedence over `bookCode` when both are set.
   */
  bookResolution?:
    | { mode: "single"; bookCode: string }
    | { mode: "multi"; bookMapping: Record<string, string> };
  //                              ^ NS internalid → ledger-core book code
  //                                (same shape as the importer's input)
  exportedAt?: Date;
}

export async function exportToNs(
  prisma: PrismaClient,
  input: ExportToNsInput
): Promise<NsExport> {
  const tenantId = input.tenantId ?? (await getDefaultTenantId(prisma));
  const bookCode = input.bookCode ?? "US_GAAP";

  // v0.9 NS Books Phase 4 — resolve book strategy. Single mode (default,
  // backward compat) queries JEs from ONE book. Multi mode queries
  // across all mapped books and reconstructs the AccountingBook array.
  const bookResolution =
    input.bookResolution ??
    ({ mode: "single", bookCode } as const);
  // The list of ledger-core book codes the JE query covers.
  const bookCodesToQuery: string[] =
    bookResolution.mode === "single"
      ? [bookResolution.bookCode]
      : Array.from(new Set(Object.values(bookResolution.bookMapping)));
  // For Subsidiary-style "where do AccountingBook entries come from"
  // reconstruction. In multi mode read each Book row's stashed NS
  // sourcePayload (Phase 4.5 — written by setupBooks on the way in)
  // and emit byref. Falls back to synthesis from the bookMapping for
  // any internalid that has no stash (e.g. native-seeded books, or
  // books imported before Phase 4.5 landed).
  let accountingBooksReconstructed: NsAccountingBook[] = [];
  if (bookResolution.mode === "multi") {
    const booksWithExtensions = await prisma.book.findMany({
      where: { code: { in: bookCodesToQuery } },
      select: { code: true, extensions: true },
    });
    // Flatten every Book's stash dictionary into a single map. The
    // many-to-one fold case (multiple NS books → one ledger-core book)
    // is preserved: a Book's stash can hold N entries, all emitted.
    const stashByInternalid = new Map<string, NsAccountingBook>();
    for (const b of booksWithExtensions) {
      const ext = (b.extensions ?? {}) as Record<string, unknown>;
      const stash =
        (ext.nsAccountingBookSourcePayloads as
          | Record<string, NsAccountingBook>
          | undefined) ?? {};
      for (const [id, payload] of Object.entries(stash)) {
        if (!stashByInternalid.has(id)) {
          stashByInternalid.set(id, payload);
        }
      }
    }
    // Walk the operator's full bookMapping (which is the
    // declared-on-the-way-in NS-book→ledger-book pairing). Prefer the
    // stash; synthesize { internalid, name } for any internalid
    // missing a stash entry.
    for (const [nsId, ledgerCode] of Object.entries(
      bookResolution.bookMapping
    )) {
      const stashed = stashByInternalid.get(nsId);
      if (stashed) {
        accountingBooksReconstructed.push(stashed);
      } else {
        accountingBooksReconstructed.push({
          internalid: nsId,
          name: ledgerCode.replace(/_/g, " "),
        });
      }
    }
    // NS conventionally orders AccountingBook by internalid ascending.
    accountingBooksReconstructed.sort(
      (a, b) => Number(a.internalid) - Number(b.internalid)
    );
  }

  // Resolve the entity exporter strategy. Single mode keeps the v0.6
  // behavior; multi mode discovers every NS-imported entity matching
  // the prefix.
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
        // The prefix was doing this job on its own — see the comment above,
        // which says the quiet part out loud ("so we don't drag in another
        // tenant's NS-imported entities"). A naming convention is not a
        // tenant boundary; this is.
        tenantId,
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
  // ⚠️ `tenantId` is the load-bearing addition here. In multi mode the filter
  // is `entityId: null` — the global chart — which without a tenant is EVERY
  // tenant's global chart, not ours.
  const masterRowEntityFilter =
    resolution.mode === "single"
      ? ({ tenantId, entity: { code: resolution.entityCode } } as const)
      : ({ tenantId, entityId: null } as const);

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

  // JEs are entity- AND book-scoped. In multi-sub mode we walk every
  // discovered entity; in multi-book mode (v0.9) we walk every mapped
  // ledger-core book and DEDUPE by sourceRecordId (per-book JEs share
  // the same frozen NS sourcePayload — reading one is the same as
  // reading any).
  const rawEntries = await prisma.journalEntry.findMany({
    where: {
      tenantId,
      sourceSystem: "NETSUITE",
      entity: { code: { in: entityCodes } },
      book: { code: { in: bookCodesToQuery } },
    },
    select: {
      sourceRecordType: true,
      sourceRecordId: true,
      sourcePayload: true,
    },
    orderBy: [{ sourceRecordType: "asc" }, { sourceRecordId: "asc" }],
  });
  // Dedupe by (sourceRecordType, sourceRecordId). Multiple per-book
  // rows are intentional in v0.9 but the NS export side reconstructs
  // ONE record per source — the per-book divergence is preserved in
  // the AccountingBook array + (Phase 4.5) bookspecific[].
  const seen = new Set<string>();
  const entries: typeof rawEntries = [];
  for (const e of rawEntries) {
    const key = `${e.sourceRecordType}|${e.sourceRecordId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(e);
  }

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
    where: { tenantId, code: { in: ["CLASS", "DEPARTMENT", "LOCATION"] } },
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
  // ⚠️ THE QUERY THAT LEAKED. "Anything not in the built-in three is custom"
  // was true of the whole database, so any dimension any tenant had ever
  // created was exported here as one of this tenant's custom segments.
  const customDimensions = await prisma.dimension.findMany({
    where: { tenantId, code: { notIn: ["CLASS", "DEPARTMENT", "LOCATION"] } },
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

  // v0.9 NS Books Phase 3.5 — sub-ledger multi-book reverse export.
  //
  // For multi-book mode ONLY, emit a per-book snapshot of every AR/AP
  // OpenItem that lineage-links to an NS Invoice / VendorBill in
  // scope. Single-book mode keeps the v0.6 export shape (no
  // OpenItemState key) — the per-book divergence doesn't exist
  // there, so emitting an empty array would be lossless noise.
  //
  // The query is scoped by `(entity in entityCodes) AND (book in
  // bookCodesToQuery) AND sourceSystem='NETSUITE'`. Native (non-NS)
  // open items are filtered out by the sourceSystem clause.
  //
  // Status values map straight through — the schema enum already
  // matches the NS-side intent (OPEN/PARTIAL/APPLIED/etc.). Decimal
  // columns are stringified to preserve precision across the wire.
  let openItemStateRows: NsOpenItemState[] = [];
  if (bookResolution.mode === "multi") {
    const arRows = await prisma.arOpenItem.findMany({
      where: {
        tenantId,
        sourceSystem: "NETSUITE",
        sourceRecordType: "Invoice",
        entity: { code: { in: entityCodes } },
        book: { code: { in: bookCodesToQuery } },
      },
      select: {
        sourceRecordId: true,
        originalAmount: true,
        currentBalance: true,
        status: true,
        entity: { select: { code: true } },
        book: { select: { code: true } },
      },
      orderBy: [{ sourceRecordId: "asc" }],
    });
    const apRows = await prisma.apOpenItem.findMany({
      where: {
        tenantId,
        sourceSystem: "NETSUITE",
        sourceRecordType: "VendorBill",
        entity: { code: { in: entityCodes } },
        book: { code: { in: bookCodesToQuery } },
      },
      select: {
        sourceRecordId: true,
        originalAmount: true,
        currentBalance: true,
        status: true,
        entity: { select: { code: true } },
        book: { select: { code: true } },
      },
      orderBy: [{ sourceRecordId: "asc" }],
    });
    const toState = (
      r: typeof arRows[number] | typeof apRows[number],
      side: "Invoice" | "VendorBill"
    ): NsOpenItemState | null => {
      if (!r.sourceRecordId) return null;
      return {
        sourceRecordType: side,
        sourceRecordId: r.sourceRecordId,
        bookCode: r.book.code,
        entityCode: r.entity.code,
        originalAmount: r.originalAmount.toString(),
        currentBalance: r.currentBalance.toString(),
        status: r.status as NsOpenItemStatus,
      };
    };
    openItemStateRows = [
      ...arRows.map((r) => toState(r, "Invoice")),
      ...apRows.map((r) => toState(r, "VendorBill")),
    ]
      .filter((s): s is NsOpenItemState => s !== null)
      // Deterministic ordering: AR before AP (sourceRecordType asc),
      // then sourceRecordId asc, then bookCode asc. This is what the
      // canonical-compare relies on for byte-stable diffs across runs.
      .sort((a, b) => {
        if (a.sourceRecordType !== b.sourceRecordType) {
          return a.sourceRecordType.localeCompare(b.sourceRecordType);
        }
        if (a.sourceRecordId !== b.sourceRecordId) {
          return a.sourceRecordId.localeCompare(b.sourceRecordId);
        }
        return a.bookCode.localeCompare(b.bookCode);
      });
  }

  const customFieldDefs = await prisma.customFieldDefinition.findMany({
    where: { tenantId, sourceErpField: { startsWith: "cust" } },
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
    // v0.9 NS Books Phase 4 — emit AccountingBook array only in multi
    // mode. Single mode keeps the v0.6 export shape (no AccountingBook
    // key), matching the v0.6 fixture.
    AccountingBook: accountingBooksReconstructed.length
      ? accountingBooksReconstructed
      : undefined,
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
    // v0.9 NS Books Phase 3.5 — per-book sub-ledger snapshot. Only
    // populated in multi mode (see the openItemStateRows guard above).
    OpenItemState: openItemStateRows.length ? openItemStateRows : undefined,
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
    "AccountingBook",
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

  // v0.9 NS Books Phase 3.5 — OpenItemState uses a composite key
  // (sourceRecordType + sourceRecordId + bookCode) instead of
  // internalid, so it gets its own canonical-compare branch.
  const stateKey = (s: { sourceRecordType: string; sourceRecordId: string; bookCode: string }) =>
    `${s.sourceRecordType}|${s.sourceRecordId}|${s.bookCode}`;
  const aStateArr = [...(a.OpenItemState ?? [])].sort((x, y) =>
    stateKey(x).localeCompare(stateKey(y))
  );
  const bStateArr = [...(b.OpenItemState ?? [])].sort((x, y) =>
    stateKey(x).localeCompare(stateKey(y))
  );
  if (aStateArr.length !== bStateArr.length) {
    return `OpenItemState: count differs (a=${aStateArr.length}, b=${bStateArr.length})`;
  }
  for (let i = 0; i < aStateArr.length; i++) {
    const aStr = canonical(aStateArr[i]);
    const bStr = canonical(bStateArr[i]);
    if (aStr !== bStr) {
      return `OpenItemState[${stateKey(aStateArr[i])}]: payload differs\n  a=${aStr}\n  b=${bStr}`;
    }
  }
  return null;
}
