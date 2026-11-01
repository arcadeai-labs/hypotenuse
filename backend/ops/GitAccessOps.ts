import type { RepositoryGrant } from "../schema/repository_grants";

/**
 * What a bot may reach on GitHub, and how a sandbox asks for the credential.
 *
 * **Git talks to GitHub directly.** The credential it uses is a GitHub App
 * installation token minted for one repository, handed over on demand through
 * `sandbox:git-credential` and revoked when the job ends. The sandbox still
 * holds no durable GitHub secret: what lives in its environment is the job
 * token, and the helper below is the thing that trades one for the other a
 * request at a time.
 *
 * Everything here is pure, and the pure part is what decides authorization —
 * a grant either covers the repository and the bot or it does not. It is unit
 * tested without a container, a network, or a GitHub App.
 *
 * **What is deliberately not here is a ref policy.** An installation token's
 * narrowest unit is `contents` on a repository; GitHub has no ref-scoped
 * permission, so `contents: write` is write to every branch and tag. A
 * grant's `branchPrefix` says what the job is *told* to do, and a repository
 * ruleset on GitHub is what makes it true.
 *
 * The scripts are ported from ToolExec's `GitAccessOps` verbatim but for
 * names; they are the hard-won part.
 */

/** What a bot may do with a repository: nothing, read it, or write to it. */
export type GrantLevel = "none" | "read" | "write";

/** The host every grant names today. */
export const GITHUB_HOST = "github.com";

/**
 * A repository git named, as parsed out of a credential request.
 */
export interface GitRepository {
  /** The repository's owner or organization. */
  owner: string;
  /** The repository's name, with any `.git` suffix removed. */
  repo: string;
}

/**
 * Read `owner/repo.git` out of the `path` git sends a credential helper.
 *
 * Git supplies the path only when `credential.useHttpPath` is on, which is why
 * the sandbox sets it for `github.com` — without it every repository on the host
 * would look like the same credential request and one token would have to cover
 * all of them.
 *
 * **Anything that is not exactly two segments is `null`.** The value arrives
 * from a remote URL inside a repository we cloned, so it is attacker-influenced
 * in the ordinary case: a submodule URL is written by whoever wrote the
 * repository. Refusing to guess is what keeps `../` and a bare host out of the
 * scope of a minted token.
 * @param path - The credential request's `path`, e.g. `acme/widget.git`.
 * @returns The repository, or `null` when the path is not one.
 */
export function parseCredentialRepository(
  path: string | undefined | null,
): GitRepository | null {
  if (!path) return null;

  const segments = path.replace(/^\/+/, "").replace(/\/+$/, "").split("/");
  if (segments.length !== 2) return null;

  const [owner, rawRepo] = segments;
  const repo = rawRepo.replace(/\.git$/, "");

  // A path segment that is empty, relative, or carries anything git would not
  // put in a repository name is not a repository. GitHub's own rule is stricter
  // than this; this is the subset that cannot be a traversal or an injection
  // into the URL the scope is built from.
  const ok = /^[A-Za-z0-9._-]+$/;
  if (!ok.test(owner) || !ok.test(repo)) return null;
  if (owner === "." || owner === ".." || repo === "." || repo === "..") {
    return null;
  }

  return { owner, repo };
}

/**
 * Read `owner/name` as a bot or a person writes it — `acme/api`,
 * `acme/api.git`, `https://github.com/acme/api` — into its parts, lowercased.
 * @param value - The repository as written.
 * @param webOrigin - The origin a URL form may start with.
 * @returns The repository, or `null` when it is not one.
 */
export function parseRepositoryName(
  value: string,
  webOrigin = "https://github.com",
): GitRepository | null {
  let path = value.trim();
  const origin = webOrigin.replace(/\/+$/, "");
  for (const prefix of [`${origin}/`, "https://github.com/", "github.com/"]) {
    if (path.toLowerCase().startsWith(prefix.toLowerCase())) {
      path = path.slice(prefix.length);
    }
  }
  const parsed = parseCredentialRepository(path);
  return parsed
    ? { owner: parsed.owner.toLowerCase(), repo: parsed.repo.toLowerCase() }
    : null;
}

/**
 * Whether a grant covers a bot: it lists the bot, or it lists no bots (every
 * bot in the project).
 * @param grant - The grant.
 * @param botId - The bot.
 * @returns `true` when the bot may use it.
 */
export function grantCoversBot(
  grant: Pick<RepositoryGrant, "botIds">,
  botId: number,
): boolean {
  return grant.botIds === null || grant.botIds.includes(botId);
}

/**
 * The grant covering a repository for a bot, if the project holds one.
 *
 * Compared case-insensitively because GitHub treats owner and repository
 * names that way, and a clone of `Acme/Widget` against a grant for
 * `acme/widget` is the same repository by every definition that matters.
 * @param grants - The project's grants.
 * @param botId - The bot asking.
 * @param target - The host and repository asked about.
 * @returns The grant, or `null`.
 */
export function findGrant<
  G extends Pick<RepositoryGrant, "host" | "owner" | "name" | "botIds">,
>(
  grants: G[],
  botId: number,
  target: { host: string; owner: string; repo: string },
): G | null {
  const same = (a: string, b: string): boolean =>
    a.toLowerCase() === b.toLowerCase();
  return (
    grants.find(
      (grant) =>
        same(grant.host, target.host) &&
        same(grant.owner, target.owner) &&
        same(grant.name, target.repo) &&
        grantCoversBot(grant, botId),
    ) ?? null
  );
}

/**
 * What a bot may do with a repository, from the grant covering it: the one
 * answer `sandbox_start`, the credential handout, and the read tools share.
 * @param grant - The grant from {@link findGrant}, or `null`.
 * @returns `none`, `read`, or `write`.
 */
export function grantLevel(
  grant: Pick<RepositoryGrant, "push"> | null,
): GrantLevel {
  if (!grant) return "none";
  return grant.push ? "write" : "read";
}

/**
 * The branch namespace a job is asked to push into.
 * @param grant - The grant.
 * @param botSlug - The bot's slug, for the default.
 * @returns e.g. `hypotenuse/toadsworth/`.
 */
export function branchPrefixFor(
  grant: Pick<RepositoryGrant, "branchPrefix">,
  botSlug: string,
): string {
  const configured = grant.branchPrefix?.trim();
  if (configured) return configured;
  return `hypotenuse/${botSlug}/`;
}

/**
 * A recommended repository ruleset for a grant: pushes by the App are allowed
 * only under the branch prefix. Shown to people as copyable JSON; nothing in
 * Hypotenuse enforces a ref, and this is what does.
 * @param prefix - The branch prefix.
 * @returns The ruleset body for `POST /repos/{owner}/{repo}/rulesets`.
 */
export function recommendedRuleset(prefix: string): Record<string, unknown> {
  return {
    name: "Hypotenuse branches",
    target: "branch",
    enforcement: "active",
    conditions: {
      ref_name: { include: ["~ALL"], exclude: [`refs/heads/${prefix}**`] },
    },
    rules: [{ type: "update" }, { type: "deletion" }, { type: "creation" }],
    bypass_actors: [],
  };
}

/** Where a sandbox's credential helper lives, and what it is called. */
export const GIT_CREDENTIAL_HELPER_FILENAME = "git-credential-hypotenuse";

/** The filename of the managed `gh` wrapper. */
export const GITHUB_CLI_WRAPPER_FILENAME = "gh";

/** Where the image keeps the real GitHub CLI, off PATH. */
export const GITHUB_CLI_REAL_PATH = "/usr/local/lib/hypotenuse/gh-real";

/**
 * The absolute URL a sandbox asks for a git credential at.
 * @param apiUrl - The URL the sandbox reaches this API at.
 * @returns The absolute endpoint URL.
 */
export function gitCredentialUrl(apiUrl: string): string {
  return `${apiUrl.replace(/\/+$/, "")}/api/sandbox/git-credential`;
}

/**
 * The credential helper script a sandbox runs whenever git needs a password.
 *
 * **A file rather than a `!`-prefixed one-liner in `~/.gitconfig`.** The two are
 * equivalent to git, and not to anybody reading them: this has to parse git's
 * stdin protocol, call an HTTP endpoint, pull one field out of the answer, and
 * put a refusal somewhere a person will see it. As a config value that is four
 * hundred characters of nested quoting on one line, which is both unreviewable
 * and untestable. As a file it is a script the push suite executes verbatim.
 *
 * Git invokes a helper as `<helper> <operation>` and only `get` wants an answer;
 * `store` and `erase` are told nothing, so a failed push does not spend a mint
 * on its way out.
 *
 * The response is read with `sed` rather than with `jq`, and **not** because the
 * image lacks `jq` — it has it. It is because this script does not only run in
 * that image. A hosted provider boots its own runtime, and a project may name its
 * own image; neither is ours to put a package in. Every other in-sandbox
 * convenience degrades to an agent writing a throwaway script, and this one
 * degrades to no clone at all, so it is held to what POSIX guarantees wherever
 * git itself runs. The shape being ours and fixed is what makes that cheap.
 *
 * **The whitespace in that pattern is load-bearing**: a server may
 * pretty-print a JSON response, so the field arrives as `"password": "ghs_…"`
 * on its own line rather than as `"password":"ghs_…"`, and a pattern without
 * `[[:space:]]*` matches nothing, emits no password, and leaves git reporting
 * that it could not read one. Both spacings are covered by tests, one of them
 * against the live endpoint.
 *
 * **Nothing here writes the token to disk.** Git holds it for the life of one
 * command; there is no `credential.helper=store` and no cache, so the next
 * command asks again and gets a token minted then.
 * @param credentialUrl - The absolute endpoint URL, from {@link gitCredentialUrl}.
 * @param tokenEnv - The environment variable holding the job token.
 * @returns The script's contents.
 */
export function gitCredentialHelperScript(
  credentialUrl: string,
  tokenEnv: string,
): string {
  return `#!/bin/sh
# Hypotenuse's git credential helper.
#
# Trades this job's token for a GitHub App installation token scoped to the one
# repository git is asking about, at write only when the repository's grant
# allows a push and this job was started to change it. The token is never
# stored: it is minted per request and revoked when the job ends.

[ "$1" = get ] || exit 0

repository=
while IFS= read -r line; do
  case "$line" in
    path=*) repository=\${line#path=} ;;
  esac
done

response=$(curl --silent --show-error --get \\
  --data-urlencode "repository=$repository" \\
  --header "Authorization: Bearer $${tokenEnv}" \\
  "${credentialUrl}")

password=$(printf '%s' "$response" |
  sed -n 's/.*"password"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')

if [ -z "$password" ]; then
  # Git prints a helper's stderr, so this is where an agent finds out that the
  # repository was not granted, or that GitHub is not connected for the project.
  printf 'hypotenuse: no git credential for "%s": %s\\n' "$repository" "$response" >&2
  exit 0
fi

printf 'username=x-access-token\\npassword=%s\\n' "$password"
`;
}

/**
 * A repository-scoped wrapper around the real GitHub CLI.
 *
 * GitHub CLI normally expects one account-wide token in `GH_TOKEN` or on disk.
 * A job has neither: it has one short-lived installation token per granted
 * repository and permission. This wrapper resolves the repository exactly as
 * `gh` does — an explicit `--repo` / `-R` wins, otherwise the current checkout's
 * origin is used — and trades the job token for that repository's credential.
 *
 * The installation token exists only in this process and the child `gh`
 * process. It is never written to `hosts.yml`, a git config, or the sandbox
 * environment from which the coding agent was launched. The existing
 * credential endpoint remains the authorization boundary, so an explicit
 * ungranted repository fails before GitHub is asked to mint anything.
 *
 * @param credentialUrl - The absolute credential endpoint URL.
 * @param tokenEnv - The environment variable holding the job token.
 * @param realGhPath - The absolute path of the unwrapped GitHub CLI binary.
 * @param webOrigin - Where repositories live (`https://github.com`); a
 *   checkout's `origin` under it names the repository. Overridden only by the
 *   suite, whose GitHub is a local fake.
 * @returns The wrapper script's contents.
 */
export function githubCliWrapperScript(
  credentialUrl: string,
  tokenEnv: string,
  realGhPath: string,
  webOrigin = "https://github.com",
): string {
  const origin = webOrigin.replace(/\/+$/, "");
  const host = new URL(origin).host;
  return `#!/bin/sh
# Hypotenuse's managed GitHub CLI.
#
# Resolves one repository, obtains that repository's short-lived GitHub App
# installation token, and gives it only to this gh invocation.

set -eu

repository=
next_is_repository=0
for argument in "$@"; do
  if [ "$next_is_repository" = 1 ]; then
    repository=$argument
    next_is_repository=0
    continue
  fi

  case "$argument" in
    --repo|-R) next_is_repository=1 ;;
    --repo=*) repository=\${argument#--repo=} ;;
    -R?*) repository=\${argument#-R} ;;
  esac
done

if [ "$next_is_repository" = 1 ]; then
  printf 'hypotenuse: gh requires a value after --repo or -R\\n' >&2
  exit 2
fi

if [ -z "$repository" ]; then
  remote=$(git config --get remote.origin.url 2>/dev/null || true)
  case "$remote" in
    ${origin}/*) repository=\${remote#${origin}/} ;;
    git@github.com:*) repository=\${remote#git@github.com:} ;;
    ssh://git@github.com/*) repository=\${remote#ssh://git@github.com/} ;;
  esac
fi

repository=\${repository#${host}/}
repository=\${repository#${origin}/}
repository=\${repository#git@github.com:}
repository=\${repository#ssh://git@github.com/}
repository=\${repository%.git}

if [ -z "$repository" ]; then
  printf 'hypotenuse: gh could not determine a GitHub repository; run it inside a checked-out repository or pass --repo owner/name\\n' >&2
  exit 2
fi

response=$(curl --silent --show-error --get \\
  --data-urlencode "repository=$repository" \\
  --header "Authorization: Bearer $${tokenEnv}" \\
  "${credentialUrl}")

password=$(printf '%s' "$response" |
  sed -n 's/.*"password"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')

if [ -z "$password" ]; then
  printf 'hypotenuse: no GitHub CLI credential for "%s": %s\\n' "$repository" "$response" >&2
  exit 1
fi

GH_TOKEN=$password
GH_HOST=${host}
export GH_TOKEN GH_HOST
exec "${realGhPath}" "$@"
`;
}

/** Filename written under `/etc/profile.d` so login shells prepend the wrapper. */
export const GITHUB_CLI_PATH_PROFILE_FILENAME = "hypotenuse-path.sh";

/** Marker that makes the PATH snippet idempotent across home rc files. */
export const GITHUB_CLI_PATH_PROFILE_MARK = "# hypotenuse github CLI";

/**
 * Quote a value for POSIX `sh` single quotes.
 * @param value - The literal to embed.
 * @returns The quoted form.
 */
function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Put the managed `gh` wrapper where login shells and later execs will find it.
 *
 * The sandbox's PATH puts the wrapper directory first for the coding-agent
 * process. That is not enough: coding agents run commands as `sh -lc`,
 * which is a login shell, and `/etc/profile` resets PATH to the image default.
 * The stock `gh` that survives that reset has no token and tells the agent to
 * run `gh auth login` — which is how a cloned repository still cannot
 * `gh issue`. Git is unaffected, because its helper is an absolute path in
 * `~/.gitconfig`.
 *
 * Lands three ways, any one of which is enough:
 *
 * - A symlink in `/usr/local/bin` when that directory is writable — the same
 *   reason the Cursor installer copies `agent` there.
 * - `/etc/profile.d/hypotenuse-path.sh` when that directory is writable, which
 *   every login shell sources through `/etc/profile`.
 * - `$HOME/.profile` and `.bashrc`. `.bash_profile` is appended only when it
 *   already exists: creating one would make bash skip `.profile` and drop
 *   whatever else a login already put on PATH.
 *
 * @param wrapperDir - Absolute directory that already holds the wrapper as `gh`.
 * @param options - Overrides for the system directories. Production omits them;
 *   the suite points them at a temp tree so a rootful test cannot write `/etc`.
 * @returns A POSIX script provisioning executes after the wrapper is on disk.
 */
export function persistGithubCliPathScript(
  wrapperDir: string,
  options: { profileDDir?: string; localBinDir?: string } = {},
): string {
  const profileDDir = shSingleQuote(options.profileDDir ?? "/etc/profile.d");
  const localBinDir = shSingleQuote(options.localBinDir ?? "/usr/local/bin");
  const dir = shSingleQuote(wrapperDir);
  const profileFile = shSingleQuote(GITHUB_CLI_PATH_PROFILE_FILENAME);
  const mark = shSingleQuote(GITHUB_CLI_PATH_PROFILE_MARK);

  return `#!/bin/sh
# Put the managed gh wrapper on PATH for login shells and later execs.
set -eu
dir=${dir}
profile_d=${profileDDir}
local_bin=${localBinDir}
profile_file=${profileFile}
mark=${mark}

if [ ! -x "$dir/gh" ]; then
  printf 'hypotenuse: managed gh wrapper missing at %s/gh\\n' "$dir" >&2
  exit 1
fi

if [ -d "$local_bin" ] && [ -w "$local_bin" ]; then
  ln -sfn "$dir/gh" "$local_bin/gh"
fi

snippet="export PATH=\\"$dir:\\$PATH\\""

append_path() {
  target=$1
  if [ -f "$target" ] && grep -F "$mark" "$target" >/dev/null 2>&1; then
    return 0
  fi
  parent=$(dirname "$target")
  mkdir -p "$parent"
  if [ ! -f "$target" ] || [ ! -s "$target" ]; then
    printf '%s\\n%s\\n' "$mark" "$snippet" >> "$target"
  else
    printf '\\n%s\\n%s\\n' "$mark" "$snippet" >> "$target"
  fi
}

if [ -d "$profile_d" ] && [ -w "$profile_d" ]; then
  printf '%s\\n%s\\n' "$mark" "$snippet" > "$profile_d/$profile_file"
fi

home=\${HOME:-}
if [ -z "$home" ]; then
  home=$(getent passwd "$(id -un)" 2>/dev/null | awk -F: '{print $6}' || true)
fi
if [ -z "$home" ]; then
  home=$(eval echo "~")
fi

if [ -n "$home" ] && [ -d "$home" ]; then
  append_path "$home/.profile"
  # Do not create .bash_profile. Bash login shells read the first of
  # .bash_profile, .bash_login, .profile and skip the rest; a file we
  # invented would hide .profile and everything it already exported.
  if [ -f "$home/.bash_profile" ]; then
    append_path "$home/.bash_profile"
  fi
  append_path "$home/.bashrc"
fi
`;
}

/**
 * Every `git config` a sandbox runs before it clones.
 *
 * There is no `insteadOf` rewrite: git resolves `https://github.com/...` to GitHub, which is also what the remote URL
 * in `.git/config` says, so a URL means the same thing inside the sandbox as
 * out. What is configured is only *how git authenticates*.
 *
 * - **`credential.<host>.helper`** points at {@link gitCredentialHelperScript}.
 * - **`credential.<host>.useHttpPath`** is what makes a per-repository token
 *   possible at all: without it git tells the helper the host and nothing else,
 *   and one token would have to cover every repository the job may reach.
 * - **`credential.<host>.username`** stops git asking for one interactively,
 *   which in a sandbox means hanging rather than failing.
 * - **`http.proactiveAuth`** asks git 2.46+ to authenticate on the first request
 *   instead of after a 401. An older git stores and ignores it, and the 401
 *   retry is the ordinary path against GitHub.
 *
 * Scoped to the origin in every case. A global credential helper would answer
 * for any remote a repository's own content pointed git at, which is the mistake
 * that hands a token to somebody else's server.
 * @param helperPath - Absolute path of the helper script inside the sandbox.
 * @param origin - The origin being configured. Overridden only by the suite,
 *   which stands a local `git-http-backend` up in GitHub's place and needs the
 *   credential config to match the URL git actually resolves.
 * @returns The `git config` invocations, as argv arrays.
 */
export function gitSandboxConfigCommands(
  helperPath: string,
  origin = "https://github.com",
): string[][] {
  const scope = origin.replace(/\/+$/, "");

  return [
    ["git", "config", "--global", `credential.${scope}.helper`, helperPath],
    ["git", "config", "--global", `credential.${scope}.useHttpPath`, "true"],
    [
      "git",
      "config",
      "--global",
      `credential.${scope}.username`,
      "x-access-token",
    ],
    ["git", "config", "--global", "http.proactiveAuth", "basic"],
  ];
}
