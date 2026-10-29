/** Base URL of the Hypotenuse backend API (override with `VITE_API_URL`). */
export const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8080";

/**
 * Call a backend action over HTTP under the `/api` prefix, sending the session
 * cookie and parsing the JSON response.
 *
 * Keryx reports action failures in an `{ error: { message } }` envelope, which
 * it can return alongside a 200, so the envelope — not the HTTP status — is the
 * thing worth checking.
 * @param path - Action route beneath `/api` (e.g. `"/status"`).
 * @param options - Standard `fetch` options; a JSON `Content-Type` is added for string bodies.
 * @returns The parsed response body typed as `T`.
 * @throws {Error} If the response carries an `error` envelope.
 */
export async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const url = `${API_URL}/api${path}`;
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };
  if (options.body && typeof options.body === "string") {
    headers["Content-Type"] ??= "application/json";
  }

  const response = await fetch(url, {
    credentials: "include",
    ...options,
    headers,
  });

  const payload = await response.json();
  if (payload?.error) {
    throw new ApiError(
      payload.error.message || String(payload.error),
      response.status,
    );
  }
  return payload as T;
}

/**
 * A refusal from the API, carrying the HTTP status it came with, so a caller
 * can tell "you are signed out" (401) from "the server could not answer".
 */
export class ApiError extends Error {
  /** The HTTP status of the response that carried the error envelope. */
  readonly status: number;

  /**
   * @param message - The envelope's message.
   * @param status - The response's HTTP status.
   */
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * Whether a failure means the session is gone — a 401 from the API. Anything
 * else (a 5xx, a dropped connection) says nothing about who is signed in.
 * @param error - What a call threw.
 * @returns `true` only for a 401.
 */
export function isSignedOut(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}
