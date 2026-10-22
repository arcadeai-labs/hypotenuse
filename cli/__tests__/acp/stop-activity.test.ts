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
