// The match-movement helper decides whether an existing JE line moves the
// bank account by the same signed amount as the feed line. Getting the sign
// wrong would match a $50 deposit to a $50 payment, so pin both normal
// sides and both directions.

import { describe, it, expect } from "vitest";
import { Decimal } from "@/lib/utils/decimal";
import { lineMovementOnNormalSide } from "../src/lib/banking/match";

describe("lineMovementOnNormalSide", () => {
  it("debit-normal (bank): debit raises, credit lowers", () => {
    expect(
      lineMovementOnNormalSide(new Decimal("50"), new Decimal("0"), true).equals(new Decimal("50"))
    ).toBe(true);
    expect(
      lineMovementOnNormalSide(new Decimal("0"), new Decimal("50"), true).equals(new Decimal("-50"))
    ).toBe(true);
  });

  it("credit-normal (card): credit raises, debit lowers", () => {
    expect(
      lineMovementOnNormalSide(new Decimal("0"), new Decimal("50"), false).equals(new Decimal("50"))
    ).toBe(true);
    expect(
      lineMovementOnNormalSide(new Decimal("50"), new Decimal("0"), false).equals(new Decimal("-50"))
    ).toBe(true);
  });

  it("a +50 feed line does NOT match a -50 line movement", () => {
    const feed = new Decimal("50");
    const paymentMovement = lineMovementOnNormalSide(new Decimal("0"), new Decimal("50"), true);
    expect(paymentMovement.equals(feed)).toBe(false); // -50 ≠ +50
  });
});
