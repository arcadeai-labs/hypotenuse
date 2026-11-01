import { config } from "keryx";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../config/platforms";
import type { OpenInstallation } from "../platforms/types";
import { runRedisScript } from "./RedisScriptOps";

/**
 * **The Pylon API client**: the single caller of Pylon's REST API
 * (https://docs.usepylon.com/pylon-docs/developer/api), for every bot's
 * Pylon token.
 *
 * - **Region.** A token belongs to one region: US `https://api.usepylon.com`
 *   or EU `https://api.eu.usepylon.com`. A token sent to the other answers
 *   `401 wrong_region_token`, which {@link PylonApiError.wrongRegion} names.
 * - **Auth.** `Authorization: Bearer <token>`: the installation's API token,
 *   created in Pylon with its own identity (its own name and role).
 * - **Errors** are `{ errors: string[], code?, request_id }`; the code names
 *   what went wrong (`invalid_api_token`, `permission_denied`, `rate_limited`).
 * - **Pacing.** Writes (`POST /issues/{id}/note`, `/reply`, `/draft-reply`,
 *   `PATCH /issues/{id}`) are limited by Pylon to 30 a minute each; every
 *   write first takes a token from the installation's bucket in Redis
 *   (`reserve-bucket.lua`), whose reserve only an acknowledgement may take.
 *   An empty bucket, like Pylon's `429` (`Retry-After` seconds), is a
 *   retryable {@link PylonApiError} carrying how long to wait: the outbox
 *   reschedules the row, and no worker sleeps.
 */

/** A Pylon call that did not succeed, in Pylon's words. */
export class PylonApiError extends Error {
  /**
   * @param operation - `METHOD /path`.
   * @param status - The HTTP status, or 0 for a network failure or an empty bucket.
   * @param code - Pylon's error code, or `network` / `http_<status>` / `rate_limited`.
   * @param detail - Pylon's message.
   * @param retryAfterMs - How long Pylon (or the bucket) asked us to wait.
   */
  constructor(
    public operation: string,
    public status: number,
    public code: string,
    public detail: string,
    public retryAfterMs?: number,
  ) {
    super(`Pylon's ${operation} answered ${code}: ${detail}`);
    this.name = "PylonApiError";
  }

  /** Whether trying again later may succeed. */
  get retryable(): boolean {
    return (
      this.code === "rate_limited" ||
      this.code === "network" ||
      this.status >= 500
    );
  }

  /** Whether the token was sent to the other region. */
  get wrongRegion(): boolean {
    return this.code === "wrong_region_token";
  }
}

/** The two regions a Pylon organization lives in. */
export type PylonRegion = "us" | "eu";

/**
 * The API origin for a region, without a trailing slash.
 * @param region - The region.
 * @returns The origin.
 */
export function pylonOrigin(region: PylonRegion): string {
  const url =
    region === "eu"
      ? config.platforms.pylon.apiUrlEu
      : config.platforms.pylon.apiUrlUs;
  return url.replace(/\/+$/, "");
}

/**
 * Take a token from an installation's write bucket.
 * @param installationId - The installation.
 * @param reserved - An acknowledgement, which may draw on the reserve.
 * @returns `0`, or how many milliseconds until a token is free.
 */
export async function takePylonWriteToken(
  installationId: number,
  reserved: boolean,
): Promise<number> {
  const {
    writeBucketCapacity,
    writeBucketRefillPerSecond,
    writeBucketReserve,
  } = config.platforms.pylon;
  return Number(
    await runRedisScript(
      "reserve-bucket",
      [`pylon:bucket:${installationId}`],
      [
        writeBucketCapacity,
        writeBucketRefillPerSecond,
        Date.now(),
        writeBucketReserve,
        reserved ? 1 : 0,
      ],
    ),
  );
}

/** How a request is paced. */
export interface PylonRequestOptions {
  /** A write, which takes a token from the installation's bucket first. */
  write?: boolean;
  /** An acknowledgement, which may draw on the bucket's reserve. */
  reserved?: boolean;
}

/**
 * **Call Pylon with a raw token.** Used by the install (before there is an
 * installation to pace) and by {@link pylonRequest}.
 * @param region - The token's region.
 * @param token - The API token.
 * @param method - The HTTP method.
 * @param path - The path, e.g. `/me`.
 * @param body - The JSON body, if any.
 * @returns The answer's `data`.
 * @throws {PylonApiError} For any failure.
 */
export async function pylonFetch<T = Record<string, unknown>>(
  region: PylonRegion,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const operation = `${method} ${path.replace(/\/[^/]*\d[^/]*/g, "/{id}")}`;
  let res: Response;
  try {
    res = await fetch(`${pylonOrigin(region)}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "user-agent": "Hypotenuse-Pylon/1",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(config.platforms.pylon.requestTimeoutMs),
    });
  } catch (e) {
    throw new PylonApiError(
      operation,
      0,
      "network",
      e instanceof Error ? e.message : String(e),
    );
  }
  let parsed: { data?: T; errors?: string[]; code?: string } = {};
  try {
    parsed = (await res.json()) as typeof parsed;
  } catch {
    // An empty or non-JSON body: the status decides.
  }
  if (res.status === 429) {
    const seconds = Number(res.headers.get("retry-after"));
    throw new PylonApiError(
      operation,
      429,
      "rate_limited",
      parsed.errors?.join("; ") || "rate limited",
      Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60_000,
    );
  }
  if (!res.ok) {
    throw new PylonApiError(
      operation,
      res.status,
      parsed.code ?? `http_${res.status}`,
      parsed.errors?.join("; ") || `HTTP ${res.status}`,
    );
  }
  return (parsed.data ?? ({} as T)) as T;
}

/**
 * **Call Pylon as an installation**: its region, its token, and — for a
 * write — a token from its bucket first.
 * @param inst - The installation, credentials opened.
 * @param method - The HTTP method.
 * @param path - The path.
 * @param body - The JSON body, if any.
 * @param opts - Whether it is a write, and whether it may draw on the reserve.
 * @returns The answer's `data`.
 * @throws {PylonApiError} For an empty bucket or any failure.
 */
export async function pylonRequest<T = Record<string, unknown>>(
  inst: OpenInstallation,
  method: string,
  path: string,
  body?: unknown,
  opts: PylonRequestOptions = {},
): Promise<T> {
  if (opts.write) {
    const wait = await takePylonWriteToken(
      inst.installation.id,
      opts.reserved === true,
    );
    if (wait > 0) {
      throw new PylonApiError(
        `${method} ${path}`,
        0,
        "rate_limited",
        "the bucket is empty",
        wait,
      );
    }
  }
  const region = (inst.installation.config.region as PylonRegion) ?? "us";
  return pylonFetch<T>(
    region === "eu" ? "eu" : "us",
    String(inst.credentials.apiToken ?? ""),
    method,
    path,
    body,
  );
}

/** A Pylon issue, as far as Hypotenuse reads one. */
export interface PylonIssue {
  id: string;
  number?: number;
  title?: string;
  body_html?: string;
  link?: string;
  state?: string;
  source?: string;
  tags?: string[] | null;
  account?: { id: string } | null;
  requester?: { id: string; email?: string } | null;
  assignee?: { id: string; email?: string } | null;
  team?: { id: string } | null;
}

/** A Pylon message, as far as Hypotenuse reads one. */
export interface PylonMessage {
  id: string;
  is_private: boolean;
  message_html: string;
  source?: string;
  timestamp?: string;
  thread_id?: string;
  author?: {
    name?: string;
    contact?: { id: string; email?: string } | null;
    user?: { id: string; email?: string } | null;
  } | null;
}

/** A Pylon account (a customer company). */
export interface PylonAccount {
  id: string;
  name?: string;
  domain?: string;
  domains?: string[] | null;
  primary_domain?: string;
  tags?: string[] | null;
}

/**
 * An issue's messages, oldest first.
 * @param inst - The installation.
 * @param issueId - The issue.
 * @returns Its messages and notes.
 */
export async function pylonMessages(
  inst: OpenInstallation,
  issueId: string,
): Promise<PylonMessage[]> {
  return pylonRequest<PylonMessage[]>(
    inst,
    "GET",
    `/issues/${encodeURIComponent(issueId)}/messages`,
  );
}

/**
 * The newest customer-visible message of an issue — what a reply answers.
 * @param messages - The issue's messages, oldest first.
 * @returns Its id, or `null` when the issue has none.
 */
export function latestPublicMessageId(messages: PylonMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!messages[i].is_private) return messages[i].id;
  }
  return null;
}
