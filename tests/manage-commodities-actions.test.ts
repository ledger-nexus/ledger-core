// createCommodityAction + recordCommodityPriceAction tests.
//
// These two actions are what made the commodity/lots arc reachable at all:
// nothing in the app could create a Commodity (so every trade failed with
// "unknown commodity") and nothing could record a price (so /holdings could
// only ever report cost).
//
// Verified:
//   1. Create: row lands, symbol upper-cased, tenant-scoped.
//   2. Create: duplicate symbol refused.
//   3. Create: signed out writes nothing.
//   4. Price: records, and getCommodityPrice then resolves it.
//   5. Price: last-write-wins on the same (commodity, currency, date).
//   6. Price: unknown symbol refused with guidance, not auto-created — the
//      substrate does not invent master data.
//   7. Price: negative refused; zero allowed (a worthless position is real).
//   8. Price: another tenant's symbol is invisible.
//   9. Audit rows for both actions.

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
import {
  createCommodityAction,
  recordCommodityPriceAction,
} from "@/app/actions/manage-commodities";
import { getCommodityPrice } from "@/lib/accounting/commodity-price";
import { withAuditLogMutableTransaction } from "./_helpers/audit-log-cleanup";

const prisma = new PrismaClient();

const SUFFIX = ("MC" + Date.now().toString(36) + Math.floor(Math.random() * 9999)).toUpperCase();
const SYM = `${SUFFIX}A`;
const OTHER_SYM = `${SUFFIX}B`;

let tenant: { id: string; slug: string };
let otherTenant: { id: string; slug: string };
let user: { id: string; email: string };
let otherUser: { id: string; email: string };

beforeAll(async () => {
  await prisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    update: {},
  });

  const u = await prisma.user.create({
    data: { email: `mc-${SUFFIX}@example.test`, displayName: "Commodity tester", isActive: true },
  });
  user = { id: u.id, email: u.email };
  tenant = await prisma.tenant.create({
    data: { slug: `mc-${SUFFIX.toLowerCase()}`, name: "Commodity tenant", ownerUserId: u.id },
  });
  await prisma.tenantMembership.create({
    data: { tenantId: tenant.id, userId: u.id, role: "OWNER" },
  });

  const ou = await prisma.user.create({
    data: { email: `mcx-${SUFFIX}@example.test`, displayName: "Other", isActive: true },
  });
  otherUser = { id: ou.id, email: ou.email };
  otherTenant = await prisma.tenant.create({
    data: { slug: `mcx-${SUFFIX.toLowerCase()}`, name: "Other tenant", ownerUserId: ou.id },
  });
  await prisma.tenantMembership.create({
    data: { tenantId: otherTenant.id, userId: ou.id, role: "OWNER" },
  });

  // A commodity that belongs ONLY to the other tenant.
  await prisma.commodity.create({
    data: { tenantId: otherTenant.id, symbol: OTHER_SYM, name: "Other Co." },
  });
});

afterAll(async () => {
  await prisma.commodityPrice.deleteMany({
    where: { tenantId: { in: [tenant.id, otherTenant.id] } },
  });
  await prisma.commodity.deleteMany({
    where: { tenantId: { in: [tenant.id, otherTenant.id] } },
  });
  // app_user hard-deletes need the audit-mutable window: Postgres runs a
  // referential-integrity query for audit_log_actorUserId_fkey and the
  // append-only RULE rewrites it, failing with XX000.
  await withAuditLogMutableTransaction(prisma, async (tx) => {
    await tx.auditLog.deleteMany({
      where: {
        OR: [
          { tenantId: { in: [tenant.id, otherTenant.id] } },
          { actorUserId: { in: [user.id, otherUser.id] } },
        ],
      },
    });
    await tx.tenantMembership.deleteMany({
      where: { tenantId: { in: [tenant.id, otherTenant.id] } },
    });
    await tx.tenant.deleteMany({ where: { id: { in: [tenant.id, otherTenant.id] } } });
    await tx.user.deleteMany({ where: { id: { in: [user.id, otherUser.id] } } });
  });
  await prisma.$disconnect();
});

function signIn() {
  mockCookieStore.clear();
  mockCookieStore.set("lc-user", { value: authInternal.encode(user.id) });
  mockCookieStore.set("lc-tenant", { value: tenant.slug });
}

function signOut() {
  mockCookieStore.clear();
}

describe("createCommodityAction", () => {
  it("creates the commodity, upper-casing the symbol", async () => {
    signIn();
    // Lowercase in: the action normalises so one security can't become two.
    const r = await createCommodityAction({
      symbol: SYM.toLowerCase(),
      name: "Test Security",
      assetClass: "equity",
    });
    expect(r.ok).toBe(true);
    const row = await prisma.commodity.findFirstOrThrow({
      where: { id: r.commodityId! },
      select: { symbol: true, assetClass: true, tenantId: true },
    });
    expect(row.symbol).toBe(SYM);
    expect(row.assetClass).toBe("EQUITY");
    expect(row.tenantId).toBe(tenant.id);
  });

  it("refuses a duplicate symbol", async () => {
    signIn();
    const r = await createCommodityAction({ symbol: SYM, name: "Dup" });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/already on file/i);
  });

  it("refuses when signed out, writing nothing", async () => {
    signOut();
    const before = await prisma.commodity.count({ where: { tenantId: tenant.id } });
    const r = await createCommodityAction({ symbol: `${SUFFIX}Z`, name: "Nope" });
    expect(r.ok).toBe(false);
    const after = await prisma.commodity.count({ where: { tenantId: tenant.id } });
    expect(after).toBe(before);
  });

  it("writes a COMMODITY_CREATED audit row", async () => {
    const log = await prisma.auditLog.findFirst({
      where: { tenantId: tenant.id, action: "COMMODITY_CREATED" },
      orderBy: { occurredAt: "desc" },
      select: { eventType: true, actorUserId: true, metadata: true },
    });
    expect(log?.eventType).toBe("PRIVILEGED_ACTION");
    expect(log?.actorUserId).toBe(user.id);
    expect((log?.metadata as Record<string, unknown>).symbol).toBe(SYM);
  });
});

describe("recordCommodityPriceAction", () => {
  it("records a price the resolver can then find", async () => {
    signIn();
    const r = await recordCommodityPriceAction({
      symbol: SYM,
      currencyCode: "USD",
      asOf: "2026-07-01",
      price: "187.42",
    });
    expect(r.ok).toBe(true);

    const found = await getCommodityPrice(prisma, {
      tenantId: tenant.id,
      commoditySymbol: SYM,
      currencyCode: "USD",
      asOf: new Date("2026-07-15"),
    });
    expect(found).not.toBeNull();
    expect(found!.price.toFixed(2)).toBe("187.42");
  });

  it("last write wins for the same commodity + currency + date", async () => {
    signIn();
    await recordCommodityPriceAction({
      symbol: SYM,
      currencyCode: "USD",
      asOf: "2026-07-01",
      price: "190.00",
    });
    const rows = await prisma.commodityPrice.count({
      where: { tenantId: tenant.id, asOf: new Date("2026-07-01T00:00:00.000Z") },
    });
    // Upsert, not insert — one row per (commodity, currency, date).
    expect(rows).toBe(1);
    const found = await getCommodityPrice(prisma, {
      tenantId: tenant.id,
      commoditySymbol: SYM,
      currencyCode: "USD",
      asOf: new Date("2026-07-15"),
    });
    expect(found!.price.toFixed(2)).toBe("190.00");
  });

  it("refuses an unknown symbol instead of creating one", async () => {
    signIn();
    const before = await prisma.commodity.count({ where: { tenantId: tenant.id } });
    const r = await recordCommodityPriceAction({
      symbol: `${SUFFIX}GHOST`,
      currencyCode: "USD",
      asOf: "2026-07-01",
      price: "1",
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/not on file/i);
    const after = await prisma.commodity.count({ where: { tenantId: tenant.id } });
    expect(after).toBe(before);
  });

  it("refuses a negative price but allows zero", async () => {
    signIn();
    const neg = await recordCommodityPriceAction({
      symbol: SYM,
      currencyCode: "USD",
      asOf: "2026-07-02",
      price: "-5",
    });
    expect(neg.ok).toBe(false);
    expect(neg.message).toMatch(/zero or positive/i);

    // Zero is a legitimate mark: a position that went worthless.
    const zero = await recordCommodityPriceAction({
      symbol: SYM,
      currencyCode: "USD",
      asOf: "2026-07-02",
      price: "0",
    });
    expect(zero.ok).toBe(true);
  });

  it("refuses a non-numeric price", async () => {
    signIn();
    const r = await recordCommodityPriceAction({
      symbol: SYM,
      currencyCode: "USD",
      asOf: "2026-07-03",
      price: "one hundred",
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/must be a number/i);
  });

  it("cannot price another tenant's commodity", async () => {
    signIn(); // tenant A
    const r = await recordCommodityPriceAction({
      symbol: OTHER_SYM, // belongs to tenant B
      currencyCode: "USD",
      asOf: "2026-07-01",
      price: "50",
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/not on file/i);
    const leaked = await prisma.commodityPrice.count({
      where: { tenantId: otherTenant.id },
    });
    expect(leaked).toBe(0);
  });

  it("writes a COMMODITY_PRICE_RECORDED audit row", async () => {
    const log = await prisma.auditLog.findFirst({
      where: { tenantId: tenant.id, action: "COMMODITY_PRICE_RECORDED" },
      orderBy: { occurredAt: "desc" },
      select: { eventType: true, metadata: true },
    });
    expect(log?.eventType).toBe("PRIVILEGED_ACTION");
    const meta = log?.metadata as Record<string, unknown>;
    expect(meta.symbol).toBe(SYM);
    expect(meta.source).toBe("MANUAL");
  });
});
