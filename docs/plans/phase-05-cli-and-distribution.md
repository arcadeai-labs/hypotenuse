# Phase 5 — CLI and distribution

> **Goal:** One `hypotenuse` command that a person installs with `npm i -g @arcadeai/hypotenuse`,
> `bun i -g @arcadeai/hypotenuse`, `curl … | bash`, or `irm … | iex`, signs in to a Hypotenuse server through
> a browser, manages projects, members, invites, tags, and the audit log over HTTP, and keeps itself current
> with `hypotenuse upgrade`. Merging a version bump to `main` publishes npm and six compiled binaries in one
> workflow — the same distribution, upgrade, and publishing system as
> [mcpx](https://github.com/arcadeai-labs/mcpx).

> **Status: planned, not built.** This phase builds the shell every later CLI phase hangs commands on — the
> daemon ([phase 10](./phase-10-daemon-and-config.md)), the ACP host ([phase 11](./phase-11-acp-agent-host.md)),
> worktrees ([phase 12](./phase-12-worktrees-and-session-lifecycle.md)), and the stdio MCP server
> ([phase 13](./phase-13-hypotenuse-mcp.md)) — and the release pipeline that ships all of them.

The `hypotenuse` CLI has two audiences, and that is why it exists as one binary rather than two:

- **An operator** at a terminal, doing what they could click in the dashboard: sign in, pick a project,
  invite a teammate, register a runner, see what agents are doing. This is ToolExec's product CLI
  ([ToolExec phase 17](https://github.com/arcadeai-labs/toolexec/blob/main/docs/plans/phase-17-product-cli.md)):
  an HTTP client of the same actions the website uses, never a wrapper around `bun keryx.ts`.
- **A machine** — the runner daemon on that person's laptop, which claims work, spawns coding agents, and
  serves them an MCP server. It needs the operator's sign-in to register itself, and it is the same person's
  machine, so the same install is the natural carrier.

The **distribution** half is mcpx's, adopted whole because it already solved a hard problem: one codebase
installed four ways, each of which can upgrade itself correctly. mcpx's machinery is the `upgradr` library
(npm as the source of truth for "latest", install-method detection from `process.execPath` and the script path,
GitHub Release assets named `<bin>-<os>-<arch>[.exe]`) and a version-driven `auto-release.yml`. We copy both,
fixing the one mcpx gotcha recorded below.

## Scope

**In:** the `cli/` package shape; commander program with mcpx's output conventions (early-env, TTY mode,
stderr logger, `--json` on stdout) and signal-safe shutdown; HTTP client and credentials file; browser sign-in
through a dashboard approval page (loopback + PKCE, or a device code), onto a CLI token Hypotenuse issues
and checks itself; operator commands `login`, `logout`,
`whoami`, `project`, `member`, `invite`, `tag`, `audit`; `upgrade` and `check-update` via upgradr with the
background update notice; `bun build --compile` for six targets; `install.sh` and `install.ps1`;
`.github/workflows/auto-release.yml` (npm trusted publishing + GitHub Release assets);
`cli/test/e2e/test-upgrade.sh` in CI; CLI spawn tests against a real server; `/docs/cli` user docs.

**Out:** `linear`, `runner`, `session`, `routing`, `identity` commands — each lands with its actions
([phases 6](./phase-06-linear-connection.md), [8](./phase-08-runners.md), [9](./phase-09-work-routing.md),
[15](./phase-15-dashboard.md)), per the rule that the CLI tracks the operator HTTP surface in the same commit.
The daemon, `config`, `agents`, `worktrees`, `service`, `doctor`, and `mcp` commands
([phase 10](./phase-10-daemon-and-config.md) onward). **Restarting a running daemon after an upgrade** — upgradr
replaces the binary and stops; the daemon's drain-and-re-exec lives with the daemon
([phase 10](./phase-10-daemon-and-config.md)). Personal access tokens (ToolExec's settled non-goal holds:
OAuth is the CLI's credential). Signed binaries and checksums (see Settled non-goals).

## Design

### 1. Package shape — `cli/package.json`

```json
{
  "name": "@arcadeai/hypotenuse",
  "version": "0.1.0",
  "type": "module",
  "bin": { "hypotenuse": "./dist/hypotenuse.js" },
  "files": ["dist", "skills", "README.md", "LICENSE"],
  "repository": { "type": "git", "url": "https://github.com/arcadeai-labs/hypotenuse.git" },
  "publishConfig": { "access": "public" },
  "scripts": {
    "dev": "bun run src/cli.ts",
    "test": "bun test",
    "lint": "tsc && biome check .",
    "format": "tsc && biome check --write .",
    "bundle": "bun build ./src/cli.ts --target bun --outfile dist/hypotenuse.js",
    "build": "bun build --compile --minify --sourcemap ./src/cli.ts --outfile dist/hypotenuse",
    "prepack": "bun run bundle"
  },
  "dependencies": { "commander": "^14", "ansis": "^4", "nanospinner": "^1", "upgradr": "^0.4", "zod": "^4" },
  "devDependencies": { "@hypotenuse/protocol": "workspace:*", "@types/bun": "latest", "typescript": "^7", "@biomejs/biome": "^2" }
}
```

**One deliberate difference from mcpx.** mcpx publishes raw TypeScript (`bin` → `src/cli.ts`) and npm users
run it under Bun. We cannot: `cli/` imports `@hypotenuse/protocol`, a private workspace package that is not on
npm, so a source publish would install a CLI whose first import fails. `prepack` therefore bundles to
`dist/hypotenuse.js` with `--target bun` (Bun shebang preserved, `protocol/` inlined, third-party dependencies
still installed by npm), and `bin` points there. **Bun is still required for npm and bun installs** — the daemon
uses `bun:sqlite`, `Bun.spawn`, and `Bun.serve` — and the README says so; the compiled binaries need nothing.
`cli/__tests__/package.test.ts` runs `npm pack --dry-run --json` and asserts the tarball holds `dist/hypotenuse.js`,
no `src/`, and no reference to `workspace:` in its `package.json`.

`repository.url` must be exactly `https://github.com/arcadeai-labs/hypotenuse.git`: `cli/src/update/updater.ts`
derives the GitHub repo from it, and the first key of `bin` is the asset name. Both are asserted by a unit test.

Files the binary needs at runtime (the default role prompts in [phase 11](./phase-11-acp-agent-host.md), the
`skills/hypotenuse.md` agent skill, the config template) are **embedded**, never read from disk relative to
`Bun.main`: `import managerPrompt from "../assets/manager.md" with { type: "text" }`. mcpx's `skill install`
reads `.claude/skills/mcpx.md` relative to `Bun.main` and is broken in every compiled binary; we do not
inherit that.

### 2. Program structure — `cli/src/**`

Copy mcpx's skeleton, file for file:

| File | From mcpx | Purpose |
|---|---|---|
| `src/cli.ts` | `src/cli.ts` | `#!/usr/bin/env bun`; imports `./output/early-env.ts` **first**; `installSignalHandlers()`; `setMode(detectMode(...))` from raw argv before commander parses; registers commands; unknown-command message; `updater.maybeBackgroundNotice()` before parse, printed on `beforeExit` |
| `src/output/early-env.ts` | same | turns `--no-color` / `--json` / `--force-color` into `NO_COLOR` / `FORCE_COLOR` before `ansis` loads |
| `src/output/{tty,logger,theme,format-table}.ts` | same | TTY mode; the stderr logger (`info`/`success`/`warn` hidden in JSON or non-TTY mode, `error` always, `debug` with `-v`); spinner integration; tables. **stdout is data only** |
| `src/shutdown.ts` | same | SIGINT 130 / SIGTERM 143 / SIGHUP 129, a `Closeable` registry with an 8 s hard timeout, `ExitError(code)` — the daemon registers its children here later |
| `src/update/updater.ts` | same | upgradr wiring (§5) |
| `src/commands/{upgrade,check-update}.ts` | same | §5 |
| `src/api/client.ts` | ToolExec `cli/src/client.ts` | HTTP client: base URL + `/api`, `Authorization: Bearer`, refresh on 401, Keryx error envelope → `ApiError` even on 200 |
| `src/api/credentials.ts` | new | the credentials file (§3) |
| `src/api/resolve.ts` | ToolExec `cli/src/resolve.ts` | project slug or id → id via `project:list` |
| `src/commands/{auth,project,member,invite,tag,audit}.ts` | ToolExec `cli/src/commands/{auth,project,ops}.ts` | one `registerXCommand(program)` per file, mcpx style |

Global options: `-c/--config <path>` (the daemon config file, read from [phase 10](./phase-10-daemon-and-config.md)),
`--url <origin>`, `--project <id|slug>`, `-j/--json`, `-v/--verbose`, `--no-color`, `--force-color`.

### 3. Credentials and base URL — `~/.config/hypotenuse/credentials.json`

`$XDG_CONFIG_HOME/hypotenuse/` (else `~/.config/hypotenuse/`), directory `0700`, file `0600`:

```json
{
  "baseUrl": "https://api.hypotenuse.cloud",
  "project": 12,
  "oauth": { "clientId": "…", "accessToken": "…", "refreshToken": "…", "expiresAt": 1767225600000 },
  "runner": null
}
```

`runner` is filled by `hypotenuse runner register` in [phase 8](./phase-08-runners.md) and is the daemon's
credential; operator sign-in and the runner token are deliberately separate entries so `logout` never
de-registers a machine and revoking a runner never signs a person out.

Base URL precedence, highest wins: `--url`, `HYPOTENUSE_URL`, `credentials.json` `baseUrl`, the config file's
`[server] url`, then the compiled-in default `https://api.hypotenuse.cloud` (the staging API; chosen in
[phase 2](./phase-02-deployment.md)). Callers pass the origin; the client appends `/api`.

### 4. Signing in: through the dashboard, onto a CLI token we own

The person signs in **on the web**, in the dashboard they already use, with whatever sign-in the web supports today
or later. The CLI never sees a password, and the server hands it a token that Hypotenuse issues, stores, and checks
itself.

Two alternatives were rejected:

- **ToolExec's `--email --password`**, which stores a session cookie. It is the wrong default for people who signed
  up in a browser. Keryx sessions also share one global `SESSION_TTL` (24 h by default), and a CLI wants months.
- **Keryx's own OAuth 2.1 server**, built for MCP clients. Its access tokens are verified on `/mcp` only. Making
  ordinary HTTP actions accept them would mean reading Keryx's token store from our middleware — a framework
  internal, and under rule 4 a capability we would have to wait on upstream. Keryx's OAuth server stays for human MCP
  clients, and the CLI does not use it.

The flow is the RFC 8252 loopback pattern with PKCE, with our own dashboard page as the authorization page:

```
hypotenuse login
  1. CLI: code_verifier + state; Bun.serve on 127.0.0.1:<ephemeral>
  2. open {app}/cli/authorize?port=<p>&state=<s>&code_challenge=<S256(verifier)>&device=<hostname>
     (the URL is printed too, for when no browser opens)
  3. the dashboard route is behind ProtectedRoute: sign in or sign up as usual, then
     "Sign in the hypotenuse CLI on <device>?"  [Approve] [Cancel]
  4. Approve → PUT /api/cli-auth/approve { codeChallenge, device }        (session; audited)
     → one-time code: Redis, 60 s TTL, bound to userId + codeChallenge
     → the page redirects to http://127.0.0.1:<p>/callback?code=…&state=…
  5. CLI checks state → POST /api/cli-auth/exchange { code, codeVerifier }   (unauthenticated; rate-limited)
     → { token: "hyp_cli_…", cliToken: { id, device, expiresAt } }  → credentials.json (0600)
  6. GET /api/me with Authorization: Bearer hyp_cli_… → "Signed in as peach@example.com"
```

**SSH and headless machines**, `login --no-browser`, use a device code instead of a loopback port. The CLI calls
`PUT /api/cli-auth/device` and gets `{ userCode: "WDJB-MJHT", deviceCode, verificationUrl }`. It prints the URL and
the code. The person opens `{app}/cli/activate` on any device, signs in, types the code, and approves
(`POST /api/cli-auth/activate`, session; audited). The CLI polls `cli-auth:exchange` with `{ deviceCode }` every
2 s for up to 10 minutes and receives the same token. Each code is single-use, and a code that is approved or
expires is gone.

**The token.** `backend/schema/cli_tokens.ts`:

| Column | Notes |
|---|---|
| `id`, `userId` | `userId` cascades on user delete |
| `device` | the hostname the CLI reported, editable in the dashboard |
| `tokenHash`, `lastFour` | sha256 of `hyp_cli_<32 random bytes, base62>`; the plaintext exists only in the exchange response |
| `createdAt`, `lastUsedAt`, `expiresAt`, `revokedAt` | `timestamptz`; 90-day expiry, **sliding** (extended on use at most once a day) |

**The middleware.** `backend/middleware/session.ts` resolves **one principal** per request. A session cookie with a
`userId` comes first. Otherwise it reads `Authorization: Bearer hyp_cli_…` (through ToolExec's
`ops/RawRequestOps.ts` `bearerToken`), looks the hash up in `cli_tokens` (not revoked, not expired), and sets the
resolved `userId` where RBAC reads it. No Redis session is created, and no Keryx internals are touched. This is
ToolExec's `RunTokenMiddleware` pattern pointed at people. A CLI token acts as its person on every human action
and is refused on `daemon:*`. A runner token (`hyp_rt_…`) is refused on every human action (rule 8). Unknown,
revoked, and expired tokens get one byte-identical 401.

**Managing sign-ins.** `cli-token:list` (the caller's own) and `cli-token:revoke` (own; audited) back a "CLI
sign-ins" section on the Account page: device, created, last used, and a Revoke button. `hypotenuse logout` revokes
the current token server-side (`DELETE /api/cli-token`), then deletes it from `credentials.json`. Removing a user
deletes their tokens; removing a membership needs nothing, because every request re-checks membership.

`cli-auth:exchange` and `cli-auth:device` are unauthenticated machine ingress: never MCP, unaudited (the audited
decision is the person's approve or activate), and rate-limited per IP and per code. `cli-auth:approve` and
`cli-auth:activate` are browser hops, never MCP.

`backend/__tests__/cli/login.test.ts` covers the following, driving the approve page's action over HTTP with a
signed-in test user:

- The code is single-use, expires after 60 s (asserted by writing the Redis TTL, not by waiting), and is bound to
  its challenge: a wrong verifier gets the same 400 as an unknown code.
- The token works on human actions as that person and respects membership: Bowser's token gets 403 on Peach's
  project.
- Revoked and expired tokens get a byte-identical 401.
- A CLI token is refused on `daemon:heartbeat`, and a runner token is refused on `project:list`.
- The device flow completes, and an unapproved device code times out.
- `logout` revokes.

There is no password path for CI. The e2e suite signs in the same way, approving with a test user's session.

### 5. Self-upgrade — `upgradr`

```ts
// cli/src/update/updater.ts
import { createUpdater } from "upgradr";
import pkg from "../../package.json";
export const updater = createUpdater({
  currentVersion: pkg.version,
  packageName: pkg.name,                                  // @arcadeai/hypotenuse
  repo: pkg.repository.url.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, ""),
  binaryName: Object.keys(pkg.bin)[0]!,                   // hypotenuse
  cacheDir: configDir(),                                  // ~/.config/hypotenuse → update.json
  cliName: "hypotenuse",
  noUpdateCheckEnv: "HYPOTENUSE_NO_UPDATE_CHECK",
  checkIntervalMs: 24 * 60 * 60 * 1000,
  timeoutMs: 5_000,
});
```

How upgradr behaves, so nobody re-derives it:

- **"Latest" comes from npm** (`registry.npmjs.org/@arcadeai/hypotenuse/latest`) even for binary installs; the
  changelog comes from GitHub Releases. Publishing the binaries without the npm package therefore upgrades
  nobody — the release workflow publishes both from one version or neither.
- **Install method** is detected from `process.execPath` and the script path: compiled binary, `bun -g`,
  `npm -g`, or local dev (running `src/cli.ts` from a checkout — a no-op that says `git pull && bun install`).
- **Binary upgrades** download `hypotenuse-<os>-<arch>[.exe]` for tag `v<latest>` to a temp file, `chmod 755`,
  and `mv` it over `process.execPath` (falling back to `sudo mv`). On macOS and Linux this replaces the inode,
  so a running daemon keeps executing the old image until it restarts — which is why the daemon's
  drain-and-re-exec in [phase 10](./phase-10-daemon-and-config.md) exists. **Windows cannot replace a running
  `.exe`** and upgradr has no `mv` there: on Windows, `upgrade` prints the `irm … | iex` line instead of
  attempting the swap. A test asserts the message.
- `hypotenuse upgrade [--json]` prints `already up to date`, `Running from source…`, `Upgraded vX → vY`, or the
  failure, and exits 1 only when an attempted upgrade failed. `hypotenuse check-update [--json]` reports
  `currentVersion`, `latestVersion`, `hasUpdate`, and the changelog.
- The **background notice** is skipped when `HYPOTENUSE_NO_UPDATE_CHECK=1`, for `upgrade`/`check-update`
  themselves, when stderr is not a TTY, and — added here — for `hypotenuse daemon *` and `hypotenuse mcp`,
  which are not interactive and whose stderr may be a log file or an agent's pipe.

### 6. Release — `.github/workflows/auto-release.yml`

**Version-driven, like mcpx:** bumping `cli/package.json` `version` in a PR and merging it to `main` releases;
merging without a bump releases nothing. The jobs, in order:

```
check-version ──► ci ──► create-release ──┬──► publish-npm
 (tag v<ver>        (lint, test,           ├──► build-binaries (matrix ×6) ──► upload assets
  exists? skip)      test-upgrade.sh)      └──► (both must succeed before the release is un-drafted)
```

**The mcpx gotcha, fixed.** mcpx creates the GitHub Release *before* CI runs, so a red CI leaves a published
tag, the next push sees the release already exists and skips, and the only way out is deleting the release or
bumping again. Here `ci` runs first; `create-release` makes a **draft** release; `publish-npm` and
`build-binaries` run against the draft; a final `finalize` job un-drafts it only when both succeed. A failed
publish leaves a draft that the next run of the same version reuses (`gh release view` treats a draft as
"exists, unfinished" and resumes rather than skipping).

| Job | Does |
|---|---|
| `check-version` | `VERSION=$(jq -r .version cli/package.json)`; `tag=v$VERSION`; `should_release` unless a **non-draft** release with that tag exists |
| `ci` | `bun install --frozen-lockfile`; root `bun run lint`; `bun run --cwd cli test`; `bash cli/test/e2e/test-upgrade.sh` |
| `create-release` | `gh release create "$tag" --draft --title "$tag" --generate-notes` (or reuse the draft) |
| `publish-npm` | `actions/setup-node@v5` (Node 22.14+), `npm i -g npm@^11.5.1`, `cd cli && npm publish --provenance --access public` — **npm trusted publishing (OIDC)**, `id-token: write`, no `NPM_TOKEN`. A version already on the registry is a no-op, so a resumed run does not fail here |
| `build-binaries` | matrix below; `bun build --compile --minify --sourcemap --target=<target> ./cli/src/cli.ts --outfile dist/<asset>`; `gh release upload "$tag" dist/<asset> --clobber` |
| `finalize` | `gh release edit "$tag" --draft=false` |

| `--target` | Asset |
|---|---|
| `bun-darwin-arm64` | `hypotenuse-darwin-arm64` |
| `bun-darwin-x64` | `hypotenuse-darwin-x64` |
| `bun-linux-arm64` | `hypotenuse-linux-arm64` |
| `bun-linux-x64` | `hypotenuse-linux-x64` |
| `bun-windows-x64` | `hypotenuse-windows-x64.exe` |
| `bun-windows-arm64` | `hypotenuse-windows-arm64.exe` |

All six cross-compile on one `ubuntu-latest` runner. Provenance: the repository is public, so
`--provenance` is on; if it is ever private, npm rejects provenance from a private source and the flag must
go (ToolExec's `publish-cli.yml` records that). The npm package needs a **trusted publisher** configured once on
npmjs.com, pointing at this repository and `auto-release.yml`; `DEPLOY.md` lists it.

`backend/__tests__/deployment/release-workflow.test.ts` (ToolExec's `publish-cli-workflow.test.ts`, ported)
parses the workflow and asserts: `ci` precedes `create-release`; the release is created as a draft and
un-drafted only by a job that `needs` both publish jobs; the matrix is exactly the six targets and asset names
above; `publish-npm` has `id-token: write` and no `NPM_TOKEN`; the version is read from `cli/package.json`.

The publish workflow sits **outside** `ci.yml` and its gate, for ToolExec's reason: a publish is not a check,
and a push-only job inside the gate would report `skipped` on every PR.

### 7. Install scripts — `install.sh`, `install.ps1`

Copied from mcpx, renamed, with two additions:

```bash
#!/usr/bin/env bash
# curl -fsSL https://raw.githubusercontent.com/arcadeai-labs/hypotenuse/main/install.sh | bash
set -euo pipefail
REPO="arcadeai-labs/hypotenuse"
INSTALL_DIR="${HYPOTENUSE_INSTALL_DIR:-/usr/local/bin}"
case "$(uname -s)" in Darwin) os=darwin;; Linux) os=linux;; *) echo "unsupported OS" >&2; exit 1;; esac
case "$(uname -m)" in arm64|aarch64) arch=arm64;; x86_64|amd64) arch=x64;; *) echo "unsupported arch" >&2; exit 1;; esac
TAG="${HYPOTENUSE_VERSION:-$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | cut -d'"' -f4)}"
TMP="$(mktemp)"
curl -fsSL "https://github.com/${REPO}/releases/download/${TAG}/hypotenuse-${os}-${arch}" -o "$TMP"
chmod +x "$TMP"
[ "$os" = darwin ] && xattr -d com.apple.quarantine "$TMP" 2>/dev/null || true
if [ -w "$INSTALL_DIR" ]; then mv "$TMP" "$INSTALL_DIR/hypotenuse"; else sudo mv "$TMP" "$INSTALL_DIR/hypotenuse"; fi
"$INSTALL_DIR/hypotenuse" --version
```

The additions are `HYPOTENUSE_VERSION` (pin a version; the e2e test uses it) and clearing the macOS quarantine
attribute, which mcpx omits. `install.ps1` downloads `hypotenuse-windows-<arch>.exe` to
`%LOCALAPPDATA%\hypotenuse\hypotenuse.exe` (or `$env:HYPOTENUSE_INSTALL_DIR`) and appends that directory to the
user `PATH`.

### 8. The upgrade path, tested end to end — `cli/test/e2e/test-upgrade.sh`

Copy mcpx's script. It installs the current branch **three ways** and checks each:

1. `cd cli && npm pack && npm install -g ./arcadeai-hypotenuse-*.tgz`
2. `bun install -g ./arcadeai-hypotenuse-*.tgz`
3. `bun run build`, then copy `cli/dist/hypotenuse` to `/usr/local/bin`

For each: `hypotenuse --version` equals `cli/package.json`; `hypotenuse --json check-update` has
`.currentVersion` and `.latestVersion`; `hypotenuse --json upgrade` reports `.from` and the right `.method`
(`npm`, `bun`, `binary`). It clears `~/.config/hypotenuse/update.json` between steps. It runs in `ci.yml` as the
**CLI Upgrade** job (in the gate) and again inside `auto-release.yml`'s `ci` job.

### 9. Operator commands

| Command | Wraps |
|---|---|
| `hypotenuse login [--url] [--no-browser]` / `logout` / `whoami` | the sign-in flow above (`cli-auth:*`); `cli-token:revoke` + local delete; `me:view` |
| `hypotenuse project list|view|create|edit|delete|use <id|slug>` | `project:*`; `use` writes `project` to credentials.json |
| `hypotenuse member list|add|remove` | `membership:*` |
| `hypotenuse invite list|pending|create|accept|reject` | `invite:*` |
| `hypotenuse tag list|create|edit|delete|assign|unassign` | `tag:*`, `user-tag:*` |
| `hypotenuse audit list [--since] [--until]` | `audit:list` |

Every list prints a table in human mode and the action's named object under `--json`; every list takes
`--page` / `--limit`. Human-mode banner, palette, glyphs, and tables come from `src/output/theme.ts`, which the
[design system](./phase-03-design-system.md) builds from `design/tokens.json` (one generator, one source).
`cli/__tests__/palette.test.ts` asserts that every token the commands use exists there.

## Steps

### 1. `cli/` skeleton — `cli/src/{cli.ts,shutdown.ts,output/*,api/*}`

Port mcpx's skeleton and ToolExec's HTTP client as tabulated above. Remove the phase-1 placeholder.

### 2. CLI tokens and sign-in actions — `backend/schema/cli_tokens.ts`, `backend/ops/CliTokenOps.ts`, `backend/actions/cli-auth/*.ts`, `backend/actions/cli-token/*.ts`, `backend/middleware/session.ts`, `frontend/src/pages/cli/{CliAuthorizePage,CliActivatePage}.tsx`, Account → CLI sign-ins

As in Design §4: `cli-auth:approve`, `cli-auth:exchange`, `cli-auth:device`, `cli-auth:activate`, `cli-token:list`,
`cli-token:revoke`, the middleware's principal resolution, and the two dashboard pages. Add `hyp_cli_` and the
exchange's `code` / `codeVerifier` / `deviceCode` keys to `SENSITIVE_KEYS`. Tests: `backend/__tests__/cli/login.test.ts`
and `backend/__tests__/middleware/principal.test.ts`.

### 3. `login` / `logout` / `whoami` — `cli/src/commands/auth.ts`, `cli/src/api/oauth.ts`

### 4. Operator commands — `cli/src/commands/{project,member,invite,tag,audit}.ts`

### 5. Upgrade — `cli/src/update/updater.ts`, `cli/src/commands/{upgrade,check-update}.ts`

### 6. Packaging — `cli/package.json` (`bundle`, `prepack`), `cli/assets/`, `cli/skills/hypotenuse.md`

`skills/hypotenuse.md` is an agent skill describing the CLI (as mcpx ships `.claude/skills/mcpx.md`); kept in
sync with `--help` by `cli/__tests__/skill-sync.test.ts`, which asserts every top-level command appears in it.

### 7. Release and install — `.github/workflows/auto-release.yml`, `install.sh`, `install.ps1`, `cli/test/e2e/test-upgrade.sh`

### 8. Tests

| Test | Asserts |
|---|---|
| `backend/__tests__/cli/cli.test.ts` | spawns `bun run cli/src/cli.ts` against `serverUrl()` with `XDG_CONFIG_HOME` in a temp dir: `login` (scripted consent) → `whoami` → `project list` → `invite create` → `audit list`; `--json` output has no ANSI; `NO_COLOR` strips color; a 200 with an error envelope exits non-zero |
| `backend/__tests__/cli/login.test.ts` | the OAuth round trip, refresh, revoke (Design §4) |
| `backend/__tests__/deployment/release-workflow.test.ts` | Design §6 invariants |
| `cli/__tests__/{credentials,url,package,palette,skill-sync,updater,imports}.test.ts` | file modes `0700`/`0600`; base-URL precedence; tarball contents; palette parity; skill coverage; updater derives repo and binary name; no server imports |
| `cli/__tests__/upgrade.test.ts` | `upgrade` from a checkout is a no-op exit 0 with method `local-dev`; `--json` has `from`, `method`, `success`; Windows message (by stubbing `process.platform`) |

### 9. User docs — `frontend/src/content/docs/cli.md`

Install four ways, sign in, project switching, upgrade, `HYPOTENUSE_NO_UPDATE_CHECK`, and the note that npm and
bun installs need Bun on the machine.

## Verification

```bash
bun run --cwd cli lint && bun run --cwd cli test
cd backend && bun test __tests__/cli __tests__/middleware __tests__/deployment
cd ../cli && bun run build && ./dist/hypotenuse --version
bash cli/test/e2e/test-upgrade.sh
bun run --cwd cli dev login --url http://localhost:8080      # opens a browser; sign in; returns
bun run --cwd cli dev whoami && bun run --cwd cli dev --json project list | jq
```

- A browser sign-in completes with no password typed into the terminal. `--no-browser` completes from a second
  device. The token appears under Account → CLI sign-ins, and revoking it there makes `whoami` fail.
- The three install paths in `test-upgrade.sh` all report the right install method.
- A dry run of the release workflow on a fork (or `act`) shows `ci` before `create-release` and a draft
  release until both publish jobs pass.
- After the first real release: `curl … install.sh | bash` installs a binary that reports the released
  version, and `npm i -g @arcadeai/hypotenuse` installs the same version.

## Definition of done

- [ ] `cli/` follows mcpx's structure: early-env, TTY mode, stderr logger, stdout data, signal-safe shutdown
- [ ] `login` signs in through the dashboard (loopback + PKCE, and a device code with `--no-browser`); `logout` revokes
- [ ] `cli_tokens` with sliding expiry; the session middleware resolves a CLI token to its person; CLI and runner tokens are each refused where they don't belong
- [ ] Account page lists and revokes CLI sign-ins
- [ ] Operator commands for project, member, invite, tag, and audit, each with `--json`
- [ ] `upgrade` / `check-update` via upgradr; background notice suppressed for daemon and MCP commands; Windows prints the reinstall line
- [ ] The npm package is a bundled `dist/hypotenuse.js`; runtime assets are embedded, never read beside `Bun.main`
- [ ] `auto-release.yml` runs CI before creating a draft release; npm (OIDC) and six binaries publish from one version; `finalize` un-drafts
- [ ] `install.sh` and `install.ps1`; `test-upgrade.sh` passes in CI for npm, bun, and binary installs
- [ ] `release-workflow.test.ts` and the CLI spawn tests pass
- [ ] `/docs/cli` user docs

## Settled non-goals (do not reopen without a new plan)

- **No personal access tokens.** OAuth is the human credential; the runner token is the machine credential.
- **No checksums or signatures yet.** mcpx ships neither and upgradr verifies neither; adding them means
  changing upgradr upstream first, then both install scripts. A later plan, not a quiet addition here.
- **No Homebrew tap or `.deb`.** Four install paths, each tested by `test-upgrade.sh`, are enough.

## Commands

```bash
npm i -g @arcadeai/hypotenuse            # needs Bun on PATH
bun i -g @arcadeai/hypotenuse
curl -fsSL https://raw.githubusercontent.com/arcadeai-labs/hypotenuse/main/install.sh | bash
irm https://raw.githubusercontent.com/arcadeai-labs/hypotenuse/main/install.ps1 | iex

hypotenuse login
hypotenuse whoami
hypotenuse project use my-team
hypotenuse --json check-update | jq
hypotenuse upgrade
HYPOTENUSE_NO_UPDATE_CHECK=1 hypotenuse project list
```

## Learnings from the build

_Nothing yet — this phase has not been built._
