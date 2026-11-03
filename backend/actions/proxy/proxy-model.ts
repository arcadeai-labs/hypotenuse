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
import {
  type CodingProvider,
  jobModels,
  unsupportedCodingModel,
} from "../../ops/SandboxProvisionOps";
import { modelAliases } from "../../schema/model_aliases";
import { modelConnections } from "../../schema/model_connections";

/**
 * How the proxy speaks each provider a coding CLI uses: the paths it
 * forwards (anything else is a 404), the path whose answer reports usage,
 * the default upstream, the headers worth forwarding each way (the
 * credential is ours to attach), how the key is attached, and the field a
 * request names its output ceiling in.
 */
interface Dialect {
  paths: Set<string>;
  usagePath: string;
  defaultBase: string;
  requestHeaders: string[];
  responseHeaders: string[];
  sign: (headers: Headers, key: string) => void;
  maxTokensField: string;
  /**
   * Whether a request may omit its output ceiling, so the proxy sets one at
   * what the job's budget has left. Anthropic requires `max_tokens`; OpenAI's
   * `max_output_tokens` is optional.
   */
  capsOutput: boolean;
}

/** The smallest output ceiling OpenAI accepts. */
const MIN_OUTPUT_TOKENS = 16;

/** Claude Code speaks Anthropic Messages; Codex speaks OpenAI Responses. */
const DIALECTS: Record<CodingProvider, Dialect> = {
  anthropic: {
    paths: new Set(["/v1/messages", "/v1/messages/count_tokens"]),
    usagePath: "/v1/messages",
    defaultBase: "https://api.anthropic.com/v1",
    requestHeaders: [
      "content-type",
      "accept",
      "anthropic-version",
      "anthropic-beta",
    ],
    responseHeaders: [
      "content-type",
      "request-id",
      "retry-after",
      "x-should-retry",
    ],
    sign: (headers, key) => headers.set("x-api-key", key),
    maxTokensField: "max_tokens",
    capsOutput: false,
  },
  openai: {
    paths: new Set(["/v1/responses"]),
    usagePath: "/v1/responses",
    defaultBase: "https://api.openai.com/v1",
    requestHeaders: ["content-type", "accept", "openai-beta"],
    responseHeaders: ["content-type", "x-request-id", "retry-after"],
    sign: (headers, key) => headers.set("authorization", `Bearer ${key}`),
    maxTokensField: "max_output_tokens",
    capsOutput: true,
  },
};

/** Model requests one job may have in flight at once. */
const MAX_INFLIGHT = 4;

/** The largest model request forwarded. */
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;

/**
 * A refusal in the provider's own error envelope, which its CLI parses and
 * shows: Anthropic's `{ type: "error", error }`, OpenAI's `{ error }`.
 * @param provider - Whose envelope.
 * @param status - The HTTP status.
 * @param type - The error type.
 * @param message - The sentence.
 * @returns The response.
 */
function refusal(
  provider: CodingProvider,
  status: number,
  type: string,
  message: string,
): Response {
  const body =
    provider === "openai"
      ? { error: { type, code: type, message, param: null } }
      : { type: "error", error: { type, message } };
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * `proxy:model` — a coding CLI's model request, signed here. The sandbox
 * holds only its job token (Claude Code's `ANTHROPIC_AUTH_TOKEN`, Codex's
 * provider `env_key`, both sent as a bearer); this attaches the key of the
 * bot's model connection, forwards the body untouched, and streams the
 * answer back. Four gates, cheapest first:
 *
 * 1. **The path** — the provider of the bot's main model, and only its
 *    completion path: Anthropic's `/v1/messages` (and `count_tokens`), or
 *    OpenAI's `/v1/responses`. Not an open relay.
 * 2. **The model** — the bot's own `modelAlias` or `fastModelAlias`, on that
 *    provider. A job cannot ask for a model its bot does not use.
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
    const provider: CodingProvider =
      match?.[1] === "openai" ? "openai" : "anthropic";
    const dialect = DIALECTS[provider];
    const refuse = (status: number, type: string, message: string) =>
      refusal(provider, status, type, message);
    if (
      !match ||
      !Object.hasOwn(DIALECTS, match[1]) ||
      !dialect.paths.has(match[2])
    ) {
      return refuse(404, "not_found_error", "This endpoint is not proxied.");
    }
    const upstreamPath = match[2];
    const body = await readCappedBody(request, MAX_REQUEST_BYTES);
    if (body.oversized) {
      return refuse(
        413,
        "request_too_large",
        "The model request is too large.",
      );
    }
    let requested: string | null = null;
    let maxTokens = 0;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(new TextDecoder().decode(body.bytes)) as Record<
        string,
        unknown
      >;
      requested = String(parsed.model ?? "");
      maxTokens = Math.max(0, Number(parsed[dialect.maxTokensField]) || 0);
    } catch {
      return refuse(400, "invalid_request_error", "The body is not JSON.");
    }
    const models = await jobModels(api.db.db, bot);
    if (!models) {
      return refuse(
        502,
        "hypotenuse_refused",
        `${unsupportedCodingModel(bot.displayName, bot.modelAlias)} A coding agent cannot use it.`,
      );
    }
    if (models.provider !== provider) {
      return refuse(
        404,
        "not_found_error",
        `${bot.displayName}'s models are on ${models.provider === "openai" ? "OpenAI" : "Anthropic"}; this job's model requests go to /proxy/model/${models.provider}.`,
      );
    }
    const allowed = [models.model, models.fastModel].filter(Boolean);
    if (!requested || !allowed.includes(requested)) {
      return refuse(
        400,
        "invalid_request_error",
        `This job may use ${allowed.map((m) => `"${m}"`).join(" or ")}, not "${requested}".`,
      );
    }
    if (overBudget(job)) {
      await requestJobCancel(job.id, "budget_exceeded");
      return refuse(
        402,
        "budget_exceeded",
        `This job used its budget of ${job.budgetTokens} tokens and is being stopped.`,
      );
    }
    // What this request could cost at most — its input, at four characters a
    // token, and every output token it may ask for — must fit what is left,
    // so parallel requests cannot all start under the line and land far
    // past it.
    let forwarded: Uint8Array = body.bytes;
    if (job.budgetTokens !== null && maxTokens === 0 && dialect.capsOutput) {
      // A Responses request may leave its output uncapped (Codex does), which
      // would reserve nothing for its answer: cap it at what the budget has
      // left, so the reservation below holds for it too.
      const left =
        job.budgetTokens -
        job.usage.inputTokens -
        job.usage.outputTokens -
        Math.ceil(body.byteLength / 4);
      if (left < MIN_OUTPUT_TOKENS) {
        return refuse(
          402,
          "budget_exceeded",
          `This request could take this job past its budget of ${job.budgetTokens} tokens. Finish with what you have.`,
        );
      }
      maxTokens = left;
      forwarded = new TextEncoder().encode(
        JSON.stringify({ ...parsed, [dialect.maxTokensField]: left }),
      );
    }
    if (
      job.budgetTokens !== null &&
      job.usage.inputTokens +
        job.usage.outputTokens +
        Math.ceil(body.byteLength / 4) +
        maxTokens >
        job.budgetTokens
    ) {
      return refuse(
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
      return refuse(
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
      return refuse(502, "hypotenuse_refused", "The bot's model is gone.");
    }
    const base = (row.connection.baseUrl || dialect.defaultBase).replace(
      /\/+$/,
      "",
    );
    const url = `${base}${upstreamPath.replace(/^\/v1/, "")}${new URL(request.url).search}`;
    const headers = new Headers();
    for (const name of dialect.requestHeaders) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    dialect.sign(headers, decryptSecret(row.connection.secret));
    let upstream: Response;
    try {
      upstream = await guardedFetch(url, {
        method: "POST",
        headers,
        body: forwarded,
      });
    } catch (e) {
      release();
      return refuse(
        502,
        "api_error",
        `The model provider could not be reached: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const out = new Headers();
    for (const name of dialect.responseHeaders) {
      const value = upstream.headers.get(name);
      if (value) out.set(name, value);
    }
    const stream =
      upstream.body && upstreamPath === dialect.usagePath
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
