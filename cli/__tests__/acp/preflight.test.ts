import { describe, expect, test } from "bun:test";
import {
  type CommandRunner,
  checkRepositoryAuth,
  isGitAuthFailure,
  providerSlug,
  remoteHost,
  remoteProvider,
} from "../../src/acp/preflight";

/**
 * A runner that answers each command by its first two words.
 * @param answers - `git ls-remote` / `gh auth` → exit code and stderr.
 * @returns The runner, and the commands it was asked to run.
 */
function scripted(
  answers: Record<string, { code: number | null; stderr?: string }>,
): { run: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: async (argv) => {
      calls.push(argv);
      const answer = answers[argv.slice(0, 2).join(" ")] ?? { code: 0 };
      return { code: answer.code, stdout: "", stderr: answer.stderr ?? "" };
    },
  };
}

const input = {
  cwd: "/tmp",
  env: {},
  runnerName: "laptop",
  pullRequests: true,
};

describe("remotes and providers", () => {
  test("a remote's host from a URL or scp syntax; none for a local path", () => {
    expect(remoteHost("https://github.com/acme/shop.git")).toBe("github.com");
    expect(remoteHost("ssh://git@gitlab.example.com/acme/shop")).toBe(
      "gitlab.example.com",
    );
    expect(remoteHost("git@github.com:acme/shop.git")).toBe("github.com");
    expect(remoteHost("/srv/git/shop.git")).toBeNull();
    expect(remoteHost("file:///srv/git/shop.git")).toBeNull();
  });

  test("github.com is GitHub; any other host names itself", () => {
    expect(remoteProvider("git@github.com:acme/shop.git")).toEqual({
      provider: "github",
      providerName: "GitHub",
    });
    expect(remoteProvider("https://git.acme.dev/shop")).toEqual({
      provider: "git.acme.dev",
      providerName: "git.acme.dev",
    });
  });

  test("an agent id becomes a path segment", () => {
    expect(providerSlug("claude-code")).toBe("claude-code");
    expect(providerSlug("My Agent!")).toBe("my-agent-");
    expect(providerSlug("___")).toBe("agent");
  });

  test("authentication failures, not network failures, are login problems", () => {
    for (const text of [
      "fatal: Authentication failed for 'https://github.com/acme/shop.git/'",
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      "git@github.com: Permission denied (publickey).",
      "remote: Support for password authentication was removed",
    ]) {
      expect(isGitAuthFailure(text), text).toBe(true);
    }
    expect(
      isGitAuthFailure("fatal: unable to access: Could not resolve host"),
    ).toBe(false);
  });
});

describe("LC-SIG-02 checkRepositoryAuth", () => {
  test("a local remote is not checked", async () => {
    const { run, calls } = scripted({});
    expect(
      await checkRepositoryAuth({ ...input, remote: "/srv/shop.git" }, run),
    ).toBeNull();
    expect(calls).toEqual([]);
  });

  test("a remote that refuses credentials needs its host's login", async () => {
    const { run } = scripted({
      "git ls-remote": { code: 128, stderr: "fatal: Authentication failed" },
    });
    const need = await checkRepositoryAuth(
      { ...input, remote: "https://git.acme.dev/shop.git" },
      run,
    );
    expect(need).toMatchObject({
      provider: "git.acme.dev",
      providerName: "git.acme.dev",
    });
    expect(need?.body).toContain("Runner laptop can't sign in");
  });

  test("a network failure is left to the fetch", async () => {
    const { run } = scripted({
      "git ls-remote": { code: 128, stderr: "Could not resolve host" },
    });
    expect(
      await checkRepositoryAuth(
        { ...input, remote: "https://git.acme.dev/shop.git" },
        run,
      ),
    ).toBeNull();
  });

  test("on github.com a worker also needs the GitHub CLI signed in, when it is installed", async () => {
    const remote = "git@github.com:acme/shop.git";
    const signedOut = scripted({ "gh auth": { code: 1 } });
    expect(
      await checkRepositoryAuth({ ...input, remote }, signedOut.run),
    ).toMatchObject({ provider: "github", providerName: "GitHub" });

    const missing = scripted({ "gh auth": { code: null } });
    expect(
      await checkRepositoryAuth({ ...input, remote }, missing.run),
    ).toBeNull();

    const manager = scripted({ "gh auth": { code: 1 } });
    expect(
      await checkRepositoryAuth(
        { ...input, remote, pullRequests: false },
        manager.run,
      ),
    ).toBeNull();
    expect(manager.calls.map((c) => c[0])).toEqual(["git"]);
  });
});
