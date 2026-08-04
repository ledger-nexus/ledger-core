// Intercompany mirror preparation — the derivation, its refusal paths,
// idempotency, approval routing, and the consolidation effect.
//
// Fixture: own tenant (slug prefix "icpx"), parent P with subsidiaries A
// and B (USD) + C (EUR, for the cross-currency refusal). A carries the
// source IC entry (DR Due-from / CR IC revenue); B carries the paired
// accounts the mirror must land on. Self-healing beforeAll per
// CLAUDE.md: scrub any stale icpx residue BEFORE seeding.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import Decimal from "decimal.js";

import { withAuditLogMutable } from "./_helpers/audit-log-cleanup";

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

import { prisma as appPrisma } from "@/lib/db";
import { _internal as authInternal } from "@/lib/auth/current-user";
import { postJournalEntry } from "@/lib/accounting/post-journal";
import { approveJournalEntry } from "@/lib/accounting/approval";
import { getTrialBalance } from "@/lib/accounting/reports";
import { getConsolidatedTrialBalance } from "@/lib/accounting/reports/consolidation";
import {
  deriveMirrorPlan,
  prepareIntercompanyMirror,
  findMirrorOfEntry,
  IntercompanyMirrorError,
  IC_MIRROR_SOURCE_SYSTEM,
  IC_MIRROR_RECORD_TYPE,
} from "@/lib/accounting/intercompany";
import { prepareMirrorAction } from "@/app/actions/intercompany";

const prisma = new PrismaClient();
const SUFFIX = Date.now().toString(36) + Math.floor(Math.random() * 9999);
const USER_MARKER = "ICPX Fixture";
const BOOK = "US_GAAP";
const DOC_DATE = new Date("2026-06-15");
const AS_OF = new Date("2026-06-30");

const E = {
  P: `ICPXP${SUFFIX}`.toUpperCase().slice(0, 14),
  A: `ICPXA${SUFFIX}`.toUpperCase().slice(0, 14),
  B: `ICPXB${SUFFIX}`.toUpperCase().slice(0, 14),
  C: `ICPXC${SUFFIX}`.toUpperCase().slice(0, 14),
};

let tenant: { id: string; slug: string };
let admin: { id: string; email: string };
let admin2: { id: string; email: string };
let viewer: { id: string; email: string };
let entityIds: Record<string, string> = {};

function signInAs(userId: string, entityCode: string) {
  mockCookieStore.clear();
  mockCookieStore.set("lc-user", { value: authInternal.encode(userId) });
  mockCookieStore.set("lc-tenant", { value: tenant.slug });
  mockCookieStore.set("lc-scope", {
    value: JSON.stringify({ entityCode, bookCode: BOOK }),
  });
}

async function scrubStale() {
  const stale = await prisma.tenant.findMany({
    where: { slug: { startsWith: "icpx" } },
    select: { id: true },
  });
  const tIds = stale.map((t) => t.id);
  const staleUsers = await prisma.user.findMany({
    where: { displayName: { startsWith: USER_MARKER } },
    select: { id: true },
  });
  const uIds = staleUsers.map((u) => u.id);
  if (tIds.length > 0) {
    await prisma.journalLine.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.journalEntry.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.recordEvent.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.account.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.period.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.fiscalCalendar.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.legalEntity.updateMany({
      where: { tenantId: { in: tIds } },
      data: { parentEntityId: null },
    });
    await prisma.legalEntity.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.notification.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.tenantMembership.deleteMany({ where: { tenantId: { in: tIds } } });
    await withAuditLogMutable(prisma, async () => {
      await prisma.auditLog.deleteMany({ where: { tenantId: { in: tIds } } });
      await prisma.tenant.deleteMany({ where: { id: { in: tIds } } });
    });
  }
  if (uIds.length > 0) {
    await withAuditLogMutable(prisma, async () => {
      await prisma.auditLog.deleteMany({ where: { actorUserId: { in: uIds } } });
      await prisma.user.deleteMany({ where: { id: { in: uIds } } });
    });
  }
}

beforeAll(async () => {
  await scrubStale();

  // Users through the APP client so ambient encryption keys populate
  // emailHash correctly (slice ③ lesson).
  const mk = (label: string) =>
    appPrisma.user.create({
      data: {
        email: `icpx-${label}-${SUFFIX}@example.test`,
        displayName: `${USER_MARKER} ${label}`,
      },
      select: { id: true, email: true },
    });
  admin = await mk("admin");
  admin2 = await mk("admin2");
  viewer = await mk("viewer");

  tenant = await prisma.tenant.create({
    data: { slug: `icpx-${SUFFIX}`, name: "ICPX Group", ownerUserId: admin.id },
    select: { id: true, slug: true },
  });
  await prisma.tenantMembership.createMany({
    data: [
      { tenantId: tenant.id, userId: admin.id, role: "ADMIN" },
      { tenantId: tenant.id, userId: admin2.id, role: "ADMIN" },
      { tenantId: tenant.id, userId: viewer.id, role: "VIEWER" },
    ],
  });

  await prisma.currency.upsert({
    where: { code: "EUR" },
    create: { code: "EUR", name: "Euro", decimals: 2, symbol: "€" },
    update: {},
  });

  const parent = await prisma.legalEntity.create({
    data: { tenantId: tenant.id, code: E.P, name: "ICPX Parent", functionalCurrencyId: "USD" },
    select: { id: true },
  });
  entityIds[E.P] = parent.id;
  for (const [code, currency] of [
    [E.A, "USD"],
    [E.B, "USD"],
    [E.C, "EUR"],
  ] as const) {
    const ent = await prisma.legalEntity.create({
      data: {
        tenantId: tenant.id,
        code,
        name: `ICPX ${code}`,
        functionalCurrencyId: currency,
        parentEntityId: parent.id,
      },
      select: { id: true },
    });
    entityIds[code] = ent.id;
    const cal = await prisma.fiscalCalendar.create({
      data: {
        tenantId: tenant.id,
        entityId: ent.id,
        code: `ICPX_CAL_${code}`.slice(0, 30),
        name: "2026",
        periodFrequency: "MONTHLY",
      },
      select: { id: true },
    });
    await prisma.period.create({
      data: {
        tenantId: tenant.id,
        calendarId: cal.id,
        code: "2026-06",
        ordinal: 6,
        startsOn: new Date("2026-06-01"),
        endsOn: new Date("2026-06-30"),
      },
    });
  }

  // Chart. A holds the source-side IC accounts; B the paired ones; a
  // SHARED IC-expense account proves entity-scoped beats shared; C gets
  // a due-to so its refusal is purely cross-currency; A also gets a
  // plain cash account for the non-IC-line blocker.
  const mkAcct = (
    code: string,
    name: string,
    type: "ASSET" | "LIABILITY" | "REVENUE" | "EXPENSE",
    subtype: string | null,
    entityCode: string | null
  ) =>
    prisma.account.create({
      data: {
        tenantId: tenant.id,
        entityId: entityCode ? entityIds[entityCode] : null,
        code,
        name,
        type,
        subtype,
        normalBalance: type === "ASSET" || type === "EXPENSE" ? "DEBIT" : "CREDIT",
      },
    });
  await mkAcct(`IXDF${SUFFIX}`.slice(0, 12), "Due from affiliates", "ASSET", "DUE_FROM_AFFILIATE", E.A);
  await mkAcct(`IXRV${SUFFIX}`.slice(0, 12), "IC management fees", "REVENUE", "INTERCOMPANY_REV", E.A);
  await mkAcct(`IXCA${SUFFIX}`.slice(0, 12), "Cash", "ASSET", null, E.A);
  await mkAcct(`IXDT${SUFFIX}`.slice(0, 12), "Due to affiliates", "LIABILITY", "DUE_TO_AFFILIATE", E.B);
  await mkAcct(`IXEX${SUFFIX}`.slice(0, 12), "IC management fee expense", "EXPENSE", "INTERCOMPANY_EXP", E.B);
  await mkAcct(`IXSH${SUFFIX}`.slice(0, 12), "Shared IC expense", "EXPENSE", "INTERCOMPANY_EXP", null);
  await mkAcct(`IXCT${SUFFIX}`.slice(0, 12), "Due to affiliates (EUR)", "LIABILITY", "DUE_TO_AFFILIATE", E.C);
});

afterAll(async () => {
  await scrubStale();
  await prisma.$disconnect();
});

async function postSourceEntry(memo: string, lines: { code: string; debit?: number; credit?: number }[]) {
  const r = await postJournalEntry(prisma, {
    tenantId: tenant.id,
    entityCode: E.A,
    bookCode: BOOK,
    documentDate: DOC_DATE,
    memo,
    source: "MANUAL",
    createdBy: admin.email,
    lines: lines.map((l) => ({ accountCode: l.code, debit: l.debit, credit: l.credit })),
  });
  return r;
}

const DF = () => `IXDF${SUFFIX}`.slice(0, 12);
const RV = () => `IXRV${SUFFIX}`.slice(0, 12);
const CA = () => `IXCA${SUFFIX}`.slice(0, 12);
const DT = () => `IXDT${SUFFIX}`.slice(0, 12);
const EX = () => `IXEX${SUFFIX}`.slice(0, 12);

describe("deriveMirrorPlan (pure)", () => {
  const candidates = [
    { code: "B_DT", name: "Due to", subtype: "DUE_TO_AFFILIATE", entityId: "ent-b" },
    { code: "B_EX", name: "IC exp", subtype: "INTERCOMPANY_EXP", entityId: "ent-b" },
    { code: "SHARED_EX", name: "Shared IC exp", subtype: "INTERCOMPANY_EXP", entityId: null },
  ];

  it("flips sides and pairs subtypes; entity-scoped account beats shared", () => {
    const plan = deriveMirrorPlan(
      [
        {
          lineNo: 1,
          accountCode: "A_DF",
          accountName: "Due from",
          subtype: "DUE_FROM_AFFILIATE",
          debit: new Decimal(1000),
          credit: new Decimal(0),
          description: "advance",
        },
        {
          lineNo: 2,
          accountCode: "A_RV",
          accountName: "IC rev",
          subtype: "INTERCOMPANY_REV",
          debit: new Decimal(0),
          credit: new Decimal(1000),
          description: null,
        },
      ],
      candidates,
      "ent-b"
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.lines).toHaveLength(2);
    // A's debit receivable → B's CREDIT payable.
    expect(plan.lines[0].accountCode).toBe("B_DT");
    expect(plan.lines[0].credit.toNumber()).toBe(1000);
    expect(plan.lines[0].debit.toNumber()).toBe(0);
    // A's credit revenue → B's DEBIT expense, on the ENTITY-scoped account.
    expect(plan.lines[1].accountCode).toBe("B_EX");
    expect(plan.lines[1].debit.toNumber()).toBe(1000);
  });

  it("refuses a line without an IC subtype, naming it", () => {
    const plan = deriveMirrorPlan(
      [
        {
          lineNo: 1,
          accountCode: "A_CASH",
          accountName: "Cash",
          subtype: null,
          debit: new Decimal(500),
          credit: new Decimal(0),
          description: null,
        },
      ],
      candidates,
      "ent-b"
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.blockers[0]).toMatch(/A_CASH/);
    expect(plan.blockers[0]).toMatch(/no intercompany subtype/);
  });

  it("refuses when the counterparty lacks the paired subtype, and when candidates tie", () => {
    const missing = deriveMirrorPlan(
      [
        {
          lineNo: 1,
          accountCode: "A_DF",
          accountName: "Due from",
          subtype: "DUE_FROM_AFFILIATE",
          debit: new Decimal(100),
          credit: new Decimal(0),
          description: null,
        },
      ],
      [],
      "ent-b"
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.blockers[0]).toMatch(/DUE_TO_AFFILIATE/);

    const ambiguous = deriveMirrorPlan(
      [
        {
          lineNo: 1,
          accountCode: "A_RV",
          accountName: "IC rev",
          subtype: "INTERCOMPANY_REV",
          debit: new Decimal(0),
          credit: new Decimal(100),
          description: null,
        },
      ],
      [
        { code: "B_EX1", name: "x", subtype: "INTERCOMPANY_EXP", entityId: "ent-b" },
        { code: "B_EX2", name: "y", subtype: "INTERCOMPANY_EXP", entityId: "ent-b" },
      ],
      "ent-b"
    );
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) expect(ambiguous.blockers[0]).toMatch(/B_EX1, B_EX2/);
  });
});

describe("prepareIntercompanyMirror (DB)", () => {
  it("prepares a POSTED mirror in the counterparty with flipped, paired lines + lineage", async () => {
    const source = await postSourceEntry("Mgmt fee to B", [
      { code: DF(), debit: 1000 },
      { code: RV(), credit: 1000 },
    ]);

    const result = await prepareIntercompanyMirror(prisma, {
      tenantId: tenant.id,
      sourceEntryId: source.id,
      counterpartyEntityCode: E.B,
      route: "POSTED",
      actor: { id: admin.id, email: admin.email },
    });
    expect(result.counterpartyEntityCode).toBe(E.B);

    const mirror = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: result.mirrorEntryId },
      include: { lines: { include: { account: true }, orderBy: { lineNo: "asc" } }, entity: true },
    });
    expect(mirror.entity.code).toBe(E.B);
    expect(mirror.status).toBe("POSTED");
    expect(mirror.source).toBe("SYSTEM");
    expect(mirror.sourceSystem).toBe(IC_MIRROR_SOURCE_SYSTEM);
    expect(mirror.sourceRecordType).toBe(IC_MIRROR_RECORD_TYPE);
    expect(mirror.sourceRecordId).toBe(source.id);
    expect(mirror.memo).toContain(source.entryNumber);
    // Flip: DR DueFrom → CR DueTo; CR ICRev → DR ICExp (entity-scoped
    // B account chosen over the shared same-subtype one).
    const byCode = new Map(mirror.lines.map((l) => [l.account.code, l]));
    const dt = byCode.get(DT())!;
    expect(dt).toBeDefined();
    expect(new Decimal(dt.credit.toString()).toNumber()).toBe(1000);
    const ex = byCode.get(EX())!;
    expect(ex).toBeDefined();
    expect(new Decimal(ex.debit.toString()).toNumber()).toBe(1000);

    // findMirrorOfEntry resolves the link for the detail page.
    const found = await findMirrorOfEntry(prisma, { tenantId: tenant.id, entryId: source.id });
    expect(found?.id).toBe(result.mirrorEntryId);
    expect(found?.entityCode).toBe(E.B);

    // Idempotency: a second preparation refuses with the existing id.
    await expect(
      prepareIntercompanyMirror(prisma, {
        tenantId: tenant.id,
        sourceEntryId: source.id,
        counterpartyEntityCode: E.B,
        route: "POSTED",
        actor: { id: admin.id, email: admin.email },
      })
    ).rejects.toMatchObject({ code: "ALREADY_MIRRORED", existingMirrorId: result.mirrorEntryId });
    const mirrors = await prisma.journalEntry.count({
      where: { tenantId: tenant.id, sourceSystem: IC_MIRROR_SOURCE_SYSTEM, sourceRecordId: source.id },
    });
    expect(mirrors).toBe(1);

    // Mirror-of-mirror is refused.
    await expect(
      prepareIntercompanyMirror(prisma, {
        tenantId: tenant.id,
        sourceEntryId: result.mirrorEntryId,
        counterpartyEntityCode: E.A,
        route: "POSTED",
        actor: { id: admin.id, email: admin.email },
      })
    ).rejects.toMatchObject({ code: "SOURCE_IS_MIRROR" });
  });

  it("refuses: non-IC line, own entity, unknown counterparty, cross-currency, pending source", async () => {
    const mixed = await postSourceEntry("Cash advance to B", [
      { code: DF(), debit: 300 },
      { code: CA(), credit: 300 },
    ]);
    await expect(
      prepareIntercompanyMirror(prisma, {
        tenantId: tenant.id,
        sourceEntryId: mixed.id,
        counterpartyEntityCode: E.B,
        route: "POSTED",
        actor: { id: admin.id, email: admin.email },
      })
    ).rejects.toMatchObject({ code: "NOT_MIRRORABLE" });
    try {
      await prepareIntercompanyMirror(prisma, {
        tenantId: tenant.id,
        sourceEntryId: mixed.id,
        counterpartyEntityCode: E.B,
        route: "POSTED",
        actor: { id: admin.id, email: admin.email },
      });
    } catch (e) {
      expect((e as IntercompanyMirrorError).blockers[0]).toMatch(/no intercompany subtype/);
    }

    const clean = await postSourceEntry("IC fee again", [
      { code: DF(), debit: 200 },
      { code: RV(), credit: 200 },
    ]);
    await expect(
      prepareIntercompanyMirror(prisma, {
        tenantId: tenant.id,
        sourceEntryId: clean.id,
        counterpartyEntityCode: E.A,
        route: "POSTED",
        actor: { id: admin.id, email: admin.email },
      })
    ).rejects.toMatchObject({ code: "COUNTERPARTY_IS_SOURCE_ENTITY" });
    await expect(
      prepareIntercompanyMirror(prisma, {
        tenantId: tenant.id,
        sourceEntryId: clean.id,
        counterpartyEntityCode: "NOPE_ENTITY",
        route: "POSTED",
        actor: { id: admin.id, email: admin.email },
      })
    ).rejects.toMatchObject({ code: "COUNTERPARTY_NOT_FOUND" });
    await expect(
      prepareIntercompanyMirror(prisma, {
        tenantId: tenant.id,
        sourceEntryId: clean.id,
        counterpartyEntityCode: E.C,
        route: "POSTED",
        actor: { id: admin.id, email: admin.email },
      })
    ).rejects.toMatchObject({ code: "CROSS_CURRENCY" });

    const pending = await postJournalEntry(prisma, {
      tenantId: tenant.id,
      entityCode: E.A,
      bookCode: BOOK,
      documentDate: DOC_DATE,
      memo: "pending IC",
      source: "MANUAL",
      createdBy: admin.email,
      initialStatus: "PENDING_APPROVAL",
      submittedByUserId: admin.id,
      lines: [
        { accountCode: DF(), debit: 50 },
        { accountCode: RV(), credit: 50 },
      ],
    });
    await expect(
      prepareIntercompanyMirror(prisma, {
        tenantId: tenant.id,
        sourceEntryId: pending.id,
        counterpartyEntityCode: E.B,
        route: "POSTED",
        actor: { id: admin.id, email: admin.email },
      })
    ).rejects.toMatchObject({ code: "SOURCE_NOT_POSTED" });
  });

  it("PENDING route: no ledger effect in B until approved; consolidation shows both sides after", async () => {
    const source = await postSourceEntry("Q2 royalty to B", [
      { code: DF(), debit: 750 },
      { code: RV(), credit: 750 },
    ]);
    // Baseline consolidation BEFORE the mirror. The suite's earlier
    // mixed entry (DR DueFrom / CR Cash — refused by the mirror) leaves
    // a genuine nonzero netIcImbalance: that is the tripwire working,
    // and exactly the class of half-booked entry the mirror can't fix.
    const consolBefore = await getConsolidatedTrialBalance(appPrisma, {
      rootEntityCode: E.P,
      bookCode: BOOK,
      asOf: AS_OF,
      tenantId: tenant.id,
    });
    const prepared = await prepareIntercompanyMirror(prisma, {
      tenantId: tenant.id,
      sourceEntryId: source.id,
      counterpartyEntityCode: E.B,
      route: "PENDING_APPROVAL",
      actor: { id: admin.id, email: admin.email },
    });
    expect(prepared.status).toBe("PENDING_APPROVAL");

    const tbBefore = await getTrialBalance(
      appPrisma,
      { entityCode: E.B, bookCode: BOOK, tenantId: tenant.id },
      AS_OF
    );
    const dtBefore = tbBefore.rows.find((r) => r.accountCode === DT());
    const dtBeforeCredit = dtBefore ? new Decimal(dtBefore.credit.toString()) : new Decimal(0);

    // Approve as a DIFFERENT admin (separation of duties holds for
    // mirrors exactly as for hand-typed submissions).
    await approveJournalEntry(prisma, {
      entryId: prepared.mirrorEntryId,
      tenantId: tenant.id,
      approverUserId: admin2.id,
      approverEmail: admin2.email,
    });

    const tbAfter = await getTrialBalance(
      appPrisma,
      { entityCode: E.B, bookCode: BOOK, tenantId: tenant.id },
      AS_OF
    );
    const dtAfter = tbAfter.rows.find((r) => r.accountCode === DT());
    expect(dtAfter).toBeDefined();
    const gained = new Decimal(dtAfter!.credit.toString()).minus(dtBeforeCredit);
    expect(gained.toNumber()).toBe(750);

    // Consolidated view: both halves land in the elimination summary,
    // the group TB balances, and — the point of pairing — the mirrored
    // pair contributes ZERO additional net IC imbalance (750 eliminated
    // debit on DueFrom offset by 750 eliminated credit on DueTo; the
    // source-side ICRev/ICExp pair nets the same way).
    const consol = await getConsolidatedTrialBalance(appPrisma, {
      rootEntityCode: E.P,
      bookCode: BOOK,
      asOf: AS_OF,
      tenantId: tenant.id,
    });
    const elimCodes = consol.eliminationSummary.map((r) => r.accountCode);
    expect(elimCodes).toContain(DF());
    expect(elimCodes).toContain(DT());
    const dtElimBefore = consolBefore.eliminationSummary.find((r) => r.accountCode === DT());
    const dtElim = consol.eliminationSummary.find((r) => r.accountCode === DT());
    const dtGained = dtElim!.totalCreditEliminated.minus(
      dtElimBefore?.totalCreditEliminated ?? new Decimal(0)
    );
    expect(dtGained.toNumber()).toBe(750);
    expect(consol.netIcImbalance.equals(consolBefore.netIcImbalance)).toBe(true);
    // The suite's half-IC fixture (DueFrom vs Cash) leaves the
    // post-elimination totals honestly UNBALANCED — one side eliminated,
    // the other kept. The mirrored pair must not move that gap: its four
    // legs eliminate symmetrically.
    const gapBefore = consolBefore.consolidatedTotalDebit.minus(
      consolBefore.consolidatedTotalCredit
    );
    const gapAfter = consol.consolidatedTotalDebit.minus(consol.consolidatedTotalCredit);
    expect(gapAfter.equals(gapBefore)).toBe(true);
  });
});

describe("prepareMirrorAction (authz)", () => {
  it("VIEWER is refused — preparing a mirror is a journal-entry post", async () => {
    const source = await postSourceEntry("viewer probe", [
      { code: DF(), debit: 10 },
      { code: RV(), credit: 10 },
    ]);
    signInAs(viewer.id, E.A);
    const r = await prepareMirrorAction({
      sourceEntryId: source.id,
      counterpartyEntityCode: E.B,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/higher role|signed in/i);
    // Nothing was created.
    const count = await prisma.journalEntry.count({
      where: { tenantId: tenant.id, sourceSystem: IC_MIRROR_SOURCE_SYSTEM, sourceRecordId: source.id },
    });
    expect(count).toBe(0);
  });

  it("ADMIN through the action: posts directly, audits, and is idempotent", async () => {
    const source = await postSourceEntry("action happy path", [
      { code: DF(), debit: 40 },
      { code: RV(), credit: 40 },
    ]);
    signInAs(admin.id, E.A);
    const r = await prepareMirrorAction({
      sourceEntryId: source.id,
      counterpartyEntityCode: E.B,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe("POSTED");

    const audit = await prisma.auditLog.findFirst({
      where: {
        tenantId: tenant.id,
        action: "intercompany.prepare-mirror",
        resourceId: r.mirrorEntryId,
      },
    });
    expect(audit).not.toBeNull();

    const again = await prepareMirrorAction({
      sourceEntryId: source.id,
      counterpartyEntityCode: E.B,
    });
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.error).toMatch(/already prepared/i);
      expect(again.existingMirrorId).toBe(r.mirrorEntryId);
    }
  });
});
