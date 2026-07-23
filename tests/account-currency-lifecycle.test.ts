// Account commodity constraint + dated lifecycle, enforced in postJournalEntry.
//
// The first test is the one that matters most: an account left at its defaults
// must post exactly as before. The whole safety argument for adding this to a
// populated ledger is that it is INERT until someone opts in — empty
// allowedCurrencies = unconstrained, NULL dates = unbounded.
//
// Then the opt-in behaviour:
//   - currency in allowedCurrencies      -> posts
//   - currency NOT in allowedCurrencies  -> AccountCurrencyNotAllowedError
//   - documentDate before openedOn       -> AccountNotOpenError
//   - documentDate ON openedOn           -> posts   (boundary INCLUSIVE)
//   - documentDate ON closedOn           -> posts   (boundary INCLUSIVE)
//   - documentDate after closedOn        -> AccountNotOpenError

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { postJournalEntry } from "@/lib/accounting/post-journal";
import {
  AccountCurrencyNotAllowedError,
  AccountNotOpenError,
} from "@/lib/accounting/types";
import { withAuditLogMutableTransaction } from "./_helpers/audit-log-cleanup";

const prisma = new PrismaClient();

const SUFFIX = ("ACL" + Date.now().toString(36) + Math.floor(Math.random() * 9999)).toUpperCase();
const ENTITY_CODE = `ACL-${SUFFIX}`;

let tenantId: string;
let userId: string;
let entityId: string;

/** Balanced 2-line post: the account under test against an unconstrained offset. */
function post(accountCode: string, documentDate: string) {
  return postJournalEntry(prisma, {
    tenantId,
    entityCode: ENTITY_CODE,
    bookCode: "US_GAAP",
    documentDate: new Date(documentDate),
    memo: `probe ${accountCode} @ ${documentDate}`,
    source: "MANUAL",
    lines: [
      { accountCode, debit: "10" },
      { accountCode: "OFFSET", credit: "10" },
    ],
  });
}

beforeAll(async () => {
  await prisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    update: {},
  });
  await prisma.currency.upsert({
    where: { code: "EUR" },
    create: { code: "EUR", name: "Euro", decimals: 2, symbol: "€" },
    update: {},
  });
  await prisma.book.upsert({
    where: { code: "US_GAAP" },
    create: { code: "US_GAAP", name: "US GAAP", basis: "US_GAAP", reportingCurrencyId: "USD" },
    update: {},
  });

  const u = await prisma.user.create({
    data: { email: `acl-${SUFFIX}@example.test`, displayName: "ACL tester", isActive: true },
  });
  userId = u.id;

  const tenant = await prisma.tenant.create({
    data: { slug: `acl-${SUFFIX.toLowerCase()}`, name: "ACL tenant", ownerUserId: u.id },
  });
  tenantId = tenant.id;

  const entity = await prisma.legalEntity.create({
    data: { tenantId, code: ENTITY_CODE, name: "ACL Co.", functionalCurrencyId: "USD" },
  });
  entityId = entity.id;

  await prisma.account.createMany({
    data: [
      // Defaults everywhere — the regression guard.
      { tenantId, entityId, code: "PLAIN", name: "Unconstrained", type: "ASSET", normalBalance: "DEBIT" },
      { tenantId, entityId, code: "OFFSET", name: "Offset", type: "REVENUE", normalBalance: "CREDIT" },
      { tenantId, entityId, code: "USDONLY", name: "USD only", type: "ASSET", normalBalance: "DEBIT", allowedCurrencies: ["USD"] },
      { tenantId, entityId, code: "EURONLY", name: "EUR only", type: "ASSET", normalBalance: "DEBIT", allowedCurrencies: ["EUR"] },
      {
        tenantId,
        entityId,
        code: "WINDOW",
        name: "Open March 2026 only",
        type: "ASSET",
        normalBalance: "DEBIT",
        openedOn: new Date("2026-03-01"),
        closedOn: new Date("2026-03-31"),
      },
    ],
  });
});

afterAll(async () => {
  await prisma.journalLine.deleteMany({ where: { entry: { entityId } } });
  await prisma.journalEntry.deleteMany({ where: { entityId } });
  await prisma.account.deleteMany({ where: { entityId } });
  await prisma.legalEntity.deleteMany({ where: { id: entityId } });
  await withAuditLogMutableTransaction(prisma, async (tx) => {
    await tx.auditLog.deleteMany({ where: { OR: [{ tenantId }, { actorUserId: userId }] } });
    await tx.tenant.delete({ where: { id: tenantId } });
    await tx.user.delete({ where: { id: userId } });
  });
  await prisma.$disconnect();
});

describe("account constraints are inert by default", () => {
  it("posts normally to an account left at its defaults", async () => {
    const r = await post("PLAIN", "2026-05-15");
    expect(r.entryNumber).toBeTruthy();
  });
});

describe("allowedCurrencies", () => {
  it("allows a currency that is listed", async () => {
    const r = await post("USDONLY", "2026-05-15");
    expect(r.entryNumber).toBeTruthy();
  });

  it("refuses a currency that is not listed", async () => {
    // Entity functional currency is USD, so this entry is USD — EURONLY
    // accepts only EUR.
    await expect(post("EURONLY", "2026-05-15")).rejects.toBeInstanceOf(
      AccountCurrencyNotAllowedError
    );
  });
});

describe("dated lifecycle (boundaries inclusive)", () => {
  it("refuses an entry dated before the account opened", async () => {
    await expect(post("WINDOW", "2026-02-28")).rejects.toBeInstanceOf(AccountNotOpenError);
  });

  it("allows an entry dated ON the open date", async () => {
    const r = await post("WINDOW", "2026-03-01");
    expect(r.entryNumber).toBeTruthy();
  });

  it("allows an entry dated ON the close date", async () => {
    const r = await post("WINDOW", "2026-03-31");
    expect(r.entryNumber).toBeTruthy();
  });

  it("refuses an entry dated after the account closed", async () => {
    await expect(post("WINDOW", "2026-04-01")).rejects.toBeInstanceOf(AccountNotOpenError);
  });

  it("names the account and the reason in the error", async () => {
    await expect(post("WINDOW", "2026-04-01")).rejects.toThrow(/WINDOW.*closed on 2026-03-31/);
  });
});
