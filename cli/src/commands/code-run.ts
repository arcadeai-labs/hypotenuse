/**
 * `hypotenuse code-run` — the programs a bot ran with `run_code`
 * (`code-run:list`, `code-run:view`): each one's source, status, the host
 * calls it made and how each was let through, and its answer.
 */
import type { Command } from "commander";
import {
  emit,
  type Paginated,
  pageFooter,
  pageQuery,
  runCommand,
  when,
  withPaging,
} from "../context";
import { parseNumber } from "../input";
import { table } from "../output/theme";

/** One host call of a run's journal. */
interface HostCall {
  fn: string;
  name?: string;
  ok: boolean;
  errorType?: string;
  gate?: string;
  approvalId?: number;
  ms: number;
}

/** A code run as the code-run actions answer it. */
interface CodeRun {
  id: number;
  conversationId: number;
  entryId: number;
  source: string;
  status: string;
  hostCalls: HostCall[];
  approvals: { id: number; status: string; name: string }[];
  output: Record<string, unknown> | null;
  errorType: string | null;
  invocations: number;
  durationMs: number | null;
  createdAt: number;
}

/**
 * A program's first non-blank line.
 * @param source - The program.
 * @returns The line.
 */
export function firstLine(source: string): string {
  return (
    source
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ""
  );
}

/**
 * Render a run for a person: its source, answer, console, host calls, and
 * the approvals it waits on.
 * @param r - The run.
 * @returns The text.
 */
export function codeRunDetail(r: CodeRun): string {
  const out = r.output ?? {};
  const lines = [
    `code run ${r.id} — ${r.status}`,
    `conversation  ${r.conversationId}`,
    `started       ${when(r.createdAt)}`,
    `took          ${r.durationMs === null ? "-" : `${(r.durationMs / 1000).toFixed(1)}s`} over ${r.invocations} invocation${r.invocations === 1 ? "" : "s"}`,
    "",
    "program",
    ...r.source.split("\n").map((l) => `  ${l}`),
  ];
  if (out.is_error) {
    lines.push(
      "",
      `error         ${String(out.error_type)}: ${String(out.message ?? "")}`,
    );
  } else if ("result" in out) {
    lines.push(
      "",
      "result",
      ...JSON.stringify(out.result, null, 2)
        .split("\n")
        .map((l) => `  ${l}`),
    );
  } else if ("path" in out) {
    lines.push(
      "",
      `saved to      ${String(out.path)} (${String(out.bytesWritten)} bytes)`,
    );
  }
  if (Array.isArray(out.console) && out.console.length > 0) {
    lines.push(
      "",
      "console",
      ...(out.console as string[]).map((l) => `  ${l}`),
    );
  }
  if (r.hostCalls.length > 0) {
    lines.push("", "host calls");
    for (const h of r.hostCalls) {
      lines.push(
        `  ${h.fn}${h.name ? ` ${h.name}` : ""} — ${h.ok ? "ok" : (h.errorType ?? "error")}${h.gate ? ` (${h.gate}${h.approvalId ? ` #${h.approvalId}` : ""})` : ""} ${h.ms} ms`,
      );
    }
  }
  const pending = r.approvals.filter((a) => a.status === "pending");
  if (pending.length > 0) {
    lines.push("", "waiting on");
    for (const a of pending) {
      lines.push(
        `  approval ${a.id}: ${a.name} — hypotenuse approval view ${a.id}`,
      );
    }
  }
  return lines.join("\n");
}

/**
 * Register `code-run list` and `code-run view`.
 * @param program - The root program.
 */
export function registerCodeRunCommands(program: Command): void {
  const codeRun = program
    .command("code-run")
    .description("Programs bots ran in code mode (run_code): list, view");

  withPaging(
    codeRun
      .command("list")
      .description(
        "List a conversation's programs, newest first (the bot's read access)",
      )
      .requiredOption("--conversation <id>", "the conversation"),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const o = this.opts() as { conversation: string };
      const conversationId = parseNumber(o.conversation, "--conversation");
      const client = ctx.signedInClient();
      const projectId = await ctx.projectId();
      const result = await client.request<Paginated<"codeRuns", CodeRun>>(
        "GET",
        `/project/${projectId}/conversation/${conversationId}/code-runs`,
        { query: pageQuery(this) },
      );
      emit(
        ctx,
        result,
        () =>
          table(
            result.codeRuns.map((r) => ({
              id: r.id,
              status: r.status,
              program: firstLine(r.source),
              calls: r.hostCalls.length,
              outcome: r.errorType ?? (r.status === "completed" ? "ok" : "-"),
              started: when(r.createdAt),
            })),
            [
              { key: "id" },
              { key: "status" },
              { key: "program", maxWidth: 60 },
              { key: "calls" },
              { key: "outcome" },
              { key: "started" },
            ],
          ) + pageFooter(result.pagination),
      );
    });
  });

  codeRun
    .command("view")
    .description(
      "Show a program: its source, result or error, console, host calls, and approvals",
    )
    .argument("<id>", "the code run")
    .action(async function (this: Command, raw: string) {
      await runCommand(this, async (ctx) => {
        const id = parseNumber(raw, "<id>");
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const result = await client.request<{ codeRun: CodeRun }>(
          "GET",
          `/project/${projectId}/code-run/${id}`,
        );
        emit(ctx, result, () => codeRunDetail(result.codeRun));
      });
    });
}
