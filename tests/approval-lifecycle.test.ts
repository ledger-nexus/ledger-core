// Maker-checker approval lifecycle tests.
//
// Pure logic + mocked prisma — we're testing the substantive guarantees:
//
//   1. Entry must be in PENDING_APPROVAL to approve / reject
//   2. Submitter ≠ approver (separation of duties)
//   3. Period close re-check refuses approval when period closed since submit
//   4. Rejection requires a reason
//   5. RecordEvent + JournalEntry update happen atomically (we assert the
//      $transaction callback was invoked)
//   6. ON_INSERT rules fire on approval but NOT on submission

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {} as never,
}));

vi.mock("../src/lib/rules/integration", () => ({
  fireInsertRules: vi.fn().mockResolvedValue({ matchedRules: 0 }),
}));

import {
  approveJournalEntry,
  rejectJournalEntry,
  EntryNotPendingError,
  SelfApprovalError,
  RejectionReasonRequiredError,
} from "../src/lib/accounting/approval";
import { PeriodClosedError } from "../src/lib/accounting/types";
import { fireInsertRules } from "../src/lib/rules/integration";

const TENANT_ID = "00000000-0000-0000-0000-000000000001";
const ENTRY_ID = "00000000-0000-0000-0000-000000000010";
const SUBMITTER_ID = "00000000-0000-0000-0000-0000000000aa";
const APPROVER_ID = "00000000-0000-0000-0000-0000000000bb";

interface MockEntry {
  id: string;
  entryNumber: string;
  status: string;
  submittedById: string | null;
  entityId: string;
  bookId: string;
  periodId: string | null;
  ownerId: string | null;
  memo: string;
  source: string;
  documentDate: Date;
  postingDate: Date;
  currencyId: string;
  ownerType: string;
  reassignmentLockedAt: Date | null;
  createdBy: string | null;
  entity: { code: string };
  book: { code: string };
}

function pendingEntry(overrides: Partial<MockEntry> = {}): MockEntry {
  return {
    id: ENTRY_ID,
    entryNumber: "ACME-US_GAAP-00042",
    status: "PENDING_APPROVAL",
    submittedById: SUBMITTER_ID,
    entityId: "entity-id",
    bookId: "book-id",
    periodId: "period-id",
    ownerId: SUBMITTER_ID,
    memo: "Office supplies",
    source: "MANUAL",
    documentDate: new Date("2026-05-01"),
    postingDate: new Date("2026-05-01"),
    currencyId: "USD",
    ownerType: "USER",
    reassignmentLockedAt: null,
    createdBy: "maker@example.com",
    entity: { code: "ACME" },
    book: { code: "US_GAAP" },
    ...overrides,
  };
}

function mockPrismaWith(args: {
  entry: MockEntry | null;
  periodClosed?: boolean;
}): unknown {
  const txCalls = {
    journalEntryUpdate: 0,
    recordEventCreate: 0,
  };
  const tx = {
    journalEntry: {
      update: vi.fn().mockImplementation(async () => {
        txCalls.journalEntryUpdate += 1;
      }),
    },
    recordEvent: {
      create: vi.fn().mockImplementation(async () => {
        txCalls.recordEventCreate += 1;
      }),
    },
  };
  return {
    _txCalls: txCalls,
    journalEntry: {
      findFirst: vi.fn().mockResolvedValue(args.entry),
      findUniqueOrThrow: vi.fn().mockResolvedValue(args.entry),
    },
    periodClose: {
      findUnique: vi.fn().mockResolvedValue(args.periodClosed ? { id: "x" } : null),
    },
    $transaction: vi.fn().mockImplementation(async (cb: (t: unknown) => unknown) => cb(tx)),
  };
}

describe("approveJournalEntry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("flips status PENDING_APPROVAL -> POSTED on a valid approval", async () => {
    const prisma = mockPrismaWith({ entry: pendingEntry() });
    const res = await approveJournalEntry(prisma as never, {
      entryId: ENTRY_ID,
      tenantId: TENANT_ID,
      approverUserId: APPROVER_ID,
      approverEmail: "approver@example.com",
    });
    expect(res.newStatus).toBe("POSTED");
    expect(res.previousStatus).toBe("PENDING_APPROVAL");
    // Atomicity assertion: both writes happened inside one $transaction.
    const txCalls = (prisma as unknown as { _txCalls: { journalEntryUpdate: number; recordEventCreate: number } })._txCalls;
    expect(txCalls.journalEntryUpdate).toBe(1);
    expect(txCalls.recordEventCreate).toBe(1);
  });

  it("refuses when the entry is not in PENDING_APPROVAL", async () => {
    const prisma = mockPrismaWith({
      entry: pendingEntry({ status: "POSTED" }),
    });
    await expect(
      approveJournalEntry(prisma as never, {
        entryId: ENTRY_ID,
        tenantId: TENANT_ID,
        approverUserId: APPROVER_ID,
        approverEmail: "approver@example.com",
      })
    ).rejects.toThrow(EntryNotPendingError);
  });

  it("refuses when the entry doesn't exist or is in another tenant", async () => {
    const prisma = mockPrismaWith({ entry: null });
    await expect(
      approveJournalEntry(prisma as never, {
        entryId: ENTRY_ID,
        tenantId: TENANT_ID,
        approverUserId: APPROVER_ID,
        approverEmail: "approver@example.com",
      })
    ).rejects.toThrow(EntryNotPendingError);
  });

  it("refuses self-approval (submitter == approver)", async () => {
    const prisma = mockPrismaWith({ entry: pendingEntry() });
    await expect(
      approveJournalEntry(prisma as never, {
        entryId: ENTRY_ID,
        tenantId: TENANT_ID,
        approverUserId: SUBMITTER_ID, // same as submittedById!
        approverEmail: "self@example.com",
      })
    ).rejects.toThrow(SelfApprovalError);
  });

  it("refuses when the period has closed since submit", async () => {
    const prisma = mockPrismaWith({
      entry: pendingEntry(),
      periodClosed: true,
    });
    await expect(
      approveJournalEntry(prisma as never, {
        entryId: ENTRY_ID,
        tenantId: TENANT_ID,
        approverUserId: APPROVER_ID,
        approverEmail: "approver@example.com",
      })
    ).rejects.toThrow(PeriodClosedError);
  });

  it("fires ON_INSERT rules on successful approval when ownerId is set", async () => {
    const prisma = mockPrismaWith({ entry: pendingEntry({ ownerId: SUBMITTER_ID }) });
    await approveJournalEntry(prisma as never, {
      entryId: ENTRY_ID,
      tenantId: TENANT_ID,
      approverUserId: APPROVER_ID,
      approverEmail: "approver@example.com",
    });
    expect(fireInsertRules).toHaveBeenCalledOnce();
  });

  it("skips rule firing when ownerId is null (seed / system entries)", async () => {
    const prisma = mockPrismaWith({ entry: pendingEntry({ ownerId: null }) });
    await approveJournalEntry(prisma as never, {
      entryId: ENTRY_ID,
      tenantId: TENANT_ID,
      approverUserId: APPROVER_ID,
      approverEmail: "approver@example.com",
    });
    expect(fireInsertRules).not.toHaveBeenCalled();
  });
});

describe("rejectJournalEntry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("flips status PENDING_APPROVAL -> VOID with the rejection reason", async () => {
    const prisma = mockPrismaWith({ entry: pendingEntry() });
    const res = await rejectJournalEntry(prisma as never, {
      entryId: ENTRY_ID,
      tenantId: TENANT_ID,
      rejectorUserId: APPROVER_ID,
      rejectorEmail: "approver@example.com",
      reason: "Account 4000 should be 4100 — please resubmit.",
    });
    expect(res.newStatus).toBe("VOID");
  });

  it("refuses without a reason", async () => {
    const prisma = mockPrismaWith({ entry: pendingEntry() });
    await expect(
      rejectJournalEntry(prisma as never, {
        entryId: ENTRY_ID,
        tenantId: TENANT_ID,
        rejectorUserId: APPROVER_ID,
        rejectorEmail: "approver@example.com",
        reason: "",
      })
    ).rejects.toThrow(RejectionReasonRequiredError);
  });

  it("refuses whitespace-only reason", async () => {
    const prisma = mockPrismaWith({ entry: pendingEntry() });
    await expect(
      rejectJournalEntry(prisma as never, {
        entryId: ENTRY_ID,
        tenantId: TENANT_ID,
        rejectorUserId: APPROVER_ID,
        rejectorEmail: "approver@example.com",
        reason: "   \n  ",
      })
    ).rejects.toThrow(RejectionReasonRequiredError);
  });

  it("refuses self-rejection (submitter can't reject their own entry)", async () => {
    const prisma = mockPrismaWith({ entry: pendingEntry() });
    await expect(
      rejectJournalEntry(prisma as never, {
        entryId: ENTRY_ID,
        tenantId: TENANT_ID,
        rejectorUserId: SUBMITTER_ID,
        rejectorEmail: "self@example.com",
        reason: "I changed my mind",
      })
    ).rejects.toThrow(SelfApprovalError);
  });

  it("refuses when entry is not PENDING_APPROVAL", async () => {
    const prisma = mockPrismaWith({
      entry: pendingEntry({ status: "VOID" }),
    });
    await expect(
      rejectJournalEntry(prisma as never, {
        entryId: ENTRY_ID,
        tenantId: TENANT_ID,
        rejectorUserId: APPROVER_ID,
        rejectorEmail: "approver@example.com",
        reason: "Some reason",
      })
    ).rejects.toThrow(EntryNotPendingError);
  });
});
