// Public entry points for the NetSuite mapper module.
//
// Usage:
//   import { importFromNs, exportToNs } from "@/lib/mappers/netsuite";
//
//   const result = await importFromNs(prisma, {
//     entityCode: "NS_DEMO",
//     export: nsJson,
//   });
//
//   const roundTripped = await exportToNs(prisma, { entityCode: "NS_DEMO" });

export { importFromNs, type ImportFromNsInput, type ImportFromNsResult } from "./import";
export { exportToNs, diffNsExports, type ExportToNsInput } from "./export";
export {
  setupDimension,
  setupDimensionValue,
  getOrCreateDimensionSet,
  dimensionSetHash,
} from "./dimensions";
export type {
  NsExport,
  NsAccount,
  NsSubsidiary,
  NsClassification,
  NsDepartment,
  NsLocation,
  NsCustomSegment,
  NsCustomFieldDefinition,
  NsCustomer,
  NsVendor,
  NsItem,
  NsInvoice,
  NsVendorBill,
  NsCustomerPayment,
  NsVendorPayment,
  NsJournalEntry,
  NsTransactionLine,
} from "./types";

// Bootstrap mappers (Subsidiary + AccountingBook + AccountingPeriod).
// These must run BEFORE the transaction import — every JE / invoice /
// bill / payment / FA references an entity + book + period that must
// already exist. See docs/reference/netsuite-gl-validation.md for the
// validation pass that surfaced this gap.
export {
  mapNsSubsidiary,
  mapNsAccountingBook,
  mapNsAccountingPeriod,
  nsSubsidiaryCode,
  nsBookCode,
  nsCalendarCode,
  nsPeriodCode,
  importSubsidiaries,
  importAccountingBooks,
  importAccountingPeriods,
  type NsSubsidiaryBootstrap,
  type NsAccountingBookBootstrap,
  type NsAccountingPeriodBootstrap,
  type MappedLegalEntity,
  type MappedBook,
  type MappedPeriod,
  type ImportSubsidiariesResult,
  type ImportAccountingBooksResult,
  type ImportAccountingPeriodsResult,
} from "./bootstrap";
