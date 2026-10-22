import {
  TOOL_RESULT_MAX_BYTES,
  type ToolDefinition,
} from "@hypotenuse/protocol";
import {
  type Action,
  type ActionMiddleware,
  type Connection,
  ErrorType,
  HTTP_METHOD,
  TypedError,
} from "keryx";
import { z } from "zod";
import type { DaemonSpanMeta } from "../initializers/telemetry";
import {
  type DaemonScopeMeta,
  DaemonSessionScopeMiddleware,
  notPermittedResponse,
} from "../middleware/daemonSessionScope";
import { RunnerRateLimitMiddleware } from "../middleware/runnerRateLimit";
import { OutboxValidationError } from "../ops/ActivityOutboxOps";
import { ToolScope } from "../ops/DaemonScopeOps";
import type { ToolOutput } from "../ops/DaemonToolOps";
import { toolForAction } from "../ops/DaemonToolPolicyOps";
import { LinearBudgetExhaustedError } from "../ops/LinearBucketOps";
import { capResult } from "../ops/LinearMarkdownOps";
import { linearErrorToTypedError } from "../ops/LinearOps";
import { withTraceScope } from "../ops/TelemetryOps";

/**
 * What a tool function takes and answers. The input is `never` here so any
 * tool's own input type fits; the action's schema has already checked it.
 */
export type ToolFunction = (
  scope: ToolScope,
  input: never,
) => Promise<ToolOutput>;

/**
 * The base of every agent tool's action (`actions/daemon/linear/*.ts`,
 * `actions/daemon/daemon-dispatch.ts`). A subclass names its action and the
 * tool function from `ops/DaemonToolOps.ts`; everything else is derived from
 * the tool's row in `protocol/src/tools.ts`:
 *
 * - `web` is the tool's route, `POST`;
 * - `inputs` is the tool's schema plus `agentSessionId`;
 * - `middleware` is the per-runner rate limit, then
 *   `DaemonSessionScopeMiddleware` for this action;
 * - never an MCP tool for people (`daemon:*`, rule 9), never audited
 *   (machine writes, recorded in the turn's `linearWrites` ledger), never
 *   wrapped by the CLI.
 *
 * `run` answers a refused scope with the byte-identical 403, caps the
 * result at 16 KB, and turns Linear's failures into errors the agent can
 * read: an exhausted budget is a 429 saying to try again shortly.
 */
export abstract class DaemonToolAction implements Action {
  /** The `daemon:*` action name; it must be a tool's. */
  abstract name: string;
  /** What the tool does. */
  protected abstract readonly invoke: ToolFunction;

  description!: string;
  mcp = { tool: false };
  middleware!: ActionMiddleware[];
  web!: { route: string; method: HTTP_METHOD };
  inputs!: z.ZodObject;
  /** The tool this action serves. */
  protected tool!: ToolDefinition;

  /**
   * Fill in everything the tool's table row decides. Called by each
   * subclass's constructor once its `name` is set.
   */
  protected bind(): void {
    this.tool = toolForAction(this.name);
    this.description = `Called by a runner's daemon for a coding agent's ${this.tool.name} tool: ${this.tool.description} Runner token only; scoped to the session's live turn.`;
    this.web = { route: this.tool.route, method: HTTP_METHOD.POST };
    this.inputs = this.tool.input.extend({
      agentSessionId: z
        .number()
        .int()
        .positive()
        .describe("The Hypotenuse session the agent is working in"),
    });
    this.middleware = [
      RunnerRateLimitMiddleware("request"),
      DaemonSessionScopeMiddleware(this.name),
    ];
  }

  /**
   * @param params - The tool input and the session.
   * @param connection - The runner's connection, its scope resolved.
   * @returns `{ result: { text, data } }`, or the scope refusal.
   */
  async run(
    params: Record<string, unknown>,
    connection: Connection<Record<string, unknown>, DaemonScopeMeta>,
  ) {
    const resolved = connection.metadata.daemonScope;
    if (!resolved) return notPermittedResponse();
    const { agentSessionId: _session, ...input } = params;
    // A traced call's Linear requests are children of its server span.
    const span = (connection.metadata as DaemonSpanMeta).telemetrySpan;
    try {
      const output = await withTraceScope(
        span
          ? {
              projectId: resolved.session.projectId,
              traceId: span.traceId,
              parentSpanId: span.spanId,
            }
          : null,
        () =>
          this.invoke(new ToolScope(resolved, this.tool.name), input as never),
      );
      return {
        result: {
          text: capResult(output.text, TOOL_RESULT_MAX_BYTES),
          data: output.data,
        },
      };
    } catch (e) {
      if (e instanceof LinearBudgetExhaustedError) {
        throw new TypedError({
          message: e.message,
          type: ErrorType.CONNECTION_RATE_LIMITED,
        });
      }
      if (e instanceof OutboxValidationError) {
        throw new TypedError({
          message: e.message,
          type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        });
      }
      throw linearErrorToTypedError(e);
    }
  }
}
