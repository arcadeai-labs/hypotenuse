/**
 * The HTTP client for the Hypotenuse API — the same actions the dashboard
 * calls, never a wrapper around the server's own CLI.
 *
 * Keryx answers an error as `{ error: { message, type } }`, and the envelope is
 * checked on every response, not only on a non-2xx status: an error body is an
 * error whatever the status line says.
 */

/** An error answered by the API. */
export class ApiError extends Error {
  /**
   * @param message - The server's message.
   * @param status - The HTTP status.
   * @param type - Keryx's error type, when present.
   */
  constructor(
    message: string,
    readonly status: number,
    readonly type?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** One request. */
export interface RequestOptions {
  /** Query parameters; `undefined` values are dropped. */
  query?: Record<string, unknown>;
  /** A JSON body. */
  body?: unknown;
  /** Send no credential even when the client holds one. */
  anonymous?: boolean;
}

/** A client bound to one server and, optionally, one bearer token. */
export class ApiClient {
  /**
   * @param origin - The server origin, without `/api`.
   * @param token - The bearer token to send, if signed in.
   * @param debug - Called with one line per request, for `--verbose`.
   */
  constructor(
    readonly origin: string,
    readonly token?: string,
    private readonly debug: (line: string) => void = () => {},
  ) {}

  /**
   * Call an action by its route.
   * @param method - `GET`, `PUT`, `POST`, or `DELETE`.
   * @param path - The route under `/api`, starting with `/`.
   * @param options - Query, body, and whether to send the token.
   * @returns The parsed JSON body.
   * @throws {ApiError} On an error envelope or a non-2xx status.
   */
  async request<T = unknown>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const url = new URL(`${this.origin}/api${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.token && !options.anonymous) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    // A JSON content type only with a body: the server will not parse an
    // empty one.
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    this.debug(`${method} ${url.pathname}${url.search}`);
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
      });
    } catch (error) {
      throw new ApiError(
        `Could not reach ${this.origin}: ${error instanceof Error ? error.message : String(error)}`,
        0,
      );
    }
    this.debug(`← ${response.status}`);

    const text = await response.text();
    let payload: unknown = null;
    if (text.length > 0) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { error: { message: text.slice(0, 500) } };
      }
    }
    const envelope = payload as {
      error?: { message?: string; type?: string } | string;
    } | null;
    if (envelope?.error) {
      const error = envelope.error;
      throw typeof error === "string"
        ? new ApiError(error, response.status)
        : new ApiError(
            error.message || `HTTP ${response.status}`,
            response.status,
            error.type,
          );
    }
    if (!response.ok) {
      throw new ApiError(
        `HTTP ${response.status} ${response.statusText}`,
        response.status,
      );
    }
    return payload as T;
  }
}
