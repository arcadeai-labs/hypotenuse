import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  buildNgrokStartArgs,
  defaultNgrokConfigCandidates,
  REPO_NGROK_CONFIG,
  userNgrokConfigPaths,
} from "../../scripts/start-ngrok";

describe("start-ngrok", () => {
  test("merges the operator's configs before the repository's endpoints", () => {
    // ngrok merges `--config` files left to right, so the authtoken-bearing
    // file must come first and the committed endpoints last.
    expect(
      buildNgrokStartArgs("/repo/ngrok.yml", ["/home/me/ngrok.yml"]),
    ).toEqual([
      "start",
      "--all",
      "--config",
      "/home/me/ngrok.yml",
      "--config",
      "/repo/ngrok.yml",
    ]);
  });

  test("NGROK_CONFIG wins, then the first default location that exists", () => {
    const home = "/home/me";
    const [, linux, legacy] = defaultNgrokConfigCandidates(home);
    const existing = new Set(["/custom.yml", linux, legacy]);
    expect(
      userNgrokConfigPaths({ NGROK_CONFIG: "/custom.yml" }, home, (path) =>
        existing.has(path),
      ),
    ).toEqual(["/custom.yml", linux!]);
  });

  test("no config anywhere yields nothing to merge", () => {
    expect(userNgrokConfigPaths({}, "/nowhere", () => false)).toEqual([]);
  });

  test("the committed endpoints file is the one at the repository root", () => {
    expect(REPO_NGROK_CONFIG).toBe(
      join(import.meta.dir, "..", "..", "..", "ngrok.yml"),
    );
  });
});
