/**
 * Pull request detection: the URLs of pull requests the agent opened, found
 * in what it ran and what it said, so the session can link them as soon as
 * they exist.
 *
 * | Forge | Pattern |
 * |---|---|
 * | GitHub | `https://github.com/<owner>/<repo>/pull/<n>` |
 * | GitLab | `https://<host>/<group>/<project>/-/merge_requests/<n>` |
 * | Bitbucket | `https://bitbucket.org/<ws>/<repo>/pull-requests/<n>` |
 * | anything else | `repositories[].pr_url_patterns` regexes: the named group `repo` must equal the remote's `owner/name`, or without one, the URL's path must hold it as whole segments |
 *
 * A URL counts only when it is of the session's own repository (the remote,
 * normalized to `host/owner/name`): an agent citing someone else's pull request
 * in passing must not link it. Each URL is linked once per session; the
 * second is labelled `Pull Request (2)`.
 */
import { normalizeRemote } from "../../../protocol/src/index";

/** The label of a session's first pull request link. */
export const PR_LABEL = "Pull Request";

/** A URL-ish token in text. */
const URL_PATTERN = /https?:\/\/[^\s<>()"'`\]\\]+/g;

/** The built-in forges: the repository part of a matching URL. */
const FORGES: RegExp[] = [
  /^https:\/\/(github\.com)\/([^/]+\/[^/]+)\/pull\/\d+$/i,
  /^https:\/\/([^/]+)\/(.+?)\/-\/merge_requests\/\d+$/i,
  /^https:\/\/(bitbucket\.org)\/([^/]+\/[^/]+)\/pull-requests\/\d+$/i,
];

/**
 * A URL with trailing punctuation a sentence put there removed.
 * @param url - The token.
 * @returns The URL.
 */
function trimUrl(url: string): string {
  return url.replace(/[.,;:!?]+$/, "").replace(/\/+$/, "");
}

/** Finds a session's pull request URLs. */
export class PrDetector {
  private readonly seen: string[];
  private readonly custom: RegExp[];

  /**
   * @param remote - The session's repository remote, or null (nothing matches).
   * @param patterns - `repositories[].pr_url_patterns`.
   * @param known - URLs already linked to the session.
   */
  constructor(
    private readonly remote: string | null,
    patterns: readonly string[] = [],
    known: readonly string[] = [],
  ) {
    this.seen = [...known];
    this.custom = patterns.flatMap((p) => {
      try {
        return [new RegExp(p, "i")];
      } catch {
        return [];
      }
    });
  }

  /**
   * Whether a URL is a pull request of the session's repository.
   * @param url - The URL.
   * @returns True when it is.
   */
  matches(url: string): boolean {
    if (!this.remote) return false;
    const remote = normalizeRemote(this.remote).toLowerCase();
    for (const forge of FORGES) {
      const match = forge.exec(url);
      if (match) return `${match[1]}/${match[2]}`.toLowerCase() === remote;
    }
    const path = remote.slice(remote.indexOf("/") + 1);
    return this.custom.some((pattern) => {
      const match = pattern.exec(url);
      if (!match) return false;
      const repo = match.groups?.repo;
      if (repo !== undefined)
        return repo.toLowerCase().replace(/^\/+|\/+$/g, "") === path;
      // No `repo` group: the URL must name the whole `owner/name` as path
      // segments, so `acme/web` does not match `acme/web-old`.
      return `${new URL(url).pathname.toLowerCase()}/`.includes(`/${path}/`);
    });
  }

  /**
   * The new pull request links in some text, labelled.
   * @param text - Tool output or an agent message.
   * @returns `{ label, url }` for each URL not linked before.
   */
  scan(text: string): { label: string; url: string }[] {
    const found: { label: string; url: string }[] = [];
    for (const raw of text.match(URL_PATTERN) ?? []) {
      const url = trimUrl(raw);
      if (this.seen.includes(url) || !this.matches(url)) continue;
      this.seen.push(url);
      found.push({
        label:
          this.seen.length === 1
            ? PR_LABEL
            : `${PR_LABEL} (${this.seen.length})`,
        url,
      });
    }
    return found;
  }
}
