/**
 * git, run for the worktree manager: asynchronous, bounded by a timeout that
 * kills the process, never prompting (`GIT_TERMINAL_PROMPT=0`), with stdout
 * and stderr captured so a failure can quote git's own words.
 */

/** A git command's outcome. */
export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Killed by the timeout. */
  timedOut: boolean;
}

/** Options for one git command. */
export interface GitOptions {
  /** Where to run it. */
  cwd?: string;
  /** Kill it after this long (default 30 s). */
  timeoutMs?: number;
  /** The environment (default: this process's). */
  env?: Record<string, string | undefined>;
}

/** Runs git. Injectable so tests can count or fail calls. */
export type GitRunner = (
  args: string[],
  options?: GitOptions,
) => Promise<GitResult>;

/**
 * Run git.
 * @param args - Arguments after `git`.
 * @param options - Where, how long, with what environment.
 * @returns The outcome; a git that cannot be spawned is code 127.
 */
export const runGit: GitRunner = async (args, options = {}) => {
  const env = { ...(options.env ?? process.env), GIT_TERMINAL_PROMPT: "0" };
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["git", ...args], {
      cwd: options.cwd,
      env: env as Record<string, string>,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    return {
      code: 127,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      timedOut: false,
    };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, options.timeoutMs ?? 30_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ]);
    return { code: timedOut ? 124 : code, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * The last lines of git's stderr, for an error message.
 * @param result - The outcome.
 * @param lines - How many.
 * @returns The tail, trimmed.
 */
export function stderrTail(result: GitResult, lines = 20): string {
  const text = result.timedOut
    ? `${result.stderr}\n(timed out)`
    : result.stderr || result.stdout;
  return text.trim().split("\n").slice(-lines).join("\n");
}
