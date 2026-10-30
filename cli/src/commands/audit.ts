/**
 * `hypotenuse audit` — who changed what: the selected project's audit log
 * (`audit:list`), or with `--org` an organization's (`organization:audit-list`).
 */
import type { Command } from "commander";
import { resolveOrganizationId, resolveProjectId } from "../api/resolve";
import {
  emit,
  type Paginated,
  pageFooter,
  pageQuery,
  runCommand,
  when,
  withPaging,
} from "../context";
import { table } from "../output/theme";

/** How far back `audit list` reads when no `--since` is given. */
const DEFAULT_WINDOW_DAYS = 30;

/** An audit row as the audit lists answer it. */
interface AuditLog {
  id: number;
  actor: {
    type: string;
    userId: number | null;
    name: string | null;
    email: string | null;
  };
  projectName: string | null;
  action: string;
  targetType: string | null;
  targetPath: string | null;
  createdAt: number;
}

/**
 * Parse a time a person typed: epoch milliseconds, an ISO-8601 date, or a
 * span back from now (`7d`, `12h`, `30m`).
 * @param raw - What they typed.
 * @param now - The current time, injectable for tests.
 * @returns Epoch milliseconds.
 * @throws {Error} For anything else.
 */
export function parseTime(raw: string, now = Date.now()): number {
  if (/^\d+$/.test(raw)) return Number(raw);
  const relative = /^(\d+)([dhm])$/.exec(raw);
  if (relative) {
    const unit = { d: 86_400_000, h: 3_600_000, m: 60_000 }[
      relative[2] as "d" | "h" | "m"
    ];
    return now - Number(relative[1]) * unit;
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(
      `Not a time: ${raw} (use ISO-8601, epoch ms, or 7d / 12h / 30m)`,
    );
  }
  return parsed;
}

/**
 * Register `audit list`.
 * @param program - The root program.
 */
export function registerAuditCommands(program: Command): void {
  const audit = program
    .command("audit")
    .description(
      "Who changed what: a project's or an organization's audit log",
    );

  withPaging(
    audit
      .command("list")
      .description(
        "List the selected project's audit log (admin), newest first; with --org, the organization's (owner), narrowed by an explicit --project or to its own rows by --org-only",
      )
      .option(
        "--since <time>",
        `start of the range: ISO-8601, epoch ms, or 7d / 12h / 30m (default ${DEFAULT_WINDOW_DAYS}d)`,
      )
      .option("--until <time>", "end of the range (default now)")
      .option("--action <name>", "only this action, e.g. tag:edit")
      .option("--actor-type <type>", "only user, participant, or system")
      .option("--target-type <type>", "only this kind of thing, e.g. tag")
      .option(
        "--org-only",
        "with --org, only the organization's own rows, which belong to no project",
      ),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const opts = this.opts() as {
        since?: string;
        until?: string;
        action?: string;
        actorType?: string;
        targetType?: string;
        orgOnly?: boolean;
      };
      if (opts.orgOnly && !ctx.options.org) {
        throw new Error("--org-only reads an organization's log: add --org");
      }
      if (opts.orgOnly && ctx.options.project) {
        throw new Error(
          "Give --project or --org-only, not both: a row belongs to a project or to none",
        );
      }
      const client = ctx.signedInClient();
      const filters = {
        since: parseTime(opts.since ?? `${DEFAULT_WINDOW_DAYS}d`),
        until: opts.until ? parseTime(opts.until) : undefined,
        action: opts.action,
        actorType: opts.actorType,
        targetType: opts.targetType,
        ...pageQuery(this),
      };
      let path: string;
      let query: Record<string, unknown> = filters;
      if (ctx.options.org) {
        const organizationId = await resolveOrganizationId(
          client,
          ctx.options.org,
        );
        path = `/organization/${organizationId}/audit`;
        if (opts.orgOnly) {
          query = { ...filters, organizationOnly: true };
        } else if (ctx.options.project) {
          query = {
            ...filters,
            projectId: await resolveProjectId(client, ctx.options.project),
          };
        }
      } else {
        path = `/project/${await ctx.projectId()}/audit`;
      }
      const result = await client.request<Paginated<"auditLogs", AuditLog>>(
        "GET",
        path,
        { query },
      );
      emit(
        ctx,
        result,
        () =>
          table(
            result.auditLogs.map((a) => ({
              when: when(a.createdAt),
              actor: a.actor.email ?? a.actor.name ?? a.actor.type,
              project: a.projectName ?? "-",
              action: a.action,
              target: [a.targetType, a.targetPath].filter(Boolean).join(" "),
            })),
            [
              { key: "when" },
              { key: "actor", maxWidth: 32 },
              ...(ctx.options.org
                ? [{ key: "project" as const, maxWidth: 24 }]
                : []),
              { key: "action" },
              { key: "target", maxWidth: 50 },
            ],
          ) + pageFooter(result.pagination),
      );
    });
  });
}
