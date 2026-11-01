import { config } from "keryx";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../config/platforms";
import { runRedisScript } from "./RedisScriptOps";

/**
 * **The Slack Web API client** — the single caller of `https://slack.com/api`.
 *
 * Every call is an HTTPS `POST` to `<apiUrl>/<method>` with the bot token as a
 * bearer credential and a JSON body (`oauth.v2.access` alone is form-encoded,
 * because Slack's OAuth exchange does not take JSON). Slack answers HTTP 200
 * with `{ok: false, error}` for almost every failure, so the `ok` field — not
 * the status — decides; HTTP 429 carries `Retry-After` in seconds
 * (https://api.slack.com/apis/rate-limits).
 *
 * Calls made for an installation first take a token from its bucket in Redis
 * (`slack-bucket.lua`), so a burst of sends from many conversations stays
 * under Slack's per-workspace tiers. An empty bucket, like a `ratelimited`
 * answer, is a {@link SlackApiError} carrying how long to wait: the outbox
 * reschedules the row, and no worker ever sleeps.
 */

/** Slack's error codes that mean the call may succeed if tried again later. */
const RETRYABLE = new Set([
  "ratelimited",
  "network",
  "internal_error",
  "fatal_error",
  "service_unavailable",
  "request_timeout",
  "http_5xx",
]);

/** Slack's error codes that mean the installation's token no longer works. */
const AUTH_FAILURES = new Set([
  "invalid_auth",
  "not_authed",
  "account_inactive",
  "token_revoked",
  "token_expired",
  "no_permission",
  "missing_scope",
]);

/** A Slack Web API call that did not succeed, in Slack's own words. */
export class SlackApiError extends Error {
  /**
   * @param method - The Web API method.
   * @param code - Slack's `error` (or `ratelimited`, `network`, `http_5xx`).
   * @param retryAfterMs - How long Slack (or the bucket) asked us to wait.
   * @param response - Slack's whole answer, for errors that carry detail.
   */
  constructor(
    public method: string,
    public code: string,
    public retryAfterMs?: number,
    public response?: Record<string, unknown>,
  ) {
    super(`Slack's ${method} answered ${code}.`);
    this.name = "SlackApiError";
  }

  /** Whether trying again later may succeed. */
  get retryable(): boolean {
    return RETRYABLE.has(this.code);
  }

  /** Whether the token no longer works (revoked, uninstalled, or missing a scope). */
  get authFailure(): boolean {
    return AUTH_FAILURES.has(this.code);
  }
}

/** How a call is authenticated and paced. */
export interface SlackCallOptions {
  /** A bot token or an app configuration token, sent as a bearer credential. */
  token?: string;
  /** The installation whose bucket the call takes a token from. */
  installationId?: number;
  /** Send the body form-encoded (Slack's OAuth exchange takes nothing else). */
  form?: boolean;
}

/**
 * Take a token from an installation's bucket.
 * @param installationId - The installation.
 * @returns `0`, or how many milliseconds until a token is free.
 */
export async function takeSlackToken(installationId: number): Promise<number> {
  const { bucketCapacity, bucketRefillPerSecond } = config.platforms.slack;
  return Number(
    await runRedisScript(
      "slack-bucket",
      [`slack:bucket:${installationId}`],
      [bucketCapacity, bucketRefillPerSecond, Date.now()],
    ),
  );
}

/**
 * Encode a body as a form, JSON-encoding anything that is not a string.
 * @param body - The fields.
 * @returns The encoded body.
 */
function formBody(body: Record<string, unknown>): string {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    form.set(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  return form.toString();
}

/**
 * **Call one Slack Web API method.**
 * @param method - The method, e.g. `chat.postMessage`.
 * @param body - Its arguments.
 * @param opts - The token, the installation's bucket, the encoding.
 * @returns Slack's answer, which had `ok: true`.
 * @throws {SlackApiError} For an empty bucket, a 429, a network or 5xx failure, or `ok: false`.
 */
export async function slackCall<T = Record<string, unknown>>(
  method: string,
  body: Record<string, unknown>,
  opts: SlackCallOptions = {},
): Promise<T & { ok: true }> {
  if (opts.installationId !== undefined) {
    const wait = await takeSlackToken(opts.installationId);
    if (wait > 0) throw new SlackApiError(method, "ratelimited", wait);
  }
  const headers: Record<string, string> = {
    "content-type": opts.form
      ? "application/x-www-form-urlencoded"
      : "application/json; charset=utf-8",
    "user-agent": "Hypotenuse-Slack/1",
  };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const url = `${config.platforms.slack.apiUrl.replace(/\/+$/, "")}/${method}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: opts.form ? formBody(body) : JSON.stringify(body),
      signal: AbortSignal.timeout(config.platforms.slack.requestTimeoutMs),
    });
  } catch {
    throw new SlackApiError(method, "network");
  }
  if (res.status === 429) {
    const seconds = Number(res.headers.get("retry-after"));
    await res.body?.cancel().catch(() => {});
    throw new SlackApiError(
      method,
      "ratelimited",
      Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 30_000,
    );
  }
  if (res.status >= 500) {
    await res.body?.cancel().catch(() => {});
    throw new SlackApiError(method, "http_5xx");
  }
  let answer: Record<string, unknown>;
  try {
    answer = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new SlackApiError(method, "network");
  }
  if (answer.ok !== true) {
    throw new SlackApiError(
      method,
      typeof answer.error === "string" ? answer.error : `http_${res.status}`,
      undefined,
      answer,
    );
  }
  return answer as T & { ok: true };
}

/**
 * Whether a Slack timestamp (`"1700000000.000100"`) is older than an age.
 * Slack's `ts` is the message's creation time in seconds, so a stream's age
 * is read from its own id.
 * @param ts - The timestamp.
 * @param maxAgeMs - The age.
 * @returns `true` when older.
 */
export function slackTsOlderThan(ts: string, maxAgeMs: number): boolean {
  const seconds = Number(ts);
  if (!Number.isFinite(seconds)) return true;
  return Date.now() - seconds * 1000 > maxAgeMs;
}
