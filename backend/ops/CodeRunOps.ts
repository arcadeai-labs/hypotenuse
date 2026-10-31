import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { api } from "keryx";
import { approvals } from "../schema/approvals";
import {
  type CodeRun,
  type CodeRunStatus,
  codeRuns,
  type HostCallRecord,
} from "../schema/code_runs";
import { botWrite } from "../tools/memory-shared";
import {
  type Suspension,
  type ToolContext,
  ToolError,
  type ToolErrorEnvelope,
} from "../tools/types";
import type { ApprovalDraft } from "./ApprovalOps";
import {
  audienceOf,
  type ContinuationScope,
  contextOf,
  openContinuation,
  projectContinuationKey,
  sealContinuation,
} from "./code/continuation";
import { hostFunctions } from "./code/host";
import { SHORT_PRIMER } from "./code/primer";
import { execute, limitsFor, type RunOutcome } from "./code/runtime";
import type { DbHandle, TxHandle } from "./DbOps";

/**
 * **Code runs**: one `run_code` call's program, from its first invocation to
 * the result written once.
 *
 * | Found for the intent | First run | Recovery (`resume`) |
 * |---|---|---|
 * | no row | insert one `running`; execute | report the call interrupted: no host call ran |
 * | `running` | — | the worker died mid-program: `interrupted_by_crash`, reported interrupted with the journal |
 * | `interrupted`, an approval pending | — | wait again on the same approvals |
 * | `interrupted`, every approval decided | — | verify, then replay from the continuation with every resolution |
 * | `completed` / `failed` / `interrupted_by_crash` | — | write the stored `output` (the worker died before it) |
 *
 * | The invocation | The row | The call |
 * |---|---|---|
 * | completed | `completed`, `output` | its result |
 * | failed | `failed`, `output` | an error envelope, with the short primer |
 * | interrupted | `interrupted`, the continuation sealed — in the parking transaction | a {@link Suspension}: one approval per interruption |
 *
 * A crashed run is never reconstructed from its journal: Run produces a
 * continuation only at an interruption, and a replay that guessed would be
 * worse than an honest "interrupted".
 */

/** What `run_code` was called with. */
export interface RunCodeInput {
  source: string;
  saveTo?: { path: string; scope?: "channel" };
  changeNote?: string;
}

/** A successful program's answer. */
export type RunCodeOutput =
  | {
      codeRunId: number;
      result: unknown;
      resultType: string;
      resultCount: number | null;
      console?: string[];
    }
  | {
      codeRunId: number;
      path: string;
      scope: string;
      versionId: number;
      bytesWritten: number;
      preview: string;
      console?: string[];
    };

/**
 * The digest of a program's source.
 * @param source - The source.
 * @returns Hex sha256.
 */
export function sourceDigest(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

/**
 * The run of an intent, if any.
 * @param db - A database handle.
 * @param entryId - The `run_code` intent.
 * @returns The row.
 */
export async function codeRunForIntent(
  db: DbHandle,
  entryId: number,
): Promise<CodeRun | undefined> {
  const [row] = await db
    .select()
    .from(codeRuns)
    .where(eq(codeRuns.entryId, entryId))
    .limit(1);
  return row;
}

/**
 * The scope a run's continuation is bound to.
 * @param run - The run.
 * @returns Its scope.
 */
function scopeOf(run: CodeRun): ContinuationScope {
  return {
    projectId: run.projectId,
    botId: run.botId,
    conversationId: run.conversationId,
    intentEntryId: run.entryId,
    codeRunId: run.id,
  };
}

/**
 * A failure envelope for the model, with what the program logged.
 * @param errorType - The stable type.
 * @param message - What happened.
 * @param hint - What to do next; the short primer is appended.
 * @param extra - Console output, the run id, the journal.
 * @returns The envelope.
 */
function failure(
  errorType: string,
  message: string,
  hint: string,
  extra: Record<string, unknown> = {},
): ToolErrorEnvelope & Record<string, unknown> {
  return {
    is_error: true,
    error_type: errorType,
    message,
    next_action_hint: `${hint}\n\n${SHORT_PRIMER}`,
    ...extra,
  };
}

/** What to do next, by failure type. */
const HINTS: Record<string, string> = {
  invalid_source:
    "Fix the syntax. The source is a function body: top-level await and return work; imports do not.",
  program_error: "Fix the program; console output up to the throw is attached.",
  sandbox_timeout:
    "Do less per run, or fetch less: capture once and compute locally rather than calling a tool per record.",
  sandbox_memory:
    "Hold less at once: reduce as you go, or write parts to memory.",
  sandbox_limit:
    "Stay within the limits: fewer host calls (capture once, then compute), a smaller result (save it with saveTo), or a shorter program.",
  host_error: "Read the message; fix the call's arguments, or try another way.",
  mcp_error: "Read the message; fix the tool call, or try another way.",
  approval_denied:
    "A person refused a call. Do not run it again; catch the HostError whose code is approval_denied to fall back, or ask the person.",
  continuation_invalid:
    "The paused program could not be resumed safely, so nothing more ran. Run it again if it is still needed.",
  internal_error: "Try again; if it keeps failing, tell the person.",
};

/**
 * Describe a value's shape for the model.
 * @param value - The result.
 * @returns Its type and, for a collection, its size.
 */
function shapeOf(value: unknown): {
  resultType: string;
  resultCount: number | null;
} {
  if (value === null || value === undefined)
    return {
      resultType: value === null ? "null" : "undefined",
      resultCount: null,
    };
  if (Array.isArray(value))
    return { resultType: "array", resultCount: value.length };
  if (typeof value === "object")
    return { resultType: "object", resultCount: Object.keys(value).length };
  return { resultType: typeof value, resultCount: null };
}

/**
 * Update a run.
 * @param db - A handle.
 * @param id - The run.
 * @param set - The columns.
 */
async function updateRun(
  db: DbHandle,
  id: number,
  set: Partial<typeof codeRuns.$inferInsert>,
): Promise<void> {
  await db.update(codeRuns).set(set).where(eq(codeRuns.id, id));
}

/**
 * Settle an invocation: write the row's outcome and shape the call's answer.
 * @param run - The run.
 * @param outcome - How the invocation ended.
 * @param input - The call's input.
 * @param ctx - The tick's context.
 * @param ms - How long it took.
 * @returns The output, an error envelope, or a suspension.
 */
async function settle(
  run: CodeRun,
  outcome: RunOutcome,
  input: RunCodeInput,
  ctx: ToolContext,
  ms: number,
): Promise<RunCodeOutput | ToolErrorEnvelope | Suspension> {
  const durationMs = (run.durationMs ?? 0) + ms;
  if (outcome.status === "interrupted") {
    const drafts: ApprovalDraft[] = outcome.interruptions.map((i) => {
      const p = (i.payload ?? {}) as {
        server?: string;
        tool?: string;
        args?: Record<string, unknown>;
        callKey?: string;
      };
      return {
        callKey: String(p.callKey),
        server: String(p.server),
        tool: String(p.tool),
        args: p.args ?? {},
        reason: "not-allowlisted",
        codeRunId: run.id,
        interruptionId: i.id,
      };
    });
    const sealed = sealContinuation(outcome.token);
    return {
      suspended: true,
      approvalIds: [],
      drafts,
      onPark: (tx: TxHandle) =>
        updateRun(tx, run.id, {
          status: "interrupted",
          continuation: sealed,
          interruptionIds: outcome.interruptions.map((i) => i.id),
          durationMs,
        }),
    };
  }
  const logs = outcome.logs.length > 0 ? { console: outcome.logs } : {};
  if (outcome.status === "failed") {
    // What already ran, so the model does not ask for the same effects again.
    const [journaled] = await api.db.db
      .select({ hostCalls: codeRuns.hostCalls })
      .from(codeRuns)
      .where(eq(codeRuns.id, run.id));
    const output = failure(
      outcome.errorType,
      outcome.message,
      HINTS[outcome.errorType] ?? HINTS.internal_error,
      {
        codeRunId: run.id,
        hostCalls: journaled?.hostCalls ?? [],
        ...(outcome.hostErrorType
          ? { hostErrorType: outcome.hostErrorType }
          : {}),
        ...logs,
      },
    );
    await updateRun(api.db.db, run.id, {
      status: "failed",
      errorType: outcome.errorType,
      output,
      continuation: null,
      durationMs,
    });
    return output;
  }
  let output: RunCodeOutput;
  if (input.saveTo) {
    const content = JSON.stringify(outcome.value ?? null, null, 2);
    try {
      const { row } = await botWrite(
        ctx,
        input.saveTo.scope ?? "channel",
        input.saveTo.path,
        () => ({
          content,
          description: "Result of run_code",
          changeNote: input.changeNote ?? "Saved by run_code",
        }),
      );
      output = {
        codeRunId: run.id,
        path: row.logicalPath,
        scope: row.scope,
        versionId: row.versionId.getTime(),
        bytesWritten: Buffer.byteLength(content, "utf8"),
        preview: content.slice(0, 500),
        ...logs,
      };
    } catch (error) {
      const e =
        error instanceof ToolError
          ? error
          : new ToolError("host_error", String(error), "Try again.");
      const out = failure(e.errorType, e.message, e.nextActionHint, {
        codeRunId: run.id,
        ...logs,
      });
      await updateRun(api.db.db, run.id, {
        status: "failed",
        errorType: e.errorType,
        output: out,
        continuation: null,
        durationMs,
      });
      return out;
    }
  } else {
    output = {
      codeRunId: run.id,
      result: outcome.value ?? null,
      ...shapeOf(outcome.value),
      ...logs,
    };
  }
  await updateRun(api.db.db, run.id, {
    status: "completed",
    output: output as Record<string, unknown>,
    continuation: null,
    durationMs,
    resultBytes: Buffer.byteLength(JSON.stringify(output), "utf8"),
  });
  return output;
}

/**
 * Invoke a run's program: fresh, or from its continuation with resolutions.
 * @param run - The run.
 * @param input - The call's input.
 * @param ctx - The tick's context.
 * @param resume - The continuation and the batch's resolutions.
 * @returns The answer.
 */
async function invokeRun(
  run: CodeRun,
  input: RunCodeInput,
  ctx: ToolContext,
  resume?: {
    continuation: string;
    resolutions: { interruptionId: string; value: unknown }[];
  },
): Promise<RunCodeOutput | ToolErrorEnvelope | Suspension> {
  const scope = scopeOf(run);
  const started = Date.now();
  const outcome = await execute({
    source: input.source,
    hostFunctions: hostFunctions({ ctx, run }),
    limits: limitsFor(ctx.bot.codeLimits),
    secret: await projectContinuationKey(api.db.db, run.projectId),
    audience: audienceOf(scope),
    context: contextOf(scope),
    signal: ctx.signal,
    ...(resume ?? {}),
  });
  return settle(run, outcome, input, ctx, Date.now() - started);
}

/**
 * **Start** a `run_code` call: record its run, then execute the program.
 * @param input - The call's input.
 * @param ctx - The tick's context.
 * @returns The answer.
 */
export async function startCodeRun(
  input: RunCodeInput,
  ctx: ToolContext,
): Promise<RunCodeOutput | ToolErrorEnvelope | Suspension> {
  const [run] = await api.db.db
    .insert(codeRuns)
    .values({
      projectId: ctx.bot.projectId,
      botId: ctx.bot.id,
      conversationId: ctx.conversation.id,
      entryId: ctx.intentEntryId,
      source: input.source,
      sourceSha256: sourceDigest(input.source),
      status: "running",
      invocations: 1,
      leaseOwner: ctx.conversation.leaseOwner,
    })
    .onConflictDoNothing()
    .returning();
  // An intent already has a run only if an earlier lease started it.
  if (!run) return resumeCodeRun(input, ctx);
  return invokeRun(run, input, ctx);
}

/**
 * The interrupted answer for a call whose program cannot go on, with what it
 * had done.
 * @param journal - The run's settled host calls.
 * @param message - What happened.
 * @returns The envelope.
 */
function interruptedOutput(
  journal: HostCallRecord[],
  message: string,
): ToolErrorEnvelope & Record<string, unknown> {
  return {
    is_error: true,
    error_type: "interrupted",
    message,
    next_action_hint:
      "Look at the host calls that settled before deciding whether to run it again; a call listed may have had its effect.",
    hostCalls: journal,
  };
}

/**
 * **Resume** a `run_code` call whose intent an earlier lease left open.
 * The table at the top of this file says what each state of its run means.
 * @param input - The call's input.
 * @param ctx - The tick's context.
 * @returns The answer, or a suspension to wait again.
 */
export async function resumeCodeRun(
  input: RunCodeInput,
  ctx: ToolContext,
): Promise<RunCodeOutput | ToolErrorEnvelope | Suspension> {
  const run = await codeRunForIntent(api.db.db, ctx.intentEntryId);
  if (!run) {
    return interruptedOutput(
      [],
      "The worker stopped before the program started; nothing in it ran.",
    );
  }
  if (run.status === "running") {
    const output = interruptedOutput(
      run.hostCalls,
      `The worker stopped while the program ran, after ${run.hostCalls.length} host call${run.hostCalls.length === 1 ? "" : "s"} settled. It was not resumed.`,
    );
    await updateRun(api.db.db, run.id, {
      status: "interrupted_by_crash",
      errorType: "interrupted",
      output: { ...output, codeRunId: run.id },
      continuation: null,
    });
    return { ...output, codeRunId: run.id };
  }
  if (run.status !== "interrupted") {
    return (run.output ??
      interruptedOutput(
        run.hostCalls,
        "The program ended without a recorded answer.",
      )) as RunCodeOutput | ToolErrorEnvelope;
  }

  const batch = await api.db.db
    .select()
    .from(approvals)
    .where(eq(approvals.codeRunId, run.id));
  const current = batch.filter((a) =>
    run.interruptionIds.includes(String(a.interruptionId)),
  );
  if (current.some((a) => a.status === "pending")) {
    return {
      suspended: true,
      approvalIds: current.map((a) => a.id),
      drafts: [],
    };
  }

  const fail = async (message: string) => {
    const output = failure(
      "continuation_invalid",
      message,
      HINTS.continuation_invalid,
      { codeRunId: run.id },
    );
    await updateRun(api.db.db, run.id, {
      status: "failed",
      errorType: "continuation_invalid",
      output,
      continuation: null,
    });
    return output;
  };
  if (run.sourceSha256 !== sourceDigest(input.source)) {
    return fail("The program to resume is not the program that paused.");
  }
  const token = run.continuation ? openContinuation(run.continuation) : null;
  if (!token)
    return fail("The paused program's saved state could not be read.");

  await updateRun(api.db.db, run.id, {
    status: "running",
    invocations: sql`${codeRuns.invocations} + 1` as unknown as number,
    leaseOwner: ctx.conversation.leaseOwner,
  });
  return invokeRun({ ...run, status: "running" }, input, ctx, {
    continuation: token,
    resolutions: run.interruptionIds.map((interruptionId) => ({
      interruptionId,
      value: { decided: true },
    })),
  });
}

/**
 * Stop every unfinished run of a conversation that is being cancelled: the
 * continuation is dropped, so nothing can resume.
 * @param tx - The cancel's transaction.
 * @param conversationId - The conversation.
 */
export async function abandonCodeRuns(
  tx: DbHandle,
  conversationId: number,
): Promise<void> {
  await tx
    .update(codeRuns)
    .set({ status: "failed", errorType: "cancelled", continuation: null })
    .where(
      and(
        eq(codeRuns.conversationId, conversationId),
        inArray(codeRuns.status, ["running", "interrupted"] as CodeRunStatus[]),
      ),
    );
}

/**
 * The approvals of some runs, by run.
 * @param db - A handle.
 * @param runIds - The runs.
 * @returns Each run's approvals, oldest first.
 */
export async function approvalsOfRuns(
  db: DbHandle,
  runIds: number[],
): Promise<Map<number, (typeof approvals.$inferSelect)[]>> {
  const out = new Map<number, (typeof approvals.$inferSelect)[]>();
  if (runIds.length === 0) return out;
  const rows = await db
    .select()
    .from(approvals)
    .where(inArray(approvals.codeRunId, runIds))
    .orderBy(approvals.id);
  for (const row of rows) {
    const id = Number(row.codeRunId);
    out.set(id, [...(out.get(id) ?? []), row]);
  }
  return out;
}

/**
 * Shape a run for any answer. Never the continuation.
 * @param run - The run.
 * @param runApprovals - Its approvals, for the transcript.
 * @returns The serialized run.
 */
export function serializeCodeRun(
  run: CodeRun,
  runApprovals: {
    id: number;
    interruptionId: string | null;
    status: string;
    server: string;
    tool: string;
  }[] = [],
) {
  return {
    id: run.id,
    projectId: run.projectId,
    botId: run.botId,
    conversationId: run.conversationId,
    entryId: run.entryId,
    source: run.source,
    sourceSha256: run.sourceSha256,
    status: run.status,
    hostCalls: run.hostCalls,
    interruptionIds: run.interruptionIds,
    approvals: runApprovals.map((a) => ({
      id: a.id,
      interruptionId: a.interruptionId,
      status: a.status,
      name: `${a.server}/${a.tool}`,
    })),
    output: run.output,
    errorType: run.errorType,
    invocations: run.invocations,
    bridgeRequests: run.bridgeRequests,
    durationMs: run.durationMs,
    resultBytes: run.resultBytes,
    createdAt: run.createdAt.getTime(),
    updatedAt: run.updatedAt.getTime(),
  };
}
