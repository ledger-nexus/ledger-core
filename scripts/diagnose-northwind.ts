// One-shot diagnostic: what's actually in the Northwind seed data?
// The seeded-company.test.ts failures suggest AR / deferred revenue /
// fixed-asset NBV / multi-book divergence aren't where they should be.

import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

(async () => {
  const entity = await prisma.legalEntity.findUnique({
    where: { code: "NORTHWIND" },
    select: { id: true, tenantId: true },
  });
  if (!entity) {
    console.log("No NORTHWIND entity — seed hasn't run.");
    await prisma.$disconnect();
    return;
  }
  console.log(`Entity: NORTHWIND (id=${entity.id}, tenant=${entity.tenantId})`);

  const jeCount = await prisma.journalEntry.count({
    where: { entityId: entity.id },
  });
  console.log(`Total JEs across all books: ${jeCount}`);

  for (const bookCode of ["US_GAAP", "US_TAX", "IFRS"]) {
    const book = await prisma.book.findUnique({ where: { code: bookCode }, select: { id: true } });
    if (!book) continue;
    const n = await prisma.journalEntry.count({
      where: { entityId: entity.id, bookId: book.id },
    });
    console.log(`  ${bookCode}: ${n} JEs`);
  }

  console.log(`\nAR open items:`);
  const arItems = await prisma.arOpenItem.findMany({
    where: { entityId: entity.id, book: { code: "US_GAAP" } },
    select: {
      referenceNumber: true,
      status: true,
      currentBalance: true,
      originalAmount: true,
      party: { select: { code: true } },
    },
    orderBy: { openedDate: "asc" },
  });
  for (const ar of arItems) {
    console.log(`  ${ar.party.code} ${ar.referenceNumber}: status=${ar.status} bal=${ar.currentBalance} (orig ${ar.originalAmount})`);
  }
  const arOpenBalance = arItems
    .filter((a) => a.status === "OPEN" || a.status === "PARTIAL" || a.status === "REOPENED")
    .reduce((acc, a) => acc + Number(a.currentBalance), 0);
  console.log(`  Total open AR balance: $${arOpenBalance.toLocaleString()}`);

  console.log(`\nRevenue contracts:`);
  const contracts = await prisma.revenueContract.findMany({
    where: { entityId: entity.id },
    select: {
      code: true,
      customer: { select: { code: true } },
      totalContractValue: true,
      performanceObligations: {
        select: { sequenceNo: true, ssp: true, recognizedToDate: true, recognitionPattern: true },
      },
    },
  });
  for (const c of contracts) {
    console.log(`  ${c.code} (${c.customer.code}): $${c.totalContractValue}`);
    for (const po of c.performanceObligations) {
      console.log(`    PO${po.sequenceNo}: ssp=${po.ssp} recognized=${po.recognizedToDate} pattern=${po.recognitionPattern}`);
    }
  }

  console.log(`\nFixed assets:`);
  const assets = await prisma.fixedAsset.findMany({
    where: { entityId: entity.id },
    select: {
      code: true,
      acquisitionCost: true,
      bookAttributes: {
        select: { book: { select: { code: true } }, accumulatedDepreciation: true, lastDepreciatedThrough: true, usefulLifeMonths: true },
      },
    },
  });
  for (const a of assets) {
    console.log(`  ${a.code} cost=$${a.acquisitionCost}`);
    for (const ba of a.bookAttributes) {
      console.log(`    ${ba.book.code}: life=${ba.usefulLifeMonths}mo accum=${ba.accumulatedDepreciation} through=${ba.lastDepreciatedThrough?.toISOString().slice(0, 10) ?? "never"}`);
    }
  }

  await prisma.$disconnect();
})();
