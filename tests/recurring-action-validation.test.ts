// @vitest-environment node

// Input validation on the recurring-entry Server Actions.
//
// The gap that prompted this: `cadence` was typed as the Prisma enum
// and never checked. A Server Action's TypeScript signature is erased
// at the boundary — the client sends whatever it likes — so an
// unrecognized cadence travelled all the way to
// prisma.recurringEntry.create and came back to the user as a raw
// Prisma error string. Enum membership is what a schema is for (CC6.8),
// and the repo's own convention already said so.
//
// The port to Zod had to preserve every refusal the hand-rolled chain
// produced, because those messages are user-facing copy. Half of these
// cases exist to prove nothing was lost in translation.
//
// DB-free: the schema refuses before the action reaches auth or Prisma,
// so these run without DATABASE_URL. Cases that would pass validation
// are covered by the DB-backed suites.

import { describe, expect, it, vi } from "vitest";

// Auth is not what's under test — stub it so validation is reached.
// Every case here must be refused by the schema BEFORE any query runs,
// which is itself part of the contract: bad input never touches Prisma.
vi.mock("@/lib/auth/authorize", () => ({
  requirePermitted: async () => ({
    user: { id: "00000000-0000-4000-8000-000000000001", email: "admin@example.test" },
    tenant: { id: "00000000-0000-4000-8000-000000000002", role: "ADMIN" },
  }),
}));
vi.mock("@/lib/db", () => ({
  prisma: new Proxy(
    {},
    {
      get() {
        throw new Error("Prisma must not be reached for invalid input");
      },
    }
  ),
}));
vi.mock("@/lib/audit/log", () => ({
  auditPrivilegedAction: async () => {},
  auditAccessDenied: async () => {},
}));

import {
  createRecurringEntryAction,
  setRecurringActiveAction,
  deleteRecurringEntryAction,
} from "@/app/actions/recurring-entries";

const VALID_STANDARD = {
  code: "MONTHLY_RENT",
  memo: "Monthly office rent",
  entityCode: "NORTHWIND",
  bookCode: "US_GAAP",
  cadence: "MONTHLY" as const,
  startDate: "2026-06-01",
  lines: [
    { accountCode: "7000", debit: "1000" },
    { accountCode: "1000", credit: "1000" },
  ],
};

async function refusal(input: unknown): Promise<string> {
  const r = await createRecurringEntryAction(input as never);
  expect(r.ok).toBe(false);
  return r.message ?? "";
}

describe("createRecurringEntryAction — the boundary", () => {
  it("refuses a cadence outside the enum instead of handing it to Prisma", async () => {
    // The actual gap. Before the schema this reached
    // prisma.recurringEntry.create and surfaced as a driver error.
    expect(await refusal({ ...VALID_STANDARD, cadence: "HOURLY" })).toMatch(
      /Cadence must be MONTHLY, QUARTERLY, or ANNUALLY/
    );
  });

  it("refuses a cadence that isn't even a string", async () => {
    expect(await refusal({ ...VALID_STANDARD, cadence: { $ne: null } })).toMatch(
      /Cadence must be/
    );
    expect(await refusal({ ...VALID_STANDARD, cadence: undefined })).toMatch(
      /Cadence must be/
    );
  });

  it("refuses an unknown template kind", async () => {
    const msg = await refusal({ ...VALID_STANDARD, kind: "SOMETHING_ELSE" });
    expect(msg.length).toBeGreaterThan(0);
  });

  it("refuses a malformed currency before the FK would", async () => {
    expect(await refusal({ ...VALID_STANDARD, currencyCode: "dollars" })).toMatch(
      /3-letter code/
    );
  });
});

describe("createRecurringEntryAction — accounting rules survived the port", () => {
  it("keeps the code format refusal", async () => {
    expect(await refusal({ ...VALID_STANDARD, code: "A" })).toMatch(/Code must be 2–40/);
    expect(await refusal({ ...VALID_STANDARD, code: "BAD__CODE" })).toMatch(
      /No double separators/
    );
  });

  it("keeps the memo bounds", async () => {
    expect(await refusal({ ...VALID_STANDARD, memo: "   " })).toMatch(/Memo must be 1–200/);
  });

  it("keeps the unbalanced refusal, with both totals named", async () => {
    const msg = await refusal({
      ...VALID_STANDARD,
      lines: [
        { accountCode: "7000", debit: "1000" },
        { accountCode: "1000", credit: "900" },
      ],
    });
    expect(msg).toMatch(/Template unbalanced: debits 1000.00 ≠ credits 900.00/);
  });

  it("keeps the per-line refusals, numbered from 1", async () => {
    expect(
      await refusal({
        ...VALID_STANDARD,
        lines: [
          { accountCode: "7000", debit: "100", credit: "100" },
          { accountCode: "1000", credit: "100" },
        ],
      })
    ).toMatch(/Line 1: cannot have both debit and credit non-zero/);

    expect(
      await refusal({
        ...VALID_STANDARD,
        lines: [
          { accountCode: "7000", debit: "-100" },
          { accountCode: "1000", credit: "100" },
        ],
      })
    ).toMatch(/Line 1: amounts must be non-negative/);
  });

  it("keeps the two-line minimum for STANDARD", async () => {
    expect(
      await refusal({ ...VALID_STANDARD, lines: [{ accountCode: "7000", debit: "1" }] })
    ).toMatch(/at least 2 lines/);
  });

  it("keeps every ALLOCATION rule", async () => {
    const alloc = {
      ...VALID_STANDARD,
      kind: "ALLOCATION" as const,
      startDate: "2026-06-30",
      allocationSourceAccountCode: "6000",
      lines: [{ accountCode: "7000", allocationPercent: "100" }],
    };
    expect(await refusal({ ...alloc, allocationSourceAccountCode: undefined })).toMatch(
      /need a source account/
    );
    expect(
      await refusal({
        ...alloc,
        lines: [{ accountCode: "6000", allocationPercent: "100" }],
      })
    ).toMatch(/target cannot be the source account/);
    expect(
      await refusal({
        ...alloc,
        lines: [{ accountCode: "7000", allocationPercent: "60" }],
      })
    ).toMatch(/must sum to exactly 100 \(got 60\)/);
    expect(
      await refusal({
        ...alloc,
        lines: [{ accountCode: "7000", allocationPercent: "100", debit: "5" }],
      })
    ).toMatch(/carry percents, not amounts/);
    expect(await refusal({ ...alloc, cadence: "QUARTERLY" })).toMatch(
      /Allocation templates run monthly/
    );
    expect(await refusal({ ...alloc, startDate: "2026-06-15" })).toMatch(
      /must start on a month-end date/
    );
  });

  it("keeps the date refusals", async () => {
    expect(await refusal({ ...VALID_STANDARD, startDate: "not-a-date" })).toMatch(
      /startDate must be a valid date/
    );
    expect(
      await refusal({ ...VALID_STANDARD, startDate: "2026-06-01", endDate: "2026-05-01" })
    ).toMatch(/endDate must be on or after startDate/);
  });
});

describe("the other actions validate their ids too", () => {
  it("refuses a non-uuid template id rather than querying with it", async () => {
    const a = await setRecurringActiveAction({ id: "'; DROP TABLE --", isActive: true });
    expect(a.ok).toBe(false);
    expect(a.message).toMatch(/valid id/);

    const d = await deleteRecurringEntryAction({ id: "not-a-uuid" } as never);
    expect(d.ok).toBe(false);
    expect(d.message).toMatch(/valid id/);
  });

  it("refuses a non-boolean isActive", async () => {
    const r = await setRecurringActiveAction({
      id: "00000000-0000-4000-8000-000000000003",
      isActive: "yes",
    } as never);
    expect(r.ok).toBe(false);
  });
});
