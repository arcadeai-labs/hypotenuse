/**
 * `hypotenuse runner` — the selected project's runners (`runner:*`): register
 * this machine, list and inspect the fleet, pause, rename, and revoke.
 *
 * `register` is the one command that writes a runner token: it lands in this
 * server's `runner` slot in `credentials.json` (0600), never on stdout, and a
 * first heartbeat proves it works before the daemon is ever started.
 */
import type { Command } from "commander";
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from "../../../protocol/src/index";
import type { ApiClient } from "../api/client";
import type { CliContext } from "../context";
import {
  emit,
  pageFooter,
  pageQuery,
  runCommand,
  when,
  withPaging,
} from "../context";
import { glyph, table } from "../output/theme";
import { defaultRunnerName, registrationHeartbeat } from "../runner/machine";

/** A runner as `runner:list` and `runner:view` serialize it. */
export interface Runner {
  id: number;
  projectId: number;
  userId: number;
  owner: { id: number; name: string; email: string } | null;
  name: string;
  status: "online" | "offline" | "draining" | "revoked";
  online: boolean;
  enabled: boolean;
  tokenLastFour: string;
  lastHeartbeatAt: number | null;
  lastConnectedAt: number | null;
  protocolVersion: number | null;
  daemonVersion: string | null;
  platform: string | null;
  hostname: string | null;
  limits: { maxParallelJobs: number } | null;
  activeCount: number;
  roles: string[];
  agents: { id: string; preset: string; available: boolean }[];
  repositories: { name: string; remote: string; baseBranch: string }[];
  subscriptions?: { teams: string[]; projects: string[]; labels: string[] };
  socketAttached?: boolean;
  standing?: { canManage: boolean };
  createdAt: number;
  revokedAt: number | null;
  revokedReason: string | null;
}

/** The page envelope every list answers with. */
interface Pagination {
  page: number;
  limit: number;
  pages: number;
  total: number;
}

/**
 * Ask a yes/no question on the terminal.
 * @param question - The question, without the `[y/N]`.
 * @returns Whether the person answered yes.
 */
async function confirm(question: string): Promise<boolean> {
  process.stderr.write(`${question} [y/N] `);
  for await (const line of console) {
    return /^y(es)?$/i.test(line.trim());
  }
  return false;
}

/**
 * A runner's status with its glyph; a paused runner says so.
 * @param runner - The runner.
 * @returns The status cell.
 */
export function statusCell(runner: Runner): string {
  const shape =
    runner.status === "revoked" ? "✕" : glyph(runner.status as "online");
  return `${shape} ${runner.status}${runner.enabled ? "" : " (paused)"}`;
}

/**
 * Capacity as `used/total`.
 * @param runner - The runner.
 * @returns The capacity cell.
 */
export function capacityCell(runner: Runner): string {
  return runner.limits
    ? `${runner.activeCount}/${runner.limits.maxParallelJobs}`
    : "-";
}

/**
 * The human rendering of one runner.
 * @param runner - The runner, as `runner:view` answers it.
 * @returns Lines for stdout.
 */
export function describeRunner(runner: Runner): string {
  const list = (values: string[] | undefined) =>
    values && values.length > 0 ? values.join(", ") : "all";
  const lines = [
    `${runner.name}  (#${runner.id})`,
    `status       ${statusCell(runner)}`,
    `socket       ${runner.socketAttached === undefined ? "-" : runner.socketAttached ? "attached" : "not attached"}`,
    `owner        ${runner.owner ? `${runner.owner.name} <${runner.owner.email}>` : runner.userId}`,
    `capacity     ${capacityCell(runner)}`,
    `roles        ${runner.roles.length > 0 ? runner.roles.join(", ") : "-"}`,
    `agents       ${runner.agents.length > 0 ? runner.agents.map((a) => `${a.id}${a.available ? "" : " (unavailable)"}`).join(", ") : "-"}`,
    `host         ${runner.hostname ?? "-"} ${runner.platform ?? ""}`.trimEnd(),
    `daemon       ${runner.daemonVersion ?? "-"} (protocol ${runner.protocolVersion ?? "-"})`,
    `heartbeat    ${when(runner.lastHeartbeatAt)}`,
    `token        …${runner.tokenLastFour}`,
    `registered   ${when(runner.createdAt)}`,
  ];
  if (runner.subscriptions) {
    lines.push(
      `teams        ${list(runner.subscriptions.teams)}`,
      `projects     ${list(runner.subscriptions.projects)}`,
      `labels       ${list(runner.subscriptions.labels)}`,
    );
  }
  for (const repo of runner.repositories) {
    lines.push(
      `repository   ${repo.name}: ${repo.remote} (${repo.baseBranch})`,
    );
  }
  if (runner.revokedAt) {
    lines.push(
      `revoked      ${when(runner.revokedAt)} (${runner.revokedReason ?? "revoked"})`,
    );
  }
  return lines.join("\n");
}

/**
 * Resolve `<id|name>` to a runner id: a number is an id; anything else is
 * looked up by name among the project's unrevoked runners.
 * @param client - A signed-in client.
 * @param projectId - The project.
 * @param selector - What the person typed.
 * @returns The runner id.
 * @throws {Error} When no runner has that name.
 */
export async function resolveRunnerId(
  client: ApiClient,
  projectId: number,
  selector: string,
): Promise<number> {
  if (/^\d+$/.test(selector)) return Number(selector);
  for (let page = 1; ; page++) {
    const result = await client.request<{
      runners: Runner[];
      pagination: Pagination;
    }>("GET", "/runners", { query: { projectId, page, limit: 100 } });
    const found = result.runners.find((r) => r.name === selector);
    if (found) return found.id;
    if (page >= result.pagination.pages) break;
  }
  throw new Error(`No runner named "${selector}" in this project.`);
}

/**
 * Send one heartbeat as a runner, as the daemon will.
 * @param ctx - The context (for the server).
 * @param token - The runner token.
 */
async function firstHeartbeat(ctx: CliContext, token: string): Promise<void> {
  await ctx.clientWith(token).request("POST", "/daemon/heartbeat", {
    body: registrationHeartbeat(),
    headers: { [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) },
  });
}

/**
 * Register `runner register|list|view|edit|revoke`.
 * @param program - The root program.
 */
export function registerRunnerCommands(program: Command): void {
  const runner = program
    .command("runner")
    .description(
      "The selected project's runners (machines that run coding agents)",
    );

  runner
    .command("register")
    .description(
      "Register this machine as a runner in the selected project and save its token",
    )
    .option("--name <name>", "the runner's name (default: this host's name)")
    .option("--replace", "revoke the runner with this name and register again")
    .option(
      "--force",
      "overwrite this machine's runner for a different project on this server",
    )
    .action(async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const opts = this.opts() as {
          name?: string;
          replace?: boolean;
          force?: boolean;
        };
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const name = opts.name ?? defaultRunnerName();
        const existing = ctx.entry.runner;
        if (existing && existing.projectId !== projectId && !opts.force) {
          throw new Error(
            `This machine is already runner "${existing.name}" (#${existing.runnerId}) in project ${existing.projectId} on ${ctx.server.origin}. Registering here would orphan it; pass --force to replace it, or revoke it first.`,
          );
        }

        const result = await client.request<{
          runner: Runner;
          token: string;
          replacedRunnerId: number | null;
        }>("PUT", "/runner", {
          body: { projectId, name, replace: Boolean(opts.replace) },
        });
        ctx.entry.runner = {
          runnerId: result.runner.id,
          projectId,
          name: result.runner.name,
          token: result.token,
        };
        ctx.save();

        try {
          await firstHeartbeat(ctx, result.token);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          throw new Error(
            `Registered runner "${result.runner.name}" (#${result.runner.id}) and saved its token to ${ctx.credentialsPath}, but its first heartbeat failed: ${message}`,
          );
        }

        const { token: _token, ...shown } = result;
        emit(ctx, shown, () =>
          [
            `Registered runner "${result.runner.name}" (#${result.runner.id})${result.replacedRunnerId ? `, replacing #${result.replacedRunnerId}` : ""}.`,
            `Its token is saved in ${ctx.credentialsPath}. Start it with \`hypotenuse daemon start\`.`,
          ].join("\n"),
        );
      });
    });

  withPaging(
    runner
      .command("list")
      .description("List the project's runners")
      .option(
        "--status <status>",
        "only runners online, offline, draining, or revoked",
      )
      .option("--all", "include revoked runners"),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const opts = this.opts() as { status?: string; all?: boolean };
      const projectId = await ctx.projectId();
      const result = await ctx.signedInClient().request<{
        runners: Runner[];
        pagination: Pagination;
      }>("GET", "/runners", {
        query: {
          projectId,
          status: opts.status,
          includeRevoked: opts.all ? true : undefined,
          ...pageQuery(this),
        },
      });
      emit(
        ctx,
        result,
        () =>
          table(
            result.runners.map((r) => ({
              id: r.id,
              name: r.name,
              owner: r.owner?.name ?? String(r.userId),
              status: statusCell(r),
              capacity: capacityCell(r),
              agents: r.agents.map((a) => a.id).join(", ") || "-",
              heartbeat: when(r.lastHeartbeatAt),
            })),
            [
              { key: "id" },
              { key: "name", maxWidth: 30 },
              { key: "owner", maxWidth: 24 },
              { key: "status" },
              { key: "capacity", align: "right" },
              { key: "agents", maxWidth: 30 },
              { key: "heartbeat" },
            ],
          ) + pageFooter(result.pagination),
      );
    });
  });

  runner
    .command("view")
    .description(
      "Show a runner's capabilities and subscriptions as the server last saw them",
    )
    .argument("<runner>", "the runner's id or name")
    .action(async function (this: Command, selector: string) {
      await runCommand(this, async (ctx) => {
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const id = await resolveRunnerId(client, projectId, selector);
        const result = await client.request<{ runner: Runner }>(
          "GET",
          `/runner/${id}`,
          { query: { projectId } },
        );
        emit(ctx, result, () => describeRunner(result.runner));
      });
    });

  runner
    .command("edit")
    .description(
      "Rename, pause, or resume a runner (its owner or a project admin)",
    )
    .argument("<runner>", "the runner's id or name")
    .option("--name <name>", "a new name")
    .option("--enable", "resume: offer it work again")
    .option("--disable", "pause: keep it connected but offer it no work")
    .action(async function (this: Command, selector: string) {
      await runCommand(this, async (ctx) => {
        const opts = this.opts() as {
          name?: string;
          enable?: boolean;
          disable?: boolean;
        };
        if (opts.enable && opts.disable) {
          throw new Error("Pass --enable or --disable, not both.");
        }
        const enabled = opts.enable ? true : opts.disable ? false : undefined;
        if (opts.name === undefined && enabled === undefined) {
          throw new Error(
            "Nothing to change: pass --name, --enable, or --disable.",
          );
        }
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const id = await resolveRunnerId(client, projectId, selector);
        const result = await client.request<{ runner: Runner }>(
          "POST",
          `/runner/${id}`,
          { body: { projectId, name: opts.name, enabled } },
        );
        const local = ctx.entry.runner;
        if (local && local.runnerId === id && opts.name !== undefined) {
          local.name = result.runner.name;
          ctx.save();
        }
        emit(
          ctx,
          result,
          () =>
            `Runner "${result.runner.name}" (#${result.runner.id}) is ${statusCell(result.runner)}.`,
        );
      });
    });

  runner
    .command("revoke")
    .description(
      "Permanently revoke a runner; its daemon stops at once (its owner or a project admin)",
    )
    .argument("<runner>", "the runner's id or name")
    .option("--yes", "do not ask for confirmation")
    .action(async function (this: Command, selector: string) {
      await runCommand(this, async (ctx) => {
        const { yes } = this.opts() as { yes?: boolean };
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const id = await resolveRunnerId(client, projectId, selector);
        if (!yes) {
          if (!process.stdin.isTTY || ctx.json) {
            throw new Error(
              `Revoking a runner cannot be undone. Re-run with --yes to revoke ${selector}.`,
            );
          }
          if (
            !(await confirm(
              `Revoke runner ${selector}? Its token stops working and its daemon stops at once.`,
            ))
          ) {
            throw new Error("Not revoked.");
          }
        }
        const result = await client.request<{ runner: Runner }>(
          "DELETE",
          `/runner/${id}`,
          { body: { projectId } },
        );
        const local = ctx.entry.runner;
        const forgotten = local?.runnerId === id;
        if (forgotten) {
          ctx.entry.runner = null;
          ctx.save();
        }
        emit(ctx, result, () =>
          [
            `Revoked runner "${result.runner.name}" (#${result.runner.id}).`,
            forgotten ? `Removed its token from ${ctx.credentialsPath}.` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      });
    });
}
