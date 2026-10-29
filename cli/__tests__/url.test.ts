import { describe, expect, test } from "bun:test";
import { type Credentials, emptyCredentials } from "../src/api/credentials";
import {
  DEFAULT_SERVER_URL,
  resolveServerUrl,
  type UrlSources,
} from "../src/api/url";

/**
 * Credentials holding the given servers.
 * @param origins - Server origins.
 * @param current - The `current` field.
 * @returns The credentials.
 */
function creds(origins: string[], current: string | null = null): Credentials {
  const c = emptyCredentials();
  c.current = current;
  for (const o of origins)
    c.servers[o] = { login: null, organization: null, project: null };
  return c;
}

/**
 * Sources with every level set, minus the ones overridden.
 * @param over - Overrides.
 * @returns The sources.
 */
function all(over: Partial<UrlSources> = {}): UrlSources {
  return {
    flag: "https://flag.example.com",
    env: { HYPOTENUSE_URL: "https://env.example.com" },
    credentials: creds(["https://creds.example.com"]),
    ...over,
  };
}

describe("base URL precedence", () => {
  test("each level wins over every level below it", () => {
    expect(resolveServerUrl(all())).toEqual({
      origin: "https://flag.example.com",
      source: "flag",
    });
    expect(resolveServerUrl(all({ flag: undefined }))).toEqual({
      origin: "https://env.example.com",
      source: "env",
    });
    expect(resolveServerUrl(all({ flag: undefined, env: {} }))).toEqual({
      origin: "https://creds.example.com",
      source: "credentials",
    });
    expect(
      resolveServerUrl({ env: {}, credentials: emptyCredentials() }),
    ).toEqual({ origin: DEFAULT_SERVER_URL, source: "default" });
  });

  test("the default is the hosted API", () => {
    expect(DEFAULT_SERVER_URL).toBe("https://api.hypotenuse.cloud");
  });

  test("with several servers, the last login's wins; with none current, the default", () => {
    const two = ["https://a.example.com", "https://b.example.com"];
    expect(
      resolveServerUrl({
        env: {},
        credentials: creds(two, "https://b.example.com"),
      }).origin,
    ).toBe("https://b.example.com");
    expect(resolveServerUrl({ env: {}, credentials: creds(two) }).origin).toBe(
      DEFAULT_SERVER_URL,
    );
  });

  test("callers pass an origin: paths and trailing slashes are dropped", () => {
    expect(
      resolveServerUrl(all({ flag: "http://localhost:8080/api/" })).origin,
    ).toBe("http://localhost:8080");
  });
});
