import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "../src/index";

describe("protocol", () => {
  test("exports a positive integer protocol version", () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });
});
