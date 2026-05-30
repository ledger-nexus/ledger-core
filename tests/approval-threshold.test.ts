// Pure-function tests for resolveApprovalRoute. No DB. Covers the
// four interesting axes (flag on/off × threshold set/unset × approver
// or not × total above/below threshold) and the legacy binary path.

import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import { resolveApprovalRoute } from "../src/lib/accounting/approval-threshold";

function inputs(over: Partial<Parameters<typeof resolveApprovalRoute>[0]> = {}) {
  return {
    requireJeApproval: true,
    jeApprovalMinAmount: null as Decimal | null,
    entryTotal: new Decimal("100"),
    actorIsApprover: false,
    ...over,
  };
}

describe("resolveApprovalRoute — approver bypass", () => {
  it("approver always POSTs even with flag on + entry above threshold", () => {
    expect(
      resolveApprovalRoute(
        inputs({
          requireJeApproval: true,
          jeApprovalMinAmount: new Decimal("10"),
          entryTotal: new Decimal("1000000"),
          actorIsApprover: true,
        })
      )
    ).toBe("POSTED");
  });

  it("approver POSTs when flag is off too", () => {
    expect(
      resolveApprovalRoute(
        inputs({ requireJeApproval: false, actorIsApprover: true })
      )
    ).toBe("POSTED");
  });
});

describe("resolveApprovalRoute — flag off", () => {
  it("non-approver POSTs when the flag is off", () => {
    expect(
      resolveApprovalRoute(
        inputs({ requireJeApproval: false, actorIsApprover: false })
      )
    ).toBe("POSTED");
  });

  it("threshold is ignored when the flag is off", () => {
    expect(
      resolveApprovalRoute(
        inputs({
          requireJeApproval: false,
          jeApprovalMinAmount: new Decimal("10"),
          entryTotal: new Decimal("1000000"),
        })
      )
    ).toBe("POSTED");
  });
});

describe("resolveApprovalRoute — flag on, no threshold (binary mode)", () => {
  it("queues every non-approver entry when threshold is null", () => {
    expect(
      resolveApprovalRoute(
        inputs({
          requireJeApproval: true,
          jeApprovalMinAmount: null,
          entryTotal: new Decimal("0.01"),
        })
      )
    ).toBe("PENDING_APPROVAL");
  });

  it("treats threshold = 0 as null (clears to binary mode)", () => {
    expect(
      resolveApprovalRoute(
        inputs({
          requireJeApproval: true,
          jeApprovalMinAmount: new Decimal("0"),
          entryTotal: new Decimal("0.01"),
        })
      )
    ).toBe("PENDING_APPROVAL");
  });

  it("treats negative threshold as null (defensive — UI should clamp)", () => {
    expect(
      resolveApprovalRoute(
        inputs({
          requireJeApproval: true,
          jeApprovalMinAmount: new Decimal("-50"),
          entryTotal: new Decimal("0.01"),
        })
      )
    ).toBe("PENDING_APPROVAL");
  });
});

describe("resolveApprovalRoute — flag on, threshold set", () => {
  it("queues when total >= threshold", () => {
    expect(
      resolveApprovalRoute(
        inputs({
          jeApprovalMinAmount: new Decimal("1000"),
          entryTotal: new Decimal("1000"),
        })
      )
    ).toBe("PENDING_APPROVAL");
    expect(
      resolveApprovalRoute(
        inputs({
          jeApprovalMinAmount: new Decimal("1000"),
          entryTotal: new Decimal("9999.99"),
        })
      )
    ).toBe("PENDING_APPROVAL");
  });

  it("POSTs directly when total < threshold", () => {
    expect(
      resolveApprovalRoute(
        inputs({
          jeApprovalMinAmount: new Decimal("1000"),
          entryTotal: new Decimal("999.99"),
        })
      )
    ).toBe("POSTED");
  });

  it("handles fractional thresholds + entries (no float drift)", () => {
    expect(
      resolveApprovalRoute(
        inputs({
          jeApprovalMinAmount: new Decimal("0.0001"),
          entryTotal: new Decimal("0.0001"),
        })
      )
    ).toBe("PENDING_APPROVAL");
    expect(
      resolveApprovalRoute(
        inputs({
          jeApprovalMinAmount: new Decimal("0.0001"),
          entryTotal: new Decimal("0.00009999"),
        })
      )
    ).toBe("POSTED");
  });

  it("zero-total entries always POST below any positive threshold", () => {
    expect(
      resolveApprovalRoute(
        inputs({
          jeApprovalMinAmount: new Decimal("100"),
          entryTotal: new Decimal("0"),
        })
      )
    ).toBe("POSTED");
  });
});
