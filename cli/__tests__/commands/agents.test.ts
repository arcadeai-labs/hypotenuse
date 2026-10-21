import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `hypotenuse agents login` and `doctor --agent`, spawned from source against
 * the fake ACP agent: a terminal method runs attached and a fresh handshake
 * confirms; an agent-run method is called over ACP; an agent that still
 * cannot open a session exits 1.
 */

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");
const AGENT = join(import.meta.dir, "..", "fixtures", "fake-acp-agent.ts");

/**
 * A home with a config whose `fake` agent plays a scenario.
 * @param scenario - The fake agent's scenario.
 * @returns The home and its config file.
 */
function home(scenario: string): {
  root: string;
  file: string;
  marker: string;
} {
  const root = mkdtempSync(join(tmpdir(), "hypagents-"));
  const marker = join(root, "logged-in");
  const file = join(root, "hyp.toml");
  writeFileSync(
    file,
    `config_version = 1\n[agents.fake]\ncommand = ["bun", "${AGENT}"]\nenv = { FAKE_ACP_SCENARIO = "${scenario}", FAKE_ACP_LOGIN_MARKER = "${marker}" }\n[roles.worker]\nagent = "fake"\n[sessions]\nmin_free_disk = "1MB"\n`,
  );
  return { root, file, marker };
}

/**
 * Run the CLI.
 * @param root - The home.
 * @param args - Its arguments.
 * @returns Code and output.
 */
async function run(root: string, args: string[]) {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: {
      ...process.env,
      HOME: root,
      XDG_CONFIG_HOME: join(root, ".config"),
      XDG_STATE_HOME: join(root, ".state"),
      HYPOTENUSE_NO_UPDATE_CHECK: "1",
      HYPOTENUSE_CONFIG: undefined,
      NO_COLOR: "1",
    },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

describe("agents login", () => {
  test("a terminal method runs the agent's own login, then a session opens", async () => {
    const { root, file, marker } = home("auth-terminal");
    const before = await run(root, [
      "-c",
      file,
      "doctor",
      "--offline",
      "--agent",
      "fake",
      "--json",
    ]);
    expect(JSON.parse(before.stdout).checks).toContainEqual({
      group: "agents",
      status: "fail",
      message:
        "fake: fake-agent 1.2.3 is not logged in — `hypotenuse agents login fake`",
    });
    const login = await run(root, [
      "-c",
      file,
      "agents",
      "login",
      "fake",
      "--json",
    ]);
    expect(login.stdout).toContain("Logged in to the fake agent.");
    expect(JSON.parse(login.stdout.slice(login.stdout.indexOf("{")))).toEqual({
      agent: "fake",
      method: "terminal-login",
      loggedIn: true,
      daemonReloaded: false,
    });
    expect(login.code).toBe(0);
    expect(existsSync(marker)).toBe(true);
  }, 30_000);

  test("an agent-run method is called over ACP", async () => {
    const { root, file } = home("auth-required");
    const login = await run(root, [
      "-c",
      file,
      "agents",
      "login",
      "fake",
      "--json",
    ]);
    expect(JSON.parse(login.stdout)).toEqual({
      agent: "fake",
      method: "agent-login",
      loggedIn: true,
      daemonReloaded: false,
    });
  }, 30_000);

  test("an unknown agent, or one still refusing sessions, exits 1", async () => {
    const { root, file } = home("happy");
    const unknown = await run(root, ["-c", file, "agents", "login", "nope"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('no agent "nope"');
    const always = home("auth-terminal");
    writeFileSync(
      always.file,
      `config_version = 1\n[agents.fake]\ncommand = ["bun", "${AGENT}"]\nenv = { FAKE_ACP_SCENARIO = "auth-terminal" }\n[roles.worker]\nagent = "fake"\n`,
    );
    const still = await run(always.root, [
      "-c",
      always.file,
      "agents",
      "login",
      "fake",
    ]);
    expect(still.code).toBe(1);
    expect(still.stdout).toContain("fake still cannot open a session");
  }, 30_000);
});
