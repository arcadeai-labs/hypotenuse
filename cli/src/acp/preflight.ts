/**
 * The checks a turn makes before the agent starts, for the logins it will
 * need that are not the agent's own: the git remote it pushes to, and the
 * GitHub CLI a worker opens pull requests with. A failure becomes an `auth`
 * elicitation naming the provider (the server links the runner's auth page
 * for it), not a turn that runs for an hour and fails at `git push`.
 *
 * | Check | Runs when | Fails as |
 * |---|---|---|
 * | `git ls-remote --heads <remote>` | the turn has a repository with a remote | provider `github` for github.com, else the remote's host — only on an authentication error; a network error is left to the fetch's own fallback |
 * | `gh auth status --hostname github.com` | a worker's turn, the remote is on github.com, and `gh` is installed | provider `github` |
 */

/** A login a turn needs and does not have. */
export interface AuthNeed {
  /** The runner auth page's path segment: an agent id, `github`, or a host. */
  provider: string;
  /** How Linear names it. */
  providerName: string;
  /** What the person reads in the elicitation. */
  body: string;
}

/**
 * An agent id as a runner auth page's path segment.
 * @param agentId - The `[agents]` id.
 * @returns Lower case, with anything outside `[a-z0-9._-]` made a dash.
 */
export function providerSlug(agentId: string): string {
  const slug = agentId
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 64);
  return slug || "agent";
}

/** What one command did. */
export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a command; tests replace it. */
export type CommandRunner = (
  argv: string[],
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    timeoutMs: number;
  },
) => Promise<CommandResult>;

/** How long a preflight command may take. */
export const PREFLIGHT_TIMEOUT_MS = 20_000;

/**
 * What git and ssh print when a remote refuses who we are (as opposed to a
 * network that is down, or a remote that is gone).
 */
const AUTH_FAILURE =
  /authentication failed|could not read username|could not read password|permission denied \(publickey|invalid username or password|terminal prompts disabled|support for password authentication was removed|http basic: access denied|403 forbidden|returned error: 40[13]/i;

/**
 * Whether git's output says the remote refused our credentials.
 * @param output - stderr (and stdout) of a git command.
 * @returns True for an authentication failure.
 */
export function isGitAuthFailure(output: string): boolean {
  return AUTH_FAILURE.test(output);
}

/**
 * The host of a git remote, from a URL (`https://host/…`, `ssh://git@host/…`)
 * or scp syntax (`git@host:owner/repo`). Null for a local path.
 * @param remote - The remote.
 * @returns The lower-cased host, or null.
 */
export function remoteHost(remote: string): string | null {
  try {
    const url = new URL(remote);
    if (url.protocol === "file:") return null;
    return url.hostname.toLowerCase() || null;
  } catch {
    const scp = remote.match(/^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)/);
    return scp ? scp[1].toLowerCase() : null;
  }
}

/**
 * The provider a remote's login belongs to.
 * @param remote - The remote.
 * @returns `github` / "GitHub" for github.com, else the host as both.
 */
export function remoteProvider(
  remote: string,
): Pick<AuthNeed, "provider" | "providerName"> {
  const host = remoteHost(remote) ?? "git";
  if (host === "github.com")
    return { provider: "github", providerName: "GitHub" };
  return { provider: host, providerName: host };
}

/**
 * Run a command with a deadline, never throwing.
 * @param argv - The command.
 * @param options - Where, the environment, and the deadline.
 * @returns What it did; `code` null when it could not run or timed out.
 */
export const runCommand: CommandRunner = async (argv, options) => {
  try {
    const proc = Bun.spawn(argv, {
      cwd: options.cwd,
      env: {
        ...options.env,
        GIT_TERMINAL_PROMPT: "0",
        GH_PROMPT_DISABLED: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), options.timeoutMs);
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]).finally(() => clearTimeout(timer));
    return { code, stdout, stderr };
  } catch (error) {
    return {
      code: null,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
};

/**
 * Check the logins a turn's repository needs.
 * @param input - The remote, the working directory, the environment, and the
 *   runner's name for the message.
 * @param run - How to run commands.
 * @returns The first missing login, or null when all is well (or unknowable).
 */
export async function checkRepositoryAuth(
  input: {
    remote: string | null;
    cwd: string;
    env: Record<string, string | undefined>;
    runnerName: string;
    /** Whether the turn may open pull requests (a worker's). */
    pullRequests: boolean;
  },
  run: CommandRunner = runCommand,
): Promise<AuthNeed | null> {
  const { remote, cwd, env, runnerName } = input;
  if (!remote || remoteHost(remote) === null) return null;
  const provider = remoteProvider(remote);
  const listed = await run(["git", "ls-remote", "--heads", remote], {
    cwd,
    env,
    timeoutMs: PREFLIGHT_TIMEOUT_MS,
  });
  if (
    listed.code !== 0 &&
    isGitAuthFailure(`${listed.stderr}\n${listed.stdout}`)
  ) {
    return {
      ...provider,
      body: `Runner ${runnerName} can't sign in to ${provider.providerName} to reach \`${remote}\`, so it could fetch and push nothing. Its owner can fix it on that machine — the link says how. Reply here once it's done and I'll carry on.`,
    };
  }
  if (provider.provider !== "github" || !input.pullRequests) return null;
  const gh = await run(["gh", "auth", "status", "--hostname", "github.com"], {
    cwd,
    env,
    timeoutMs: PREFLIGHT_TIMEOUT_MS,
  });
  // `gh` not installed (or not runnable) is not a login problem.
  if (gh.code === null || gh.code === 127) return null;
  if (gh.code !== 0) {
    return {
      ...provider,
      body: `The GitHub CLI on runner ${runnerName} is not signed in, so I couldn't open a pull request. Its owner can fix it on that machine — the link says how. Reply here once it's done and I'll carry on.`,
    };
  }
  return null;
}
