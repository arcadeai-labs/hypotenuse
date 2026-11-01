import { and, eq } from "drizzle-orm";
import { type Action, api, HTTP_METHOD } from "keryx";
import { z } from "zod";
import {
  actingBot,
  actingJob,
  type JobConnection,
  JobTokenMiddleware,
} from "../../middleware/jobToken";
import { decryptSecret } from "../../ops/CryptoOps";
import { teeUsage } from "../../ops/ModelProxyOps";
import { guardedFetch } from "../../ops/NetworkGuardOps";
import {
  rawRequestOf,
  readCappedBody,
  requestPath,
} from "../../ops/RawRequestOps";
import {
  addJobUsage,
  overBudget,
  requestJobCancel,
} from "../../ops/SandboxJobOps";
import { jobModels } from "../../ops/SandboxProvisionOps";
import { modelAliases } from "../../schema/model_aliases";
import { modelConnections } from "../../schema/model_connections";

/** The upstream paths the proxy forwards; anything else is a 404. */
const FORWARDED_PATHS = new Set(["/v1/messages", "/v1/messages/count_tokens"]);

/** Model requests one job may have in flight at once. */
const MAX_INFLIGHT = 4;

/** The largest model request forwarded. */
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;

/** Request headers worth forwarding; the credential is ours to attach. */
const FORWARDED_REQUEST_HEADERS = [
  "content-type",
  "accept",
  "anthropic-version",
  "anthropic-beta",
];

/** Response headers worth handing back to the CLI. */
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "request-id",
  "retry-after",
  "x-should-retry",
];

/** The Anthropic API's own error envelope, which a CLI parses and shows. */
function refusal(status: number, type: string, message: string): Response {
  return new Response(
    JSON.stringify({ type: "error", error: { type, message } }),
    {
      status,
      headers: {
        "content-type": "application/json",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

/**
 * `proxy:model` — a coding CLI's model request, signed here. The sandbox
 * holds only its job token (`ANTHROPIC_AUTH_TOKEN`, sent as a bearer); this
 * attaches the key of the bot's model connection, forwards the body
 * untouched, and streams the answer back. Four gates, cheapest first:
 *
 * 1. **The path** — only `/v1/messages` (and `count_tokens`): not an open relay.
 * 2. **The model** — the bot's own `modelAlias` or `fastModelAlias`, on an
 *    Anthropic connection. A job cannot ask for a model its bot does not use.
 * 3. **The budget** — over the job's token budget is HTTP 402
 *    (`budget_exceeded`) and the job is cancelled; checked again when each
 *    answer's usage lands.
 * 4. **The credential** — decrypted here, attached, and dropped.
 *
 * `web.rawBody` and `web.streaming` are load-bearing: without the first the
 * body would be parsed into params and gone; without the second, a stream
 * would be buffered. Nothing is read from params: a body carrying a `token`
 * cannot choose which job this is. Not audited: machine traffic, recorded on
 * the job's `usage`.
 */
export class ProxyModel implements Action {
  name = "proxy:model";
  description =
    "Forward a sandbox coding agent's model request to its bot's model provider, attaching the credential. Reachable only from inside a sandbox, with a live job token.";
  mcp = { tool: false };
  middleware = [JobTokenMiddleware];
  web = {
    route: /^\/proxy\/model\/.+$/,
    method: HTTP_METHOD.POST,
    rawBody: true,
    streaming: true,
  };
  timeout = 0;
  inputs = z.object({});

  /**
   * Forward one model request.
   * @param _params - Unused; everything is read from the raw request.
   * @param connection - The job's connection.
   * @returns The upstream's answer, streamed, or a refusal in the provider's shape.
   */
  async run(_params: unknown, connection: JobConnection) {
    const request = rawRequestOf(connection);
    const job = actingJob(connection);
    const bot = actingBot(connection);
    const match = /^\/proxy\/model\/([a-z-]+)(\/.*)$/.exec(
      requestPath(request),
    );
    if (!match || match[1] !== "anthropic" || !FORWARDED_PATHS.has(match[2])) {
      return refusal(404, "not_found_error", "This endpoint is not proxied.");
    }
    const upstreamPath = match[2];
    const body = await readCappedBody(request, MAX_REQUEST_BYTES);
    if (body.oversized) {
      return refusal(
        413,
        "request_too_large",
        "The model request is too large.",
      );
    }
    let requested: string | null = null;
    let maxTokens = 0;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(body.bytes)) as {
        model?: unknown;
        max_tokens?: unknown;
      };
      requested = String(parsed.model ?? "");
      maxTokens = Math.max(0, Number(parsed.max_tokens) || 0);
    } catch {
      return refusal(400, "invalid_request_error", "The body is not JSON.");
    }
    const models = await jobModels(api.db.db, bot);
    if (!models) {
      return refusal(
        502,
        "hypotenuse_refused",
        `${bot.displayName}'s "${bot.modelAlias}" model is not on an Anthropic connection, so a coding agent cannot use it.`,
      );
    }
    const allowed = [models.model, models.fastModel].filter(Boolean);
    if (!requested || !allowed.includes(requested)) {
      return refusal(
        400,
        "invalid_request_error",
        `This job may use ${allowed.map((m) => `"${m}"`).join(" or ")}, not "${requested}".`,
      );
    }
    if (overBudget(job)) {
      await requestJobCancel(job.id, "budget_exceeded");
      return refusal(
        402,
        "budget_exceeded",
        `This job used its budget of ${job.budgetTokens} tokens and is being stopped.`,
      );
    }
    // What this request could cost at most — its input, at four characters a
    // token, and every output token it may ask for — must fit what is left,
    // so parallel requests cannot all start under the line and land far
    // past it.
    if (
      job.budgetTokens !== null &&
      job.usage.inputTokens +
        job.usage.outputTokens +
        Math.ceil(body.byteLength / 4) +
        maxTokens >
        job.budgetTokens
    ) {
      return refusal(
        402,
        "budget_exceeded",
        `This request could take this job past its budget of ${job.budgetTokens} tokens. Ask for fewer max_tokens, or finish with what you have.`,
      );
    }
    // A few requests in flight per job at once, counted in Redis.
    const inflight = `sandbox:model-inflight:${job.id}`;
    const count = await api.redis.redis.incr(inflight);
    await api.redis.redis.pexpire(inflight, 10 * 60 * 1000);
    if (count > MAX_INFLIGHT) {
      await api.redis.redis.decr(inflight);
      return refusal(
        429,
        "rate_limit_error",
        `At most ${MAX_INFLIGHT} model requests may run at once for one job.`,
      );
    }
    const release = () => void api.redis.redis.decr(inflight).catch(() => 0);
    const alias =
      requested === models.model ? bot.modelAlias : bot.fastModelAlias;
    const [row] = await api.db.db
      .select({ connection: modelConnections })
      .from(modelAliases)
      .innerJoin(
        modelConnections,
        eq(modelConnections.id, modelAliases.connectionId),
      )
      .where(
        and(
          eq(modelAliases.projectId, job.projectId),
          eq(modelAliases.name, alias),
        ),
      )
      .limit(1);
    if (!row) {
      release();
      return refusal(502, "hypotenuse_refused", "The bot's model is gone.");
    }
    const base = (
      row.connection.baseUrl || "https://api.anthropic.com/v1"
    ).replace(/\/+$/, "");
    const url = `${base}${upstreamPath.replace(/^\/v1/, "")}${new URL(request.url).search}`;
    const headers = new Headers();
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    headers.set("x-api-key", decryptSecret(row.connection.secret));
    let upstream: Response;
    try {
      upstream = await guardedFetch(url, {
        method: "POST",
        headers,
        body: body.bytes,
      });
    } catch (e) {
      release();
      return refusal(
        502,
        "api_error",
        `The model provider could not be reached: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const out = new Headers();
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) out.set(name, value);
    }
    const stream =
      upstream.body && upstreamPath === "/v1/messages"
        ? teeUsage(upstream.body, (usage) => {
            release();
            void addJobUsage(job.id, usage)
              .then(async (total) => {
                if (overBudget(job, total)) {
                  await requestJobCancel(job.id, "budget_exceeded");
                }
              })
              .catch((e) =>
                api.logger.warn("could not record a sandbox job's usage", {
                  jobId: job.id,
                  error: e instanceof Error ? e.message : String(e),
                }),
              );
          })
        : upstream.body;
    if (stream === upstream.body) release();
    return new Response(stream, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: out,
    });
  }
}
