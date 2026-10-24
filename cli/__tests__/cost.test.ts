import { describe, expect, test } from "bun:test";
import { describeTotals, usd } from "../src/commands/cost";

/** How `hypotenuse cost` and `session view` write money and totals. */
describe("cost formatting", () => {
  test("dollars are cents, with more places below a cent, and - when unknown", () => {
    expect(usd(1.25)).toBe("$1.25");
    expect(usd(0)).toBe("$0.00");
    expect(usd(0.0042)).toBe("$0.0042");
    expect(usd(12345.678)).toBe("$12345.68");
    expect(usd(null)).toBe("-");
  });

  test("totals name the turns, the unpriced ones, and the tokens", () => {
    expect(
      describeTotals({
        turns: 8,
        unpricedTurns: 2,
        inputTokens: 1255,
        outputTokens: 310,
        costUsd: 3.5,
      }),
    ).toBe("$3.50 over 8 turns (2 unpriced), 1,255 in / 310 out");
    expect(
      describeTotals({
        turns: 1,
        unpricedTurns: 1,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: null,
      }),
    ).toBe("- over 1 turn (1 unpriced), 0 in / 0 out");
  });
});
