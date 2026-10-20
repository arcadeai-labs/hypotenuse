/**
 * Fetch finear — the fake Linear every Linear-facing test runs against — at a
 * pinned commit into `backend/.finear/`.
 *
 * finear is not on npm, and Bun resolves a GitHub dependency through GitHub's
 * tarball API, which some sandboxed environments refuse. A plain `git fetch` of
 * one commit works everywhere `git` does, and pinning the SHA means an upstream
 * change can never alter what a test means without a commit here. finear's own
 * runtime dependencies (`@linear/sdk`, `graphql`) are backend devDependencies at
 * the versions finear pins, so its sources resolve them from our install.
 *
 * Idempotent: does nothing when `.finear/` is already at the pinned commit.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

/** The finear commit every test runs against. Bump deliberately, in its own PR. */
export const FINEAR_COMMIT = "c0a30366422b8af46987c955411923bc4f5f9815";
const REPO = "https://github.com/pmdroid/finear.git";
const DIR = join(import.meta.dir, "..", ".finear");

/**
 * Run git in a directory, failing loudly.
 * @param args - git arguments.
 * @param cwd - Working directory.
 * @returns Trimmed stdout.
 */
async function git(args: string[], cwd = DIR): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = [
    await new Response(proc.stdout).text(),
    await new Response(proc.stderr).text(),
  ];
  if ((await proc.exited) !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${err.trim()}`);
  return out.trim();
}

if (existsSync(join(DIR, ".git"))) {
  const head = await git(["rev-parse", "HEAD"]).catch(() => "");
  if (head === FINEAR_COMMIT) process.exit(0);
} else {
  await Bun.$`mkdir -p ${DIR}`.quiet();
  await git(["init", "-q"]);
  await git(["remote", "add", "origin", REPO]);
}
await git(["fetch", "-q", "--depth", "1", "origin", FINEAR_COMMIT]);
await git(["checkout", "-q", "--detach", "FETCH_HEAD"]);
console.log(`finear at ${FINEAR_COMMIT.slice(0, 7)}`);
