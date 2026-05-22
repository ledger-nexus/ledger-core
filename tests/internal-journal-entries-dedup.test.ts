// Idempotency test for POST /api/internal/journal-entries.
//
// Verifies the dedup-by-lineage-triple contract that fa-amort,
// integrations, and the future bank-lines endpoint rely on:
//
//   - A repeat POST with the same (sourceSystem, sourceRecordType,
//     sourceRecordId) returns the existing entry's id + entryNumber
//     with `wasDuplicate: true`. NO new row is inserted.
//
//   - A POST without a complete lineage triple is NOT deduped — every
//     such call creates a new entry (manual postings, native seeds).
//
// We invoke the route handler directly with a synthetic NextRequest;
// no HTTP server is started. This keeps the test fast and deterministic.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { PrismaClient } from "@prisma/client";
import { POST } from "../src/app/api/internal/journal-entries/route";

const prisma = new PrismaClient();

const TOKEN = "test-internal-token-dedup";
const ENTITY_CODE = "DEDUPCO";
const SCOPE = { entityCode: ENTITY_CODE, bookCode: "US_GAAP" };

beforeAll(async () => {
  process.env.INTERNAL_API_TOKEN = TOKEN;
  await seedMasterData();
});

beforeEach(async () => {
  await prisma.journalLine.deleteMany({
    where: { entry: { entity: { code: ENTITY_CODE } } },
  });
  await prisma.journalEntry.deleteMany({
    where: { entity: { code: ENTITY_CODE } },
  });
});

async function seedMasterData() {
  await prisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    update: {},
  });
  const entity = await prisma.legalEntity.upsert({
    where: { code: ENTITY_CODE },
    create: { code: ENTITY_CODE, name: "Dedup Co.", functionalCurrencyId: "USD" },
    update: {},
  });
  await prisma.book.upsert({
    where: { code: "US_GAAP" },
    create: {
      code: "US_GAAP",
      name: "US GAAP",
      basis: "US_GAAP",
      reportingCurrencyId: "USD",
    },
    update: {},
  });
  // Two minimal accounts to satisfy postJournalEntry's account checks.
  for (const a of [
    { code: "1000", name: "Cash", type: "ASSET", normalBalance: "DEBIT" },
    { code: "4000", name: "Revenue", type: "REVENUE", normalBalance: "CREDIT" },
  ] as const) {
    const existing = await prisma.account.findFirst({
      where: { entityId: entity.id, code: a.code },
    });
    if (!existing) {
      await prisma.account.create({
        data: {
          entityId: entity.id,
          code: a.code,
          name: a.name,
          type: a.type,
          normalBalance: a.normalBalance,
        },
      });
    }
  }
}

function buildBody(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    entityCode: ENTITY_CODE,
    bookCode: SCOPE.bookCode,
    currencyCode: "USD",
    documentDate: "2026-05-31",
    memo: "Dedup test entry",
    source: "SYSTEM",
    lines: [
      { accountCode: "1000", debit: "100.00" },
      { accountCode: "4000", credit: "100.00" },
    ],
    ...overrides,
  };
}

function buildRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/internal/journal-entries", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/internal/journal-entries — lineage dedup", () => {
  it("first call creates a new entry", async () => {
    const res = await POST(
      buildRequest(
        buildBody({
          sourceSystem: "fa-amort",
          sourceRecordType: "DepreciationRun",
          sourceRecordId: "asset-1:US_GAAP:2026-05-31",
        })
      )
    );
    const json = (await res.json()) as {
      ok: boolean;
      id: string;
      entryNumber: string;
      wasDuplicate?: boolean;
    };
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.id).toBeTruthy();
    expect(json.entryNumber).toBeTruthy();
    expect(json.wasDuplicate).toBeUndefined();
  });

  it("repeat call with the same triple returns the existing entry with wasDuplicate=true and does NOT insert", async () => {
    const body = buildBody({
      sourceSystem: "fa-amort",
      sourceRecordType: "DepreciationRun",
      sourceRecordId: "asset-2:US_GAAP:2026-05-31",
    });
    const res1 = await POST(buildRequest(body));
    const j1 = (await res1.json()) as { id: string; entryNumber: string };

    const res2 = await POST(buildRequest(body));
    const j2 = (await res2.json()) as {
      id: string;
      entryNumber: string;
      wasDuplicate?: boolean;
    };
    expect(res2.status).toBe(200);
    expect(j2.id).toBe(j1.id);
    expect(j2.entryNumber).toBe(j1.entryNumber);
    expect(j2.wasDuplicate).toBe(true);

    // Confirm exactly ONE row exists in the DB.
    const count = await prisma.journalEntry.count({
      where: {
        sourceSystem: "fa-amort",
        sourceRecordType: "DepreciationRun",
        sourceRecordId: "asset-2:US_GAAP:2026-05-31",
      },
    });
    expect(count).toBe(1);
  });

  it("call WITHOUT lineage triple is NOT deduped — every call creates a new row", async () => {
    const body = buildBody(); // no sourceSystem/sourceRecordType/sourceRecordId
    const r1 = await POST(buildRequest(body));
    const r2 = await POST(buildRequest(body));
    const j1 = (await r1.json()) as { id: string };
    const j2 = (await r2.json()) as { id: string };
    expect(j1.id).not.toBe(j2.id);

    const count = await prisma.journalEntry.count({
      where: { entity: { code: ENTITY_CODE }, sourceSystem: null },
    });
    expect(count).toBe(2);
  });

  it("partial lineage (system + type but no recordId) is NOT deduped", async () => {
    const body = buildBody({
      sourceSystem: "fa-amort",
      sourceRecordType: "DepreciationRun",
      // sourceRecordId omitted intentionally
    });
    const r1 = await POST(buildRequest(body));
    const r2 = await POST(buildRequest(body));
    const j1 = (await r1.json()) as { id: string; wasDuplicate?: boolean };
    const j2 = (await r2.json()) as { id: string; wasDuplicate?: boolean };
    expect(j1.id).not.toBe(j2.id);
    expect(j2.wasDuplicate).toBeUndefined();
  });

  it("two DIFFERENT triples post independently — no false-positive dedup", async () => {
    const a = await POST(
      buildRequest(
        buildBody({
          sourceSystem: "fa-amort",
          sourceRecordType: "DepreciationRun",
          sourceRecordId: "asset-X:US_GAAP:2026-05-31",
        })
      )
    );
    const b = await POST(
      buildRequest(
        buildBody({
          sourceSystem: "fa-amort",
          sourceRecordType: "DepreciationRun",
          sourceRecordId: "asset-Y:US_GAAP:2026-05-31",
        })
      )
    );
    const ja = (await a.json()) as { id: string; wasDuplicate?: boolean };
    const jb = (await b.json()) as { id: string; wasDuplicate?: boolean };
    expect(ja.id).not.toBe(jb.id);
    expect(ja.wasDuplicate).toBeUndefined();
    expect(jb.wasDuplicate).toBeUndefined();
  });
});
