// recordCommodityTradeAction — the gated entry point to the lots machinery.
//
// This is the control the domain commands were deliberately left without until
// now: auth, session-derived scope, and a privileged-action audit row. The
// posting mechanics themselves are covered by tests/commodity-trade.test.ts;
// what matters here is that the gate holds and the trade is attributable.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

const mockCookieStore = new Map<string, { value: string }>();
vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) => mockCookieStore.get(name),
    set: (opts: { name: string; value: string } | string, maybeValue?: string) => {
      if (typeof opts === "string") mockCookieStore.set(opts, { value: maybeValue ?? "" });
      else mockCookieStore.set(opts.name, { value: opts.value });
    },
    delete: (name: string) => mockCookieStore.delete(name),
  }),
  headers: () => ({ get: () => null }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { _internal as authInternal } from "@/lib/auth/current-user";
import { recordCommodityTradeAction } from "@/app/actions/record-commodity-trade";
import { withAuditLogMutableTransaction } from "./_helpers/audit-log-cleanup";

const prisma = new PrismaClient();

const SUFFIX = ("TRA" + Date.now().toString(36) + Math.floor(Math.random() * 9999)).toUpperCase();
const ENTITY_CODE = `TRA-${SUFFIX}`;

let tenant: { id: string; slug: string };
let user: { id: string; email: string };
let entityId: string;

beforeAll(async () => {
  await prisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    update: {},
  });
  await prisma.book.upsert({
    where: { code: "US_GAAP" },
    create: { code: "US_GAAP", name: "US GAAP", basis: "US_GAAP", reportingCurrencyId: "USD" },
    update: {},
  });

  const u = await prisma.user.create({
    data: { email: `tra-${SUFFIX}@example.test`, displayName: "Trade action tester", isActive: true },
  });
  user = { id: u.id, email: u.email };
  tenant = await prisma.tenant.create({
    data: { slug: `tra-${SUFFIX.toLowerCase()}`, name: "Trade action tenant", ownerUserId: u.id },
  });
  await prisma.tenantMembership.create({ data: { tenantId: tenant.id, userId: u.id, role: "OWNER" } });

  // Exactly ONE entity in this tenant, so getCurrentScope resolves it via the
  // fallback and bookCode defaults to US_GAAP — no lc-scope cookie needed.
  const entity = await prisma.legalEntity.create({
    data: { tenantId: tenant.id, code: ENTITY_CODE, name: "Trade Action Co.", functionalCurrencyId: "USD" },
  });
  entityId = entity.id;

  await prisma.account.createMany({
    data: [
      { tenantId: tenant.id, entityId, code: "INVEST", name: "Investments", type: "ASSET", normalBalance: "DEBIT" },
      { tenantId: tenant.id, entityId, code: "CASH", name: "Cash", type: "ASSET", normalBalance: "DEBIT" },
      { tenantId: tenant.id, entityId, code: "GAIN", name: "Realized gain", type: "REVENUE", normalBalance: "CREDIT" },
      { tenantId: tenant.id, entityId, code: "LOSS", name: "Realized loss", type: "EXPENSE", normalBalance: "DEBIT" },
    ],
  });
  await prisma.commodity.create({ data: { tenantId: tenant.id, symbol: "AAPL", name: "Apple Inc." } });
});

afterAll(async () => {
  await prisma.lot.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.commodity.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.journalLine.deleteMany({ where: { entry: { entityId } } });
  await prisma.journalEntry.deleteMany({ where: { entityId } });
  await prisma.account.deleteMany({ where: { entityId } });
  await prisma.recordEvent.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.legalEntity.deleteMany({ where: { id: entityId } });
  await withAuditLogMutableTransaction(prisma, async (tx) => {
    await tx.auditLog.deleteMany({ where: { OR: [{ tenantId: tenant.id }, { actorUserId: user.id }] } });
    await tx.tenantMembership.deleteMany({ where: { tenantId: tenant.id } });
    await tx.tenant.delete({ where: { id: tenant.id } });
    await tx.user.delete({ where: { id: user.id } });
  });
  await prisma.$disconnect();
});

function signIn() {
  mockCookieStore.clear();
  mockCookieStore.set("lc-user", { value: authInternal.encode(user.id) });
  mockCookieStore.set("lc-tenant", { value: tenant.slug });
}

const BUY = {
  side: "BUY" as const,
  commoditySymbol: "AAPL",
  units: "10",
  price: "100",
  currencyCode: "USD",
  tradeDate: "2026-01-01",
  investmentAccountCode: "INVEST",
  cashAccountCode: "CASH",
};

describe("recordCommodityTradeAction — the gate", () => {
  it("refuses when not signed in", async () => {
    mockCookieStore.clear();
    const r = await recordCommodityTradeAction(BUY);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/signed in/i);
  });

  it("refuses non-positive units", async () => {
    signIn();
    const r = await recordCommodityTradeAction({ ...BUY, units: "0" });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/positive/i);
  });

  it("refuses a SELL without gain/loss accounts", async () => {
    signIn();
    const r = await recordCommodityTradeAction({
      ...BUY, side: "SELL", price: "130", tradeDate: "2026-03-01",
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/gain and loss/i);
  });
});

describe("recordCommodityTradeAction — BUY", () => {
  it("posts the purchase, opens a lot, and writes an audit row", async () => {
    signIn();
    const r = await recordCommodityTradeAction(BUY);
    expect(r.ok).toBe(true);
    expect(r.entryNumber).toBeTruthy();
    expect(r.lotId).toBeTruthy();

    const lot = await prisma.lot.findUniqueOrThrow({ where: { id: r.lotId! } });
    expect(lot.remainingUnits.toFixed(0)).toBe("10");
    expect(lot.openedByEntryId).toBe(r.entryId);

    const audit = await prisma.auditLog.findFirst({
      where: {
        eventType: "PRIVILEGED_ACTION",
        action: "record-commodity-trade",
        tenantId: tenant.id,
        resourceId: "AAPL",
      },
      orderBy: { occurredAt: "desc" },
      select: { metadata: true, actorEmail: true, outcome: true },
    });
    expect(audit).not.toBeNull();
    expect(audit!.outcome).toBe("SUCCESS");
    expect(audit!.actorEmail).toBe(user.email); // the trade is attributable
    expect((audit!.metadata as Record<string, unknown>).side).toBe("BUY");
  });
});

describe("recordCommodityTradeAction — SELL", () => {
  it("posts the disposal with realized gain and audits the result", async () => {
    signIn();
    const r = await recordCommodityTradeAction({
      side: "SELL",
      commoditySymbol: "AAPL",
      units: "4",
      price: "130",
      currencyCode: "USD",
      tradeDate: "2026-03-01",
      investmentAccountCode: "INVEST",
      cashAccountCode: "CASH",
      gainAccountCode: "GAIN",
      lossAccountCode: "LOSS",
      method: "FIFO",
    });
    expect(r.ok).toBe(true);
    // 4 units @100 cost = 400; proceeds 4*130 = 520; gain 120.
    expect(r.realizedGain).toBe("120.00");

    const lot = await prisma.lot.findFirstOrThrow({ where: { tenantId: tenant.id, status: "OPEN" } });
    expect(lot.remainingUnits.toFixed(0)).toBe("6");

    const audit = await prisma.auditLog.findFirst({
      where: {
        eventType: "PRIVILEGED_ACTION",
        action: "record-commodity-trade",
        tenantId: tenant.id,
        resourceId: "AAPL",
      },
      orderBy: { occurredAt: "desc" },
      select: { metadata: true },
    });
    const meta = audit!.metadata as Record<string, unknown>;
    expect(meta.side).toBe("SELL");
    expect(meta.realizedGain).toBe("120.00");
    expect(meta.proceeds).toBe("520.00");
    expect(meta.lotsConsumed).toBe(1);
  });
});
