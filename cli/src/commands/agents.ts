/**
 * `hypotenuse agents` — the coding agents this machine runs.
 *
 * - `agents list [--all]` and `agents kill <session|issue>` ask the running
 *   daemon over its control socket (exit 3 when it is not running).
 * - `agents login <agent>` logs a coding agent in on this machine, once, so
 *   the daemon never has to ask a person to during a turn.
 *
 * It asks the agent (`initialize`) how it authenticates. A **terminal** method
 * is run interactively: the agent's own command with the method's `args` and
 * `env`, attached to this terminal. An **agent-run** method is called over
 * ACP (`authenticate`). Either way a fresh handshake then opens a session to
 * confirm, and says so. An agent that advertises no methods logs in with its
 * own tools (`claude login`, an API key); the confirmation still runs.
 */
import type { Command } from "commander";
import { handshake } from "../acp/handshake";
import { resolveAgentLaunch } from "../acp/presets";
import { checkConfig, formatIssue } from "../config/check";
import { tildify } from "../config/paths";
import { resolveAgents } from "../config/resolve";
import { type CliContext, emit, runCommand, when } from "../context";
import { callDaemon } from "../daemon/control-client";
import { glyph, table } from "../output/theme";
import { ExitError } from "../shutdown";
import { locateDaemon, notRunning } from "./daemon";

/** One row of `agents.list`. */
interface AgentRow {
  agentSessionId: number;
  issueIdentifier: string | null;
  role: string;
  agent: string | null;
  state: string;
  pid: number | null;
  startedAt: number;
  lastEventAt: number | null;
  worktree: string | null;
}

/**
 * How long a turn has been going: `12m`, `1h04m`.
 * @param since - When it started.
 * @param now - The current time.
 * @returns The text.
 */
export function forHowLong(since: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - since) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * Log one agent in.
 * @param ctx - The context.
 * @param agentId - The agent's id.
 * @param method - The auth method to use, if the agent offers several.
 * @returns What happened.
 */
export async function loginAgent(
  ctx: CliContext,
  agentId: string,
  method?: string,
): Promise<{
  agent: string;
  method: string | null;
  loggedIn: boolean;
  daemonReloaded: boolean;
}> {
  const checked = checkConfig(ctx.configPath, { env: ctx.env, offline: true });
  if (!checked.config) {
    throw new ExitError(
      1,
      checked.findings.errors
        .map((i) => formatIssue(i, ctx.configPath))
        .join("\n"),
    );
  }
  const config = checked.config;
  const launch = resolveAgentLaunch(config, agentId, ctx.env);
  if (!launch) {
    const known = resolveAgents(config).map((a) => a.id);
    throw new ExitError(
      1,
      `no agent "${agentId}" in ${ctx.configPath}${known.length ? ` (agents: ${known.join(", ")})` : ""}`,
    );
  }
  const first = await handshake({
    command: launch.command,
    env: launch.env,
    timeoutMs: launch.startupTimeoutMs,
    session: false,
  });
  if (!first.ok)
    throw new ExitError(1, `${agentId} did not start: ${first.error}`);

  const chosen =
    (method ?? launch.authMethod)
      ? first.authMethods.find((m) => m.id === (method ?? launch.authMethod))
      : (first.authMethods.find((m) => m.type === "terminal") ??
        first.authMethods[0]);
  if ((method ?? launch.authMethod) && !chosen) {
    throw new ExitError(
      1,
      `${agentId} offers no auth method "${method ?? launch.authMethod}" (it offers: ${first.authMethods.map((m) => m.id).join(", ") || "none"})`,
    );
  }

  if (chosen?.type === "terminal") {
    if (!ctx.json)
      process.stderr.write(
        `Running ${agentId}'s "${chosen.name}" login in this terminal…\n`,
      );
    const proc = Bun.spawn([...launch.command, ...chosen.args], {
      env: { ...launch.env, ...chosen.env },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = await proc.exited;
    if (code !== 0)
      throw new ExitError(1, `${agentId}'s login exited with code ${code}`);
  }

  const confirm = await handshake({
    command: launch.command,
    env: launch.env,
    timeoutMs: launch.startupTimeoutMs,
    session: true,
    ...(chosen && chosen.type !== "terminal"
      ? { authenticate: chosen.id }
      : {}),
  });
  const loggedIn = confirm.session === true;
  // A running daemon forgets that this agent was unavailable, so routing
  // offers it work again.
  let daemonReloaded = false;
  if (loggedIn) {
    try {
      await callDaemon(locateDaemon(ctx).socket, "reload", {}, 30_000);
      daemonReloaded = true;
    } catch {
      // No daemon running: it learns at its next start.
    }
  }
  return {
    agent: agentId,
    method: chosen?.id ?? null,
    loggedIn,
    daemonReloaded,
  };
}

/**
 * Register `agents login`.
 * @param program - The root program.
 */
export function registerAgentsCommands(program: Command): void {
  const agents = program
    .command("agents")
    .description("The coding agents this machine runs");
  agents
    .command("list")
    .description(
      "The agent sessions the daemon is running (and, with --all, has run)",
    )
    .option("--all", "include finished sessions")
    .action(async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const opts = this.opts() as { all?: boolean };
        let rows: AgentRow[];
        try {
          rows = await callDaemon<AgentRow[]>(
            locateDaemon(ctx).socket,
            "agents.list",
            { all: Boolean(opts.all) },
          );
        } catch (error) {
          notRunning(ctx, error);
        }
        emit(ctx, { agents: rows }, () =>
          rows.length
            ? table(
                rows.map((r) => ({
                  session: r.agentSessionId,
                  issue: r.issueIdentifier ?? "-",
                  role: r.role,
                  agent: r.agent ?? "-",
                  state: r.state,
                  for: forHowLong(r.startedAt),
                  pid: r.pid ?? "-",
                  worktree: r.worktree ? tildify(r.worktree, ctx.env) : "-",
                  "last event": when(r.lastEventAt),
                })),
                [
                  { key: "session" },
                  { key: "issue" },
                  { key: "role" },
                  { key: "agent" },
                  { key: "state" },
                  { key: "for" },
                  { key: "pid" },
                  { key: "worktree" },
                  { key: "last event" },
                ],
              )
            : "No agent sessions on this runner.",
        );
      });
    });
  agents
    .command("kill <target>")
    .description(
      "Stop the running turn of a session (by Hypotenuse session id or issue identifier); it says so in Linear",
    )
    .option("--reason <text>", "said in Linear with the stop, and logged")
    .action(async function (this: Command, target: string) {
      await runCommand(this, async (ctx) => {
        const opts = this.opts() as { reason?: string };
        let result: { killed: number[] };
        try {
          result = await callDaemon<{ killed: number[] }>(
            locateDaemon(ctx).socket,
            "agents.kill",
            {
              target: /^\d+$/.test(target) ? Number(target) : target,
              reason: opts.reason,
            },
          );
        } catch (error) {
          notRunning(ctx, error);
        }
        emit(ctx, result, () =>
          result.killed.length
            ? `Stopping ${result.killed.length} turn(s) for ${target}.`
            : `Nothing is running for ${target}.`,
        );
        if (!result.killed.length) process.exitCode = 1;
      });
    });
  agents
    .command("login <agent>")
    .description(
      "Log a coding agent in on this machine, then confirm it can open a session",
    )
    .option(
      "--method <id>",
      "the agent's auth method to use, when it offers several",
    )
    .action(async function (this: Command, agentId: string) {
      await runCommand(this, async (ctx) => {
        const opts = this.opts() as { method?: string };
        const result = await loginAgent(ctx, agentId, opts.method);
        emit(ctx, result, () =>
          result.loggedIn
            ? `${glyph("complete")} ${agentId} is logged in: it opened a session.`
            : `${glyph("error")} ${agentId} still cannot open a session. Check its own login (\`hypotenuse doctor --agent ${agentId}\`).`,
        );
        if (!result.loggedIn) process.exitCode = 1;
      });
    });
}
