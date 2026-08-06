// Maker-checker JE approvals (#46 harvest slice ④).
//
// The contract:
//   - resolveApprovalRoute matrix (pure): approver bypass, flag off,
//     binary flag, threshold above/below
//   - flag OFF preserves the historical direct-post behavior exactly
//   - flag ON routes a MEMBER's entry to PENDING_APPROVAL, and the
//     TRIAL BALANCE EXCLUDES it — a queued entry has NO ledger effect
//     (this is the slice's core correctness claim)
//   - ADMIN direct posts bypass the queue even with the flag on
//   - approve: second-pair-of-eyes flips to POSTED, TB then includes
//     it, approval columns + RecordEvent written; SELF-approval refused
//   - reject requires a reason and lands VOID (excluded from TB);
//     withdraw is submitter-only and reuses the rejection columns with
//     the "Withdrawn:" marker
//   - the period closing between submit and approve refuses approval
//   - toggle/threshold actions are ADMIN-gated (authz-failure path)

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  vi,
} from "vitest";
import { PrismaClient } from "@prisma/client";
import { Decimal } from "@/lib/utils/decimal";
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
// createJournalEntryAction redirects on success — capture instead of throw.
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { url });
  },
}));

import { resolveApprovalRoute } from "@/lib/accounting/approval-threshold";
import {
  approveJournalEntry,
  rejectJournalEntry,
  withdrawJournalEntry,
  SelfApprovalError,
  NotSubmitterError,
  RejectionReasonRequiredError,
} from "@/lib/accounting/approval";
import { PeriodClosedError } from "@/lib/accounting/types";
import { createJournalEntryAction } from "@/app/actions/create-journal-entry";
import {
  approveJournalEntryAction,
} from "@/app/actions/approve-journal-entry";
import {
  toggleRequireJeApprovalAction,
  setJeApprovalThresholdAction,
} from "@/app/actions/toggle-je-approval";
import { getTrialBalance } from "@/lib/accounting/reports";
import { _internal as authInternal } from "@/lib/auth/current-user";
import { prisma as appPrisma } from "@/lib/db";

const prisma = new PrismaClient();
const SUFFIX = "azj" + Date.now().toString(36) + Math.floor(Math.random() * 9999);
const USER_MARKER = "AZJ Approvals Fixture";
const ENTITY_CODE = `AZJ${SUFFIX}`.toUpperCase().slice(0, 14);
const BOOK = "US_GAAP";
const DOC_DATE = "2026-06-15";

let tenantA: { id: string; slug: string };
let admin: { id: string; email: string };
let admin2: { id: string; email: string };
let maker: { id: string; email: string };
let entityId: string;
let bookId: string;
let periodId: string;

function signInAs(userId: string) {
  mockCookieStore.clear();
  mockCookieStore.set("lc-user", { value: authInternal.encode(userId) });
  mockCookieStore.set("lc-tenant", { value: tenantA.slug });
  mockCookieStore.set("lc-scope", {
    value: JSON.stringify({ entityCode: ENTITY_CODE, bookCode: BOOK }),
  });
}

function jeForm(amount: string, memo: string) {
  const fd = new FormData();
  fd.set("documentDate", DOC_DATE);
  fd.set("memo", memo);
  fd.set("source", "MANUAL");
  fd.set(
    "linesJson",
    JSON.stringify([
      { accountCode: "1000", side: "DEBIT", amount },
      { accountCode: "4000", side: "CREDIT", amount },
    ])
  );
  return fd;
}

/** Post via the real action; returns the created entry row. */
async function postViaAction(amount: string, memo: string) {
  try {
    await createJournalEntryAction({}, jeForm(amount, memo));
  } catch (e) {
    if (!(e instanceof Error) || e.message !== "NEXT_REDIRECT") throw e;
  }
  const entry = await appPrisma.journalEntry.findFirst({
    where: { tenantId: tenantA.id, memo },
    select: {
      id: true,
      entryNumber: true,
      status: true,
      submittedById: true,
      submittedAt: true,
    },
  });
  expect(entry).not.toBeNull();
  return entry!;
}

async function tbBalanceFor(accountCode: string): Promise<Decimal> {
  const tb = await getTrialBalance(
    appPrisma,
    { entityCode: ENTITY_CODE, bookCode: BOOK, tenantId: tenantA.id },
    new Date("2026-06-30")
  );
  const row = tb.rows.find((r) => r.accountCode === accountCode);
  return row ? new Decimal(row.debit.toString()).minus(row.credit.toString()) : new Decimal(0);
}

async function scrubStale() {
  const staleTenants = await prisma.tenant.findMany({
    where: { slug: { startsWith: "azj" } },
    select: { id: true },
  });
  const tIds = staleTenants.map((t) => t.id);
  const staleUsers = await prisma.user.findMany({
    where: { displayName: { startsWith: USER_MARKER } },
    select: { id: true },
  });
  const uIds = staleUsers.map((u) => u.id);
  if (tIds.length > 0) {
    await prisma.periodClose.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.journalLine.deleteMany({
      where: { entry: { tenantId: { in: tIds } } },
    });
    await prisma.journalEntry.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.recordEvent.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.period.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.fiscalCalendar.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.account.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.legalEntity.deleteMany({ where: { tenantId: { in: tIds } } });
    await withAuditLogMutable(prisma, async () => {
      await prisma.auditLog.deleteMany({ where: { tenantId: { in: tIds } } });
    });
    await prisma.tenant.deleteMany({ where: { id: { in: tIds } } });
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

  // Users go through the APP client (raw-client rows carry NULL
  // emailHash and break under ambient encryption keys — slice ③ lesson).
  const mk = (label: string) =>
    appPrisma.user.create({
      data: {
        email: `azj-${label}-${SUFFIX}@example.test`,
        displayName: `${USER_MARKER} ${label}`,
      },
      select: { id: true, email: true },
    });
  admin = await mk("admin");
  admin2 = await mk("admin2");
  maker = await mk("maker");

  tenantA = await prisma.tenant.create({
    data: { slug: `azj-a-${SUFFIX}`, name: "AZJ A", ownerUserId: admin.id },
    select: { id: true, slug: true },
  });
  await prisma.tenantMembership.createMany({
    data: [
      { tenantId: tenantA.id, userId: admin.id, role: "ADMIN" },
      { tenantId: tenantA.id, userId: admin2.id, role: "ADMIN" },
      { tenantId: tenantA.id, userId: maker.id, role: "MEMBER" },
    ],
  });

  const entity = await prisma.legalEntity.create({
    data: {
      tenantId: tenantA.id,
      code: ENTITY_CODE,
      name: "AZJ Approvals Co.",
      functionalCurrencyId: "USD",
    },
    select: { id: true },
  });
  entityId = entity.id;
  const book = await prisma.book.findUniqueOrThrow({
    where: { code: BOOK },
    select: { id: true },
  });
  bookId = book.id;
  const cal = await prisma.fiscalCalendar.create({
    data: {
      tenantId: tenantA.id,
      entityId,
      code: "STD_2026",
      name: "2026",
      periodFrequency: "MONTHLY",
    },
    select: { id: true },
  });
  const period = await prisma.period.create({
    data: {
      tenantId: tenantA.id,
      calendarId: cal.id,
      code: "2026-06",
      ordinal: 6,
      startsOn: new Date("2026-06-01"),
      endsOn: new Date("2026-06-30"),
    },
    select: { id: true },
  });
  periodId = period.id;

  for (const [code, name, type, nb] of [
    ["1000", "Cash", "ASSET", "DEBIT"],
    ["4000", "Revenue", "REVENUE", "CREDIT"],
  ] as const) {
    await prisma.account.create({
      data: {
        tenantId: tenantA.id,
        entityId,
        code,
        name,
        type,
        normalBalance: nb,
      },
    });
  }
});

afterAll(async () => {
  if (tenantA) {
    const tIds = [tenantA.id];
    const uIds = [admin.id, admin2.id, maker.id];
    await prisma.periodClose.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.journalLine.deleteMany({
      where: { entry: { tenantId: { in: tIds } } },
    });
    await prisma.journalEntry.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.recordEvent.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.period.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.fiscalCalendar.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.account.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.legalEntity.deleteMany({ where: { tenantId: { in: tIds } } });
    await withAuditLogMutable(prisma, async () => {
      await prisma.auditLog.deleteMany({
        where: {
          OR: [{ tenantId: { in: tIds } }, { actorUserId: { in: uIds } }],
        },
      });
    });
    await prisma.tenant.deleteMany({ where: { id: { in: tIds } } });
    await withAuditLogMutable(prisma, async () => {
      await prisma.user.deleteMany({ where: { id: { in: uIds } } });
    });
  }
  await prisma.$disconnect();
  await appPrisma.$disconnect();
});

// ─── 1. Pure routing matrix ──────────────────────────────────────────────

describe("resolveApprovalRoute", () => {
  const d = (n: number) => new Decimal(n);
  it("approver bypasses regardless of flag/threshold", () => {
    expect(
      resolveApprovalRoute({
        requireJeApproval: true,
        jeApprovalMinAmount: d(1),
        entryTotal: d(1_000_000),
        actorIsApprover: true,
      })
    ).toBe("POSTED");
  });
  it("flag off → direct post", () => {
    expect(
      resolveApprovalRoute({
        requireJeApproval: false,
        jeApprovalMinAmount: null,
        entryTotal: d(999),
        actorIsApprover: false,
      })
    ).toBe("POSTED");
  });
  it("flag on, no threshold → queue everything", () => {
    expect(
      resolveApprovalRoute({
        requireJeApproval: true,
        jeApprovalMinAmount: null,
        entryTotal: d(0.01),
        actorIsApprover: false,
      })
    ).toBe("PENDING_APPROVAL");
  });
  it("threshold: below posts, at/above queues", () => {
    const base = {
      requireJeApproval: true,
      jeApprovalMinAmount: d(500),
      actorIsApprover: false,
    };
    expect(resolveApprovalRoute({ ...base, entryTotal: d(499.99) })).toBe("POSTED");
    expect(resolveApprovalRoute({ ...base, entryTotal: d(500) })).toBe(
      "PENDING_APPROVAL"
    );
  });
});

// ─── 2. Lifecycle through the real actions + TB exclusion ────────────────

describe("maker-checker lifecycle", () => {
  it("flag OFF: a MEMBER's entry posts directly (historical behavior)", async () => {
    signInAs(maker.id);
    const e = await postViaAction("100", `azj-off-${SUFFIX}`);
    expect(e.status).toBe("POSTED");
    expect(e.submittedById).toBeNull();
    expect((await tbBalanceFor("1000")).toNumber()).toBe(100);
  });

  it("toggle actions are ADMIN-gated; ADMIN can enable the flag", async () => {
    signInAs(maker.id);
    const refused = await toggleRequireJeApprovalAction(true);
    expect(refused.ok).toBe(false);

    signInAs(admin.id);
    const enabled = await toggleRequireJeApprovalAction(true);
    expect(enabled.ok).toBe(true);
    const t = await prisma.tenant.findUnique({
      where: { id: tenantA.id },
      select: { requireJeApproval: true },
    });
    expect(t?.requireJeApproval).toBe(true);
  });

  it("flag ON: MEMBER entry queues; the TRIAL BALANCE EXCLUDES it; ADMIN bypasses", async () => {
    signInAs(maker.id);
    const pending = await postViaAction("250", `azj-pend-${SUFFIX}`);
    expect(pending.status).toBe("PENDING_APPROVAL");
    expect(pending.submittedById).toBe(maker.id);
    expect(pending.submittedAt).not.toBeNull();

    // Core correctness claim: the queued entry has NO ledger effect.
    expect((await tbBalanceFor("1000")).toNumber()).toBe(100);

    signInAs(admin.id);
    const direct = await postViaAction("50", `azj-adm-${SUFFIX}`);
    expect(direct.status).toBe("POSTED");
    expect((await tbBalanceFor("1000")).toNumber()).toBe(150);
  });

  it("a MEMBER cannot approve (authz-failure path); an ADMIN approver who IS the submitter is refused at the lib", async () => {
    const pending = await appPrisma.journalEntry.findFirst({
      where: { tenantId: tenantA.id, status: "PENDING_APPROVAL" },
      select: { id: true },
    });
    signInAs(maker.id);
    const refused = await approveJournalEntryAction({ entryId: pending!.id });
    expect(refused.ok).toBe(false);

    await expect(
      approveJournalEntry(appPrisma as unknown as PrismaClient, {
        entryId: pending!.id,
        tenantId: tenantA.id,
        approverUserId: maker.id, // submitter
        approverEmail: maker.email,
      })
    ).rejects.toBeInstanceOf(SelfApprovalError);
  });

  it("approve by a second pair of eyes: POSTED + columns + RecordEvent + TB includes it", async () => {
    const pending = await appPrisma.journalEntry.findFirst({
      where: { tenantId: tenantA.id, status: "PENDING_APPROVAL" },
      select: { id: true },
    });
    signInAs(admin.id);
    const r = await approveJournalEntryAction({ entryId: pending!.id });
    expect(r.ok).toBe(true);

    const after = await appPrisma.journalEntry.findUnique({
      where: { id: pending!.id },
      select: { status: true, approvedById: true, approvedAt: true },
    });
    expect(after?.status).toBe("POSTED");
    expect(after?.approvedById).toBe(admin.id);
    expect(after?.approvedAt).not.toBeNull();

    const event = await prisma.recordEvent.findFirst({
      where: {
        tenantId: tenantA.id,
        recordId: pending!.id,
        eventType: "STATE_CHANGED",
      },
    });
    expect(event).not.toBeNull();

    // 100 (off) + 250 (approved) + 50 (admin direct) = 400
    expect((await tbBalanceFor("1000")).toNumber()).toBe(400);
  });

  it("reject requires a reason and lands VOID with no ledger effect", async () => {
    signInAs(maker.id);
    const pending = await postViaAction("75", `azj-rej-${SUFFIX}`);
    expect(pending.status).toBe("PENDING_APPROVAL");

    await expect(
      rejectJournalEntry(appPrisma as unknown as PrismaClient, {
        entryId: pending.id,
        tenantId: tenantA.id,
        rejectorUserId: admin.id,
        rejectorEmail: admin.email,
        reason: "   ",
      })
    ).rejects.toBeInstanceOf(RejectionReasonRequiredError);

    const rejected = await rejectJournalEntry(
      appPrisma as unknown as PrismaClient,
      {
        entryId: pending.id,
        tenantId: tenantA.id,
        rejectorUserId: admin.id,
        rejectorEmail: admin.email,
        reason: "wrong account",
      }
    );
    expect(rejected.newStatus).toBe("VOID");
    const after = await appPrisma.journalEntry.findUnique({
      where: { id: pending.id },
      select: { status: true, rejectionReason: true, rejectedById: true },
    });
    expect(after?.status).toBe("VOID");
    expect(after?.rejectionReason).toBe("wrong account");
    // VOID = excluded: TB unchanged at 400.
    expect((await tbBalanceFor("1000")).toNumber()).toBe(400);
  });

  it("withdraw is submitter-only and reuses the rejection columns with the marker", async () => {
    signInAs(maker.id);
    const pending = await postViaAction("60", `azj-wd-${SUFFIX}`);

    await expect(
      withdrawJournalEntry(appPrisma as unknown as PrismaClient, {
        entryId: pending.id,
        tenantId: tenantA.id,
        withdrawerUserId: admin.id, // not the submitter
        withdrawerEmail: admin.email,
      })
    ).rejects.toBeInstanceOf(NotSubmitterError);

    const withdrawn = await withdrawJournalEntry(
      appPrisma as unknown as PrismaClient,
      {
        entryId: pending.id,
        tenantId: tenantA.id,
        withdrawerUserId: maker.id,
        withdrawerEmail: maker.email,
        reason: "typo",
      }
    );
    expect(withdrawn.newStatus).toBe("VOID");
    const after = await appPrisma.journalEntry.findUnique({
      where: { id: pending.id },
      select: { rejectionReason: true, rejectedById: true, submittedById: true },
    });
    expect(after?.rejectionReason).toBe("Withdrawn: typo");
    // Structural marker: withdrawer === submitter.
    expect(after?.rejectedById).toBe(after?.submittedById);
  });

  it("a period closing between submit and approve refuses the approval", async () => {
    signInAs(maker.id);
    const pending = await postViaAction("80", `azj-race-${SUFFIX}`);
    expect(pending.status).toBe("PENDING_APPROVAL");

    await prisma.periodClose.create({
      data: {
        tenantId: tenantA.id,
        entityId,
        bookId,
        periodId,
        closedBy: admin.email,
      },
    });
    await expect(
      approveJournalEntry(appPrisma as unknown as PrismaClient, {
        entryId: pending.id,
        tenantId: tenantA.id,
        approverUserId: admin2.id,
        approverEmail: admin2.email,
      })
    ).rejects.toBeInstanceOf(PeriodClosedError);
    await prisma.periodClose.deleteMany({
      where: { tenantId: tenantA.id },
    });
  });

  it("threshold: below posts directly even from a MEMBER; at/above queues", async () => {
    signInAs(admin.id);
    const set = await setJeApprovalThresholdAction("500");
    expect(set.ok).toBe(true);

    signInAs(maker.id);
    const small = await postViaAction("100", `azj-small-${SUFFIX}`);
    expect(small.status).toBe("POSTED");
    const big = await postViaAction("900", `azj-big-${SUFFIX}`);
    expect(big.status).toBe("PENDING_APPROVAL");
  });
});
