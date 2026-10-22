import { describe, expect, test } from "bun:test";
import { type StopContext, stopActivity } from "../../src/acp/lifecycle";

/** A stop's context, with overrides. */
function ctx(over: Partial<StopContext> = {}): StopContext {
  return {
    reason: "dashboard",
    runnerName: "laptop",
    cwd: "/work/eng-1",
    branch: "hypotenuse/eng-1",
    note: null,
    timeoutMs: 0,
    waitingOnPerson: false,
    changedFiles: 0,
    ...over,
  };
}

describe("a dashboard cancel's final activity", () => {
  test("names who cancelled when the server said", () => {
    expect(stopActivity(ctx({ note: "Mario" }))).toEqual({
      type: "error",
      body: "Cancelled from the Hypotenuse dashboard by Mario. Changes so far are on branch `hypotenuse/eng-1` in `/work/eng-1` (nothing uncommitted).",
    });
  });

  test("says where it came from when an older server did not", () => {
    const activity = stopActivity(ctx());
    expect(activity && "body" in activity ? activity.body : "").toStartWith(
      "Cancelled from the Hypotenuse dashboard. Changes so far",
    );
  });
});

describe("a Linear stop's final activity", () => {
  test("says where things stand, with no quote when nothing was typed", () => {
    expect(stopActivity(ctx({ reason: "stop", changedFiles: 2 }))).toEqual({
      type: "response",
      body: "Stopped at your request. Changes so far are on branch `hypotenuse/eng-1` in `/work/eng-1` (2 files changed, not committed).",
    });
  });

  test("quotes what the person typed with the stop, every line", () => {
    const activity = stopActivity(
      ctx({ reason: "stop", note: "wrong file\nuse cart.ts" }),
    );
    expect(activity && "body" in activity ? activity.body : "").toEndWith(
      "(nothing uncommitted).\n\n> You said: wrong file\n> use cart.ts",
    );
  });

  test("an unassignment, like every disengagement, says nothing", () => {
    expect(stopActivity(ctx({ reason: "unassigned" }))).toBeNull();
  });
});
