// What a Server Action's catch-all is allowed to say.
//
// The two halves matter equally and pull in opposite directions, which
// is why a blanket rule would have been wrong:
//
//   - Authored refusals are user-facing copy. "Allocation percents must
//     sum to exactly 100 (got 99.5)" tells the operator what to fix.
//     Replacing it with a generic apology would be a regression.
//   - Driver errors are internal structure. A Prisma message carries
//     table names, column names, the constraint that fired, and — for a
//     validation error — the failing call arguments, which can include
//     amounts. A toast is not the place for any of that.
//
// So these cases pin the boundary from both sides, and the last one
// pins that a financial value in a driver message does not survive.
//
// DB-free.

import { describe, expect, it, vi, afterEach } from "vitest";
import { Prisma } from "@prisma/client";

import {
  isDriverError,
  sanitizeActionError,
} from "@/lib/actions/action-error";

// The helper reports driver errors through captureError, which falls
// back to console.error when Sentry is unconfigured. Silence it so a
// passing run isn't noisy — the reporting itself is asserted below.
const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
afterEach(() => quiet.mockClear());

function knownRequestError() {
  return new Prisma.PrismaClientKnownRequestError(
    "Unique constraint failed on the fields: (`tenantId`,`code`)",
    { code: "P2002", clientVersion: "5.22.0", meta: { target: ["tenantId", "code"] } }
  );
}

describe("authored errors keep their wording", () => {
  it("passes a domain refusal through verbatim", () => {
    const msg = "Allocation percents must sum to exactly 100 (got 99.5).";
    expect(sanitizeActionError(new Error(msg), "Unknown error")).toBe(msg);
  });

  it("does not treat an ordinary Error as a driver error", () => {
    expect(isDriverError(new Error("Debits must equal credits"))).toBe(false);
  });
});

describe("driver errors are replaced by the caller's fallback", () => {
  it("replaces a known-request error", () => {
    expect(sanitizeActionError(knownRequestError(), "That code is already in use.")).toBe(
      "That code is already in use."
    );
  });

  it("catches a driver error whose class identity was lost", () => {
    // Two copies of the client can be loaded at once — the same
    // dual-package hazard that made Decimal.set() a no-op for 99 files.
    // instanceof fails there; the name/code check has to carry it.
    const lookalike = Object.assign(
      new Error("Unique constraint failed on the fields: (`tenantId`,`code`)"),
      { name: "PrismaClientKnownRequestError", code: "P2002" }
    );
    expect(isDriverError(lookalike)).toBe(true);
    expect(sanitizeActionError(lookalike, "fallback")).toBe("fallback");
  });

  it("keeps a financial value out of the returned message", () => {
    // A validation error renders the failing call arguments into its
    // own message. This is the case that would put a customer's amount
    // in a toast.
    const e = new Prisma.PrismaClientValidationError(
      "Invalid `prisma.journalLine.create()` invocation: { debit: 148250.75, accountId: null }",
      { clientVersion: "5.22.0" }
    );
    const out = sanitizeActionError(e, "Could not save that entry.");
    expect(out).toBe("Could not save that entry.");
    expect(out).not.toContain("148250.75");
    expect(out).not.toContain("journalLine");
  });

  it("reports the schema fact, never the row value", () => {
    sanitizeActionError(knownRequestError(), "fallback");
    expect(quiet).toHaveBeenCalled();
    // captureError's console fallback is (tag, message, context).
    const context = quiet.mock.calls[0]?.[2] as {
      extra?: { prismaCode?: string; target?: string[] };
    };
    expect(context.extra?.prismaCode).toBe("P2002");
    expect(context.extra?.target).toEqual(["tenantId", "code"]);
  });
});

describe("non-Error throws", () => {
  it("falls back rather than stringifying whatever was thrown", () => {
    expect(sanitizeActionError("boom", "Unknown error")).toBe("Unknown error");
    expect(sanitizeActionError(undefined, "Unknown error")).toBe("Unknown error");
  });
});
