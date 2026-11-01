import { eq } from "drizzle-orm";
import {
  type ActionMiddleware,
  api,
  CONNECTION_TYPE,
  type Connection,
  checkRateLimit,
  config,
  ErrorType,
  TypedError,
} from "keryx";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../config/sandbox";
import { bearerToken } from "../ops/RawRequestOps";
import { resolveJobByToken } from "../ops/SandboxJobOps";
import { type Bot, bots } from "../schema/bots";
import type { SandboxJob } from "../schema/sandbox_jobs";
import type { RbacConnectionMeta } from "./rbac";
import type { SessionImpl } from "./session";

/** The connection metadata a job-authenticated action reads. */
export interface JobConnectionMeta extends RbacConnectionMeta {
  /** The job this request acts for. */
  job?: SandboxJob;
  /** That job's bot. */
  jobBot?: Bot;
}

/** The connection every job-authenticated action receives. */
export type JobConnection = Connection<SessionImpl, JobConnectionMeta>;

/** The one refusal for a token that does not authenticate. */
const INVALID_JOB_TOKEN = "Invalid or expired sandbox job token";

/**
 * Authenticate a request as **a sandbox job**, over every transport it
 * arrives on:
 *
 * - **MCP** — Keryx verifies the `Authorization: Bearer` header and sets
 *   `connection.sessionId` to the token.
 * - **A param** — the supervisor posts JSON with the token as a
 *   `secret(z.string())` `token` field, redacted from logs for free.
 * - **A bearer header on plain HTTP** — the proxies' callers (the coding CLI,
 *   an MCP client) send a header or nothing.
 *
 * The job must be live (`provisioning`, `running`, or `awaiting_input`): a
 * token whose job has ended is refused before Redis expires it. One message
 * for "never valid", "ended", and "expired", so a caller cannot probe which
 * tokens exist. The job's row is re-read on every request, so every tool
 * re-derives its scope from it.
 */
export const JobTokenMiddleware: ActionMiddleware = {
  runBefore: async (params, connection) => {
    const conn = connection as JobConnection;
    const token =
      (params as { token?: string }).token ??
      (conn.type === CONNECTION_TYPE.MCP ? conn.sessionId : undefined) ??
      (conn.rawRequest
        ? (bearerToken(conn.rawRequest) ?? undefined)
        : undefined);
    if (!token) {
      throw new TypedError({
        message:
          "A sandbox job token is required. This endpoint is for a coding agent running inside a Hypotenuse sandbox.",
        type: ErrorType.CONNECTION_SESSION_NOT_FOUND,
      });
    }
    const job = await resolveJobByToken(token);
    if (!job) {
      throw new TypedError({
        message: INVALID_JOB_TOKEN,
        type: ErrorType.CONNECTION_SESSION_NOT_FOUND,
      });
    }
    const [bot] = await api.db.db
      .select()
      .from(bots)
      .where(eq(bots.id, job.botId))
      .limit(1);
    conn.metadata.job = job;
    conn.metadata.jobBot = bot;
  },
};

/**
 * Per-job rate limit, after {@link JobTokenMiddleware}: keyed on the resolved
 * job, never on the IP (many sandboxes share a NAT) or the presented secret.
 * The proxies stay off it: a model stream would burn the budget in seconds.
 */
export const JobTokenRateLimitMiddleware: ActionMiddleware = {
  runBefore: async (_params, connection) => {
    if (!config.rateLimit.enabled) return;
    const job = actingJob(connection as JobConnection);
    const info = await checkRateLimit(`sandbox-job:${job.id}`, true, {
      limit: config.sandbox.supervisorRateLimit,
      windowMs: config.sandbox.supervisorRateWindowMs,
    });
    connection.rateLimitInfo = info;
    if (info.retryAfter !== undefined) {
      throw new TypedError({
        message: `Rate limit exceeded. Try again in ${info.retryAfter} seconds.`,
        type: ErrorType.CONNECTION_RATE_LIMITED,
      });
    }
  },
};

/**
 * The job a connection acts for.
 * @param connection - A connection {@link JobTokenMiddleware} ran on.
 * @returns The job.
 * @throws {TypedError} When the middleware did not run.
 */
export function actingJob(connection: JobConnection): SandboxJob {
  const job = connection.metadata.job;
  if (!job) {
    throw new TypedError({
      message: "No sandbox job is authenticated on this connection",
      type: ErrorType.CONNECTION_SESSION_NOT_FOUND,
    });
  }
  return job;
}

/**
 * The bot a job acts for.
 * @param connection - A connection {@link JobTokenMiddleware} ran on.
 * @returns The bot.
 */
export function actingBot(connection: JobConnection): Bot {
  const bot = connection.metadata.jobBot;
  if (!bot) {
    throw new TypedError({
      message: "No sandbox job is authenticated on this connection",
      type: ErrorType.CONNECTION_SESSION_NOT_FOUND,
    });
  }
  return bot;
}
