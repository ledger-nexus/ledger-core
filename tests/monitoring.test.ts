// Tests for the monitoring shim. Focused on the redaction-before-
// transmit contract (the core SOC 2 guarantee) + the fallback path
// when Sentry is unavailable. Real Sentry transmission is integration
// territory and not exercised here.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { captureError, captureMessage } from "../src/lib/monitoring";

describe("monitoring.captureError (CC7.2)", () => {
  let consoleErr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env.SENTRY_DSN;
    consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErr.mockRestore();
  });

  it("falls back to console.error when SENTRY_DSN is unset", () => {
    captureError(new Error("test"), { context: "api" });
    expect(consoleErr).toHaveBeenCalled();
  });

  it("redacts PII fields in context.extra before logging", () => {
    captureError(new Error("test"), {
      actionName: "approve_je",
      extra: { email: "alice@example.com", entryId: "je-1" },
    });
    const callArgs = consoleErr.mock.calls[0];
    // The third arg is the safe context object.
    const safeContext = callArgs[2] as { extra: { email: string; entryId: string } };
    expect(safeContext.extra.email).toBe("[REDACTED]");
    expect(safeContext.extra.entryId).toBe("je-1");
  });

  it("redacts top-level PII keys too (defense in depth — actorUserId is allowed; emails would not be)", () => {
    captureError(new Error("x"), {
      actorUserId: "u-1",
      extra: { displayName: "Alice", role: "ADMIN" },
    });
    const safeContext = consoleErr.mock.calls[0][2] as {
      actorUserId: string;
      extra: { displayName: string; role: string };
    };
    expect(safeContext.actorUserId).toBe("u-1"); // ID is not PII
    expect(safeContext.extra.displayName).toBe("[REDACTED]");
    expect(safeContext.extra.role).toBe("ADMIN");
  });

  it("handles non-Error throws gracefully", () => {
    captureError("plain string error", { context: "api" });
    expect(consoleErr).toHaveBeenCalled();
  });
});

describe("monitoring.captureMessage (CC7.2)", () => {
  let consoleLog: ReturnType<typeof vi.spyOn>;
  let consoleWarn: ReturnType<typeof vi.spyOn>;
  let consoleErr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env.SENTRY_DSN;
    consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLog.mockRestore();
    consoleWarn.mockRestore();
    consoleErr.mockRestore();
  });

  it("routes by level when Sentry is unavailable", () => {
    captureMessage("info event", "info");
    expect(consoleLog).toHaveBeenCalled();

    captureMessage("warn event", "warning");
    expect(consoleWarn).toHaveBeenCalled();

    captureMessage("error event", "error");
    expect(consoleErr).toHaveBeenCalled();
  });

  it("redacts PII in context.extra (same contract as captureError)", () => {
    captureMessage("ai rejection", "info", {
      actionName: "ai_suggestion_rejected",
      extra: { email: "u@x.com", memo: "Wire payment to Vendor X", reason: "wrong_amount" },
    });
    const safeContext = consoleLog.mock.calls[0][2] as {
      extra: { email: string; memo: string; reason: string };
    };
    expect(safeContext.extra.email).toBe("[REDACTED]");
    expect(safeContext.extra.memo).toBe("[REDACTED]");
    expect(safeContext.extra.reason).toBe("wrong_amount");
  });
});
