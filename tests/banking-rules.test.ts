// Learned-rule matching + merchant normalization. Pure functions; the
// suggestion these produce is advisory (the user still clicks Add), but a
// wrong suggestion is friction, so pin the behavior.

import { describe, it, expect } from "vitest";
import { normalizeMerchant, computeMatchHash, bestRuleFor, type RuleForMatching } from "../src/lib/banking/rules";

describe("normalizeMerchant", () => {
  it("strips store numbers, dates, and case so variants collapse", () => {
    expect(normalizeMerchant("WHOLE FOODS MARKET #123 SEATTLE 07/03")).toBe(
      "whole foods market seattle"
    );
    expect(normalizeMerchant("WHOLE FOODS MARKET #456")).toBe("whole foods market");
  });

  it("is stable + hashable", () => {
    const a = normalizeMerchant("SHELL OIL 5521 07/05");
    expect(a).toBe("shell oil");
    expect(computeMatchHash(a)).toBe(computeMatchHash(normalizeMerchant("shell oil 9999")));
  });
});

describe("bestRuleFor", () => {
  const rules: RuleForMatching[] = [
    { id: "r1", matchText: "whole foods", bankAccountId: null, categoryAccountId: "5200", timesUsed: 3 },
    { id: "r2", matchText: "whole foods market seattle", bankAccountId: null, categoryAccountId: "5250", timesUsed: 1 },
    { id: "r3", matchText: "shell", bankAccountId: "card", categoryAccountId: "5300", timesUsed: 5 },
  ];

  it("matches by containment (rule text inside the line)", () => {
    const m = bestRuleFor(rules, "WHOLE FOODS #789", "chk");
    expect(m?.categoryAccountId).toBe("5200");
  });

  it("prefers the more specific (longer) rule on overlap", () => {
    const m = bestRuleFor(rules, "WHOLE FOODS MARKET SEATTLE #1", "chk");
    expect(m?.id).toBe("r2");
  });

  it("respects a rule's bank-account filter", () => {
    expect(bestRuleFor(rules, "SHELL OIL 12", "chk")).toBeNull(); // r3 is card-only
    expect(bestRuleFor(rules, "SHELL OIL 12", "card")?.categoryAccountId).toBe("5300");
  });

  it("returns null when nothing matches", () => {
    expect(bestRuleFor(rules, "TRADER JOES", "chk")).toBeNull();
  });
});
