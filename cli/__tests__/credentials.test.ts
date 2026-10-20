import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyCredentials,
  loadCredentials,
  originOf,
  saveCredentials,
  serverEntry,
} from "../src/api/credentials";
import { configDir, credentialsPath } from "../src/paths";

/**
 * A fresh directory to stand in for `$XDG_CONFIG_HOME`.
 * @returns Its path.
 */
function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "hyp-cred-"));
}

describe("credentials.json", () => {
  test("lives under XDG_CONFIG_HOME, else ~/.config", () => {
    expect(configDir({ XDG_CONFIG_HOME: "/x" })).toBe("/x/hypotenuse");
    expect(configDir({ HOME: "/home/peach" })).toBe(
      "/home/peach/.config/hypotenuse",
    );
    expect(credentialsPath({ XDG_CONFIG_HOME: "/x" })).toBe(
      "/x/hypotenuse/credentials.json",
    );
  });

  test("is written with the directory 0700 and the file 0600", () => {
    const path = credentialsPath({ XDG_CONFIG_HOME: tempHome() });
    const credentials = emptyCredentials();
    serverEntry(credentials, "https://api.example.com").login = {
      token: "hyp_cli_secret",
      cliTokenId: 1,
      device: "laptop",
    };
    saveCredentials(credentials, path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
  });

  test("tightens an existing directory and file that are too open", () => {
    const home = tempHome();
    const path = credentialsPath({ XDG_CONFIG_HOME: home });
    saveCredentials(emptyCredentials(), path);
    const { chmodSync } = require("node:fs") as typeof import("node:fs");
    chmodSync(join(path, ".."), 0o755);
    chmodSync(path, 0o644);
    saveCredentials(emptyCredentials(), path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
  });

  test("round-trips, keyed by server, with login and runner apart", () => {
    const path = credentialsPath({ XDG_CONFIG_HOME: tempHome() });
    const credentials = emptyCredentials();
    credentials.current = "https://api.example.com";
    const entry = serverEntry(credentials, "https://api.example.com");
    entry.login = { token: "hyp_cli_x", cliTokenId: 7, device: "box" };
    entry.project = 12;
    saveCredentials(credentials, path);

    const loaded = loadCredentials(path);
    expect(loaded).toEqual({
      version: 1,
      current: "https://api.example.com",
      servers: {
        "https://api.example.com": {
          login: { token: "hyp_cli_x", cliTokenId: 7, device: "box" },
          project: 12,
          runner: null,
        },
      },
    });
    // No temp file left behind by the atomic write.
    const raw = readFileSync(path, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
  });

  test("a missing file is empty; a malformed one is an error naming it", () => {
    const home = tempHome();
    const path = credentialsPath({ XDG_CONFIG_HOME: home });
    expect(loadCredentials(path)).toEqual(emptyCredentials());
    saveCredentials(emptyCredentials(), path);
    writeFileSync(path, "{not json");
    expect(() => loadCredentials(path)).toThrow(path);
    writeFileSync(path, JSON.stringify({ version: 2 }));
    expect(() => loadCredentials(path)).toThrow("not a hypotenuse credentials");
  });

  test("servers are keyed by origin", () => {
    expect(originOf("https://api.example.com/")).toBe(
      "https://api.example.com",
    );
    expect(originOf("http://localhost:8080/api")).toBe("http://localhost:8080");
    expect(() => originOf("ftp://x")).toThrow("http(s)");
    expect(() => originOf("nope")).toThrow("Not a URL");
  });
});
