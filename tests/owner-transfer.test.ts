// Ownership-transfer lifecycle tests. Pure logic + mocked prisma —
// we're testing the substantive guarantees:
//
//   1. Only the current OWNER can initiate
//   2. Can't transfer to self
//   3. Target must be an active member of this tenant
//   4. Can't double-initiate (must cancel first)
//   5. Only the pending TARGET can accept
//   6. Accept swaps roles + Tenant.ownerUserId in one $transaction
//   7. Either OWNER or pending TARGET can cancel (no one else)
//
// Atomic swap is the load-bearing invariant — if the $transaction
// callback runs at all, all three writes happen, or none do.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} as never }));

import {
  initiateOwnerTransfer,
  acceptOwnerTransfer,
  cancelOwnerTransfer,
  NotCurrentOwnerError,
  SelfTransferError,
  TargetNotMemberError,
  TransferAlreadyPendingError,
  NoTransferPendingError,
  NotTransferPartyError,
} from "../src/lib/auth/owner-transfer";

const TENANT_ID = "00000000-0000-0000-0000-000000000001";
const OWNER_ID = "00000000-0000-0000-0000-0000000000aa";
const TARGET_ID = "00000000-0000-0000-0000-0000000000bb";
const STRANGER_ID = "00000000-0000-0000-0000-0000000000cc";

interface MockTenant {
  id: string;
  ownerUserId: string;
  pendingOwnerTransferToUserId: string | null;
}

function tenant(over: Partial<MockTenant> = {}): MockTenant {
  return {
    id: TENANT_ID,
    ownerUserId: OWNER_ID,
    pendingOwnerTransferToUserId: null,
    ...over,
  };
}

function mockPrismaWith(args: {
  tenant: MockTenant | null;
  targetMembership?: { id: string } | null;
}): unknown {
  const txCalls = {
    membershipUpdates: 0,
    tenantUpdates: 0,
  };
  const tx = {
    tenantMembership: {
      updateMany: vi.fn().mockImplementation(async () => {
        txCalls.membershipUpdates += 1;
        return { count: 1 };
      }),
    },
    tenant: {
      update: vi.fn().mockImplementation(async () => {
        txCalls.tenantUpdates += 1;
      }),
    },
  };
  return {
    _txCalls: txCalls,
    tenant: {
      findUnique: vi.fn().mockResolvedValue(args.tenant),
      update: vi.fn().mockResolvedValue(args.tenant),
    },
    tenantMembership: {
      findFirst: vi.fn().mockResolvedValue(args.targetMembership ?? null),
    },
    $transaction: vi.fn().mockImplementation(async (cb: (t: unknown) => unknown) => cb(tx)),
  };
}

// ─── initiate ──────────────────────────────────────────────────────────────

describe("initiateOwnerTransfer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("happy path: records the pending offer on the tenant row", async () => {
    const prisma = mockPrismaWith({
      tenant: tenant(),
      targetMembership: { id: "m1" },
    });
    const r = await initiateOwnerTransfer(prisma as never, {
      tenantId: TENANT_ID,
      currentOwnerUserId: OWNER_ID,
      targetUserId: TARGET_ID,
    });
    expect(r.targetUserId).toBe(TARGET_ID);
    expect(r.initiatedAt).toBeInstanceOf(Date);
  });

  it("refuses when initiator is not the current OWNER", async () => {
    const prisma = mockPrismaWith({
      tenant: tenant({ ownerUserId: OWNER_ID }),
      targetMembership: { id: "m1" },
    });
    await expect(
      initiateOwnerTransfer(prisma as never, {
        tenantId: TENANT_ID,
        currentOwnerUserId: STRANGER_ID, // not the owner!
        targetUserId: TARGET_ID,
      })
    ).rejects.toThrow(NotCurrentOwnerError);
  });

  it("treats unknown tenant the same as not-owner (no existence leak)", async () => {
    const prisma = mockPrismaWith({ tenant: null });
    await expect(
      initiateOwnerTransfer(prisma as never, {
        tenantId: TENANT_ID,
        currentOwnerUserId: OWNER_ID,
        targetUserId: TARGET_ID,
      })
    ).rejects.toThrow(NotCurrentOwnerError);
  });

  it("refuses self-transfer (nothing would change)", async () => {
    const prisma = mockPrismaWith({
      tenant: tenant(),
      targetMembership: { id: "m1" },
    });
    await expect(
      initiateOwnerTransfer(prisma as never, {
        tenantId: TENANT_ID,
        currentOwnerUserId: OWNER_ID,
        targetUserId: OWNER_ID, // self!
      })
    ).rejects.toThrow(SelfTransferError);
  });

  it("refuses if target is not an active member", async () => {
    const prisma = mockPrismaWith({
      tenant: tenant(),
      targetMembership: null, // not a member
    });
    await expect(
      initiateOwnerTransfer(prisma as never, {
        tenantId: TENANT_ID,
        currentOwnerUserId: OWNER_ID,
        targetUserId: STRANGER_ID,
      })
    ).rejects.toThrow(TargetNotMemberError);
  });

  it("refuses double-initiation (must cancel first)", async () => {
    const prisma = mockPrismaWith({
      tenant: tenant({ pendingOwnerTransferToUserId: TARGET_ID }),
      targetMembership: { id: "m1" },
    });
    await expect(
      initiateOwnerTransfer(prisma as never, {
        tenantId: TENANT_ID,
        currentOwnerUserId: OWNER_ID,
        targetUserId: TARGET_ID,
      })
    ).rejects.toThrow(TransferAlreadyPendingError);
  });
});

// ─── accept ────────────────────────────────────────────────────────────────

describe("acceptOwnerTransfer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("swaps roles + ownerUserId atomically when the pending TARGET accepts", async () => {
    const prisma = mockPrismaWith({
      tenant: tenant({ pendingOwnerTransferToUserId: TARGET_ID }),
    });
    const r = await acceptOwnerTransfer(prisma as never, {
      tenantId: TENANT_ID,
      accepterUserId: TARGET_ID,
    });
    expect(r.previousOwnerUserId).toBe(OWNER_ID);
    expect(r.newOwnerUserId).toBe(TARGET_ID);
    const txCalls = (prisma as unknown as { _txCalls: { membershipUpdates: number; tenantUpdates: number } })._txCalls;
    // 2 membership updates (target → OWNER, old owner → ADMIN) + 1 tenant update
    expect(txCalls.membershipUpdates).toBe(2);
    expect(txCalls.tenantUpdates).toBe(1);
  });

  it("refuses when no transfer is pending", async () => {
    const prisma = mockPrismaWith({ tenant: tenant() });
    await expect(
      acceptOwnerTransfer(prisma as never, {
        tenantId: TENANT_ID,
        accepterUserId: TARGET_ID,
      })
    ).rejects.toThrow(NoTransferPendingError);
  });

  it("refuses when accepter is not the pending TARGET (no recipient leak)", async () => {
    const prisma = mockPrismaWith({
      tenant: tenant({ pendingOwnerTransferToUserId: TARGET_ID }),
    });
    await expect(
      acceptOwnerTransfer(prisma as never, {
        tenantId: TENANT_ID,
        accepterUserId: STRANGER_ID,
      })
    ).rejects.toThrow(NoTransferPendingError);
  });
});

// ─── cancel ────────────────────────────────────────────────────────────────

describe("cancelOwnerTransfer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("the current OWNER can cancel a pending transfer", async () => {
    const prisma = mockPrismaWith({
      tenant: tenant({ pendingOwnerTransferToUserId: TARGET_ID }),
    });
    const r = await cancelOwnerTransfer(prisma as never, {
      tenantId: TENANT_ID,
      cancellerUserId: OWNER_ID,
    });
    expect(r.cancelledBy).toBe("OWNER");
  });

  it("the pending TARGET can decline a transfer", async () => {
    const prisma = mockPrismaWith({
      tenant: tenant({ pendingOwnerTransferToUserId: TARGET_ID }),
    });
    const r = await cancelOwnerTransfer(prisma as never, {
      tenantId: TENANT_ID,
      cancellerUserId: TARGET_ID,
    });
    expect(r.cancelledBy).toBe("TARGET");
  });

  it("refuses when there is no pending transfer", async () => {
    const prisma = mockPrismaWith({ tenant: tenant() });
    await expect(
      cancelOwnerTransfer(prisma as never, {
        tenantId: TENANT_ID,
        cancellerUserId: OWNER_ID,
      })
    ).rejects.toThrow(NoTransferPendingError);
  });

  it("refuses when canceller is neither OWNER nor pending TARGET", async () => {
    const prisma = mockPrismaWith({
      tenant: tenant({ pendingOwnerTransferToUserId: TARGET_ID }),
    });
    await expect(
      cancelOwnerTransfer(prisma as never, {
        tenantId: TENANT_ID,
        cancellerUserId: STRANGER_ID,
      })
    ).rejects.toThrow(NotTransferPartyError);
  });
});
