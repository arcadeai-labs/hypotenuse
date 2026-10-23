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
  const state = { valid: true, exiting: false };
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
      configValid: () => state.valid,
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

  test("a file gone invalid by the time turns finish is not restarted into", async () => {
    const h = harness();
    const wait = h.restart.saved(needs, "c.toml");
    h.state.valid = false;
    h.waits[0]?.(true);
    await wait;
    expect(h.calls).toEqual([
      "pause",
      "resume",
      "log: config restart called off: c.toml is not valid now; the running config stays",
    ]);
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
