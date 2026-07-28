// Tenant ownership transfer (#46 harvest slice ⑤).
//
// The contract:
//   - initiate: OWNER-only; self-transfer, non-member targets, and a
//     second pending offer are refused; the pending columns record the
//     offer
//   - accept: pending-target-only; the swap is ATOMIC — target's role
//     → OWNER, previous owner's → ADMIN, Tenant.ownerUserId rotated,
//     pending columns cleared
//   - cancel: either party (owner or target) can; outsiders refused
//   - the action layer notifies via slice ②'s email seam (LOGGED_ONLY
//     here — no provider key in tests)

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  vi,
} from "vitest";
import { PrismaClient } from "@prisma/client";
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

import {
  initiateOwnerTransfer,
  acceptOwnerTransfer,
  cancelOwnerTransfer,
  NotCurrentOwnerError,
  SelfTransferError,
  TargetNotMemberError,
  TransferAlreadyPendingError,
  NotTransferPartyError,
} from "@/lib/auth/owner-transfer";
import {
  initiateOwnerTransferAction,
} from "@/app/actions/owner-transfer";
import { _internal as authInternal } from "@/lib/auth/current-user";
import { prisma as appPrisma } from "@/lib/db";

const prisma = new PrismaClient();
const SUFFIX = "azo" + Date.now().toString(36) + Math.floor(Math.random() * 9999);
const USER_MARKER = "AZO Transfer Fixture";

let tenantA: { id: string; slug: string };
let owner: { id: string; email: string };
let member: { id: string; email: string };
let outsider: { id: string; email: string };

function signInAs(userId: string) {
  mockCookieStore.clear();
  mockCookieStore.set("lc-user", { value: authInternal.encode(userId) });
  mockCookieStore.set("lc-tenant", { value: tenantA.slug });
}

async function scrubStale() {
  const staleTenants = await prisma.tenant.findMany({
    where: { slug: { startsWith: "azo" } },
    select: { id: true },
  });
  const tIds = staleTenants.map((t) => t.id);
  const staleUsers = await prisma.user.findMany({
    where: { displayName: { startsWith: USER_MARKER } },
    select: { id: true },
  });
  const uIds = staleUsers.map((u) => u.id);
  if (tIds.length > 0) {
    await prisma.emailDelivery.deleteMany({ where: { tenantId: { in: tIds } } });
    // The initiate action rings the in-app bell — notification rows
    // FK the tenant and must go first.
    await prisma.notification.deleteMany({ where: { tenantId: { in: tIds } } });
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
  const mk = (label: string) =>
    appPrisma.user.create({
      data: {
        email: `azo-${label}-${SUFFIX}@example.test`,
        displayName: `${USER_MARKER} ${label}`,
      },
      select: { id: true, email: true },
    });
  owner = await mk("owner");
  member = await mk("member");
  outsider = await mk("outsider");

  tenantA = await prisma.tenant.create({
    data: { slug: `azo-a-${SUFFIX}`, name: "AZO A", ownerUserId: owner.id },
    select: { id: true, slug: true },
  });
  await prisma.tenantMembership.createMany({
    data: [
      { tenantId: tenantA.id, userId: owner.id, role: "OWNER" },
      { tenantId: tenantA.id, userId: member.id, role: "MEMBER" },
      // outsider deliberately has NO membership
    ],
  });
});

beforeEach(() => {
  vi.stubEnv("RESEND_API_KEY", "");
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterAll(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (tenantA) {
    const tIds = [tenantA.id];
    const uIds = [owner.id, member.id, outsider.id];
    await prisma.emailDelivery.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.notification.deleteMany({ where: { tenantId: { in: tIds } } });
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

const raw = () => appPrisma as unknown as PrismaClient;

describe("initiateOwnerTransfer", () => {
  it("refuses a non-owner, self-transfer, and a non-member target", async () => {
    await expect(
      initiateOwnerTransfer(raw(), {
        tenantId: tenantA.id,
        currentOwnerUserId: member.id,
        targetUserId: owner.id,
      })
    ).rejects.toBeInstanceOf(NotCurrentOwnerError);

    await expect(
      initiateOwnerTransfer(raw(), {
        tenantId: tenantA.id,
        currentOwnerUserId: owner.id,
        targetUserId: owner.id,
      })
    ).rejects.toBeInstanceOf(SelfTransferError);

    await expect(
      initiateOwnerTransfer(raw(), {
        tenantId: tenantA.id,
        currentOwnerUserId: owner.id,
        targetUserId: outsider.id,
      })
    ).rejects.toBeInstanceOf(TargetNotMemberError);
  });

  it("records the offer via the ACTION (owner signed in) + LOGGED_ONLY email; second offer refused", async () => {
    signInAs(owner.id);
    const r = await initiateOwnerTransferAction(member.id);
    expect(r.ok).toBe(true);

    const t = await prisma.tenant.findUnique({
      where: { id: tenantA.id },
      select: {
        pendingOwnerTransferToUserId: true,
        pendingOwnerTransferInitiatedAt: true,
      },
    });
    expect(t?.pendingOwnerTransferToUserId).toBe(member.id);
    expect(t?.pendingOwnerTransferInitiatedAt).not.toBeNull();

    const delivery = await appPrisma.emailDelivery.findFirst({
      where: { tenantId: tenantA.id, template: "owner_transfer_offered" },
      orderBy: { sentAt: "desc" },
      select: { status: true, toEmail: true },
    });
    expect(delivery?.status).toBe("LOGGED_ONLY");
    expect(delivery?.toEmail).toBe(member.email);

    await expect(
      initiateOwnerTransfer(raw(), {
        tenantId: tenantA.id,
        currentOwnerUserId: owner.id,
        targetUserId: member.id,
      })
    ).rejects.toBeInstanceOf(TransferAlreadyPendingError);
  });
});

describe("accept / cancel", () => {
  it("only the pending target can accept; the swap is atomic and complete", async () => {
    // A wrong accepter gets NoTransferPendingError, NOT a "not the
    // party" error — deliberately indistinguishable from no-pending so
    // the endpoint can't be used to discover WHO the recipient is.
    await expect(
      acceptOwnerTransfer(raw(), {
        tenantId: tenantA.id,
        accepterUserId: owner.id,
      })
    ).rejects.toThrow("No ownership transfer is pending");

    await acceptOwnerTransfer(raw(), {
      tenantId: tenantA.id,
      accepterUserId: member.id,
    });

    const t = await prisma.tenant.findUnique({
      where: { id: tenantA.id },
      select: { ownerUserId: true, pendingOwnerTransferToUserId: true },
    });
    expect(t?.ownerUserId).toBe(member.id);
    expect(t?.pendingOwnerTransferToUserId).toBeNull();

    const roles = await prisma.tenantMembership.findMany({
      where: { tenantId: tenantA.id },
      select: { userId: true, role: true },
    });
    expect(roles.find((m) => m.userId === member.id)?.role).toBe("OWNER");
    expect(roles.find((m) => m.userId === owner.id)?.role).toBe("ADMIN");
  });

  it("either party can cancel; outsiders can't; no-pending refused", async () => {
    // member is the OWNER now — offer back to the original owner (ADMIN).
    await initiateOwnerTransfer(raw(), {
      tenantId: tenantA.id,
      currentOwnerUserId: member.id,
      targetUserId: owner.id,
    });

    await expect(
      cancelOwnerTransfer(raw(), {
        tenantId: tenantA.id,
        cancellerUserId: outsider.id,
      })
    ).rejects.toBeInstanceOf(NotTransferPartyError);

    // The pending TARGET cancels (declines) the offer.
    await cancelOwnerTransfer(raw(), {
      tenantId: tenantA.id,
      cancellerUserId: owner.id,
    });
    const t = await prisma.tenant.findUnique({
      where: { id: tenantA.id },
      select: { ownerUserId: true, pendingOwnerTransferToUserId: true },
    });
    expect(t?.ownerUserId).toBe(member.id); // unchanged
    expect(t?.pendingOwnerTransferToUserId).toBeNull();

    await expect(
      cancelOwnerTransfer(raw(), {
        tenantId: tenantA.id,
        cancellerUserId: member.id,
      })
    ).rejects.toThrow(); // NoTransferPendingError
  });
});
