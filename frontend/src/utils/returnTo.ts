/**
 * Where to send someone after they sign in. A protected page that bounced a
 * signed-out visitor to `/sign-in` passes itself as `?next=`, so the CLI's
 * approval link survives a sign-in (and a sign-up) on the way.
 *
 * Only a path on this site is honored: `next=https://evil.example` or
 * `next=//evil.example` would turn the sign-in form into an open redirect.
 */

/** Where a sign-in lands when there is nowhere better. */
export const DEFAULT_LANDING = "/home";

/**
 * Accept a `next` value only if it is a same-origin path.
 * @param raw - The `next` query value.
 * @returns The path, or null for anything else.
 */
export function safeNext(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) {
    return null;
  }
  return raw;
}

/**
 * The sign-in URL for a page that needs a session.
 * @param path - The page's path and query.
 * @returns `/sign-in?next=…`, or plain `/sign-in` for the default landing.
 */
export function signInFor(path: string): string {
  return path === DEFAULT_LANDING || path === "/"
    ? "/sign-in"
    : `/sign-in?next=${encodeURIComponent(path)}`;
}
