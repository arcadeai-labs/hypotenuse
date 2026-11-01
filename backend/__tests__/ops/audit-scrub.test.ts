import { describe, expect, test } from "bun:test";
import { SENSITIVE_KEYS, scrubParams } from "../../ops/AuditOps";

/**
 * The whole set, as a literal. Adding a key to `SENSITIVE_KEYS` — or, worse,
 * removing one — fails here until this list changes with it, so either is a
 * decision a reviewer sees.
 */
const EXPECTED_SENSITIVE_KEYS = [
  "password",
  "currentPassword",
  "passwordHash",
  "password_hash",
  "secret",
  "secretValue",
  "token",
  "apiKey",
  "connectionString",
  "accessToken",
  "refreshToken",
  "clientSecret",
  "signingSecret",
  "webhookSecret",
  "apiToken",
  "botToken",
  "appToken",
  "configToken",
  "privateKey",
  "code",
  "codeVerifier",
  "state",
  "deviceCode",
  "runToken",
  "tokenHash",
  "continuationSecret",
  "callbackSecret",
  "credentials",
  "routingKey",
  "headers",
  "authorization",
  "bearerToken",
];

/** A value no scrubbed row may contain. */
const SECRET = "s3cr3t-value-that-must-never-be-logged";

describe("SENSITIVE_KEYS", () => {
  test("is exactly the reviewed set", () => {
    expect([...SENSITIVE_KEYS].sort() as string[]).toEqual(
      [...EXPECTED_SENSITIVE_KEYS].sort(),
    );
  });
});

describe("scrubParams", () => {
  for (const key of SENSITIVE_KEYS) {
    test(`removes ${key} at depth 0 and depth 3, in objects and arrays`, () => {
      const params = {
        [key]: SECRET,
        name: "kept",
        a: { b: { c: { [key]: SECRET, kept: 1 } } },
        list: [{ nested: [{ [key]: SECRET, kept: 2 }] }],
      };
      const scrubbed = scrubParams(params);
      expect(JSON.stringify(scrubbed)).not.toContain(SECRET);
      expect(scrubbed).toEqual({
        name: "kept",
        a: { b: { c: { kept: 1 } } },
        list: [{ nested: [{ kept: 2 }] }],
      });
    });
  }

  test("drops a whole headers map, whatever its keys are called", () => {
    const scrubbed = scrubParams({
      name: "github",
      server: {
        url: "https://mcp.example.com",
        headers: { "X-Api-Key": SECRET, Authorization: `Bearer ${SECRET}` },
      },
    });
    expect(scrubbed).toEqual({
      name: "github",
      server: { url: "https://mcp.example.com" },
    });
  });

  test("matches keys, not values: a token-shaped value under an ordinary key stays", () => {
    // v1 scrubbed by value prefix and missed every secret it had not
    // predicted; a key is what an action declares, so the key is what is
    // matched.
    expect(scrubParams({ name: "hyp_cli_looks_like_a_token" })).toEqual({
      name: "hyp_cli_looks_like_a_token",
    });
  });

  test("leaves the caller's params untouched", () => {
    const params = { token: SECRET, nested: { password: SECRET } };
    scrubParams(params);
    expect(params).toEqual({ token: SECRET, nested: { password: SECRET } });
  });
});
