import { describe, expect, test } from "bun:test";
import { acpSessionAfterTurn } from "../../src/daemon/supervisor";

/**
 * What a turn's end records about its ACP session: the session to resume and
 * the cost the next turn is measured from — including for a turn taken away,
 * whose spend the server already recorded with the lost claim.
 */
describe("acpSessionAfterTurn", () => {
  const ended = {
    outcome: "completed" as const,
    acpSessionId: "s2",
    acpCostUsd: 1.5,
  };

  test("an ended turn records its session and cost", () => {
    expect(acpSessionAfterTurn(ended, false, "s1")).toEqual({
      acpSessionId: "s2",
      acpCostUsd: 1.5,
    });
    expect(
      acpSessionAfterTurn({ ...ended, acpCostUsd: undefined }, false, null),
    ).toEqual({ acpSessionId: "s2", acpCostUsd: null });
  });

  test("a turn that opened no session records nothing", () => {
    const none = { outcome: "failed" as const };
    expect(acpSessionAfterTurn(none, false, "s1")).toEqual({});
    expect(acpSessionAfterTurn(none, true, "s1")).toEqual({});
  });

  test("a turn taken away on the recorded session moves its baseline, so the next resume does not count the lost claim again", () => {
    expect(acpSessionAfterTurn(ended, true, "s2")).toEqual({ acpCostUsd: 1.5 });
  });

  test("a turn taken away on another session leaves the recorded one as it was", () => {
    expect(acpSessionAfterTurn(ended, true, "s1")).toEqual({});
    expect(acpSessionAfterTurn(ended, true, null)).toEqual({});
  });
});
