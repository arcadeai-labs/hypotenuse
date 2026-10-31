import type { z } from "zod";
import type { CodeRun, HostCallRecord } from "../../schema/code_runs";
import { type ToolContext, ToolError } from "../../tools/types";
import { hostContext } from "./runtime";

/**
 * What the host function adapters share with the wrapper in `host.ts`: their
 * shape, the refusal they throw, and the context they hand to a tool's code.
 */

/** Where host functions run: the tick's context and the run they belong to. */
export interface HostScope {
  ctx: ToolContext;
  run: Pick<CodeRun, "id" | "projectId" | "conversationId">;
}

/** What a host function adapter returns, before journaling. */
export interface HostResult {
  value: unknown;
  /** What the journal says the call was about (`server/tool`, a path). */
  name?: string;
  gate?: HostCallRecord["gate"];
  approvalId?: number;
}

/**
 * A host function's body: validated arguments in, a result out. It throws a
 * {@link ToolError} for a refusal; the wrapper answers it as data. A gated
 * call returns `{interrupt}` instead, and the wrapper interrupts the program
 * outside any `try`, as Run requires.
 */
export type HostBody = (
  scope: HostScope,
  args: unknown[],
) => Promise<HostResult | { interrupt: Record<string, unknown> }>;

/** One host function's definition. */
export interface HostFunctionDef {
  /** The guest-facing name, for the journal (`mcp.exec`). */
  fn: string;
  /** Validates the guest's arguments, as a tuple. */
  args: z.ZodType<unknown[]>;
  /** Prefix refusals with `mcp:`. */
  mcp?: boolean;
  body: HostBody;
}

/**
 * A refusal that carries journal details (an MCP call's gate decision).
 * @param errorType - The refusal's type.
 * @param message - What happened.
 * @param hint - What to do.
 * @param record - What the journal should say besides.
 * @returns The error.
 */
export function refusal(
  errorType: string,
  message: string,
  hint: string,
  record: Partial<HostCallRecord> = {},
): ToolError {
  const error = new ToolError(errorType, message, hint) as ToolError & {
    record?: Partial<HostCallRecord>;
  };
  error.record = record;
  return error;
}

/**
 * The context a host call passes to a tool's own code: the tick's, with a
 * call id unique to this host call, so a memory write's retry dedupe (keyed by
 * conversation and call id) tells two writes of one program apart.
 * @param scope - Where it runs.
 * @returns The context.
 */
export function hostToolContext(scope: HostScope): ToolContext {
  const index = hostContext().requestIndex;
  return {
    ...scope.ctx,
    toolCallId: `${scope.ctx.toolCallId}:code:${index}`,
  };
}
