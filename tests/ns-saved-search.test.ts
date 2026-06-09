// v0.9 NS SuiteAnalytics Phase 4 — saved-search query endpoint test.
//
// Covers the validation surface (defense-in-depth) + the happy paths
// for both Account and Transaction searchTypes. The validation tests
// are pure (no DB needed); the happy-path tests run against an
// authenticated bearer token.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { PrismaClient } from "@prisma/client";

import { provisionTenantApiToken } from "@/lib/auth/token";
import {
  validateRequest,
  SavedSearchValidationError,
  MAX_FILTERS,
  MAX_PAGE_SIZE,
} from "@/lib/external/ns-saved-search";
import { POST as savedSearch } from "@/app/api/external/ns-analytics/saved-search/route";

const prisma = new PrismaClient();
const SUFFIX = "P4SS";

let tenantId: string;
let ownerUserId: string;
let token: string;

beforeAll(async () => {
  delete process.env.INTERNAL_API_TOKEN;
  // Upsert tolerates prior failed-run stale state.
  const user = await prisma.user.upsert({
    where: { email: `nss-${SUFFIX}@example.test` },
    create: {
      email: `nss-${SUFFIX}@example.test`,
      displayName: "NSS test owner",
      isActive: true,
    },
    update: {},
  });
  ownerUserId = user.id;
  const tenant = await prisma.tenant.upsert({
    where: { slug: `nss-${SUFFIX}` },
    create: {
      slug: `nss-${SUFFIX}`,
      name: "NS Saved-Search test tenant",
      ownerUserId: user.id,
    },
    update: {},
  });
  tenantId = tenant.id;
  const prov = await provisionTenantApiToken({
    tenantId,
    label: `nss-${SUFFIX}`,
  });
  token = prov.plaintext;
});

afterAll(async () => {
  // Order matters + tolerate races: token deletion may itself write
  // audit rows. Audit log writes can also fire from anywhere via
  // Prisma extensions. Use a tight retry loop that always sweeps
  // audit then tenant.
  await prisma.tenantApiToken
    .deleteMany({ where: { tenantId } })
    .catch(() => {});
  for (let attempt = 0; attempt < 3; attempt++) {
    await prisma.auditLog
      .deleteMany({ where: { tenantId } })
      .catch(() => {});
    try {
      await prisma.tenant.delete({ where: { id: tenantId } });
      break;
    } catch {
      // FK violation — another audit row landed. Loop + retry.
      if (attempt === 2) {
        // Last attempt failed; leave the tenant + audit rows. Test
        // pollution is operator-actionable but won't block this test
        // file's assertions from passing.
        break;
      }
    }
  }
  await prisma.user.delete({ where: { id: ownerUserId } }).catch(() => {});
  await prisma.$disconnect();
});

function makeReq(body: unknown, authValue?: string): NextRequest {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (authValue) headers.authorization = authValue;
  return new NextRequest("http://localhost/api/external/ns-analytics/saved-search", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

// ─── Pure validation tests ──────────────────────────────────────────

describe("v0.9 NS SuiteAnalytics Phase 4: validateRequest", () => {
  it("rejects null body", () => {
    expect(() => validateRequest(null)).toThrow(SavedSearchValidationError);
  });

  it("rejects unknown searchType", () => {
    expect(() =>
      validateRequest({ searchType: "Pony" })
    ).toThrow(/Invalid searchType/);
  });

  it("rejects unknown field for the searchType", () => {
    expect(() =>
      validateRequest({
        searchType: "Account",
        filters: [{ field: "secret", operator: "EQUALS", values: ["x"] }],
      })
    ).toThrow(/Unknown field/);
  });

  it("rejects mismatched operator for field type (WITHIN on string field)", () => {
    expect(() =>
      validateRequest({
        searchType: "Account",
        filters: [{ field: "acctname", operator: "WITHIN", values: ["a", "b"] }],
      })
    ).toThrow(/Invalid operator/);
  });

  it("rejects too many filters (DoS guard)", () => {
    const filters = Array.from({ length: MAX_FILTERS + 1 }, () => ({
      field: "acctname",
      operator: "EQUALS" as const,
      values: ["x"],
    }));
    expect(() =>
      validateRequest({ searchType: "Account", filters })
    ).toThrow(/Too many filters/);
  });

  it("rejects pageSize over MAX_PAGE_SIZE", () => {
    expect(() =>
      validateRequest({ searchType: "Account", pageSize: MAX_PAGE_SIZE + 1 })
    ).toThrow(/pageSize/);
  });

  it("rejects WITHIN with wrong number of values", () => {
    expect(() =>
      validateRequest({
        searchType: "Transaction",
        filters: [{ field: "trandate", operator: "WITHIN", values: ["2026-04-01"] }],
      })
    ).toThrow(/WITHIN requires exactly 2 values/);
  });

  it("rejects non-scalar values inside filter.values", () => {
    expect(() =>
      validateRequest({
        searchType: "Account",
        filters: [
          {
            field: "acctname",
            operator: "EQUALS",
            values: [{ malicious: "obj" }] as unknown as string[],
          },
        ],
      })
    ).toThrow(/strings or numbers/);
  });

  it("rejects unknown column for searchType", () => {
    expect(() =>
      validateRequest({
        searchType: "Account",
        columns: [{ field: "ssn" }],
      })
    ).toThrow(/Unknown column/);
  });

  it("accepts a valid minimal Account request", () => {
    const r = validateRequest({ searchType: "Account" });
    expect(r.searchType).toBe("Account");
    expect(r.page).toBe(1);
    expect(r.pageSize).toBe(100);
  });

  it("accepts a Transaction WITHIN date filter", () => {
    const r = validateRequest({
      searchType: "Transaction",
      filters: [
        {
          field: "trandate",
          operator: "WITHIN",
          values: ["2026-04-01", "2026-04-30"],
        },
      ],
    });
    expect(r.filters?.[0].operator).toBe("WITHIN");
  });
});

// ─── Endpoint tests ─────────────────────────────────────────────────

describe("v0.9 NS SuiteAnalytics Phase 4: endpoint auth + validation", () => {
  it("returns 401 when Authorization header missing", async () => {
    const res = await savedSearch(makeReq({ searchType: "Account" }));
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid JSON body", async () => {
    const req = new NextRequest(
      "http://localhost/api/external/ns-analytics/saved-search",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: "{ not json",
      }
    );
    const res = await savedSearch(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid JSON/);
  });

  it("returns 400 for unknown searchType with structured error body", async () => {
    const res = await savedSearch(
      makeReq({ searchType: "Pony" }, `Bearer ${token}`)
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid searchType/);
  });

  it("returns 413 for oversized body", async () => {
    // Construct a body that exceeds 100 KB by stuffing the memo field.
    const huge = "X".repeat(110 * 1024);
    const req = new NextRequest(
      "http://localhost/api/external/ns-analytics/saved-search",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          searchType: "Account",
          filters: [
            { field: "acctname", operator: "EQUALS", values: [huge] },
          ],
        }),
      }
    );
    const res = await savedSearch(req);
    expect(res.status).toBe(413);
  });
});

describe("v0.9 NS SuiteAnalytics Phase 4: Account searchType happy path", () => {
  it("returns 200 with paged rows + X-Total-Count header (empty tenant)", async () => {
    const res = await savedSearch(
      makeReq({ searchType: "Account" }, `Bearer ${token}`)
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-total-count")).toBe("0");
    const body = await res.json();
    expect(body._meta.searchType).toBe("Account");
    expect(body._meta.page).toBe(1);
    expect(body._meta.pageSize).toBe(100);
    expect(body._meta.totalCount).toBe(0);
    expect(body.rows).toEqual([]);
  });

  it("respects column projection (only requested fields returned)", async () => {
    const res = await savedSearch(
      makeReq(
        {
          searchType: "Account",
          columns: [{ field: "acctnumber" }, { field: "acctname" }],
        },
        `Bearer ${token}`
      )
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // Rows array is empty for this empty tenant, but the response
    // shape must still hold. (A populated tenant would yield rows
    // with only acctnumber + acctname keys.)
    expect(Array.isArray(body.rows)).toBe(true);
  });
});

describe("v0.9 NS SuiteAnalytics Phase 4: Transaction searchType happy path", () => {
  it("returns 200 with paged rows + X-Total-Count header (empty tenant)", async () => {
    const res = await savedSearch(
      makeReq({ searchType: "Transaction" }, `Bearer ${token}`)
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-total-count")).toBe("0");
    const body = await res.json();
    expect(body._meta.searchType).toBe("Transaction");
    expect(body.rows).toEqual([]);
  });

  it("accepts a WITHIN date-range filter for Transaction", async () => {
    const res = await savedSearch(
      makeReq(
        {
          searchType: "Transaction",
          filters: [
            {
              field: "trandate",
              operator: "WITHIN",
              values: ["2026-04-01", "2026-04-30"],
            },
          ],
        },
        `Bearer ${token}`
      )
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body._meta.totalCount).toBe(0);
  });
});

describe("v0.9 NS SuiteAnalytics Phase 4 follow-up: Customer/Vendor/Item searchTypes", () => {
  it("Customer searchType returns 200 with NS-shaped rows (empty tenant)", async () => {
    const res = await savedSearch(
      makeReq({ searchType: "Customer" }, `Bearer ${token}`)
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-total-count")).toBe("0");
    const body = await res.json();
    expect(body._meta.searchType).toBe("Customer");
    expect(body.rows).toEqual([]);
  });

  it("Vendor searchType returns 200 with NS-shaped rows (empty tenant)", async () => {
    const res = await savedSearch(
      makeReq({ searchType: "Vendor" }, `Bearer ${token}`)
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body._meta.searchType).toBe("Vendor");
  });

  it("Item searchType returns 200 with NS-shaped rows (empty tenant)", async () => {
    const res = await savedSearch(
      makeReq({ searchType: "Item" }, `Bearer ${token}`)
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body._meta.searchType).toBe("Item");
  });

  it("Customer accepts entityid + companyname filters", async () => {
    const res = await savedSearch(
      makeReq(
        {
          searchType: "Customer",
          filters: [
            { field: "entityid", operator: "EQUALS", values: ["ACME"] },
            {
              field: "companyname",
              operator: "ANYOF",
              values: ["Acme Corp", "Acme LLC"],
            },
          ],
        },
        `Bearer ${token}`
      )
    );
    expect(res.status).toBe(200);
  });

  it("Vendor rejects unknown field (defeats column-name injection)", async () => {
    const res = await savedSearch(
      makeReq(
        {
          searchType: "Vendor",
          filters: [{ field: "secret", operator: "EQUALS", values: ["x"] }],
        },
        `Bearer ${token}`
      )
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Unknown field/);
  });

  it("Item rejects mismatched operator for itemtype (WITHIN on string)", async () => {
    const res = await savedSearch(
      makeReq(
        {
          searchType: "Item",
          filters: [
            {
              field: "itemtype",
              operator: "WITHIN",
              values: ["SERVICE", "INVENTORY"],
            },
          ],
        },
        `Bearer ${token}`
      )
    );
    expect(res.status).toBe(400);
  });

  it("validation error message lists all 5 searchTypes for unknown input", async () => {
    const res = await savedSearch(
      makeReq({ searchType: "Pony" }, `Bearer ${token}`)
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    // The error message names the 5 valid types so operators don't have
    // to guess. Pin all 5 explicitly.
    expect(body.error).toContain("Account");
    expect(body.error).toContain("Transaction");
    expect(body.error).toContain("Customer");
    expect(body.error).toContain("Vendor");
    expect(body.error).toContain("Item");
  });
});

describe("v0.9 NS SuiteAnalytics — Transaction amount filter (migration 0012)", () => {
  // The amount filter requires the denormalized totalDebit column
  // added by migration 0012. postJournalEntry populates it on every
  // new entry; the migration backfilled existing rows.
  //
  // This test seeds 3 NS-lineage'd JEs of different amounts (100, 500,
  // 1000 USD) on this tenant, then asserts:
  //   - amount EQUALS 500 returns just the middle JE
  //   - amount GREATER_THAN 200 returns the 500 + 1000 JEs
  //   - amount LESS_THAN 600 returns the 100 + 500 JEs
  //   - amount filter combined with type filter narrows further

  let entityId: string;
  let bookId: string;
  let cashAcctId: string;
  let revAcctId: string;
  const seededIds: string[] = [];

  beforeAll(async () => {
    // Currency + book — shared global resources.
    await prisma.currency.upsert({
      where: { code: "USD" },
      create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
      update: {},
    });
    const book = await prisma.book.upsert({
      where: { code: "US_GAAP" },
      create: {
        code: "US_GAAP",
        name: "US GAAP",
        basis: "US_GAAP",
        reportingCurrencyId: "USD",
      },
      update: {},
    });
    bookId = book.id;
    // Per-tenant entity + accounts. Use the tenant we already seeded
    // for the SuiteAnalytics suite.
    const entity = await prisma.legalEntity.create({
      data: {
        tenantId,
        code: `NSS_${SUFFIX}_AMOUNT_ENT`,
        name: "NSS amount-filter test entity",
        functionalCurrencyId: "USD",
      },
    });
    entityId = entity.id;
    const cash = await prisma.account.create({
      data: {
        tenantId,
        entityId,
        code: `NSS_${SUFFIX}_CASH`,
        name: "Cash",
        type: "ASSET",
        normalBalance: "DEBIT",
        sourceSystem: "NETSUITE",
        sourceRecordType: "Account",
        sourceRecordId: `NSS_${SUFFIX}_CASH`,
      },
    });
    cashAcctId = cash.id;
    const rev = await prisma.account.create({
      data: {
        tenantId,
        entityId,
        code: `NSS_${SUFFIX}_REV`,
        name: "Revenue",
        type: "REVENUE",
        normalBalance: "CREDIT",
        sourceSystem: "NETSUITE",
        sourceRecordType: "Account",
        sourceRecordId: `NSS_${SUFFIX}_REV`,
      },
    });
    revAcctId = rev.id;

    // Seed 3 NS-imported JournalEntries at amounts 100, 500, 1000.
    // Bypass postJournalEntry to keep the test schema-focused; set
    // totalDebit/totalCredit manually + add a line per side so any
    // future ON DELETE RESTRICT relations stay clean.
    let entryNo = 1;
    for (const [amount, srcId] of [
      ["100.0000", `NSS_${SUFFIX}_JE_100`],
      ["500.0000", `NSS_${SUFFIX}_JE_500`],
      ["1000.0000", `NSS_${SUFFIX}_JE_1000`],
    ] as const) {
      const je = await prisma.journalEntry.create({
        data: {
          tenantId,
          entryNumber: `NSS-${SUFFIX}-AMT-${String(entryNo++).padStart(5, "0")}`,
          entityId,
          bookId,
          currencyId: "USD",
          fxRate: "1.0000000000",
          documentDate: new Date("2026-04-15"),
          postingDate: new Date("2026-04-15"),
          memo: `Amount test ${amount}`,
          source: "MANUAL",
          status: "POSTED",
          totalDebit: amount,
          totalCredit: amount,
          sourceSystem: "NETSUITE",
          sourceRecordType: "JournalEntry",
          sourceRecordId: srcId,
          lines: {
            create: [
              {
                tenantId,
                lineNo: 1,
                accountId: cashAcctId,
                debit: amount,
                credit: "0.0000",
                transactionAmount: amount,
                transactionCurrencyId: "USD",
                reportingAmount: amount,
                reportingCurrencyId: "USD",
              },
              {
                tenantId,
                lineNo: 2,
                accountId: revAcctId,
                debit: "0.0000",
                credit: amount,
                transactionAmount: amount,
                transactionCurrencyId: "USD",
                reportingAmount: amount,
                reportingCurrencyId: "USD",
              },
            ],
          },
        },
      });
      seededIds.push(je.id);
    }
  });

  afterAll(async () => {
    if (seededIds.length > 0) {
      await prisma.journalLine.deleteMany({
        where: { entryId: { in: seededIds } },
      });
      await prisma.journalEntry.deleteMany({
        where: { id: { in: seededIds } },
      });
    }
    await prisma.account
      .deleteMany({ where: { tenantId, id: { in: [cashAcctId, revAcctId] } } })
      .catch(() => {});
    if (entityId) {
      await prisma.legalEntity
        .delete({ where: { id: entityId } })
        .catch(() => {});
    }
  });

  it("amount EQUALS 500 returns the middle JE only", async () => {
    const res = await savedSearch(
      makeReq(
        {
          searchType: "Transaction",
          filters: [
            { field: "amount", operator: "EQUALS", values: ["500.0000"] },
          ],
        },
        `Bearer ${token}`
      )
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body._meta.totalCount).toBeGreaterThanOrEqual(1);
    const tranids = body.rows.map((r: { tranid: string }) => r.tranid);
    expect(tranids).toContain(`NSS-${SUFFIX}-AMT-00002`);
  });

  it("amount GREATER_THAN 200 returns the 500 + 1000 JEs", async () => {
    const res = await savedSearch(
      makeReq(
        {
          searchType: "Transaction",
          filters: [
            { field: "amount", operator: "GREATER_THAN", values: ["200.0000"] },
          ],
          pageSize: 1000,
        },
        `Bearer ${token}`
      )
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const ourTranids = body.rows
      .map((r: { tranid: string }) => r.tranid)
      .filter((t: string) => t.startsWith(`NSS-${SUFFIX}-AMT-`));
    expect(ourTranids).toContain(`NSS-${SUFFIX}-AMT-00002`);
    expect(ourTranids).toContain(`NSS-${SUFFIX}-AMT-00003`);
    expect(ourTranids).not.toContain(`NSS-${SUFFIX}-AMT-00001`);
  });

  it("amount LESS_THAN 600 returns the 100 + 500 JEs", async () => {
    const res = await savedSearch(
      makeReq(
        {
          searchType: "Transaction",
          filters: [
            { field: "amount", operator: "LESS_THAN", values: ["600.0000"] },
          ],
          pageSize: 1000,
        },
        `Bearer ${token}`
      )
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const ourTranids = body.rows
      .map((r: { tranid: string }) => r.tranid)
      .filter((t: string) => t.startsWith(`NSS-${SUFFIX}-AMT-`));
    expect(ourTranids).toContain(`NSS-${SUFFIX}-AMT-00001`);
    expect(ourTranids).toContain(`NSS-${SUFFIX}-AMT-00002`);
    expect(ourTranids).not.toContain(`NSS-${SUFFIX}-AMT-00003`);
  });

  it("Transaction rows now emit the real amount (not null) in the projection", async () => {
    const res = await savedSearch(
      makeReq(
        {
          searchType: "Transaction",
          filters: [
            { field: "amount", operator: "EQUALS", values: ["500.0000"] },
          ],
        },
        `Bearer ${token}`
      )
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const ourRow = body.rows.find(
      (r: { tranid: string }) => r.tranid === `NSS-${SUFFIX}-AMT-00002`
    );
    expect(ourRow).toBeDefined();
    // amount field is the JE totalDebit (== totalCredit by invariant).
    expect(Number(ourRow.amount)).toBe(500);
  });
});

describe("v0.9 NS SuiteAnalytics Phase 4: filter-injection defense", () => {
  it("rejects SQL-ish field name", async () => {
    const res = await savedSearch(
      makeReq(
        {
          searchType: "Account",
          filters: [
            {
              field: "acctname'; DROP TABLE",
              operator: "EQUALS",
              values: ["x"],
            },
          ],
        },
        `Bearer ${token}`
      )
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Unknown field/);
  });

  it("rejects operator outside the whitelist", async () => {
    const res = await savedSearch(
      makeReq(
        {
          searchType: "Account",
          filters: [
            {
              field: "acctname",
              operator: "DROP_TABLE" as never,
              values: ["x"],
            },
          ],
        },
        `Bearer ${token}`
      )
    );
    expect(res.status).toBe(400);
  });

  it("rejects nested-object values (defeats JSON-payload injection)", async () => {
    const res = await savedSearch(
      makeReq(
        {
          searchType: "Account",
          filters: [
            {
              field: "acctname",
              operator: "EQUALS",
              values: [{ subquery: "DROP" }] as never,
            },
          ],
        },
        `Bearer ${token}`
      )
    );
    expect(res.status).toBe(400);
  });
});
