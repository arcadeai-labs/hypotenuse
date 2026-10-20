import { describe, expect, test } from "bun:test";
import { durationIsLive } from "../hooks/useDisplayClock";

describe("durationIsLive", () => {
  test("ticks only while something has started and has not finished", () => {
    expect(durationIsLive(1_000, null)).toBe(true);
    expect(durationIsLive(1_000, 2_000)).toBe(false);
    expect(durationIsLive(null, null)).toBe(false);
    expect(durationIsLive(undefined, null)).toBe(false);
  });
});
