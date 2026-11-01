import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api, config } from "keryx";
import { type AgentStage, buildAgentStage } from "../agent/harness";
import { type FakePylon, startPylon } from "../fakes/pylon/server";
import { cliSignIn, HOOK_TIMEOUT } from "../setup";

/**
 * `hypotenuse pylon setup|connect|settings`, spawned from source against the
 * booted server with Pylon played by the Pylon fake: the setup a Pylon admin
 * follows, the token and webhook secret connected from the environment and
 * checked at once, the reply policy set, then `installation test` — and no
 * Pylon secret handed to the CLI comes back out of it.
 */
const CLI = join(import.meta.dir, "..", "..", "..", "cli", "src", "cli.ts");
let stage: AgentStage;
let pylon: FakePylon;
let home: string;
const saved = { apiUrlUs: "", apiUrlEu: "" };
const printed: string[] = [];

beforeAll(async () => {
  stage = await buildAgentStage("anthropic");
  pylon = startPylon();
  saved.apiUrlUs = config.platforms.pylon.apiUrlUs;
  saved.apiUrlEu = config.platforms.pylon.apiUrlEu;
  config.platforms.pylon.apiUrlUs = `${pylon.url}/us`;
  config.platforms.pylon.apiUrlEu = `${pylon.url}/eu`;
  home = mkdtempSync(join(tmpdir(), "hyp-pylon-"));
  const url = stage.u.url;
  const { token, cliTokenId } = await cliSignIn(
    url,
    stage.u.peach,
    "peach-cli",
  );
  mkdirSync(join(home, "hypotenuse"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(home, "hypotenuse", "credentials.json"),
    JSON.stringify({
      version: 1,
      current: url,
      servers: {
        [url]: {
          login: { token, cliTokenId, device: "peach-cli" },
          organization: null,
          project: null,
        },
      },
    }),
    { mode: 0o600 },
  );
}, HOOK_TIMEOUT);

afterAll(async () => {
  config.platforms.pylon.apiUrlUs = saved.apiUrlUs;
  config.platforms.pylon.apiUrlEu = saved.apiUrlEu;
  await pylon.stop();
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * Run the CLI as Peach, in the Castle project.
 * @param args - Arguments after `hypotenuse --project <castle>`.
 * @param env - Extra environment.
 * @returns Exit code and output.
 */
async function run(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(
    ["bun", "run", CLI, "--project", String(stage.u.projectId), ...args],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        ...env,
        XDG_CONFIG_HOME: home,
        BROWSER: "none",
        NO_COLOR: "1",
        HYPOTENUSE_NO_UPDATE_CHECK: "1",
        HYPOTENUSE_URL: undefined,
        HYPOTENUSE_ORG: undefined,
        HYPOTENUSE_PROJECT: undefined,
      },
    },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  printed.push(stdout, stderr);
  return { code: await proc.exited, stdout, stderr };
}

describe("hypotenuse pylon", () => {
  test("setup, connect from the environment, set the policy, then test — no secret printed", async () => {
    const setup = await run(["pylon", "setup", "--bot", "toadsworth"]);
    expect(setup.code).toBe(0);
    expect(setup.stdout).toContain("/api/webhooks/pylon/hyp_rk_");
    expect(setup.stdout).toContain(
      'Trigger "New issue created" → Send webhook',
    );
    expect(setup.stdout).toContain('"issue_id": "{{ issue.id }}"');
    const { token } = pylon.createToken("Toadsworth");
    const webhookSecret = `pylon-wh-${crypto.randomUUID()}`;
    const connected = await run(
      [
        "--json",
        "pylon",
        "connect",
        "--bot",
        "toadsworth",
        "--region",
        "us",
        "--name",
        "Toadsworth",
        "--token-env",
        "PYLON_TOKEN",
        "--webhook-secret-env",
        "PYLON_WH",
      ],
      { PYLON_TOKEN: token, PYLON_WH: webhookSecret },
    );
    expect(connected.code).toBe(0);
    const { installation } = JSON.parse(connected.stdout) as {
      installation: { id: number; status: string };
    };
    expect(installation.status).toBe("active");
    const settings = await run([
      "pylon",
      "settings",
      "--bot",
      "toadsworth",
      "--policy",
      "approve",
      "--auto-triage",
      "off",
      "--tags",
      "billing, refunds",
    ]);
    expect(settings.code).toBe(0);
    expect(settings.stdout).toContain("customer replies  approve");
    expect(settings.stdout).toContain("auto-triage off");
    expect(settings.stdout).toContain("tags: billing, refunds");
    const wrong = await run([
      "pylon",
      "settings",
      "--bot",
      "toadsworth",
      "--policy",
      "always",
    ]);
    expect(wrong.code).not.toBe(0);
    expect(wrong.stderr).toContain(
      "--policy takes never, approve, auto-on-low-risk",
    );
    const tested = await run(["installation", "test", String(installation.id)]);
    expect(tested.code).toBe(0);
    for (const out of printed) {
      expect(out).not.toContain(token);
      expect(out).not.toContain(webhookSecret);
    }
  });
});
