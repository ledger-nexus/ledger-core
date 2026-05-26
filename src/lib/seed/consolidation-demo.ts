// Multi-entity consolidation demo seed.
//
// Sets up a tiny parent + 2 subsidiaries with an intercompany transaction
// so the /reports/consolidation page has something to render. Independent
// of the Northwind seed — runs against the existing chart of accounts +
// US_GAAP book.
//
//   ACME_GROUP   (parent — non-operating)
//     ├── ACME_US   ($10k revenue from external customer, $3k IC sale to UK)
//     └── ACME_UK   ($3k IC purchase from US, $5k revenue from external customer)
//
// At consolidation the IC revenue ($3k) + IC expense ($3k) eliminate,
// plus the Due-from / Due-to balances ($3k each) cancel. The group's
// consolidated revenue = $15k (NOT $18k); group AR = $0 IC + external
// receivables.

import { PrismaClient } from "@prisma/client";
import { postJournalEntry } from "../accounting/post-journal";
import { getDefaultTenantId } from "./default-tenant";

const PARENT_CODE = "ACME_GROUP";
const SUB_US_CODE = "ACME_US";
const SUB_UK_CODE = "ACME_UK";
const BOOK_CODE = "US_GAAP";

export const CONSOLIDATION_DEMO_ENTITIES = [PARENT_CODE, SUB_US_CODE, SUB_UK_CODE];

export async function seedConsolidationDemo(prisma: PrismaClient): Promise<void> {
  // Ensure currencies + book exist (no-op if Northwind seed already ran).
  await prisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    update: {},
  });
  await prisma.book.upsert({
    where: { code: BOOK_CODE },
    create: { code: BOOK_CODE, name: "US GAAP", basis: "US_GAAP", reportingCurrencyId: "USD" },
    update: {},
  });

  const tenantId = await getDefaultTenantId(prisma);

  // Create parent entity first so child rows can FK to it.
  const parent = await prisma.legalEntity.upsert({
    where: { code: PARENT_CODE },
    create: {
      tenantId,
      code: PARENT_CODE,
      name: "Acme Group (consolidation parent)",
      functionalCurrencyId: "USD",
    },
    update: { tenantId },
  });

  const usSub = await prisma.legalEntity.upsert({
    where: { code: SUB_US_CODE },
    create: {
      tenantId,
      code: SUB_US_CODE,
      name: "Acme US Subsidiary",
      functionalCurrencyId: "USD",
      parentEntityId: parent.id,
    },
    update: { tenantId, parentEntityId: parent.id },
  });
  const ukSub = await prisma.legalEntity.upsert({
    where: { code: SUB_UK_CODE },
    create: {
      tenantId,
      code: SUB_UK_CODE,
      name: "Acme UK Subsidiary",
      functionalCurrencyId: "USD",  // Real-world: GBP; demo uses USD to keep math clean.
      parentEntityId: parent.id,
    },
    update: { tenantId, parentEntityId: parent.id },
  });

  // Fiscal calendar + Q1 period for each sub (needed by postJournalEntry).
  for (const ent of [parent, usSub, ukSub]) {
    const cal = await prisma.fiscalCalendar.upsert({
      where: { entityId_code: { entityId: ent.id, code: "STANDARD_2026" } },
      create: {
        tenantId,
        entityId: ent.id,
        code: "STANDARD_2026",
        name: "Standard 2026",
        periodFrequency: "MONTHLY",
      },
      update: { tenantId },
    });
    for (let m = 1; m <= 12; m++) {
      const code = `2026-${String(m).padStart(2, "0")}`;
      await prisma.period.upsert({
        where: { calendarId_code: { calendarId: cal.id, code } },
        create: {
          tenantId,
          calendarId: cal.id,
          code,
          ordinal: m,
          startsOn: new Date(Date.UTC(2026, m - 1, 1)),
          endsOn: new Date(Date.UTC(2026, m, 0)),
        },
        update: { tenantId },
      });
    }
  }

  // ---- Transactions: subs only (the parent has no operating activity) ----

  // US sub: $10k external revenue + $3k intercompany sale to UK sub.
  await postJournalEntry(prisma, {
    entityCode: SUB_US_CODE,
    bookCode: BOOK_CODE,
    documentDate: new Date("2026-02-15"),
    memo: "External customer revenue",
    source: "SEED",
    lines: [
      { accountCode: "1000", debit: 10_000 },
      { accountCode: "4000", credit: 10_000 },
    ],
  });
  await postJournalEntry(prisma, {
    entityCode: SUB_US_CODE,
    bookCode: BOOK_CODE,
    documentDate: new Date("2026-03-01"),
    memo: "Intercompany sale to Acme UK",
    source: "SEED",
    sourceRecordType: "IntercompanyInvoice",
    sourceRecordId: "IC-USUK-001",
    lines: [
      // US sub debits Due from Affiliates (asset) when shipping to UK sub on account
      { accountCode: "1300", debit: 3_000, description: "Due from Acme UK" },
      // Credits its intercompany revenue
      { accountCode: "4900", credit: 3_000, description: "Intercompany revenue" },
    ],
  });

  // UK sub: $5k external revenue + $3k intercompany expense from US.
  await postJournalEntry(prisma, {
    entityCode: SUB_UK_CODE,
    bookCode: BOOK_CODE,
    documentDate: new Date("2026-02-20"),
    memo: "External customer revenue (UK)",
    source: "SEED",
    lines: [
      { accountCode: "1000", debit: 5_000 },
      { accountCode: "4000", credit: 5_000 },
    ],
  });
  await postJournalEntry(prisma, {
    entityCode: SUB_UK_CODE,
    bookCode: BOOK_CODE,
    documentDate: new Date("2026-03-01"),
    memo: "Intercompany purchase from Acme US",
    source: "SEED",
    sourceRecordType: "IntercompanyBill",
    sourceRecordId: "IC-USUK-001",
    lines: [
      // UK sub debits intercompany expense
      { accountCode: "5900", debit: 3_000, description: "Intercompany expense" },
      // Credits Due to Affiliates (liability owed to US sub)
      { accountCode: "2400", credit: 3_000, description: "Due to Acme US" },
    ],
  });

  // Capital contributions to each sub so the BS makes sense.
  await postJournalEntry(prisma, {
    entityCode: SUB_US_CODE,
    bookCode: BOOK_CODE,
    documentDate: new Date("2026-01-02"),
    memo: "Capital from parent",
    source: "SEED",
    lines: [
      { accountCode: "1000", debit: 50_000 },
      { accountCode: "3100", credit: 50_000 },
    ],
  });
  await postJournalEntry(prisma, {
    entityCode: SUB_UK_CODE,
    bookCode: BOOK_CODE,
    documentDate: new Date("2026-01-02"),
    memo: "Capital from parent",
    source: "SEED",
    lines: [
      { accountCode: "1000", debit: 25_000 },
      { accountCode: "3100", credit: 25_000 },
    ],
  });
}

export async function clearConsolidationDemo(prisma: PrismaClient): Promise<void> {
  const entities = await prisma.legalEntity.findMany({
    where: { code: { in: CONSOLIDATION_DEMO_ENTITIES } },
    select: { id: true },
  });
  const ids = entities.map((e) => e.id);
  if (ids.length === 0) return;

  await prisma.arApplication.deleteMany({
    where: { openItem: { entityId: { in: ids } } },
  });
  await prisma.apApplication.deleteMany({
    where: { openItem: { entityId: { in: ids } } },
  });
  await prisma.arOpenItem.deleteMany({ where: { entityId: { in: ids } } });
  await prisma.apOpenItem.deleteMany({ where: { entityId: { in: ids } } });
  await prisma.journalEntry.deleteMany({ where: { entityId: { in: ids } } });
  await prisma.partyRole.deleteMany({
    where: { party: { entityId: { in: ids } } },
  });
  await prisma.party.deleteMany({ where: { entityId: { in: ids } } });
  await prisma.periodClose.deleteMany({ where: { entityId: { in: ids } } });
  // Leave fiscal calendars + entities themselves so re-seed is idempotent.
}
