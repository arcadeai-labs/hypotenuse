/**
 * Where to send someone after they sign in. A protected page that bounced a
 * signed-out visitor to `/sign-in` passes itself as `?next=`, so the page they
 * were opening is where they land.
 *
 * Only a path on this site is honored: `next=https://evil.example` or
 * `next=//evil.example` would turn the sign-in form into an open redirect.
 */

/** Where a sign-in lands when there is nowhere better: the active organization's projects. */
export const DEFAULT_LANDING = "/organization/projects";

/**
 * Accept a `next` value only if it is a same-origin relative path.
 *
 * A browser reads `//host`, `/\host`, and `\/host` as another origin, and
 * strips tabs and newlines out of a URL before it parses one — so `/\t/host`
 * is `//host` too. Anything with a control character, a backslash anywhere in
 * the authority position, or a scheme is refused outright rather than cleaned.
 * @param raw - The `next` query value.
 * @returns The path, or null for anything else.
 */
export function safeNext(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/")) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point.
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  const second = raw[1];
  if (second === "/" || second === "\\") return null;
  // Resolve it the way the browser will, and insist the origin did not move.
  try {
    const base = "https://hypotenuse.invalid";
    const resolved = new URL(raw, base);
    if (resolved.origin !== base) return null;
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return null;
  }
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
