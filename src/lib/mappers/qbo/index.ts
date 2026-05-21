// Public entry points for the QBO mapper module.
//
// Usage:
//   import { importFromQbo, exportToQbo } from "@/lib/mappers/qbo";
//
//   const result = await importFromQbo(prisma, {
//     entityCode: "QBO_DEMO",
//     export: qboJson,
//   });
//
//   const roundTripped = await exportToQbo(prisma, { entityCode: "QBO_DEMO" });

export { importFromQbo, type ImportFromQboInput, type ImportFromQboResult } from "./import";
export { exportToQbo, diffQboExports, type ExportToQboInput } from "./export";
export type {
  QboExport,
  QboAccount,
  QboCustomer,
  QboVendor,
  QboInvoice,
  QboBill,
  QboPayment,
  QboBillPayment,
  QboJournalEntry,
} from "./types";
