import { describe, expect, test } from "bun:test";
import { Backoff } from "../../src/daemon/backoff";
import { childArgs, selfCommand } from "../../src/daemon/self";
import { changedKeys } from "../../src/daemon/supervisor";

describe("backoff", () => {
  test("1 s × 2ⁿ capped at 30 s, full jitter, reset after 60 s healthy", () => {
    let now = 0;
    const max = new Backoff(
      1_000,
      30_000,
      60_000,
      () => 0.999999,
      () => now,
    );
    expect(
      [1, 2, 3, 4, 5, 6, 7].map(() => Math.round(max.fail() / 1000)),
    ).toEqual([1, 2, 4, 8, 16, 30, 30]);
    const none = new Backoff(
      1_000,
      30_000,
      60_000,
      () => 0,
      () => now,
    );
    expect(none.fail()).toBe(0);
    max.succeed();
    now = 59_000;
    max.succeed();
    expect(max.attempts).toBe(7);
    now = 60_000;
    max.succeed();
    expect(max.attempts).toBe(0);
  });
});

describe("reload", () => {
  test("changedKeys names the leaves that differ", () => {
    expect(
      changedKeys(
        {
          runner: { roles: ["worker"], max_parallel_jobs: 2 },
          log: { level: "info" },
        },
        {
          runner: { roles: ["worker", "manager"], max_parallel_jobs: 2 },
          log: { level: "debug" },
        },
      ),
    ).toEqual(["runner.roles", "log.level"]);
  });
});

describe("starting itself again", () => {
  test("a checkout runs bun and the script; a compiled binary runs itself", () => {
    expect(
      selfCommand(
        ["/usr/bin/bun", "/src/cli/src/cli.ts", "daemon"],
        "/usr/bin/bun",
      ),
    ).toEqual(["/usr/bin/bun", "/src/cli/src/cli.ts"]);
    expect(
      selfCommand(
        ["bun", "/$bunfs/root/hypotenuse", "daemon"],
        "/usr/local/bin/hypotenuse",
      ),
    ).toEqual(["/usr/local/bin/hypotenuse"]);
    expect(
      childArgs(["-c", "x.toml", "daemon", "start", "--foreground"]),
    ).toEqual([
      "-c",
      "x.toml",
      "daemon",
      "start",
      "--foreground",
      "--detached-child",
    ]);
  });
});
