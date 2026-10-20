import { describe, expect, test } from "bun:test";
import {
  callbackUrl,
  parseAuthorizeRequest,
  parseOutcome,
} from "../pages/cli/cliLink";
import { DEFAULT_LANDING, safeNext, signInFor } from "../utils/returnTo";

const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

/**
 * Search params for an authorize link.
 * @param over - Fields to replace or drop (with undefined).
 * @returns The params.
 */
function link(over: Record<string, string | undefined> = {}) {
  const fields: Record<string, string | undefined> = {
    port: "53682",
    state: "abcDEF123_-xyz",
    code_challenge: CHALLENGE,
    device: "peach-mbp",
    ...over,
  };
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields))
    if (v !== undefined) params.set(k, v);
  return params;
}

describe("the CLI's authorize link", () => {
  test("a well-formed link parses", () => {
    expect(parseAuthorizeRequest(link())).toEqual({
      port: 53682,
      state: "abcDEF123_-xyz",
      codeChallenge: CHALLENGE,
      device: "peach-mbp",
    });
  });

  test("any malformed part makes the whole link invalid", () => {
    for (const over of [
      { port: undefined },
      { port: "0" },
      { port: "70000" },
      { port: "80.5" },
      { state: "" },
      { state: "has spaces in it" },
      { code_challenge: "short" },
      { code_challenge: `${CHALLENGE}=` },
      { device: "  " },
      { device: "x".repeat(257) },
    ]) {
      expect(
        parseAuthorizeRequest(link(over)),
        JSON.stringify(over),
      ).toBeNull();
    }
  });

  test("the callback only ever goes to the loopback listener", () => {
    const request = parseAuthorizeRequest(link())!;
    const approved = new URL(callbackUrl(request, { code: "c0de" }));
    expect(approved.origin).toBe("http://127.0.0.1:53682");
    expect(approved.pathname).toBe("/callback");
    expect(approved.searchParams.get("code")).toBe("c0de");
    expect(approved.searchParams.get("state")).toBe("abcDEF123_-xyz");

    const denied = new URL(callbackUrl(request, { denied: true }));
    expect(denied.searchParams.get("error")).toBe("access_denied");
    expect(denied.searchParams.get("code")).toBeNull();
  });

  test("the listener's redirect back is recognized", () => {
    expect(parseOutcome(new URLSearchParams("status=done"))).toBe("done");
    expect(parseOutcome(new URLSearchParams("status=cancelled"))).toBe(
      "cancelled",
    );
    expect(parseOutcome(new URLSearchParams("status=nope"))).toBeNull();
    expect(parseOutcome(link())).toBeNull();
  });
});

describe("returning after sign-in", () => {
  test("only a same-origin path is honored", () => {
    expect(safeNext("/cli/authorize?port=1")).toBe("/cli/authorize?port=1");
    for (const bad of [
      null,
      "",
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "javascript:alert(1)",
    ]) {
      expect(safeNext(bad), String(bad)).toBeNull();
    }
  });

  test("the sign-in link carries the page, except for the default landing", () => {
    expect(signInFor("/cli/activate?code=AB")).toBe(
      "/sign-in?next=%2Fcli%2Factivate%3Fcode%3DAB",
    );
    expect(signInFor(DEFAULT_LANDING)).toBe("/sign-in");
  });
});
