// Validation: cross-tenant period-close interference.
//
// Hypothesis: when tenant A closes period 2026-05 on its entity, does
// the lock cleanly stay inside tenant A? Specifically:
//
//   1. Closing period 2026-05 for tenant A's entity DOES NOT close it
//      for tenant B's entity (even if both entities use the same period
//      code "2026-05" on their own calendars).
//
//   2. After tenant A closes its period, tenant B can still post JEs
//      to its OWN 2026-05 period without hitting PeriodClosedError.
//
//   3. The PeriodClose row's tenantId matches the closing actor's
//      tenant (denormalized correctly in the action).
//
// This is mostly verification — the period-close action already pulls
// tenantId from the entity and the postJournalEntry close-check is keyed
// on entityId + bookId + periodId. There's no obvious leak path. But:
// "obviously correct" deserves a test.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

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

import { postJournalEntry } from "@/lib/accounting/post-journal";
import { PeriodClosedError } from "@/lib/accounting/types";
import { closePeriodAction } from "@/app/actions/period-close";
import { _internal as authInternal } from "@/lib/auth/current-user";

const prisma = new PrismaClient();

const SUFFIX = "pc" + Date.now().toString(36) + Math.floor(Math.random() * 9999);
const ADMIN_EMAIL = "controller@northwind.test";

let tenantA: { id: string };
let tenantB: { id: string };
let entityA: { id: string; code: string };
let entityB: { id: string; code: string };
let calendarA: { id: string };
let calendarB: { id: string };
let periodA: { id: string };
let periodB: { id: string };
let admin: { id: string; email: string };

beforeAll(async () => {
  const a = await prisma.user.findUnique({
    where: { email: ADMIN_EMAIL },
    select: { id: true, email: true },
  });
  if (!a) throw new Error("Run Northwind seed first.");
  admin = { id: a.id, email: a.email };

  tenantA = await prisma.tenant.create({
    data: {
      slug: `pc-iso-a-${SUFFIX}`,
      name: "PC-Iso A",
      ownerUserId: admin.id,
    },
  });
  tenantB = await prisma.tenant.create({
    data: {
      slug: `pc-iso-b-${SUFFIX}`,
      name: "PC-Iso B",
      ownerUserId: admin.id,
    },
  });
  // Admin must be a member of tenantA to use closePeriodAction; tenantB
  // is the comparison tenant.
  await prisma.tenantMembership.create({
    data: { tenantId: tenantA.id, userId: admin.id, role: "OWNER" },
  });

  // Entities, both with calendar + period code "2026-05".
  for (const t of [
    { tenant: tenantA, label: "A" },
    { tenant: tenantB, label: "B" },
  ]) {
    const e = await prisma.legalEntity.create({
      data: {
        tenantId: t.tenant.id,
        code: `PC-ISO-${t.label}-${SUFFIX}`,
        name: `PC Iso ${t.label}`,
        functionalCurrencyId: "USD",
      },
    });
    const cal = await prisma.fiscalCalendar.create({
      data: {
        tenantId: t.tenant.id,
        entityId: e.id,
        code: "STANDARD_2026",
        name: "2026",
        periodFrequency: "MONTHLY",
      },
    });
    const per = await prisma.period.create({
      data: {
        tenantId: t.tenant.id,
        calendarId: cal.id,
        code: "2026-05",
        ordinal: 5,
        startsOn: new Date(Date.UTC(2026, 4, 1)),
        endsOn: new Date(Date.UTC(2026, 4, 31)),
      },
    });
    // Minimal chart for postable JEs.
    await prisma.account.createMany({
      data: [
        {
          tenantId: t.tenant.id,
          entityId: e.id,
          code: "1000",
          name: `Cash (${t.label})`,
          type: "ASSET",
          normalBalance: "DEBIT",
        },
        {
          tenantId: t.tenant.id,
          entityId: e.id,
          code: "3000",
          name: `Capital (${t.label})`,
          type: "EQUITY",
          normalBalance: "CREDIT",
        },
      ],
    });
    if (t.label === "A") {
      entityA = { id: e.id, code: e.code };
      calendarA = { id: cal.id };
      periodA = { id: per.id };
    } else {
      entityB = { id: e.id, code: e.code };
      calendarB = { id: cal.id };
      periodB = { id: per.id };
    }
  }
});

afterAll(async () => {
  const tenantIds = [tenantA.id, tenantB.id];
  await prisma.periodClose.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.journalLine.deleteMany({
    where: { entry: { tenantId: { in: tenantIds } } },
  });
  await prisma.journalEntry.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.period.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.fiscalCalendar.deleteMany({
    where: { tenantId: { in: tenantIds } },
  });
  await prisma.account.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.legalEntity.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.recordEvent.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.tenantMembership.deleteMany({
    where: { tenantId: { in: tenantIds } },
  });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await prisma.$disconnect();
});

describe("Period close: cross-tenant isolation", () => {
  it("closing tenantA's 2026-05 does NOT close tenantB's 2026-05", async () => {
    mockCookieStore.clear();
    mockCookieStore.set("lc-user", { value: authInternal.encode(admin.id) });
    mockCookieStore.set("lc-tenant", { value: `pc-iso-a-${SUFFIX}` });

    const result = await closePeriodAction({
      entityCode: entityA.code,
      bookCode: "US_GAAP",
      periodCode: "2026-05",
    });
    expect(result.ok).toBe(true);

    // Verify: a PeriodClose row exists for tenantA's (entity, period).
    const closeA = await prisma.periodClose.findFirst({
      where: {
        entityId: entityA.id,
        periodId: periodA.id,
      },
      select: { tenantId: true },
    });
    expect(closeA).not.toBeNull();
    expect(closeA!.tenantId).toBe(tenantA.id);

    // No PeriodClose row for tenantB.
    const closeB = await prisma.periodClose.findFirst({
      where: {
        entityId: entityB.id,
        periodId: periodB.id,
      },
    });
    expect(closeB).toBeNull();
  });

  it("tenantB can still post JEs to its 2026-05 after tenantA closes (no false-positive lock)", async () => {
    // Post a 2026-05 JE to tenantB's entity. Should NOT throw
    // PeriodClosedError because the close above only touched tenantA.
    await expect(
      postJournalEntry(prisma, {
        entityCode: entityB.code,
        bookCode: "US_GAAP",
        documentDate: new Date("2026-05-15"),
        memo: "tenantB May post after tenantA close",
        lines: [
          { accountCode: "1000", debit: 100 },
          { accountCode: "3000", credit: 100 },
        ],
      })
    ).resolves.toMatchObject({ bookCode: "US_GAAP" });
  });

  it("tenantA's 2026-05 IS closed — posting there throws PeriodClosedError", async () => {
    // Symmetric correctness check: the close DID lock tenantA.
    await expect(
      postJournalEntry(prisma, {
        entityCode: entityA.code,
        bookCode: "US_GAAP",
        documentDate: new Date("2026-05-15"),
        memo: "tenantA post into closed period — should fail",
        lines: [
          { accountCode: "1000", debit: 50 },
          { accountCode: "3000", credit: 50 },
        ],
      })
    ).rejects.toBeInstanceOf(PeriodClosedError);
  });
});
