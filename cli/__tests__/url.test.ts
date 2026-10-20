import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Credentials, emptyCredentials } from "../src/api/credentials";
import {
  DEFAULT_SERVER_URL,
  resolveServerUrl,
  type UrlSources,
} from "../src/api/url";

const dir = mkdtempSync(join(tmpdir(), "hyp-url-"));
const CONFIG = join(dir, "config.toml");
writeFileSync(CONFIG, '[server]\nurl = "https://config.example.com"\n');
const NO_CONFIG = join(dir, "absent.toml");

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
    c.servers[o] = { login: null, project: null, runner: null };
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
    configPath: CONFIG,
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
      resolveServerUrl(
        all({ flag: undefined, env: {}, credentials: emptyCredentials() }),
      ),
    ).toEqual({ origin: "https://config.example.com", source: "config" });
    expect(
      resolveServerUrl({
        env: {},
        credentials: emptyCredentials(),
        configPath: NO_CONFIG,
      }),
    ).toEqual({ origin: DEFAULT_SERVER_URL, source: "default" });
  });

  test("the default is the hosted API", () => {
    expect(DEFAULT_SERVER_URL).toBe("https://api.hypotenuse.cloud");
  });

  test("with several servers, the last login's wins; with none current, config decides", () => {
    const two = ["https://a.example.com", "https://b.example.com"];
    expect(
      resolveServerUrl({
        env: {},
        credentials: creds(two, "https://b.example.com"),
        configPath: NO_CONFIG,
      }).origin,
    ).toBe("https://b.example.com");
    expect(
      resolveServerUrl({
        env: {},
        credentials: creds(two),
        configPath: CONFIG,
      }).origin,
    ).toBe("https://config.example.com");
  });

  test("callers pass an origin: paths and trailing slashes are dropped", () => {
    expect(
      resolveServerUrl(all({ flag: "http://localhost:8080/api/" })).origin,
    ).toBe("http://localhost:8080");
  });

  test("a config file that is not TOML is an error naming it", () => {
    const bad = join(dir, "bad.toml");
    writeFileSync(bad, "[server\nurl =");
    expect(() =>
      resolveServerUrl({
        env: {},
        credentials: emptyCredentials(),
        configPath: bad,
      }),
    ).toThrow(bad);
  });
});
