import { describe, expect, test } from "bun:test";
import { botBody } from "../src/commands/bot";
import { largeResultId } from "../src/commands/large-result";
import {
  authModeOf,
  authText,
  type McpServer,
} from "../src/commands/mcp-server";
import { collect, parseDuration, parseHeaders, readSecret } from "../src/input";

describe("parseHeaders", () => {
  test("Name: value entries, trimmed, skipping blank lines", () => {
    expect(
      parseHeaders(
        ["X-Team: billing", "", "Authorization:  Token abc \r"],
        "--header",
      ),
    ).toEqual({ "X-Team": "billing", Authorization: "Token abc" });
  });

  test("an entry without a name is refused, naming the flag", () => {
    expect(() => parseHeaders(["no colon"], "--headers-stdin")).toThrow(
      "--headers-stdin",
    );
    expect(() => parseHeaders([": value"], "--header")).toThrow("--header");
  });
});

describe("parseDuration", () => {
  test("seconds, or a number with a unit", () => {
    expect(parseDuration("3600", "--approval-ttl")).toBe(3600);
    expect(parseDuration("30m", "--approval-ttl")).toBe(1800);
    expect(parseDuration("24h", "--approval-ttl")).toBe(86_400);
    expect(parseDuration("7d", "--approval-ttl")).toBe(604_800);
    expect(parseDuration("1.5h", "--approval-ttl")).toBe(5400);
  });

  test("anything else is refused, naming the flag", () => {
    expect(() => parseDuration("soon", "--approval-ttl")).toThrow(
      "--approval-ttl",
    );
    expect(() => parseDuration("-1", "--approval-ttl")).toThrow();
  });
});

describe("collect", () => {
  test("gathers a repeated flag in order", () => {
    expect(collect("b", collect("a"))).toEqual(["a", "b"]);
  });
});

describe("readSecret names the flags it was given", () => {
  test("a refusal names the bearer flags, not the API key's", async () => {
    await expect(
      readSecret({
        label: "bearer token",
        env: {},
        isTTY: false,
        readStdin: async () => "",
        prompt: async () => "",
        flags: { stdin: "--bearer-stdin", env: "--bearer-env" },
      }),
    ).rejects.toThrow("--bearer-stdin");
  });
});

describe("authModeOf", () => {
  test("follows from the credential flags", () => {
    expect(authModeOf({})).toBeUndefined();
    expect(authModeOf({ header: ["A: b"] })).toBe("headers");
    expect(authModeOf({ headersStdin: true })).toBe("headers");
    expect(authModeOf({ bearerEnv: "TOKEN" })).toBe("bearer");
    expect(authModeOf({ oauth: true, clientId: "c" })).toBe("oauth");
    expect(authModeOf({ auth: "none" })).toBe("none");
  });

  test("two modes, a mode against its flags, or an unknown mode are refused", () => {
    expect(() => authModeOf({ bearerStdin: true, oauth: true })).toThrow(
      "more than one way",
    );
    expect(() => authModeOf({ auth: "none", bearerStdin: true })).toThrow(
      "--auth none",
    );
    expect(() => authModeOf({ auth: "basic" })).toThrow("--auth is one of");
  });
});

describe("authText never shows a credential", () => {
  const base = {
    headerNames: [],
    lastFour: null,
    signedIn: null,
  } as unknown as McpServer;

  test("each mode", () => {
    expect(authText({ ...base, authMode: "none" })).toBe("none");
    expect(
      authText({ ...base, authMode: "headers", headerNames: ["X-Key"] }),
    ).toBe("headers (X-Key)");
    expect(authText({ ...base, authMode: "bearer", lastFour: "wxyz" })).toBe(
      "bearer …wxyz",
    );
    expect(authText({ ...base, authMode: "oauth", signedIn: false })).toBe(
      "oauth (not signed in)",
    );
  });
});

describe("largeResultId", () => {
  test("lr_<id> or its number", () => {
    expect(largeResultId("lr_12")).toBe(12);
    expect(largeResultId("12")).toBe(12);
    expect(() => largeResultId("lr_x")).toThrow("lr_<id>");
  });
});

describe("botBody approval settings", () => {
  test("approver tag, its removal, and the approval TTL", () => {
    expect(botBody({ approverTag: "ops", approvalTtl: "2h" })).toEqual({
      approverTag: "ops",
      approvalTtlSeconds: 7200,
    });
    expect(botBody({ approverTag: false })).toEqual({ approverTag: null });
  });
});
