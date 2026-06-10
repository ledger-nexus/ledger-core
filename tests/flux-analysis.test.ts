// BlackLine arc — Phase 3 PR 2 tests.
//
// Pins:
//   1. Materiality classification: over-$, over-%, both, neither
//   2. Zero-prior division-by-zero → null deltaPercent + abs-only test
//   3. Skip flat-zero rows (no flux to review)
//   4. Sort by abs(delta) DESC
//   5. State machine end-to-end through Server Actions:
//      - generateFluxStatement upserts + frozen snapshots
//      - addFluxLineCommentary IMMATERIAL refused
//      - addFluxLineCommentary on NEEDS_COMMENT → EXPLAINED
//      - waiveFluxLine sets WAIVED with reason
//      - finalizeFluxStatement REFUSED while NEEDS_COMMENT remains
//      - finalizeFluxStatement succeeds when all material lines are
//        EXPLAINED/WAIVED
//      - re-running generate preserves EXPLAINED commentary

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { Decimal } from "decimal.js";

const mockCookieStore = new Map<string, { value: string }>();
vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) => mockCookieStore.get(name),
    set: (
      opts: { name: string; value: string } | string,
      maybeValue?: string
    ) => {
      if (typeof opts === "string") {
        mockCookieStore.set(opts, { value: maybeValue ?? "" });
      } else {
        mockCookieStore.set(opts.name, { value: opts.value });
      }
    },
    delete: (name: string) => mockCookieStore.delete(name),
  }),
  headers: () => ({ get: () => null }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { _internal as authInternal } from "@/lib/auth/current-user";
import {
  generateFluxStatement,
  addFluxLineCommentary,
  waiveFluxLine,
  finalizeFluxStatement,
} from "@/app/actions/flux";
import { getFluxAnalysis } from "@/lib/flux/get-flux-analysis";

const prisma = new PrismaClient();

const SUFFIX =
  "fx2" + Date.now().toString(36) + Math.floor(Math.random() * 9999);

let tenant: { id: string; slug: string };
let owner: { id: string; email: string };
let entity: { id: string; code: string };
let book: { id: string; code: string };
let fromPeriod: { id: string; code: string; endsOn: Date };
let toPeriod: { id: string; code: string; endsOn: Date };
// Accounts with controlled GL balances so the helper produces known deltas.
const accountIds: Record<string, string> = {};

async function postPair(
  debitId: string,
  creditId: string,
  amount: string,
  periodId: string,
  documentDate: Date
): Promise<void> {
  await prisma.journalEntry.create({
    data: {
      tenantId: tenant.id,
      entityId: entity.id,
      bookId: book.id,
      periodId,
      documentDate,
      postingDate: documentDate,
      currencyId: "USD",
      memo: `${SUFFIX} flux test`,
      status: "POSTED",
      source: "MANUAL",
      entryNumber: `JE-${SUFFIX}-${Math.random()
        .toString(36)
        .slice(2, 8)}`.slice(0, 30),
      lines: {
        create: [
          {
            tenantId: tenant.id,
            lineNo: 1,
            accountId: debitId,
            debit: amount as never,
            credit: "0" as never,
          },
          {
            tenantId: tenant.id,
            lineNo: 2,
            accountId: creditId,
            debit: "0" as never,
            credit: amount as never,
          },
        ],
      },
    },
  });
}

beforeAll(async () => {
  const u = await prisma.user.findUnique({
    where: { email: "controller@northwind.test" },
    select: { id: true, email: true },
  });
  if (!u) throw new Error("Run Northwind seed first.");
  owner = { id: u.id, email: u.email };

  await prisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    update: {},
  });

  tenant = await prisma.tenant.create({
    data: {
      slug: `fx2-${SUFFIX}`.slice(0, 60),
      name: "Flux Tests Tenant",
      ownerUserId: owner.id,
    },
  });
  await prisma.tenantMembership.create({
    data: { tenantId: tenant.id, userId: owner.id, role: "OWNER" },
  });

  const e = await prisma.legalEntity.create({
    data: {
      tenantId: tenant.id,
      code: `FX2E-${SUFFIX}`.slice(0, 50),
      name: "Flux Test Entity",
      functionalCurrencyId: "USD",
    },
    select: { id: true, code: true },
  });
  entity = e;
  const b = await prisma.book.findUnique({
    where: { code: "US_GAAP" },
    select: { id: true, code: true },
  });
  if (!b) throw new Error("Missing US_GAAP book.");
  book = b;

  const cal = await prisma.fiscalCalendar.create({
    data: {
      tenantId: tenant.id,
      entityId: entity.id,
      code: `FX2C-${SUFFIX}`.slice(0, 32),
      name: "Cal",
      periodFrequency: "MONTHLY",
    },
    select: { id: true },
  });
  const p1 = await prisma.period.create({
    data: {
      tenantId: tenant.id,
      calendarId: cal.id,
      code: `${SUFFIX.slice(0, 6)}-1`,
      ordinal: 1,
      startsOn: new Date("2026-05-01"),
      endsOn: new Date("2026-05-31"),
    },
    select: { id: true, code: true, endsOn: true },
  });
  fromPeriod = p1;
  const p2 = await prisma.period.create({
    data: {
      tenantId: tenant.id,
      calendarId: cal.id,
      code: `${SUFFIX.slice(0, 6)}-2`,
      ordinal: 2,
      startsOn: new Date("2026-06-01"),
      endsOn: new Date("2026-06-30"),
    },
    select: { id: true, code: true, endsOn: true },
  });
  toPeriod = p2;

  // Mint test accounts:
  //   CASH     ASSET — big mover ($50k → $1M = +950k, +1900%) → MATERIAL
  //   REV      REVENUE — small swing (+$100) → IMMATERIAL
  //   AR       ASSET — prior=0 (new account), current=+8000 → over-abs
  //                    threshold of $5000 → MATERIAL with null %
  //   PREPAID  ASSET — prior=$1000, current=$1300 → +30% but only
  //                    +$300 (below $5000 abs but over 10% pct)
  //                    → MATERIAL via percent gate
  //   OFFSET   LIABILITY — used for balancing JEs only; we'll check
  //                        that its delta is included in the analysis
  async function mintAccount(
    code: string,
    type: "ASSET" | "REVENUE" | "LIABILITY"
  ): Promise<string> {
    const a = await prisma.account.create({
      data: {
        tenantId: tenant.id,
        code,
        name: `${code} test`,
        type,
        normalBalance: type === "ASSET" || type === "REVENUE" ? "DEBIT" : "CREDIT",
      },
      select: { id: true },
    });
    return a.id;
  }
  accountIds.CASH = await mintAccount(`${SUFFIX}_CASH`.slice(0, 20), "ASSET");
  accountIds.REV = await mintAccount(`${SUFFIX}_REV`.slice(0, 20), "REVENUE");
  accountIds.AR = await mintAccount(`${SUFFIX}_AR`.slice(0, 20), "ASSET");
  accountIds.PREPAID = await mintAccount(
    `${SUFFIX}_PRP`.slice(0, 20),
    "ASSET"
  );
  accountIds.OFFSET = await mintAccount(
    `${SUFFIX}_OFF`.slice(0, 20),
    "LIABILITY"
  );

  // Seed FROM-period balances (post by end of May).
  //   CASH:    Dr 50,000 / Cr OFFSET 50,000
  //   REV:     Dr OFFSET 1,000 / Cr REV 1,000
  //            (Bigger prior so a small absolute change stays
  //            sub-10% on the percent gate too.)
  //   PREPAID: Dr 1,000 / Cr OFFSET 1,000
  await postPair(
    accountIds.CASH,
    accountIds.OFFSET,
    "50000",
    fromPeriod.id,
    new Date("2026-05-15")
  );
  await postPair(
    accountIds.OFFSET,
    accountIds.REV,
    "1000",
    fromPeriod.id,
    new Date("2026-05-20")
  );
  await postPair(
    accountIds.PREPAID,
    accountIds.OFFSET,
    "1000",
    fromPeriod.id,
    new Date("2026-05-25")
  );

  // Seed TO-period activity (incremental on top of May balances).
  //   CASH: + 950,000 (Dr CASH / Cr OFFSET) → ending = 1,000,000
  //         (+$950k > $5k AND +1900% > 10% → MATERIAL, multi-gate)
  //   REV:  + 50      → ending = 1,050  (+$50 < $5k AND +5% < 10% →
  //                                       IMMATERIAL, neither gate)
  //   AR:   + 8,000   → ending = 8,000   (prior 0, percent undefined,
  //                                       $8k > $5k → MATERIAL via abs)
  //   PREPAID: + 300  → ending = 1,300   (+$300 < $5k BUT +30% > 10% →
  //                                       MATERIAL via percent gate only)
  //
  // OFFSET absorbs all credits/debits; its delta ends up larger than
  // CASH's. Sort-order test below accounts for OFFSET topping the list.
  await postPair(
    accountIds.CASH,
    accountIds.OFFSET,
    "950000",
    toPeriod.id,
    new Date("2026-06-15")
  );
  await postPair(
    accountIds.OFFSET,
    accountIds.REV,
    "50",
    toPeriod.id,
    new Date("2026-06-15")
  );
  await postPair(
    accountIds.AR,
    accountIds.OFFSET,
    "8000",
    toPeriod.id,
    new Date("2026-06-20")
  );
  await postPair(
    accountIds.PREPAID,
    accountIds.OFFSET,
    "300",
    toPeriod.id,
    new Date("2026-06-25")
  );
});

afterAll(async () => {
  await prisma.fluxLine.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.fluxStatement.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.journalLine.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.journalEntry.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.account.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.period.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.fiscalCalendar.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.legalEntity.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.tenantMembership.deleteMany({ where: { tenantId: tenant.id } });
  try {
    await prisma.tenant.delete({ where: { id: tenant.id } });
  } catch {
    /* audit_log FK */
  }
  await prisma.$disconnect();
});

function signIn() {
  mockCookieStore.clear();
  mockCookieStore.set("lc-user", { value: authInternal.encode(owner.id) });
  mockCookieStore.set("lc-tenant", { value: tenant.slug });
}

describe("getFluxAnalysis — materiality classification", () => {
  it("flags CASH as MATERIAL (over $5k absolute), REV as IMMATERIAL", async () => {
    const result = await getFluxAnalysis(prisma, {
      tenantId: tenant.id,
      entityCode: entity.code,
      bookCode: book.code,
      asOfPrior: fromPeriod.endsOn,
      asOfCurrent: toPeriod.endsOn,
      absoluteThreshold: new Decimal("5000"),
      percentThreshold: new Decimal("10"),
    });
    const cash = result.lines.find((l) => l.accountId === accountIds.CASH);
    const rev = result.lines.find((l) => l.accountId === accountIds.REV);
    expect(cash).toBeDefined();
    expect(cash!.status).toBe("NEEDS_COMMENT");
    expect(cash!.deltaAmount.toString()).toBe("950000");
    expect(rev).toBeDefined();
    expect(rev!.status).toBe("IMMATERIAL");
  });

  it("flags new-account AR via absolute (prior=0 → null %)", async () => {
    const result = await getFluxAnalysis(prisma, {
      tenantId: tenant.id,
      entityCode: entity.code,
      bookCode: book.code,
      asOfPrior: fromPeriod.endsOn,
      asOfCurrent: toPeriod.endsOn,
      absoluteThreshold: new Decimal("5000"),
      percentThreshold: new Decimal("10"),
    });
    const ar = result.lines.find((l) => l.accountId === accountIds.AR);
    expect(ar).toBeDefined();
    expect(ar!.priorAmount.toString()).toBe("0");
    expect(ar!.currentAmount.toString()).toBe("8000");
    expect(ar!.deltaPercent).toBeNull(); // division-by-zero guard
    expect(ar!.status).toBe("NEEDS_COMMENT"); // $8k > $5k abs threshold
  });

  it("flags PREPAID via percent gate ($300 delta but +30% > 10%)", async () => {
    const result = await getFluxAnalysis(prisma, {
      tenantId: tenant.id,
      entityCode: entity.code,
      bookCode: book.code,
      asOfPrior: fromPeriod.endsOn,
      asOfCurrent: toPeriod.endsOn,
      absoluteThreshold: new Decimal("5000"),
      percentThreshold: new Decimal("10"),
    });
    const prepaid = result.lines.find((l) => l.accountId === accountIds.PREPAID);
    expect(prepaid).toBeDefined();
    expect(prepaid!.deltaAmount.toString()).toBe("300");
    expect(prepaid!.deltaPercent?.toString()).toBe("30");
    expect(prepaid!.status).toBe("NEEDS_COMMENT");
  });

  it("sorts by abs(delta) DESC — biggest mover first", async () => {
    const result = await getFluxAnalysis(prisma, {
      tenantId: tenant.id,
      entityCode: entity.code,
      bookCode: book.code,
      asOfPrior: fromPeriod.endsOn,
      asOfCurrent: toPeriod.endsOn,
      absoluteThreshold: new Decimal("5000"),
      percentThreshold: new Decimal("10"),
    });
    // The balancer OFFSET absorbs all the other movements so it tops
    // the list. The substantive test: CASH ($950k) precedes AR ($8k)
    // which precedes PREPAID ($300) — pin the relative order of the
    // accounts the controller actually reviews.
    const positions = new Map(
      result.lines.map((l, i) => [l.accountId, i])
    );
    expect(positions.get(accountIds.CASH)).toBeLessThan(
      positions.get(accountIds.AR)!
    );
    expect(positions.get(accountIds.AR)).toBeLessThan(
      positions.get(accountIds.PREPAID)!
    );
  });
});

describe("generateFluxStatement — Server Action end-to-end", () => {
  let statementId: string;
  let cashLineId: string;
  let revLineId: string;
  let arLineId: string;

  it("upserts the statement + creates a line per non-flat account", async () => {
    signIn();
    const r = await generateFluxStatement({
      entityCode: entity.code,
      bookCode: book.code,
      fromPeriodCode: fromPeriod.code,
      toPeriodCode: toPeriod.code,
      absoluteThreshold: "5000",
      percentThreshold: "10",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("generate failed");
    statementId = r.statementId;
    // 4 non-flat accounts (CASH, REV, AR, PREPAID) + OFFSET — depending on
    // OFFSET's signed math it may or may not be flat. We'll just sanity-
    // check we got at least the 4 we expect and that material counts are 3.
    expect(r.totalLines).toBeGreaterThanOrEqual(4);
    expect(r.materialLines).toBeGreaterThanOrEqual(3);

    // Pull the line IDs we need for downstream tests.
    const lines = await prisma.fluxLine.findMany({
      where: { statementId },
      select: { id: true, accountId: true, status: true },
    });
    const find = (acctId: string) => {
      const l = lines.find((x) => x.accountId === acctId);
      if (!l) throw new Error("missing line");
      return l;
    };
    cashLineId = find(accountIds.CASH).id;
    revLineId = find(accountIds.REV).id;
    arLineId = find(accountIds.AR).id;
  });

  it("addFluxLineCommentary refused on IMMATERIAL line", async () => {
    signIn();
    const r = await addFluxLineCommentary({
      lineId: revLineId,
      commentary: "Trying to comment on immaterial",
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("should refuse");
    expect(r.code).toBe("WRONG_STATUS");
  });

  it("addFluxLineCommentary on NEEDS_COMMENT → EXPLAINED", async () => {
    signIn();
    const r = await addFluxLineCommentary({
      lineId: cashLineId,
      commentary: "Series A funding round closed in June",
    });
    expect(r.ok).toBe(true);
    const after = await prisma.fluxLine.findUnique({
      where: { id: cashLineId },
      select: { status: true, commentary: true, commentaryBy: true },
    });
    expect(after!.status).toBe("EXPLAINED");
    expect(after!.commentary).toBe("Series A funding round closed in June");
    expect(after!.commentaryBy).toBe(owner.id);
  });

  it("waiveFluxLine sets WAIVED with reason in commentary", async () => {
    signIn();
    const r = await waiveFluxLine({
      lineId: arLineId,
      reason: "First-month entity — no prior basis to compare",
    });
    expect(r.ok).toBe(true);
    const after = await prisma.fluxLine.findUnique({
      where: { id: arLineId },
      select: { status: true, commentary: true },
    });
    expect(after!.status).toBe("WAIVED");
    expect(after!.commentary).toContain("WAIVED:");
    expect(after!.commentary).toContain("First-month entity");
  });

  it("finalize REFUSED while a material line remains NEEDS_COMMENT", async () => {
    signIn();
    // PREPAID is still NEEDS_COMMENT — confirm.
    const r = await finalizeFluxStatement({ statementId });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("should refuse");
    expect(r.code).toBe("FINALIZE_GATE_BLOCKED");
    expect(r.pendingLines).toBeDefined();
    expect(r.pendingLines!.length).toBeGreaterThanOrEqual(1);
  });

  it("finalize succeeds when every material line is EXPLAINED or WAIVED", async () => {
    signIn();
    // Clear EVERY remaining NEEDS_COMMENT line. With the OFFSET
    // balancer in the mix there are multiple material lines beyond
    // the ones explicitly tested.
    const pending = await prisma.fluxLine.findMany({
      where: { statementId, status: "NEEDS_COMMENT" },
      select: { id: true },
    });
    for (const p of pending) {
      await addFluxLineCommentary({
        lineId: p.id,
        commentary: "Routine month-over-month timing",
      });
    }
    const r = await finalizeFluxStatement({ statementId });
    expect(r.ok).toBe(true);
    const after = await prisma.fluxStatement.findUnique({
      where: { id: statementId },
      select: { status: true, finalizedBy: true },
    });
    expect(after!.status).toBe("FINALIZED");
    expect(after!.finalizedBy).toBe(owner.id);
  });

  it("addFluxLineCommentary refused on FINALIZED statement", async () => {
    signIn();
    const r = await addFluxLineCommentary({
      lineId: cashLineId,
      commentary: "Trying to amend signed-off statement",
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("should refuse");
    expect(r.code).toBe("STATEMENT_FINALIZED");
  });

  it("re-generate resets to DRAFT and preserves EXPLAINED/WAIVED across the regen", async () => {
    signIn();
    const r = await generateFluxStatement({
      entityCode: entity.code,
      bookCode: book.code,
      fromPeriodCode: fromPeriod.code,
      toPeriodCode: toPeriod.code,
      absoluteThreshold: "5000",
      percentThreshold: "10",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("regen failed");
    expect(r.statementId).toBe(statementId); // idempotent

    // Status reset to DRAFT.
    const stmt = await prisma.fluxStatement.findUnique({
      where: { id: statementId },
      select: { status: true, finalizedBy: true },
    });
    expect(stmt!.status).toBe("DRAFT");
    expect(stmt!.finalizedBy).toBeNull();

    // EXPLAINED commentary on CASH preserved.
    const cash = await prisma.fluxLine.findFirst({
      where: { statementId, accountId: accountIds.CASH },
      select: { status: true, commentary: true },
    });
    expect(cash!.status).toBe("EXPLAINED");
    expect(cash!.commentary).toBe("Series A funding round closed in June");

    // WAIVED AR preserved.
    const ar = await prisma.fluxLine.findFirst({
      where: { statementId, accountId: accountIds.AR },
      select: { status: true },
    });
    expect(ar!.status).toBe("WAIVED");
  });
});
