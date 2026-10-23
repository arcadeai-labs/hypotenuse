/**
 * `hypotenuse doctor` — "why isn't my runner picking anything up", answered
 * without opening a log. A checklist of ✓ / ! / ✗ lines (`--json` for a
 * report); exit 1 when any check fails.
 *
 * | Check | How |
 * |---|---|
 * | Version and install method | upgradr; whether an update is available |
 * | Bun (npm installs), git ≥ 2.38, gh | `--version` |
 * | Config | `config validate` passes 1–3 |
 * | Credentials | present, `0600`, a runner for the server |
 * | Server | `/api/status`, a dry-run heartbeat, latency, clock skew |
 * | Daemon | the control socket's `status`; the service unit |
 * | Agents | each used agent's command; `--agent <id>` runs `initialize` and opens a session |
 * | Repositories | pass-3 checks and `git fetch --dry-run` |
 * | Disk | free space under `worktree_root` against `min_free_disk` |
 */

import { existsSync, statfsSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import type { Command } from "commander";
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from "../../../protocol/src/index";
import pkg from "../../package.json";
import { handshake } from "../acp/handshake";
import { resolveAgentLaunch } from "../acp/presets";
import { ApiClient, ApiError } from "../api/client";
import { originOf } from "../api/credentials";
import { checkConfig, formatIssue } from "../config/check";
import { formatSize } from "../config/durations";
import { applyOverrides } from "../config/loader";
import {
  MIN_GIT_VERSION,
  parseGitVersion,
  realMachine,
} from "../config/machine";
import { tildify } from "../config/paths";
import { resolveAgents } from "../config/resolve";
import type { Config } from "../config/schema";
import { type CliContext, emit, runCommand } from "../context";
import {
  buildCapabilities,
  buildLimits,
  daemonRepositories,
} from "../daemon/capabilities";
import { callDaemon } from "../daemon/control-client";
import { CLOCK_SKEW_WARN_MS } from "../daemon/server-link";
import { color, glyph } from "../output/theme";
import { machineId, platform } from "../runner/machine";
import { nativeTelemetrySupport } from "../telemetry/native";
import { updater } from "../update/updater";
import type { DaemonStatus } from "./daemon";
import { locateDaemon } from "./daemon";
import { unitPath } from "./service";

/** One check's outcome. */
export interface Check {
  /** The checklist row. */
  group: string;
  /** `ok`, `warn`, or `fail`. */
  status: "ok" | "warn" | "fail";
  /** What was found. */
  message: string;
}

/** The checks so far. */
class Checklist {
  readonly checks: Check[] = [];

  /**
   * @param group - The row.
   * @param message - What was found.
   */
  ok(group: string, message: string): void {
    this.checks.push({ group, status: "ok", message });
  }

  /**
   * @param group - The row.
   * @param message - What was found.
   */
  warn(group: string, message: string): void {
    this.checks.push({ group, status: "warn", message });
  }

  /**
   * @param group - The row.
   * @param message - What was found.
   */
  fail(group: string, message: string): void {
    this.checks.push({ group, status: "fail", message });
  }
}

/**
 * Run every check.
 * @param ctx - The context.
 * @param options - `agent` for a handshake with one agent; `offline` to skip the network.
 * @returns The checks.
 */
export async function runDoctor(
  ctx: CliContext,
  options: { agent?: string; offline?: boolean },
): Promise<Check[]> {
  const list = new Checklist();
  const machine = realMachine(ctx.env);

  // Version and install method.
  const method = updater.detectInstallMethod();
  if (options.offline) {
    list.ok("version", `hypotenuse v${pkg.version} (${method})`);
  } else {
    const info = await updater
      .checkForUpdate(AbortSignal.timeout(5_000))
      .catch(() => null);
    if (info?.hasUpdate)
      list.warn(
        "version",
        `hypotenuse v${pkg.version} (${method}); v${info.latestVersion} is available — \`hypotenuse upgrade\``,
      );
    else
      list.ok(
        "version",
        `hypotenuse v${pkg.version} (${method})${info ? ", up to date" : ""}`,
      );
  }

  // Tools.
  if (method !== "binary") {
    const bun = machine.which("bun");
    if (bun) list.ok("tools", `bun ${Bun.version}`);
    else list.fail("tools", "bun is not on PATH (the npm package runs on Bun)");
  }
  const git = parseGitVersion(machine.git(["--version"]).stdout);
  if (!git) list.fail("tools", "git is not on PATH");
  else if (
    git[0] < MIN_GIT_VERSION[0] ||
    (git[0] === MIN_GIT_VERSION[0] && git[1] < MIN_GIT_VERSION[1])
  ) {
    list.fail(
      "tools",
      `git ${git.join(".")} is older than ${MIN_GIT_VERSION.join(".")}`,
    );
  } else list.ok("tools", `git ${git.join(".")}`);
  if (machine.which("gh")) list.ok("tools", "gh is installed");
  else
    list.warn(
      "tools",
      "gh is not installed (agents open pull requests with it)",
    );

  // Config.
  const checked = checkConfig(ctx.configPath, {
    env: ctx.env,
    machine,
    offline: options.offline,
  });
  for (const issue of checked.findings.errors)
    list.fail("config", formatIssue(issue, ctx.configPath));
  for (const issue of checked.findings.warnings)
    list.warn("config", formatIssue(issue, ctx.configPath));
  if (checked.findings.errors.length === 0)
    list.ok("config", `${tildify(ctx.configPath, ctx.env)} is valid`);
  const config: Config | null = checked.config
    ? applyOverrides(
        checked.config,
        { url: ctx.options.url, project: ctx.options.project },
        ctx.env,
      )
    : checked.load.config;

  // Credentials.
  let origin: string;
  try {
    origin = config?.server.url
      ? originOf(config.server.url)
      : ctx.server.origin;
  } catch (error) {
    list.fail(
      "credentials",
      error instanceof Error ? error.message : String(error),
    );
    return list.checks;
  }
  let runner: {
    runnerId: number;
    projectId: number;
    name: string;
    token: string;
  } | null = null;
  if (!existsSync(ctx.credentialsPath)) {
    list.fail(
      "credentials",
      `${tildify(ctx.credentialsPath, ctx.env)} does not exist — \`hypotenuse login\`, then \`hypotenuse runner register\``,
    );
  } else {
    try {
      runner = ctx.credentials.servers[origin]?.runner ?? null;
      const mode = statSync(ctx.credentialsPath).mode & 0o777;
      if (runner)
        list.ok(
          "credentials",
          `runner "${runner.name}" (#${runner.runnerId}) for ${origin}; mode ${mode.toString(8)}`,
        );
      else
        list.fail(
          "credentials",
          `no runner for ${origin} — \`hypotenuse runner register\``,
        );
    } catch (error) {
      list.fail(
        "credentials",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // Server.
  if (!options.offline) {
    const started = Date.now();
    try {
      await new ApiClient(origin).request("GET", "/status", {
        timeoutMs: 10_000,
      });
      list.ok("server", `${origin} answers (${Date.now() - started} ms)`);
    } catch (error) {
      list.fail(
        "server",
        `${origin} is not reachable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (runner && config) {
      try {
        const sent = Date.now();
        const answer = await new ApiClient(origin, runner.token).request<{
          serverTime: number;
          runner?: { projectSlug: string };
        }>("POST", "/daemon/heartbeat", {
          body: {
            protocolVersion: PROTOCOL_VERSION,
            daemonVersion: pkg.version,
            platform: platform(),
            hostname: hostname().slice(0, 256) || "unknown",
            draining: false,
            machineId: machineId(),
            limits: buildLimits(config),
            active: [],
            capabilities: buildCapabilities(
              config,
              machine,
              daemonRepositories(config, machine),
            ),
            dryRun: true,
          },
          headers: { [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) },
          timeoutMs: 10_000,
        });
        const latency = Date.now() - sent;
        const skew = Math.round(sent + latency / 2 - answer.serverTime);
        list.ok(
          "server",
          `the runner token is accepted (project ${answer.runner?.projectSlug ?? runner.projectId}; ${latency} ms)`,
        );
        if (Math.abs(skew) > CLOCK_SKEW_WARN_MS) {
          list.warn(
            "server",
            `this clock is ${Math.round(skew / 1000)}s off the server's; agents that sign things may fail`,
          );
        } else {
          list.ok("server", `clock skew ${skew} ms`);
        }
      } catch (error) {
        list.fail(
          "server",
          error instanceof ApiError && error.status === 401
            ? "the runner token is not accepted (revoked or deleted) — `hypotenuse runner register`"
            : `the dry-run heartbeat failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  // Daemon.
  try {
    const status = await callDaemon<DaemonStatus>(
      locateDaemon(ctx).socket,
      "status",
      {},
      3_000,
    );
    list.ok(
      "daemon",
      `running (pid ${status.pid}), ${status.server.connected ? "connected" : "not connected"}, ${status.slots.busy}/${status.slots.total} slots busy`,
    );
  } catch {
    list.warn(
      "daemon",
      "not running — `hypotenuse daemon start` or `hypotenuse service install`",
    );
  }
  const unit = unitPath(process.platform, ctx.env);
  if (unit && existsSync(unit))
    list.ok("daemon", `service unit ${tildify(unit, ctx.env)}`);
  else if (unit)
    list.warn(
      "daemon",
      "no service unit — `hypotenuse service install` starts the daemon at login",
    );

  if (!config) return list.checks;

  // Agents.
  for (const agent of resolveAgents(config)) {
    if (agent.roles.length === 0 && agent.id !== options.agent) continue;
    const binary = agent.command[0] ?? "";
    if (!machine.which(binary)) {
      list.fail("agents", `${agent.id}: "${binary}" is not on PATH`);
      continue;
    }
    if (options.agent !== agent.id) {
      list.ok(
        "agents",
        `${agent.id}: ${binary} resolves (used by ${agent.roles.join(", ")})`,
      );
      continue;
    }
    const launch = resolveAgentLaunch(config, agent.id, ctx.env);
    const probe = await handshake({
      command: agent.command,
      env: launch?.env ?? (ctx.env as Record<string, string>),
      timeoutMs: config.agents[agent.id]?.startup_timeout ?? 60_000,
      session: true,
    });
    if (!probe.ok)
      list.fail("agents", `${agent.id}: initialize failed: ${probe.error}`);
    else {
      const name =
        [probe.agentInfo?.name, probe.agentInfo?.version]
          .filter(Boolean)
          .join(" ") || agent.id;
      const methods = probe.authMethods.length
        ? `; auth methods: ${probe.authMethods.map((m) => m.id).join(", ")}`
        : "; no authentication needed";
      if (probe.session)
        list.ok(
          "agents",
          `${agent.id}: ${name} answered initialize${methods}; a session opened`,
        );
      else if (probe.authRequired)
        list.fail(
          "agents",
          `${agent.id}: ${name} is not logged in — \`hypotenuse agents login ${agent.id}\``,
        );
      else
        list.fail(
          "agents",
          `${agent.id}: ${name} answered initialize, but a session did not open: ${probe.error}`,
        );
    }
  }
  if (
    options.agent &&
    !resolveAgents(config).some((a) => a.id === options.agent)
  ) {
    list.fail("agents", `no agent "${options.agent}" in the config`);
  }

  // Telemetry: what this machine lets leave, and who adds their own.
  const t = config.telemetry;
  if (!t.enabled)
    list.ok(
      "telemetry",
      "off: this runner sends no telemetry (`[telemetry] enabled = false`)",
    );
  else {
    list.ok(
      "telemetry",
      `sends up to \`${t.max_content}\` for the project's exporters; buffer ${t.buffer_mb} MB`,
    );
    const agents = resolveAgents(config).filter((a) => a.roles.length > 0);
    if (!t.agent_native)
      list.ok("telemetry", "agents' own telemetry is not captured");
    else
      for (const agent of agents) {
        const support = nativeTelemetrySupport(agent.preset);
        list.ok(
          "telemetry",
          support === "native"
            ? `${agent.id}: contributes its own telemetry (model requests, tokens, cost)`
            : support === "standard-otel"
              ? `${agent.id}: contributes its own telemetry if it reads the standard OTEL_* variables`
              : `${agent.id}: a custom command — it gets OTEL_EXPORTER_OTLP_ENDPOINT and HYPOTENUSE_OTLP_ENDPOINT`,
        );
      }
  }

  // Repositories.
  for (const repo of daemonRepositories(config, machine)) {
    if (options.offline) {
      list.ok(
        "repositories",
        `${repo.name}: ${repo.remote} (${repo.baseBranch})`,
      );
      continue;
    }
    const fetch = machine.git(
      ["fetch", "--dry-run", "origin", repo.baseBranch],
      repo.path,
    );
    if (fetch.code === 0)
      list.ok(
        "repositories",
        `${repo.name}: origin ${repo.remote} is reachable`,
      );
    else
      list.fail(
        "repositories",
        `${repo.name}: cannot fetch from origin: ${fetch.stderr.trim().split("\n").at(-1) ?? ""}`,
      );
  }

  // Disk.
  let probePath = config.sessions.worktree_root;
  // Walk up to the nearest directory that exists; dirname() stops at any root.
  while (!existsSync(probePath) && dirname(probePath) !== probePath)
    probePath = dirname(probePath);
  try {
    const fs = statfsSync(probePath);
    const free = fs.bavail * fs.bsize;
    if (free < config.sessions.min_free_disk) {
      list.fail(
        "disk",
        `${formatSize(free)} free under ${tildify(config.sessions.worktree_root, ctx.env)}; sessions need ${formatSize(config.sessions.min_free_disk)}`,
      );
    } else
      list.ok(
        "disk",
        `${formatSize(free)} free under ${tildify(config.sessions.worktree_root, ctx.env)}`,
      );
  } catch (error) {
    list.warn(
      "disk",
      `could not read free space: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return list.checks;
}

/**
 * The human rendering of the checklist.
 * @param checks - The checks.
 * @returns Lines for stdout.
 */
export function describeChecks(checks: Check[]): string {
  const mark = (s: Check["status"]) =>
    s === "ok"
      ? glyph("complete")
      : s === "warn"
        ? color("status-waiting", "!")
        : glyph("error");
  const width = Math.max(...checks.map((c) => c.group.length));
  return checks
    .map((c) => `${mark(c.status)} ${c.group.padEnd(width)}  ${c.message}`)
    .join("\n");
}

/**
 * Register `doctor`.
 * @param program - The root program.
 */
export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description(
      "Check this machine's runner setup end to end (exit 1 when a check fails)",
    )
    .option(
      "--agent <id>",
      "also start this agent, run the ACP handshake, and open a session",
    )
    .option("--offline", "skip every check that needs the network")
    .action(async function (this: Command) {
      await runCommand(this, async (ctx: CliContext) => {
        const opts = this.opts() as { agent?: string; offline?: boolean };
        const checks = await runDoctor(ctx, opts);
        const failed = checks.filter((c) => c.status === "fail").length;
        emit(ctx, { ok: failed === 0, checks }, () => describeChecks(checks));
        if (failed > 0) process.exitCode = 1;
      });
    });
}
