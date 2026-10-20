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
    throw new Error(payload.error.message || String(payload.error));
  }
  return payload as T;
}
