# Phase 06 — Operator CLI

> **Goal:** One `hypotenuse` command, installed with `npm i -g @arcadeai/hypotenuse`,
> `bun i -g @arcadeai/hypotenuse`, `curl … | bash`, or `irm … | iex`. It signs in to a Hypotenuse server through a
> browser, manages organizations, projects, members, invites, tags, and the audit log over HTTP, and keeps itself
> current with `hypotenuse upgrade`. Merging a version bump to `main` publishes npm and six compiled binaries in
> one workflow.

> **Status: built.** It builds on [phase 04](./phase-04-organizations-users-and-rbac.md) (the actions
> it wraps) and [phase 05](./phase-05-audit-logging.md) (`audit:list`). Every later phase that adds an operator
> action adds its command in the same commit (rule 13). This phase builds the shell and the release pipeline those
> commands hang on.

v1's CLI had two audiences: an operator at a terminal, and the runner daemon on that person's laptop. 2.0 drops
the daemon, so only the operator remains, and **the CLI becomes exactly ToolExec's product CLI**: an HTTP client
of the same actions the website uses, never a wrapper around `bun keryx.ts`. The ToolExec version is described in
[ToolExec phase 17](https://github.com/arcadeai-labs/toolexec/blob/main/docs/plans/phase-17-product-cli.md).

What carries over from v1 is the hard part, already built and reviewed:
- **mcpx's distribution machinery:** one codebase installed four ways, each of which can upgrade itself
  correctly, via `upgradr`. The version-driven `auto-release.yml`, with npm trusted publishing, a draft-then-publish
  GitHub release, and six binaries.
- **v1's CLI sign-in:** the dashboard approves the CLI through loopback + PKCE or a device code, onto a
  `hyp_cli_` token that Hypotenuse issues and checks itself.

Read [v1 phase 05](https://github.com/arcadeai-labs/hypotenuse/blob/v1/docs/plans/phase-05-cli-and-distribution.md)
before changing any of it. Its learnings record over a dozen departures and traps.

Headless bots make the CLI matter more in 2.0, not less. A team that runs bots in Slack wants to script them:
- create a bot from a file;
- bind it to twenty channels;
- tail a conversation;
- read its memory.

So every domain phase that follows adds commands here, and the skill file shipped with the package
(`cli/skills/hypotenuse.md`) is how a coding agent learns to drive Hypotenuse.

## Scope

**In:**
- **Package and program:** the `cli/` package shape; mcpx's program structure (early-env, TTY mode, stderr
  logger, `--json` on stdout, signal-safe shutdown).
- **Credentials and sign-in:**
  - the HTTP client and a credentials file keyed by server;
  - `cli_tokens`, `CliTokenOps`, the `cli-auth:*` and `cli-token:*` actions;
  - the principal resolution in `middleware/session.ts`;
  - the dashboard approval pages.
- **Commands:**
  - `login`, `logout`, `whoami`;
  - `org`, `project`, `member`, `invite`, `tag`, `audit`;
  - `upgrade` and `check-update`, with the background update notice.
- **Distribution:**
  - `bun build --compile` for six targets;
  - `install.sh`, `install.ps1`;
  - `auto-release.yml`;
  - `cli/test/e2e/test-upgrade.sh` in the gate as **CLI Upgrade**.
- **Tests and docs:** CLI spawn tests against a real server; user docs `/docs/cli`; the agent skill.

**Out:**
- Commands for later nouns (`model`, `bot`, `conversation`, `memory`, `mcp`, `skill`, `channel`, `sandbox`,
  `schedule`, `cost`). Each lands with its actions.
- Any daemon, `config`, `worktrees`, `service`, or `mcp` stdio server. Those were v1's and are dropped.
- The settled non-goals below.

## What already exists

| Piece | Where |
|---|---|
| CLI skeleton, output, theme, shutdown, client, credentials | [v1 `cli/src/`](https://github.com/arcadeai-labs/hypotenuse/tree/v1/cli/src) minus `acp/`, `daemon/`, `worktree/`, `mcp/`, `runner/`, `telemetry/` |
| `cli_tokens`, `CliTokenOps`, `cli-auth:*`, `cli-token:*`, principal hook | v1 `backend/{schema/cli_tokens.ts,ops/CliTokenOps.ts,actions/cli-auth,actions/cli-token,middleware/session.ts}` |
| `/cli/authorize`, `/cli/activate`, Account → CLI sign-ins | v1 `frontend/src/pages/cli/` |
| upgradr wiring, `upgrade`, `check-update` | v1 `cli/src/update/`, `cli/src/commands/{upgrade,check-update}.ts` |
| Release workflow and installers | [v1 `.github/workflows/auto-release.yml`](https://github.com/arcadeai-labs/hypotenuse/blob/v1/.github/workflows/auto-release.yml), [v1 `install.sh`](https://github.com/arcadeai-labs/hypotenuse/blob/v1/install.sh), `install.ps1`, `cli/test/e2e/test-upgrade.sh` |
| Operator command shape | [ToolExec `cli/src/commands/`](https://github.com/arcadeai-labs/toolexec/tree/main/cli/src/commands) |

## What this must not weaken

1. **The CLI never imports the server at runtime** (`cli/__tests__/imports.test.ts`). Nor does it import a
   `workspace:` package: `npm pack` copies `package.json` verbatim, so the spec would ship in the tarball
   (`package.test.ts`).
2. **A CLI token acts as its person, never more.** It never reaches the actions that need a browser:
   `BrowserSessionMiddleware` refuses `cli-auth:approve` and `cli-auth:activate` to it, so one sign-in can never
   mint another without a person on a dashboard page.
3. **A presented token that does not authenticate gets one 401, whatever the reason.**
4. **The principal hook never writes a `userId` into a Redis session.** Keryx creates an anonymous session for
   every cookie-less request; the token's user is set in memory only.
5. **The release workflow sits outside the CI gate**, and a release is a version bump, never a tag pushed by hand.

## Design

### The version: `2.0.0`, same package

- `@arcadeai/hypotenuse` stays the package name. Install docs, `install.sh`, and upgradr's GitHub repository
  derivation all already point at it.
- v1 published `0.x`, so 2.0's first release is **`2.0.0`**. A major bump is the honest signal that `daemon`,
  `runner`, and `config` are gone.
- A v1 user who runs `hypotenuse upgrade` gets 2.0, which no longer runs their daemon. So:
  - the final step of the first 2.0 release runs `npm deprecate @arcadeai/hypotenuse@"<1" "…"`, pointing at the
    `v1` branch;
  - `upgrade` refuses to cross a major version without `--major`, and prints why.

  The second guard is an upgradr option if it has one. If it does not, file the gap upstream rather than fork.

### Principals

Unchanged from v1, minus the runner. `middleware/session.ts` resolves exactly one principal per request, in a
`beforeAct` hook:

1. A cookie session wins.
2. Otherwise, a live `hyp_cli_` bearer sets the person's `userId` in memory.
3. Otherwise, anonymous.

The sandbox run token ([phase 17](./phase-17-sandboxes.md)) is a third principal, resolved by its own
middleware. It is never accepted here.

### Credentials file — `~/.config/hypotenuse/credentials.json`

Keyed by server:

```json
{ "current": "https://api.hypotenuse.cloud",
  "servers": { "https://api.hypotenuse.cloud": {
      "login": { "token": "hyp_cli_…", "tokenId": 7, "device": "evan-mbp", "email": "…" },
      "organization": 3, "project": 12 } } }
```

`org use` and `project use` set the defaults. `--org` and `--project` override per command. The base URL comes
from, in order:
1. `--url`;
2. `HYPOTENUSE_URL`;
3. `current`;
4. the hosted default.

### Commands this phase ships

| Command | Wraps |
|---|---|
| `login [--url] [--device]`, `logout`, `whoami` | `cli-auth:*` hops, `cli-token:revoke` (self), `me:view` |
| `org list`, `org view`, `org use`, `org create`, `org members`, `org member set-role`, `org member remove` | `organization:*`, `organization-membership:*` |
| `project list`, `project view`, `project use`, `project create`, `project edit`, `project delete` | `project:*` |
| `member list`, `member add`, `member remove` | `membership:*` |
| `invite create`, `invite list`, `invite accept`, `invite reject` | `invite:*` |
| `tag list`, `tag create`, `tag edit`, `tag delete`, `tag assign`, `tag remove` | `tag:*`, `user-tag:*` |
| `audit list [--org] [--since] [--until] [--action]` | `audit:list`, `organization:audit-list` |
| `upgrade [--major]`, `check-update` | upgradr |

Every listing command pages (`--page`, `--limit`) and supports `--json`.

**Rule 13 decisions for routed actions with no command:**
- `cli-token:list`: the Account page's job.
- `notification:*`: the bell is a dashboard surface.
- `user:edit` and `project:settings-view`: account and settings pages.
- the `cli-auth:*` hops: `login` drives them rather than wrapping them.

Record each decision in this doc's learnings as v1 did.

### Release and install

v1's `auto-release.yml`, unchanged in shape:
1. `check-version` reads `cli/package.json` and releases unless a published, non-draft release with that tag
   exists.
2. Release CI.
3. Create (or resume, retargeting to `GITHUB_SHA`) the draft release.
4. `publish-npm` through OIDC trusted publishing.
5. Six binaries, `hypotenuse-<os>-<arch>[.exe]`.
6. Publish the release.

The first `2.0.0` release must account for npm's trusted-publisher rule: npm accepts a trusted publisher only for
a package that already exists. The package already exists from v1, so 2.0 inherits the configured publisher.
Verify this rather than assume it, and record the outcome.

## Schema sketch

```ts
cli_tokens { id serial, userId → users, tokenHash text unique, device text, lastUsedAt timestamptz,
             expiresAt timestamptz /* 90-day sliding, touched at most daily */, revokedAt timestamptz null,
             createdAt timestamptz }
```

## Actions and policy sketch

| Action | Route | RBAC | MCP | Audited |
|---|---|---|---|---|
| `cli-auth:approve` | `POST /cli-auth/approve` | none (browser session required) | never (browser hop) | yes (personal: no `projectId`) |
| `cli-auth:activate` | `POST /cli-auth/activate` | none (browser session required) | never | yes |
| `cli-auth:device` | `PUT /cli-auth/device` | none | never (sign-in ingress) | no (closed list) |
| `cli-auth:exchange` | `POST /cli-auth/exchange` | none | never (returns a token) | no (closed list) |
| `cli-token:list` | `GET /cli-tokens` | none (own rows) | yes | read |
| `cli-token:revoke` | `DELETE /cli-token/:tokenId` | none (own rows) | yes | yes |

## Frontend and user docs

- Ported pages: `/cli/authorize` and `/cli/activate`, which end on our painted page via
  `?status=done|cancelled|error`. Account → CLI sign-ins, listing and revoking.
- `frontend/src/content/docs/cli.md`: install four ways, sign in, choose an organization and project, the command
  reference, upgrading (including the major-version guard), and `--json` for scripts.
- `cli/skills/hypotenuse.md` ships in the npm package. `skill-sync.test.ts` keeps it in step with `--help`.

## Steps

### 1. Skeleton — `cli/src/{cli.ts,shutdown.ts,output/*,api/*}`

Port v1's, deleting every daemon import.

### 2. Tokens and sign-in — `backend/schema/cli_tokens.ts`, `backend/ops/CliTokenOps.ts`, `backend/actions/{cli-auth,cli-token}/*`, `backend/middleware/session.ts`, `frontend/src/pages/cli/*`

### 3. Commands — `cli/src/commands/{auth,org,project,member,invite,tag,audit}.ts`

### 4. Upgrade — `cli/src/update/updater.ts`, `cli/src/commands/{upgrade,check-update}.ts`

Includes the major-version guard. `upgrade` prints "Could not check for updates" when upgradr reports an error
alongside `hasUpdate: false`; mcpx printed "already up to date" in that case.

### 5. Packaging — `cli/package.json` (`bundle`, `prepack`), `cli/LICENSE` (byte-identical copy), `cli/skills/hypotenuse.md`

### 6. Release and install — `.github/workflows/auto-release.yml`, `install.sh`, `install.ps1`, `cli/test/e2e/test-upgrade.sh`

### 7. Tests — `cli/__tests__/**`, `backend/__tests__/cli/**`

## Test plan

- **`backend/__tests__/cli/`** spawns the real CLI against the booted server:
  - **sign-in:** login by device code, approved over HTTP as a test user; login by loopback with a scripted
    browser hop; `whoami`;
  - **commands:** every command against the Mushroom Kingdom universe;
  - **refusals:** a revoked token gets one 401; a CLI token refused on `cli-auth:approve`.
- **`login.test.ts`**: the stored Redis session never gains a `userId`, and its cookie is signed out.
- **CLI unit tests**: `imports`, `package` (no `workspace:`, `LICENSE` shipped), `skill-sync`, `theme`, the
  credentials ladder, and the major-version guard.
- **`test-upgrade.sh`** installs the branch by npm, bun, and binary, then upgrades each. It runs in CI only,
  because it installs globally.
- **`release-workflow.test.ts`**: the workflow's invariants (outside the gate; OIDC permissions; draft
  retargeting).

## Verification

```bash
cd cli && bun run lint && bun test && bun run build && ./dist/hypotenuse --version
cd ../backend && bun test __tests__/cli
bun run --cwd cli hypotenuse login --url http://localhost:8080
bun run --cwd cli hypotenuse org list && bun run --cwd cli hypotenuse audit list --json | jq '.pagination'
```

## Definition of done

- [x] `cli/` is mcpx's skeleton with no daemon code; `imports.test.ts` and `package.test.ts` pass
- [x] Sign-in by loopback + PKCE and by device code, onto `hyp_cli_` tokens; Account → CLI sign-ins revokes them
- [x] `org`, `project`, `member`, `invite`, `tag`, and `audit` commands, each with `--json` and paging
- [x] `upgrade` and `check-update`, with the major-version guard and an honest failure message
- [x] `auto-release.yml`, `install.sh`, and `install.ps1`; `test-upgrade.sh` runs in the gate as CLI Upgrade
- [ ] The first `2.0.0` release is published, and `0.x` is deprecated with a pointer to the `v1` branch. A person
      with npm access does this; record who
- [x] User docs `/docs/cli` and the agent skill are in step with `--help`

## Open questions

- Whether `hypotenuse` should offer `apply -f bots.yaml` (ToolExec's dump/apply) once bots exist. It is a
  candidate for [phase 07](./phase-07-model-providers-and-bots.md) or later. The default is no, until the bot
  shape stops moving.

### Settled non-goals

- **No personal access tokens.** The CLI token is the human credential; the sandbox run token is the only machine
  credential.
- **No checksums or signatures yet.** That needs upgradr to change upstream first, then both install scripts.
- **No Homebrew tap or `.deb`.** Four install paths, each tested by `test-upgrade.sh`, are enough.

## Learnings from the build

### What is built

| Piece | Where |
|---|---|
| `cli_tokens` (sha256 and last four only), migration 0003 | `backend/schema/cli_tokens.ts`, `backend/drizzle/0003_*.sql` |
| Codes in Redis by hash, minting, sliding expiry, serializer | `backend/ops/CliTokenOps.ts`, `backend/config/cliAuth.ts` |
| `cli-auth:approve` / `activate` (audited, browser only), `cli-auth:device` / `exchange` (closed list), `cli-token:list` / `revoke` | `backend/actions/cli-auth/`, `backend/actions/cli-token/` |
| The principal hook and `BrowserSessionMiddleware` | `backend/middleware/session.ts`, `backend/initializers/principal.ts` |
| `/cli/authorize`, `/cli/activate`, Account → CLI sign-ins | `frontend/src/pages/cli/`, `frontend/src/components/account/CliSignInsCard.tsx` |
| The CLI: early env, stderr logger, shutdown, client, credentials, sign-in flows, context | `cli/src/{cli,program,context,paths,shutdown}.ts`, `cli/src/output/`, `cli/src/api/` |
| Commands | `cli/src/commands/{auth,org,project,member,invite,tag,audit,check-update,upgrade}.ts` |
| upgradr wiring and the major-version guard | `cli/src/update/updater.ts`, `cli/src/commands/upgrade.ts` |
| Packaging | `cli/package.json` (2.0.0, `files` ships `skills`, `README.md`, `LICENSE`), `cli/LICENSE`, `cli/README.md`, `cli/skills/hypotenuse.md` |
| Release and install | `.github/workflows/auto-release.yml`, `install.sh`, `install.ps1`, `cli/test/e2e/test-upgrade.sh`, **CLI Upgrade** in `ci.yml` |
| User docs | `frontend/src/content/docs/cli.md`, the CLI sign-ins section of `accounts.md` |
| Proof | `backend/__tests__/cli/{login,cli,commands}.test.ts`, `backend/__tests__/deployment/release-workflow.test.ts`, `cli/__tests__/*`, `frontend/e2e/cli.spec.ts`, `frontend/src/__tests__/cli-link.test.ts` |

### Departures from the plan

| Plan | Built | Why |
|---|---|---|
| `cli-token:revoke` at `DELETE /cli-token/:tokenId` | `DELETE /cli-token`, `cliTokenId` optional in the body | v1's shape: with no id it revokes the calling token, which is what `logout` sends. A path parameter cannot be optional |
| `login [--device]` | `--device` chooses the device-code flow; `--name <name>` names the machine | v1 used `--device <name>` for the name and `--no-browser` for the flow; the plan's flag name won, so the name moved |
| The release's final step runs `npm deprecate` | Not in the workflow | Trusted publishing (OIDC) authorizes `npm publish` and nothing else; `npm deprecate` needs a person's npm credentials. It stays a DoD item for that person |
| The major-version guard "is an upgradr option if it has one" | Our own check before `upgrade()` | upgradr 0.4.1 has no such option. `performUpgrade` calls `checkForUpdate`, compares majors (`crossesMajor`), and only then calls `upgrade`, which re-checks on its own. Nothing is forked. Asking upgradr for the option upstream is still open, for someone with access to its repository |
| `-v` for verbose (v1) | `-v` is `--version`; verbose is `--verbose` only | The workspace's version test already pinned `-v, --version` |

Commands beyond the plan's table, because each wraps a routed action and costs a few lines: `org edit`, `org delete`,
`invite pending` (`invite:list-pending`), and `invite list --org` (`organization:invite-list`). An explicit `--org`
widens `project list`, `invite list`, and `audit list` to the organization; a saved `org use` does not, so a listing
never hides what a person can see.

### Rule 13 decisions

| Routed action | Command | Why |
|---|---|---|
| `cli-token:list` | none | The Account page's job |
| `cli-token:revoke` | `logout` (own token only) | Revoking another machine is the Account page's job |
| `cli-auth:*` | `login` drives them | Browser hops and sign-in ingress |
| `notification:*` | none | The bell is a dashboard surface |
| `user:edit`, `project:settings-view` | none | The Account and settings pages |
| `me:view` | `whoami` | |
| `user:create`, `session:*`, `status`, `health`, `swagger`, `actions:permissions` | none | Sign-up, browser sessions, and introspection |

### Decisions the plan left open

- **The principal hook writes no refusal of its own beyond the 401.** v1's also enforced the runner wall; 2.0 has no
  runner, and the sandbox's run token will get its own middleware. A presented `hyp_cli_` token that does not
  authenticate is refused even on a public action (`status`), so a stale CLI learns it is signed out.
- **`cli-auth:approve` and `cli-auth:activate` are personal audit rows**: no project and no organization, so neither
  `audit:list` nor `organization:audit-list` lists a CLI sign-in. `targetType: "cli-token"`, `targetPath` the device name.
- **`credentials.json` drops v1's `runner` slot on load** (Zod strips unknown keys), so a v1 file keeps its sign-in
  and project and gains `organization: null`. `logout` clears the sign-in and keeps both selections.
- **`config.cliAuth.appUrl` is gone**: the dashboard origin is `config.frontend.url`, the same `FRONTEND_URL` every
  other dashboard link uses.
- **The version is `2.0.0`** in this change, so merging it releases. If the first release must wait for the npm
  check below, hold the merge or set a pre-release version first.

### Not verified here

- **npm's trusted publisher for 2.0.** The package and its publisher exist from v1, so the first run should inherit
  them; this was not checked from this change. The first run of `auto-release.yml` on `main` is the check — record
  the outcome here.
- `test-upgrade.sh` ran once in a disposable container before the PR (18 of 18). It installs globally, so elsewhere
  it runs in CI only, as CLI Upgrade.
