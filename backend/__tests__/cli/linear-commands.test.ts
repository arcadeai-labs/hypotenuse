import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api, config } from "keryx";
import { LINEAR_SCOPES } from "../../ops/LinearManifestOps";
import { type AgentStage, buildAgentStage } from "../agent/harness";
import { type Finear, startFinear } from "../linear/finear";
import { cliSignIn, HOOK_TIMEOUT } from "../setup";

/**
 * `hypotenuse linear link|connect|install`, spawned from source against the
 * booted server with Linear played by finear: the creation link, the app
 * registered on finear with its webhook, the credentials connected from the
 * environment, the install link a workspace admin approves, then
 * `installation test` — and no Linear secret handed to the CLI comes back
 * out of it.
 */
const CLI = join(import.meta.dir, "..", "..", "..", "cli", "src", "cli.ts");
let stage: AgentStage;
let linear: Finear;
let home: string;
const saved = { apiUrl: "", authorizeUrl: "" };
const printed: string[] = [];

beforeAll(async () => {
  stage = await buildAgentStage("anthropic");
  linear = await startFinear();
  saved.apiUrl = config.platforms.linear.apiUrl;
  saved.authorizeUrl = config.platforms.linear.authorizeUrl;
  config.platforms.linear.apiUrl = linear.url;
  config.platforms.linear.authorizeUrl = `${linear.url}/oauth/authorize`;
  home = mkdtempSync(join(tmpdir(), "hyp-linear-"));
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
  config.platforms.linear.apiUrl = saved.apiUrl;
  config.platforms.linear.authorizeUrl = saved.authorizeUrl;
  await linear.stop();
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

const secrets = {
  clientSecret: `lin-secret-${crypto.randomUUID()}`,
  webhookSecret: `lin-wh-${crypto.randomUUID()}`,
};

describe("hypotenuse linear", () => {
  test("link, connect from the environment, install by the printed link, then test", async () => {
    const linked = await run([
      "--json",
      "linear",
      "link",
      "--bot",
      "toadsworth",
    ]);
    expect(linked.code).toBe(0);
    const minted = JSON.parse(linked.stdout) as {
      installation: { id: number };
      urls: { events: string; oauthRedirect: string };
      link: string;
    };
    expect(minted.link).toContain("manifest=");
    const human = await run(["linear", "link", "--bot", "toadsworth"]);
    expect(human.stdout).toContain(
      "https://linear.app/settings/api/applications/new",
    );

    // The admin creates the app in Linear (here, on finear) from the link.
    const again = JSON.parse(
      (await run(["--json", "linear", "link", "--bot", "toadsworth"])).stdout,
    ) as typeof minted;
    const clientId = crypto.randomUUID();
    linear.register({
      id: clientId,
      name: "Toadsworth",
      secret: secrets.clientSecret,
      redirectUris: [again.urls.oauthRedirect],
      scopes: [...LINEAR_SCOPES],
      webhook: {
        url: `${stage.u.url}${new URL(again.urls.events).pathname}`,
        secret: secrets.webhookSecret,
        resourceTypes: ["Issue"],
        agentSessionEvents: true,
      },
    });

    const missing = await run([
      "linear",
      "connect",
      "--bot",
      "toadsworth",
      "--client-id",
      clientId,
    ]);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain("--client-secret-env");

    const connected = await run(
      [
        "linear",
        "connect",
        "--bot",
        "toadsworth",
        "--client-id",
        clientId,
        "--client-secret-env",
        "LIN_CS",
        "--webhook-secret-env",
        "LIN_WH",
      ],
      { LIN_CS: secrets.clientSecret, LIN_WH: secrets.webhookSecret },
    );
    expect(connected.code).toBe(0);
    expect(connected.stdout).toContain("pending");

    const id = String(again.installation.id);
    const link = await run(["linear", "install", id]);
    expect(link.code).toBe(0);
    const url =
      /https?:\/\/\S+oauth\/authorize\S*/.exec(link.stdout)?.[0] ?? "";
    expect(url).toContain("actor=app");
    const back = new URL(await linear.consent(url));
    const res = await fetch(`${stage.u.url}${back.pathname}${back.search}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);

    const tested = await run(["installation", "test", id]);
    expect(tested.code).toBe(0);
  });

  test("no Linear secret comes back out of the CLI", () => {
    const all = printed.join("\n");
    for (const s of Object.values(secrets)) {
      expect(all.includes(s)).toBe(false);
    }
  });
});
