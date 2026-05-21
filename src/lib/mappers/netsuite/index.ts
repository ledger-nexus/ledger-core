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
