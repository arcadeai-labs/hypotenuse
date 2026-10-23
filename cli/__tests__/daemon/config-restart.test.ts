import { describe, expect, test } from "bun:test";
import { ConfigRestart } from "../../src/daemon/config-restart";

/**
 * The config restart's state machine, each ending forced in order: the wait
 * for running turns is a promise the test resolves itself, so a stop or a
 * save can land exactly where a race would put it.
 */

/**
 * A ConfigRestart over recording fakes.
 * @returns It, its record, and the levers the test pulls.
 */
function harness() {
  const calls: string[] = [];
  const waits: ((idle: boolean) => void)[] = [];
  const state = { problem: null as string | null, exiting: false };
  const restart = new ConfigRestart(
    {
      pauseClaims: () => calls.push("pause"),
      resumeClaims: () => calls.push("resume"),
      waitIdle: () =>
        new Promise<boolean>((resolve) => {
          waits.push(resolve);
        }),
      stopTurns: async () => {
        calls.push("stopTurns");
      },
      startProblem: () => state.problem,
      exiting: () => state.exiting,
      restart: () => calls.push("restart"),
      log: (m) => calls.push(`log: ${m}`),
    },
    600_000,
  );
  return { restart, calls, waits, state };
}

const needs = { needsRestart: true, invalid: false };
const fine = { needsRestart: false, invalid: false };
const invalid = { needsRestart: false, invalid: true };

describe("ConfigRestart", () => {
  test("turns finish: it restarts, without stopping any", async () => {
    const h = harness();
    const wait = h.restart.saved(needs, "c.toml");
    expect(h.calls).toEqual(["pause"]);
    h.waits[0]?.(true);
    await wait;
    expect(h.calls).toEqual(["pause", "restart"]);
    expect(h.restart.isPending).toBe(false);
  });

  test("the wait runs out: the rest are stopped, then it restarts", async () => {
    const h = harness();
    const wait = h.restart.saved(needs, "c.toml");
    h.waits[0]?.(false);
    await wait;
    expect(h.calls).toEqual(["pause", "stopTurns", "restart"]);
  });

  test("a stop that drains while it waits takes over: the turns finishing never restart it", async () => {
    const h = harness();
    const wait = h.restart.saved(needs, "c.toml");
    h.restart.takeOver();
    // The stop's own drain empties the slots, and this wait sees it first.
    h.waits[0]?.(true);
    await wait;
    expect(h.calls).toEqual([
      "pause",
      "log: config restart called off: a stop or restart was asked for",
    ]);
  });

  test("the daemon exiting before the wait ends never restarts", async () => {
    const h = harness();
    const wait = h.restart.saved(needs, "c.toml");
    h.state.exiting = true;
    h.waits[0]?.(false);
    await wait;
    expect(h.calls).toEqual(["pause"]);
  });

  test("a file the next process would refuse by the time turns finish is not restarted into", async () => {
    const h = harness();
    const wait = h.restart.saved(needs, "c.toml");
    // An invalid file, or a server with no runner here: startup's own refusals.
    h.state.problem = "c.toml has no runner for https://other.example";
    h.waits[0]?.(true);
    await wait;
    expect(h.calls).toEqual([
      "pause",
      "resume",
      "log: config restart called off: the daemon would not start on c.toml as it is now (c.toml has no runner for https://other.example); the running config stays",
    ]);
  });

  test("a save the next process would refuse never pauses claims", () => {
    const h = harness();
    h.state.problem =
      "server.project is 424242, but this machine's runner belongs to project 1";
    expect(h.restart.saved(needs, "c.toml")).toBeNull();
    expect(h.restart.isPending).toBe(false);
    expect(h.calls).toEqual([
      "log: config restart not started: the daemon would not start on c.toml as it is now (server.project is 424242, but this machine's runner belongs to project 1); the running config stays",
    ]);
    expect(h.waits).toHaveLength(0);
  });

  test("a takeover is for good: saves during a stop's drain start nothing and resume nothing", async () => {
    const h = harness();
    h.restart.saved(needs, "c.toml");
    h.restart.takeOver();
    expect(h.restart.isTakenOver).toBe(true);
    expect(h.restart.saved(needs, "c.toml")).toBeNull();
    expect(h.restart.saved(invalid, "c.toml")).toBeNull();
    h.waits[0]?.(true);
    await Bun.sleep(0);
    expect(h.calls).toEqual([
      "pause",
      "log: config restart called off: a stop or restart was asked for",
    ]);
    expect(h.waits).toHaveLength(1);
  });

  test("a takeover with nothing pending still keeps later saves from restarting", () => {
    const h = harness();
    h.restart.takeOver();
    expect(h.restart.saved(needs, "c.toml")).toBeNull();
    expect(h.calls).toEqual([]);
  });

  test("a newer save: invalid or undone calls it off; still needing it keeps waiting", async () => {
    const h = harness();
    h.restart.saved(needs, "c.toml");
    expect(h.restart.saved(needs, "c.toml")).toBeNull();
    expect(h.restart.isPending).toBe(true);
    h.restart.saved(invalid, "c.toml");
    expect(h.restart.isPending).toBe(false);
    expect(h.calls.at(-2)).toBe("resume");

    h.restart.saved(needs, "c.toml");
    h.restart.saved(fine, "c.toml");
    expect(h.calls.at(-1)).toBe(
      "log: config restart called off: the change that needed it was undone",
    );
  });

  test("a superseded wait does nothing; only the newest request restarts", async () => {
    const h = harness();
    const first = h.restart.saved(needs, "c.toml");
    h.restart.saved(fine, "c.toml");
    const second = h.restart.saved(needs, "c.toml");
    h.waits[0]?.(true);
    await first;
    expect(h.calls).not.toContain("restart");
    h.waits[1]?.(true);
    await second;
    expect(h.calls.filter((c) => c === "restart")).toHaveLength(1);
  });

  test("a save that needs nothing, with nothing pending, does nothing", () => {
    const h = harness();
    expect(h.restart.saved(fine, "c.toml")).toBeNull();
    expect(h.restart.saved(invalid, "c.toml")).toBeNull();
    expect(h.calls).toEqual([]);
    h.restart.takeOver();
    expect(h.calls).toEqual([]);
  });
});
