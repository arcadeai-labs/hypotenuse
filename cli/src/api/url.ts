/**
 * Which Hypotenuse server a command talks to. Highest wins:
 *
 * | # | Source |
 * |---|---|
 * | 1 | `--url <origin>` |
 * | 2 | `HYPOTENUSE_URL` |
 * | 3 | `credentials.json`: the server the last `login` used, or its only server |
 * | 4 | the compiled-in default, {@link DEFAULT_SERVER_URL} |
 *
 * Callers pass an origin; the client appends `/api`.
 */
import { type Credentials, originOf } from "./credentials";

/** The hosted API. */
export const DEFAULT_SERVER_URL = "https://api.hypotenuse.cloud";

/** Everything the resolution reads, injected so tests state it. */
export interface UrlSources {
  flag?: string;
  env: Record<string, string | undefined>;
  credentials: Credentials;
}

/** A resolved server and where it came from. */
export interface ResolvedUrl {
  origin: string;
  source: "flag" | "env" | "credentials" | "default";
}

/**
 * Resolve the server origin by the precedence above.
 * @param sources - The flag, environment, and credentials.
 * @returns The origin and its source.
 */
export function resolveServerUrl(sources: UrlSources): ResolvedUrl {
  if (sources.flag) return { origin: originOf(sources.flag), source: "flag" };
  if (sources.env.HYPOTENUSE_URL) {
    return { origin: originOf(sources.env.HYPOTENUSE_URL), source: "env" };
  }
  const { current, servers } = sources.credentials;
  const known = Object.keys(servers);
  if (current && servers[current]) {
    return { origin: current, source: "credentials" };
  }
  if (known.length === 1 && known[0]) {
    return { origin: known[0], source: "credentials" };
  }
  return { origin: DEFAULT_SERVER_URL, source: "default" };
}
