import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api, config } from "keryx";
import { type AgentStage, buildAgentStage } from "../agent/harness";
import { SlackFake } from "../fakes/slack/server";
import { cliSignIn, HOOK_TIMEOUT } from "../setup";

/**
 * `hypotenuse slack create|connect|install`, spawned from source against the
 * booted server with the Web API pointed at the Slack fake: the
 * configuration-token path end to end (create, the install link, the
 * person's approval, `installation test`), the manual path, and that no
 * Slack secret handed to the CLI comes back out of it.
 */
const CLI = join(import.meta.dir, "..", "..", "..", "cli", "src", "cli.ts");
let stage: AgentStage;
let slack: SlackFake;
let home: string;
let apiUrl: string;
const printed: string[] = [];

beforeAll(async () => {
  stage = await buildAgentStage("anthropic");
  slack = new SlackFake().start();
  apiUrl = config.platforms.slack.apiUrl;
  config.platforms.slack.apiUrl = `${slack.url}/api`;
  home = mkdtempSync(join(tmpdir(), "hyp-slack-"));
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
  config.platforms.slack.apiUrl = apiUrl;
  await slack.stop();
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

describe("hypotenuse slack", () => {
  test("create with a configuration token, install by the printed link, then test", async () => {
    const created = await run(
      [
        "--json",
        "slack",
        "create",
        "--bot",
        "toadsworth",
        "--config-token-env",
        "SLACK_CFG",
      ],
      { SLACK_CFG: slack.configToken },
    );
    expect(created.code).toBe(0);
    const { installation, appId } = JSON.parse(created.stdout);
    expect(appId).toBe(slack.appId);
    expect(installation).toMatchObject({ type: "slack", status: "pending" });

    const link = await run(["slack", "install", String(installation.id)]);
    expect(link.code).toBe(0);
    const url = /https?:\/\/\S+oauth\S*/.exec(link.stdout)?.[0] ?? "";
    expect(url).toContain(`client_id=${slack.clientId}`);
    const back = new URL(slack.approveInstall(url));
    const res = await fetch(`${stage.u.url}${back.pathname}${back.search}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);

    const tested = await run(["installation", "test", String(installation.id)]);
    expect(tested.code).toBe(0);
    expect(tested.stdout).toContain(slack.botUserId);
  });

  test("connect: the manual path, secrets from the environment", async () => {
    const minted = await run([
      "--json",
      "installation",
      "manifest",
      "--bot",
      "toadsworth",
      "--type",
      "slack",
      "--workspace",
      "manual",
    ]);
    expect(minted.code).toBe(0);
    const out = await run(
      [
        "slack",
        "connect",
        "--bot",
        "toadsworth",
        "--workspace",
        "manual",
        "--client-id",
        slack.clientId,
        "--app-id",
        slack.appId,
        "--client-secret-env",
        "CS",
        "--signing-secret-env",
        "SS",
        "--bot-token-env",
        "BT",
      ],
      { CS: slack.clientSecret, SS: slack.signingSecret, BT: slack.botToken },
    );
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("active");
    const missing = await run([
      "slack",
      "connect",
      "--bot",
      "toadsworth",
      "--workspace",
      "manual",
      "--client-id",
      slack.clientId,
    ]);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain("--client-secret-env");
  });

  test("no Slack secret comes back out of the CLI", () => {
    const all = printed.join("\n");
    for (const s of [
      slack.configToken,
      slack.clientSecret,
      slack.signingSecret,
      slack.botToken,
    ]) {
      expect(all.includes(s)).toBe(false);
    }
  });
});
