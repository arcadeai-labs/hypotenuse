import { describe, expect, test } from "bun:test";
import {
  checkedTags,
  connectionStatusLabel,
  describeAccess,
  isOpenToEveryone,
  maskedKey,
  optionalNumber,
  PROVIDER_OPTIONS,
  providerOption,
} from "../utils/models";

describe("model providers", () => {
  test("the add form offers every kind once, and only openai-compatible needs a base URL", () => {
    expect(PROVIDER_OPTIONS.map((p) => p.kind)).toEqual([
      "anthropic",
      "openai",
      "gateway",
      "openai-compatible",
    ]);
    expect(
      PROVIDER_OPTIONS.filter((p) => p.needsBaseUrl).map((p) => p.kind),
    ).toEqual(["openai-compatible"]);
  });

  test("an unknown kind falls back to the first option", () => {
    expect(providerOption("gateway").label).toBe("Vercel AI Gateway");
    expect(providerOption("nope").kind).toBe("anthropic");
  });
});

describe("a connection as a list shows it", () => {
  test("each status has words for its glyph", () => {
    expect(connectionStatusLabel("ok")).toBe("Key works");
    expect(connectionStatusLabel("error")).toBe("Last test failed");
    expect(connectionStatusLabel("unverified")).toBe("Not tested yet");
  });

  test("a key is only ever its last four", () => {
    expect(maskedKey("wxyz")).toBe("…wxyz");
  });
});

describe("access lists in words", () => {
  test("empty or * is every member; otherwise the tags", () => {
    expect(isOpenToEveryone([])).toBe(true);
    expect(isOpenToEveryone(["*"])).toBe(true);
    expect(isOpenToEveryone(["support"])).toBe(false);
    expect(describeAccess([])).toBe("Every member");
    expect(describeAccess(["*", "eng"])).toBe("Every member");
    expect(describeAccess(["support", "eng"])).toBe("support, eng");
  });

  test("* is never a check a person ticks", () => {
    expect(checkedTags(["*"])).toEqual([]);
    expect(checkedTags(["support", "*"])).toEqual(["support"]);
  });
});

describe("optional number fields", () => {
  test("empty is null, a number is a number, anything else is undefined", () => {
    expect(optionalNumber("")).toBeNull();
    expect(optionalNumber("  ")).toBeNull();
    expect(optionalNumber("0.7")).toBe(0.7);
    expect(optionalNumber("abc")).toBeUndefined();
  });
});
