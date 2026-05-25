// `pnpm demo` entry point.
//
// Wipes DEMO_CO and re-seeds a believable May 2026 month of activity,
// then closes May on US_GAAP. Designed as the showcase artifact: after
// running this you can open /reports/month-end?period=2026-05 (with
// scope = DEMO_CO / US_GAAP) and see a polished, balanced, closed-book
// month-end packet — TB ties, BS ties, P&L is non-zero, downloads work.
//
// This DOES NOT touch Northwind or the consolidation demo. The seed
// data those rely on stays intact.

import { PrismaClient } from "@prisma/client";
import {
  seedDemoMonth,
  DEMO_ENTITY_CODE,
  DEMO_PERIOD_CODE,
} from "../src/lib/seed/demo-month";

const prisma = new PrismaClient();

async function closeMayPeriod(): Promise<void> {
  const entity = await prisma.legalEntity.findUniqueOrThrow({
    where: { code: DEMO_ENTITY_CODE },
    select: { id: true },
  });
  const gaapBook = await prisma.book.findUniqueOrThrow({
    where: { code: "US_GAAP" },
    select: { id: true },
  });
  const mayPeriod = await prisma.period.findFirstOrThrow({
    where: {
      code: DEMO_PERIOD_CODE,
      calendar: { entityId: entity.id },
    },
    select: { id: true },
  });

  // Idempotent close: skip if already locked.
  const existing = await prisma.periodClose.findUnique({
    where: {
      entityId_bookId_periodId: {
        entityId: entity.id,
        bookId: gaapBook.id,
        periodId: mayPeriod.id,
      },
    },
    select: { id: true },
  });
  if (existing) return;

  await prisma.periodClose.create({
    data: {
      entityId: entity.id,
      bookId: gaapBook.id,
      periodId: mayPeriod.id,
      closedBy: "demo-script",
    },
  });
}

async function main(): Promise<void> {
  const t0 = Date.now();
  console.log("Seeding DEMO_CO with one believable month of accounting activity...");
  const result = await seedDemoMonth(prisma);
  console.log(
    `  Posted ${result.jeCount} JEs (across US_GAAP + US_TAX),`,
    `${result.arOpened} AR open items,`,
    `${result.apOpened} AP open items.`
  );

  console.log("Closing May 2026 on US_GAAP...");
  await closeMayPeriod();
  console.log("  Period locked — postJournalEntry will reject further writes for this (entity, book, period).");

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s.\n`);

  console.log("Next steps:");
  console.log("  1. Start the dev server:  pnpm dev");
  console.log("  2. In the sidebar, switch scope to DEMO_CO / US_GAAP");
  console.log("  3. Open /reports/month-end?period=2026-05");
  console.log("");
  console.log("Or fetch the packet directly (once dev server is running):");
  console.log(
    "  curl -b 'lc-scope={\"entityCode\":\"DEMO_CO\",\"bookCode\":\"US_GAAP\"}' \\"
  );
  console.log(
    "    'http://localhost:3000/api/reports/month-end/csv?period=2026-05' -o demo-packet.csv"
  );
  console.log(
    "  curl -b 'lc-scope={\"entityCode\":\"DEMO_CO\",\"bookCode\":\"US_GAAP\"}' \\"
  );
  console.log(
    "    'http://localhost:3000/api/reports/month-end/pdf?period=2026-05' -o demo-packet.pdf"
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
