import { describe, expect, test } from "bun:test";
import { outcomeView } from "../utils/deliveryOutcomes";

describe("delivery outcomes", () => {
  test("outcomes that ask for something carry a warning and a sentence", () => {
    for (const outcome of [
      "mention_without_session",
      "assigned_not_delegated",
    ]) {
      const view = outcomeView(outcome);
      expect(view.tone).toBe("warning");
      expect(view.hint).toBeString();
    }
  });

  test("a failure is danger; anything else is shown plainly", () => {
    expect(outcomeView("failed")).toEqual({ tone: "danger", hint: null });
    for (const outcome of [
      "handled",
      "noted",
      "disengaged",
      "ignored",
      "new",
    ]) {
      expect(outcomeView(outcome)).toEqual({ tone: "secondary", hint: null });
    }
  });
});
