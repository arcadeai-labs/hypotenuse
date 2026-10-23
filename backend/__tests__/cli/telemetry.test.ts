import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api } from "keryx";
import { OtlpCollector } from "../fixtures/otlp-collector";
import {
  authHeaders,
  buildTestUniverse,
  computeS256Challenge,
  HOOK_TIMEOUT,
  randomString,
  type TestUniverse,
  type TestUser,
} from "../setup";

/**
 * `hypotenuse telemetry exporter`, spawned from source against the booted
 * server and the test collector: add with write-only headers (never printed,
 * never in `--json`), list and view, edit keeping or clearing headers, test,
 * remove, and a member refused the admin verbs.
 */
const CLI = join(import.meta.dir, "..", "..", "..", "cli", "src", "cli.ts");

let universe: TestUniverse;
let url: string;
const homes: Record<string, string> = {};
const collector = new OtlpCollector();
const SECRET = "vendor-key-cli-1234567";

/**
 * Sign a test user's CLI in the way the dashboard would, with the shared
 * project selected.
 * @param user - Who to sign in.
 * @returns Their config directory.
 */
async function signIn(user: TestUser): Promise<string> {
  const verifier = randomString(64);
  const approve = await fetch(`${url}/api/cli-auth/approve`, {
    method: "PUT",
    headers: authHeaders(user.sessionId),
    body: JSON.stringify({
      codeChallenge: await computeS256Challenge(verifier),
      device: `${user.name}-laptop`,
    }),
  });
  const { code } = (await approve.json()) as { code: string };
  const exchange = await fetch(`${url}/api/cli-auth/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, codeVerifier: verifier }),
  });
  const { token, cliToken } = (await exchange.json()) as {
    token: string;
    cliToken: { id: number; device: string };
  };
  const home = mkdtempSync(join(tmpdir(), "hyp-cli-telemetry-"));
  mkdirSync(join(home, "hypotenuse"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(home, "hypotenuse", "credentials.json"),
    JSON.stringify({
      version: 1,
      current: url,
      servers: {
        [url]: {
          login: {
            token,
            cliTokenId: cliToken.id,
            device: cliToken.device,
            email: user.email,
          },
          project: universe.projectId,
          runner: null,
        },
      },
    }),
    { mode: 0o600 },
  );
  return home;
}

beforeAll(async () => {
  universe = await buildTestUniverse();
  url = universe.url;
  homes.peach = await signIn(universe.peach);
  homes.mario = await signIn(universe.mario);
}, HOOK_TIMEOUT);

afterAll(async () => {
  collector.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * Run the CLI to completion as someone.
 * @param who - Whose sign-in.
 * @param args - Arguments after `hypotenuse`.
 * @returns Exit code and captured output.
 */
async function run(who: string, args: string[]) {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: {
      ...process.env,
      XDG_CONFIG_HOME: homes[who],
      HYPOTENUSE_NO_UPDATE_CHECK: "1",
      HYPOTENUSE_URL: undefined,
      HYPOTENUSE_PROJECT: undefined,
      NO_COLOR: "1",
      FORCE_COLOR: undefined,
    },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

describe("hypotenuse telemetry exporter", () => {
  let id: number;

  test("add sends the headers and never prints them", async () => {
    const added = await run("peach", [
      "telemetry",
      "exporter",
      "add",
      "--name",
      "vendor",
      "--endpoint",
      `${collector.url}/v`,
      "--header",
      `x-api-key=${SECRET}`,
      "--content",
      "content",
      "--sample",
      "0.5",
      "--no-agent-native",
      "--json",
    ]);
    expect(added.code).toBe(0);
    expect(added.stdout + added.stderr).not.toContain(SECRET);
    const body = JSON.parse(added.stdout) as {
      telemetryExporter: {
        id: number;
        headerNames: string[];
        content: string;
        traceSampleRatio: number;
        agentNative: boolean;
      };
    };
    id = body.telemetryExporter.id;
    expect(body.telemetryExporter).toMatchObject({
      headerNames: ["x-api-key"],
      content: "content",
      traceSampleRatio: 0.5,
      agentNative: false,
    });
  });

  test("list and view show names and health, never values", async () => {
    const list = await run("mario", ["telemetry", "exporter", "list"]);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("vendor");
    expect(list.stdout).toContain("x-api-key");
    expect(list.stdout).toContain("nothing yet");
    const view = await run("mario", [
      "telemetry",
      "exporter",
      "view",
      String(id),
    ]);
    expect(view.stdout).toContain("x-api-key (values are never shown)");
    expect(view.stdout).toContain("50% of turns");
    expect(view.stdout + list.stdout).not.toContain(SECRET);
  });

  test("edit keeps headers unless told; --clear-headers clears them", async () => {
    const kept = await run("peach", [
      "telemetry",
      "exporter",
      "edit",
      String(id),
      "--content",
      "full",
      "--json",
    ]);
    const k = JSON.parse(kept.stdout) as {
      telemetryExporter: {
        headerNames: string[];
        content: string;
        agentNative: boolean;
      };
    };
    expect(k.telemetryExporter).toMatchObject({
      headerNames: ["x-api-key"],
      content: "full",
      agentNative: false,
    });
    const cleared = await run("peach", [
      "telemetry",
      "exporter",
      "edit",
      String(id),
      "--clear-headers",
      "--json",
    ]);
    expect(
      (
        JSON.parse(cleared.stdout) as {
          telemetryExporter: { headerNames: string[] };
        }
      ).telemetryExporter.headerNames,
    ).toEqual([]);
  });

  test("test prints each signal's answer, and fails when one fails", async () => {
    const ok = await run("peach", [
      "telemetry",
      "exporter",
      "test",
      String(id),
    ]);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toMatch(/traces\s+200/);
    collector.fail(503, 1);
    const failed = await run("peach", [
      "telemetry",
      "exporter",
      "test",
      String(id),
    ]);
    expect(failed.code).toBe(1);
    expect(failed.stdout).toMatch(/traces\s+503/);
  });

  test("a member may not add, edit, test, or remove", async () => {
    for (const args of [
      ["add", "--name", "x", "--endpoint", collector.url],
      ["edit", String(id), "--content", "metadata"],
      ["test", String(id)],
      ["remove", String(id)],
    ]) {
      const res = await run("mario", ["telemetry", "exporter", ...args]);
      expect(res.code, args.join(" ")).not.toBe(0);
    }
  });

  test("remove", async () => {
    const removed = await run("peach", [
      "telemetry",
      "exporter",
      "remove",
      String(id),
    ]);
    expect(removed.code).toBe(0);
    const list = await run("peach", [
      "telemetry",
      "exporter",
      "list",
      "--json",
    ]);
    expect(
      (JSON.parse(list.stdout) as { telemetryExporters: unknown[] })
        .telemetryExporters,
    ).toEqual([]);
  });
});
