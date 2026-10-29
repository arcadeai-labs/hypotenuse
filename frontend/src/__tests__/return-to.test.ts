import { describe, expect, test } from "bun:test";
import { DEFAULT_LANDING, safeNext, signInFor } from "../utils/returnTo";

describe("safeNext", () => {
  test("keeps a same-origin path, with its query and fragment", () => {
    expect(safeNext("/settings/members")).toBe("/settings/members");
    expect(safeNext("/organization/projects?x=1#top")).toBe(
      "/organization/projects?x=1#top",
    );
  });

  test("refuses anything that leaves the origin", () => {
    for (const raw of [
      "//evil.example",
      "//evil.example/settings",
      "/\\evil.example",
      "\\/evil.example",
      "\\\\evil.example",
      "http://evil.example",
      "https://evil.example/settings",
      "javascript:alert(1)",
      "evil.example",
      "settings",
      // Browsers strip tabs and newlines before parsing, so these are `//`.
      "/\t/evil.example",
      "/\n/evil.example",
      "/\r/evil.example",
      " //evil.example",
    ]) {
      expect(safeNext(raw), JSON.stringify(raw)).toBeNull();
    }
  });

  test("nothing is nowhere", () => {
    expect(safeNext(null)).toBeNull();
    expect(safeNext(undefined)).toBeNull();
    expect(safeNext("")).toBeNull();
  });
});

describe("signInFor", () => {
  test("carries the page along, encoded", () => {
    expect(signInFor("/settings/tags?x=1")).toBe(
      "/sign-in?next=%2Fsettings%2Ftags%3Fx%3D1",
    );
  });

  test("the default landing needs no next", () => {
    expect(signInFor(DEFAULT_LANDING)).toBe("/sign-in");
    expect(signInFor("/")).toBe("/sign-in");
  });

  test("what it carries is what safeNext keeps", () => {
    const path = "/organization/members";
    const next = new URL(
      `https://x.invalid${signInFor(path)}`,
    ).searchParams.get("next");
    expect(safeNext(next)).toBe(path);
  });
});

describe("safeNext and dot segments", () => {
  test("refuses a path that resolves to another host", () => {
    for (const raw of [
      "/.//evil.com",
      "/%2e%2e//evil.com/x",
      "/a/..//evil.com",
    ]) {
      expect(safeNext(raw), raw).toBeNull();
    }
    // A dot segment that stays on this site is still fine.
    expect(safeNext("/settings/../invites")).toBe("/invites");
  });
});
