import { eq, sql } from "drizzle-orm";
import { api } from "keryx";
import type { HostCallRecord } from "../../schema/code_runs";
import { codeRuns } from "../../schema/code_runs";
import { ToolError } from "../../tools/types";
import type { HostBody, HostFunctionDef, HostScope } from "./host-shared";
import { largeResultHost } from "./large-result";
import { mcpHost } from "./mcp";
import { memoryHost } from "./memory";
import { type HostAnswer, hostContext } from "./runtime";

/**
 * **The host API**: everything a program can do, as host functions that run
 * in the worker with the tick's context. Each one validates and bounds its
 * arguments, enforces the conversation's scope, the bot's allowlist, and the
 * approval gate exactly as the top-level tool does — the same ops, one
 * policy — and answers data, never a client, connection, or function.
 *
 * | Guest | Host function | Through |
 * |---|---|---|
 * | `memory.search` / `list` / `read` / `write` | `memory_*` | the memory tools' ops, channel writes only |
 * | `mcp.listTools` / `search` / `info` | `mcp_list_tools` / `mcp_search` / `mcp_info` | the MCP meta-tools |
 * | `mcp.exec` / `capture` | `mcp_exec` / `mcp_capture` | `mcp_exec`'s client and gate; a gated call interrupts the program |
 * | `largeResult.read` | `large_result_read` | `read_large_result` |
 *
 * A refusal is answered as data (`{ok: false, error}`) and turned into a
 * thrown `HostError` by the guest shim; an MCP refusal's type is prefixed
 * `mcp:` so a program that lets it escape fails as `mcp_error`. Every settled
 * call is journaled to `code_runs.host_calls` before it answers.
 */

/**
 * Append one record to a run's journal.
 * @param runId - The run.
 * @param record - The settled call.
 */
async function journal(runId: number, record: HostCallRecord): Promise<void> {
  await api.db.db
    .update(codeRuns)
    .set({
      hostCalls: sql`${codeRuns.hostCalls} || ${JSON.stringify([record])}::jsonb`,
      bridgeRequests: sql`${codeRuns.bridgeRequests} + 1`,
    })
    .where(eq(codeRuns.id, runId));
}

/**
 * The byte length of a value as JSON.
 * @param value - Anything.
 * @returns Its size, or 0 when it has none.
 */
function sizeOf(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return 0;
  }
}

/**
 * Wrap one host function: validate, run, journal, answer — and interrupt
 * when the body says a person must decide first.
 * @param scope - Where it runs.
 * @param def - The function.
 * @returns The function Run calls.
 */
function wrap(
  scope: HostScope,
  def: HostFunctionDef,
): (...args: unknown[]) => Promise<HostAnswer> {
  return async (...raw: unknown[]) => {
    const started = Date.now();
    const argBytes = sizeOf(raw);
    const refuse = async (
      type: string,
      message: string,
      hint: string,
      extra: Partial<HostCallRecord> = {},
    ): Promise<HostAnswer> => {
      const prefixed =
        def.mcp && type !== "approval_denied" ? `mcp:${type}` : type;
      await journal(scope.run.id, {
        fn: def.fn,
        ok: false,
        errorType: type,
        argBytes,
        outputBytes: 0,
        ms: Date.now() - started,
        ...extra,
      });
      return { ok: false, error: { type: prefixed, message, hint } };
    };
    // Trailing `undefined`s are how a guest leaves an optional argument out.
    const trimmed = [...raw];
    while (trimmed.length && trimmed[trimmed.length - 1] === undefined) {
      trimmed.pop();
    }
    const parsed = def.args.safeParse(trimmed);
    if (!parsed.success) {
      return refuse(
        "invalid_arguments",
        `${def.fn}: ${parsed.error.issues
          .map((i) => `${i.path.join(".") || "arguments"}: ${i.message}`)
          .join("; ")}`,
        'Read the API with run_code and source "?", then call it with arguments that match.',
      );
    }
    let outcome: Awaited<ReturnType<HostBody>>;
    try {
      outcome = await def.body(scope, parsed.data);
    } catch (error) {
      if (scope.ctx.signal.aborted) throw error;
      if (error instanceof ToolError) {
        const extra = (
          error as ToolError & { record?: Partial<HostCallRecord> }
        ).record;
        return refuse(
          error.errorType,
          error.message,
          error.nextActionHint,
          extra,
        );
      }
      return refuse(
        "host_failed",
        `${def.fn} failed: ${error instanceof Error ? error.message : String(error)}`,
        "Try again if it may have been transient; otherwise report what failed.",
      );
    }
    if ("interrupt" in outcome) {
      // Before any effect, and outside every `try`: Run's interrupt throws.
      return hostContext().interrupt(outcome.interrupt);
    }
    await journal(scope.run.id, {
      fn: def.fn,
      ok: true,
      ...(outcome.name ? { name: outcome.name } : {}),
      ...(outcome.gate ? { gate: outcome.gate } : {}),
      ...(outcome.approvalId ? { approvalId: outcome.approvalId } : {}),
      argBytes,
      outputBytes: sizeOf(outcome.value),
      ms: Date.now() - started,
    });
    return { ok: true, value: outcome.value };
  };
}

/**
 * Every host function, bound to one run.
 * @param scope - The tick's context and the run.
 * @returns The host function group, by the names the shim calls.
 */
export function hostFunctions(
  scope: HostScope,
): Record<string, (...args: never[]) => Promise<HostAnswer>> {
  const defs: Record<string, HostFunctionDef> = {
    ...memoryHost,
    ...mcpHost,
    ...largeResultHost,
  };
  return Object.fromEntries(
    Object.entries(defs).map(([name, def]) => [name, wrap(scope, def)]),
  ) as Record<string, (...args: never[]) => Promise<HostAnswer>>;
}
