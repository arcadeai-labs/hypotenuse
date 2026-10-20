/**
 * `hypotenuse audit` — the selected project's audit log (`audit:list`).
 */
import type { Command } from "commander";
import {
  emit,
  pageFooter,
  pageQuery,
  runCommand,
  when,
  withPaging,
} from "../context";
import { table } from "../output/theme";

/** How far back `audit list` looks without `--since`. */
const DEFAULT_WINDOW_DAYS = 30;

/** An audit row as `audit:list` answers it. */
interface AuditLog {
  id: number;
  userId: number | null;
  action: string;
  targetType: string | null;
  targetPath: string | null;
  createdAt: number;
}

/**
 * A `--since` / `--until` value: an ISO-8601 time, epoch milliseconds, or a
 * relative `7d` / `12h` / `30m` meaning that long ago.
 * @param raw - What was typed.
 * @param now - The current time in epoch ms.
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
    .description("The selected project's audit log (admin)");

  withPaging(
    audit
      .command("list")
      .description("List who changed what, newest first")
      .option(
        "--since <time>",
        `start of the range: ISO-8601, epoch ms, or 7d / 12h / 30m (default ${DEFAULT_WINDOW_DAYS}d)`,
      )
      .option("--until <time>", "end of the range (default now)")
      .option("--action <name>", "only this action, e.g. tag:edit"),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const opts = this.opts() as {
        since?: string;
        until?: string;
        action?: string;
      };
      const projectId = await ctx.projectId();
      const result = await ctx.signedInClient().request<{
        auditLogs: AuditLog[];
        pagination: { page: number; pages: number; total: number };
      }>("GET", "/audit-logs", {
        query: {
          projectId,
          since: parseTime(opts.since ?? `${DEFAULT_WINDOW_DAYS}d`),
          until: opts.until ? parseTime(opts.until) : undefined,
          action: opts.action,
          ...pageQuery(this),
        },
      });
      emit(
        ctx,
        result,
        () =>
          table(
            result.auditLogs.map((a) => ({
              when: when(a.createdAt),
              user: a.userId ?? "-",
              action: a.action,
              target: [a.targetType, a.targetPath].filter(Boolean).join(" "),
            })),
            [
              { key: "when" },
              { key: "user" },
              { key: "action" },
              { key: "target", maxWidth: 50 },
            ],
          ) + pageFooter(result.pagination),
      );
    });
  });
}
