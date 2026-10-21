/**
 * Normalize a git remote to `hostname/owner/name`, so the scp form, an HTTPS
 * URL, and the bare form of one repository compare equal.
 *
 * `git@github.com:acme/web.git`, `https://github.com/acme/web`,
 * `ssh://git@github.com:22/acme/web.git`, and `github.com/acme/web` all
 * become `github.com/acme/web`. The host is lowercased (hosts are
 * case-insensitive); the path is not (some forges' paths are not).
 * @param remote - The remote as the daemon reported it.
 * @returns The normalized remote.
 */
export function normalizeRemote(remote: string): string {
  let rest = remote.trim();
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(rest);
  if (scheme) rest = rest.slice(scheme[0].length);
  // user@ (ssh and scp forms).
  rest = rest.replace(/^[^@/]+@/, "");
  let host: string;
  let path: string;
  const slash = rest.indexOf("/");
  const colon = rest.indexOf(":");
  if (!scheme && colon !== -1 && (slash === -1 || colon < slash)) {
    // scp form: host:owner/name
    host = rest.slice(0, colon);
    path = rest.slice(colon + 1);
  } else {
    host = slash === -1 ? rest : rest.slice(0, slash);
    path = slash === -1 ? "" : rest.slice(slash + 1);
    host = host.replace(/:\d+$/, "");
  }
  path = path
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .replace(/^\/+/, "");
  return path ? `${host.toLowerCase()}/${path}` : host.toLowerCase();
}
