# AGENTS.md — Hypotenuse

Hypotenuse connects **coding agents running on people's own computers** to **Linear** as a Linear agent. Delegate an
issue to `@hypotenuse` (or mention it) and a coding agent — Claude Code, Codex, Gemini CLI, goose, OpenCode, or any
other [ACP](https://agentclientprotocol.com) agent — picks it up on a teammate's machine in a fresh git worktree,
streams its thinking, plan, and tool calls into the Linear agent session, opens a pull request, and answers. A
**manager** role writes PRDs and tickets and dispatches them to **worker** roles that implement them.

Three parts, one repository:

- a hosted **[Keryx](https://www.keryxjs.com/)** service (`backend/` + `frontend/`) that receives Linear's webhooks,
  holds every Linear credential, and routes work to runners — one Action class is simultaneously an HTTP endpoint,
  a CLI command, a background task, and an OAuth-protected MCP tool;
- the **`hypotenuse` CLI and daemon** (`cli/`), distributed on npm and as compiled binaries, which registers a
  machine as a runner, runs ACP agents in worktrees, and validates its own config;
- a shared wire contract (`protocol/`).

**This file is the working summary: the rules, the conventions, and enough architecture to find your way.** The map
is [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md). The reasoning behind each decision lives with the plan that
builds it, in [`docs/plans/`](./docs/plans/README.md). Every doc there ends in a **Learnings from the build** section,
and that is where to read before changing something load-bearing, and where to write when you learn something new.

> **Status:** being built, one phase at a time — see [`docs/plans/README.md`](./docs/plans/README.md) for which phases
> have shipped.
> The plumbing for users, projects, RBAC, audit, the frontend shell, and the operator CLI is ported from
> [ToolExec](https://github.com/arcadeai-labs/toolexec); distribution and self-upgrade are ported from
> [mcpx](https://github.com/arcadeai-labs/mcpx).

## Non-negotiable rules

1. **Tests required.** Every code addition ships with tests. Backend tests drive a **real booted server over HTTP**
   against an isolated test database — no mocks. Linear is **[finear](https://github.com/pmdroid/finear)**, booted in
   process; coding agents are the scripted fake ACP agent in `cli/__tests__/fixtures/`. Neither is a mock of *our*
   code: both speak the real wire protocol to it.
2. **JSDoc everywhere.** Every method and exported function has a JSDoc annotation/description.
3. **CRUD includes a paginated `list`.** Every CRUD action set includes a `list` action using Keryx's
   `paginationInputs({ defaultLimit: 25 })` / `paginate`, answering with a `pagination: { page, limit, total, pages }`
   envelope alongside the named collection.
4. **Keryx bugs go upstream.** If you hit a bug in **Keryx itself**, do **not** work around it. File an issue at
   [`actionhero/keryx`](https://github.com/actionhero/keryx/issues) with a minimal repro, then stop and surface it.
   The known one — Keryx handles a WebSocket connection's frames concurrently, so subscribe and unsubscribe can be
   applied out of order — is recorded in [`phase-08-runners.md`](./docs/plans/phase-08-runners.md); the daemon
   subscribes exactly once per connection, which is a design choice, not a workaround.
5. **finear gaps go upstream too.** finear is our Linear. When it lacks a behavior real Linear has (a mention in a
   comment starting a session, a structured `promptContext`, guidance, `client_credentials`), file it at
   [`pmdroid/finear`](https://github.com/pmdroid/finear/issues) and drive the behavior through finear's
   `/__test/*` control routes meanwhile. Never fake Linear behavior inside `backend/` to make a test pass. The open
   list is in [`docs/LINEAR_COVERAGE.md`](./docs/LINEAR_COVERAGE.md#known-finear-gaps).
6. **Every data-changing action is audited.** Any action that inserts, updates, or deletes extends `AuditedAction`
   and implements `runWithAudit(tx, params, connection)`, routing **every** write through `tx` and setting
   `connection.metadata.auditBefore` / `auditAfter` from `serializeX()` output. A new secret-bearing param means
   adding its key to `SENSITIVE_KEYS` in the same commit. The unaudited writers are a closed list, argued in
   [`phase-04-users-tenancy-and-audit.md`](./docs/plans/phase-04-users-tenancy-and-audit.md): reads, sweeps,
   `session:create` / `session:destroy`, `webhooks:linear` and `linear:process-event` (machine ingress, recorded in
   `linear_events`), the outbox and clocks, and the daemon half (`daemon:*`, recorded in `agent_activities` and
   `work_items`). The audited thing is always **the decision a person made** — connecting Linear, registering or
   revoking a runner, editing a routing rule, cancelling a session.
7. **Linear credentials never leave the server.** No action returns a Linear access token, refresh token, client
   secret, or webhook secret, and no serializer has a field one fits in. The daemon, the coding agent, and its MCP
   tools reach Linear only through `daemon:linear-*` actions, which re-derive their scope (installation, issue,
   role) from the agent session row on every call. That list is closed and asserted by name.
8. **Daemon actions and human actions are disjoint.** Runner-token actions live in `DAEMON_ONLY_ACTION_NAMES`
   (`daemon:*`) — do **not** filter by prefix alone, because the human ledger (`runner:list`, `runner:revoke`) is a
   different prefix on purpose and must stay that way. A `beforeAct` hook refuses every other action to a runner
   token (it carries its owner's `userId` and would otherwise pass membership for anything that person could do),
   and refuses `daemon:*` to a human session. If a daemon needs something a human action does, **duplicate it** as
   `daemon:*`. `daemon:*` and `webhooks:*` are never MCP tools.
9. **Human MCP ≈ HTTP.** Almost every action with a `web.route` is published as an MCP tool for human OAuth clients.
   `applyMcpToolPolicy` / `shouldPublishAsMcpTool` in `backend/ops/McpToolPolicyOps.ts` is the source of truth;
   `rbac.test.ts` asserts every action's live flag equals that function. **Never MCP:** login/signup,
   `webhooks:linear`, `linear:callback` (a browser hop), `daemon:*`, unauthenticated introspection (`status`,
   `swagger`, `actions:permissions`), clocks (`task.frequency > 0`), and anything with no `web.route`.
10. **Every Linear interaction is in the coverage matrix.** A new webhook, mutation, query, signal, or activity
    shape gets a row in [`docs/LINEAR_COVERAGE.md`](./docs/LINEAR_COVERAGE.md) in the same commit, naming the
    module that handles it and the test that proves it. `backend/__tests__/docs/linear-coverage.test.ts` asserts
    every row's test file exists and mentions the row's id.
11. **Never name a plan phase outside `docs/plans/`.** No comment, JSDoc block, test name, config note, or doc says
    "Phase 9" or "this phase". Say what a column, hook, or placeholder is *for* — "read by the routing clock, which
    does not exist yet" — because that stays true after the schedule is forgotten.
12. **User-facing docs ship with the feature.** Any change an operator or visitor can see or do — a settings
    section, a routing behavior, a config key, a CLI command, an RBAC rule — updates the markdown under
    `frontend/src/content/docs/` in the **same commit**. A new daemon config key also updates
    [`docs/CONFIG.md`](./docs/CONFIG.md) and the zod schema's `.describe()`; a wire change updates
    [`docs/RUNNER_PROTOCOL.md`](./docs/RUNNER_PROTOCOL.md) and bumps `PROTOCOL_VERSION` when it is not additive.
13. **The CLI tracks the operator HTTP surface.** A new action with a `web` route is a candidate for a
    `hypotenuse <noun> <verb>` command. In the same commit, either wrap it or decide it is out of scope. Out of scope
    by default: clocks, `daemon:*`, `webhooks:*`, `linear:callback`. A change to `cli/` that should reach users
    **bumps `cli/package.json` `version`**; merging to `main` releases it (npm + binaries + GitHub release).
14. **The plans are kept current, and only half of each one is.** Everything above a phase doc's
    `## Learnings from the build` heading is the **plan** — a historical record of what was going to be built. Leave
    it alone even when it is wrong. The learnings section is the opposite — it describes what is true *now* — and so
    does every doc that is not one of those plan sections: this file, the [plans index](./docs/plans/README.md),
    [`ARCHITECTURE.md`](./docs/ARCHITECTURE.md), [`RUNNER_PROTOCOL.md`](./docs/RUNNER_PROTOCOL.md),
    [`CONFIG.md`](./docs/CONFIG.md), [`LINEAR_COVERAGE.md`](./docs/LINEAR_COVERAGE.md),
    [`DESIGN.md`](./docs/DESIGN.md), and [`DEPLOY.md`](./docs/DEPLOY.md). A change that makes any of those wrong fixes them **in the same commit**.
    `backend/__tests__/docs/links.test.ts` resolves every relative link in `AGENTS.md`, `README.md`, and `docs/**`,
    and asserts every plan doc still carries the `## Learnings from the build` heading.
15. **A pull request is not the artifact.** A PR, issue, or comment is for a human who already has the diff. Keep it
    as short as it can be while still conveying the meaning. Load-bearing argument belongs in a code comment or a
    learnings section, not in the PR body. The same goes for what an agent writes into Linear: activities are for
    the person watching the session, and a `response` says what happened and where — not a file-by-file list.

16. **Paint with tokens, both themes.** Components use semantic tokens only — no color literals, no literal
    font sizes — and every surface is checked in light **and** dark. The look changes by changing an input in
    `design/tokens.ts`, never a generated file. Status is shown with the shared glyphs, an agent is always visibly
    an agent, and the CLI prints the same palette and glyphs. [`docs/DESIGN.md`](./docs/DESIGN.md) is the spec.

## Local development

**Always use the system's Postgres and Redis — never Docker, and never Docker Compose.** Docker is used only to build
deployment images.

```bash
brew services start postgresql@17 redis           # once per machine
createdb hypotenuse && createdb hypotenuse_test   # once per checkout

bun install
cd backend && cp .env.example .env
cd ../frontend && cp .env.example .env
```

One `.env` covers development and test: `loadFromEnvIfSet` checks `${VAR}_${NODE_ENV}` before `${VAR}`. If `$USER` is
unset (some containers), node-postgres cannot pick a role from `postgres://localhost/…` — put the user in the URL in
your local `.env`.

**finear** is fetched, not installed: `bun run --cwd backend finear:fetch` clones it at the commit pinned in
`backend/scripts/fetch-finear.ts` into `backend/.finear/` (gitignored), and `bun run test` in `backend/` does that
first. Bump the pin deliberately, in its own commit.
`bun run workspace:setup` gives a worktree its own test database, Redis index, and ports when several checkouts run
at once.

**Linear in development.** Tests never touch real Linear. To try the real thing, create a private Linear OAuth app
(see [`DEPLOY.md`](./docs/DEPLOY.md#create-the-linear-oauth-app)), run `bun run ngrok` for a public HTTPS URL (Linear
refuses localhost webhook URLs), and set `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, and `LINEAR_WEBHOOK_SECRET` in
`backend/.env`.

**A local runner against a local server:**

```bash
bun run --cwd cli hypotenuse login --url http://localhost:8080
bun run --cwd cli hypotenuse runner register --name dev-laptop
bun run --cwd cli hypotenuse config init && $EDITOR ~/.config/hypotenuse/config.toml
bun run --cwd cli hypotenuse config validate
bun run --cwd cli hypotenuse daemon start --foreground
```

## Stack

| Layer | Choice |
|---|---|
| Runtime / language | Bun + TypeScript (strict). No `npm`/`npx` in development — use `bun`/`bunx` |
| Hosted framework | Keryx (latest; actions, channels, tasks, MCP, OAuth 2.1) |
| Database | Postgres via Drizzle (`api.db.db`); migrations via `drizzle-kit`, applied by the worker |
| Cache / queue | Redis — sessions, rate limits, `node-resque`, WebSocket pub/sub, the Linear token bucket |
| Linear | GraphQL at `LINEAR_API_URL` (finear in tests), OAuth `actor=app`, signed webhooks |
| Coding agents | ACP over stdio via `@agentclientprotocol/sdk` (v2 API: `client()` / `connectWith()`) |
| Agent tools | A stdio MCP server, `hypotenuse mcp`, via `@modelcontextprotocol/sdk` |
| Daemon state | `bun:sqlite` at `~/.local/state/hypotenuse/state.db` |
| Validation / lint | Zod v4; Biome (`bun run lint` = `tsc && biome check .`) |
| Frontend | Vite + React 19 + React Router 7; ToolExec's UI-kit API, repainted by our own design system (LCH-generated tokens, light + dark, Inter, Lucide, `cmdk`) — see [`docs/DESIGN.md`](./docs/DESIGN.md) |
| CLI | commander; upgradr for self-upgrade; mcpx's logger, TTY detection, and shutdown registry |
| Distribution | npm `@arcadeai/hypotenuse` (a `--target bun` bundle, so Bun is required) + `bun build --compile` binaries for darwin/linux/windows × x64/arm64, `install.sh` / `install.ps1` |
| Deploy | Render, one blueprint, staging first |

## Action conventions

Ported unchanged from ToolExec. One class per file, grouped in a domain folder (`actions/runner/runner-register.ts`),
auto-discovered.

```ts
export class RunnerRegister extends AuditedAction {
  name = "runner:register";                      // CLI: bun keryx.ts runner:register --projectId 1
  description = "…";                             // the MCP tool description the model reads
  middleware = [RateLimitMiddleware, ProjectMemberMiddleware()];
  web = { route: "/runner", method: HTTP_METHOD.PUT };
  inputs = z.object({ /* Zod, every field .describe()d */ });
  async runWithAudit(tx, params, connection) { /* … */ }
}
```

- **HTTP verbs:** `PUT` = create, `GET` = read/list, `POST` = edit, `DELETE` = delete.
- **Responses are always a named object** (`{ runner }`, `{ runners, pagination }`), never a bare array.
- **Errors:** `TypedError({ message, type: ErrorType.* })`. Use `CONNECTION_ACTION_PARAM_VALIDATION` for input
  validation, never `ACTION_VALIDATION` (that maps to 500).
- **Anything a client must decide with, the server decides** (`standing`, `reserved`, a runner's `online`).
- **`ops/*.ts`** hold pure logic and `serializeX()` functions, which strip secrets and emit epoch-ms timestamps.
- **`secret(z.string())`** marks a credential-bearing input for redaction.
- **Side effects belong in `afterCommit`** — enqueueing `linear:process-event`, pinging `runner:<id>`, broadcasting
  to dashboard channels.
- **Clocks are task-only — never a `web` route.**
- **Machine ingress answers fast and works later.** `webhooks:linear` verifies, records, answers 200, and enqueues;
  it never calls Linear or touches routing inline. Linear gives 5 seconds and retries at 1 minute, 1 hour, and
  6 hours.
- **Everything written to Linear goes through the activity outbox**, with a client-generated UUID on each
  `agentActivityCreate`. Nothing calls `agentActivityCreate` directly from an action.
- **Redis Lua lives in `backend/lua/*.lua`**, loaded at boot by `initializers/redisScripts.ts`.

## Schema conventions

`serial` primary keys; **every timestamp column is `timestamp(..., { withTimezone: true })`**. Linear ids are `text`
(UUIDs), never coerced. Every table that mirrors a Linear object carries the Linear id under a unique index so a
replayed webhook is an upsert, not a duplicate.

## Tenancy and RBAC

A **project** is the tenant, and it connects at most one Linear workspace. Two gates, no role ladder, ported from
ToolExec's `backend/middleware/rbac.ts`:

| Level | Means | Middleware |
|---|---|---|
| `none` | session-scoped or public | — |
| `member` | holds a membership in `params.projectId` | `ProjectMemberMiddleware()` |
| `admin` | additionally holds the reserved `admin` tag | `AdminMiddleware()` |

Members register their own runners, see sessions, and cancel work; admins connect Linear, edit routing rules, manage
members, and revoke anyone's runner. `actions:permissions` reports every action's level, and the frontend's `can()`
is the only place UI gating decides. Removing a membership revokes that person's runners in the same transaction.

Three principals reach the API: a **browser session** (cookie), a **CLI token** (`hyp_cli_…`, issued after the
person approves the CLI in the dashboard; acts as that person, never on `daemon:*`), and a **runner token**
(`hyp_rt_…`; `daemon:*` only). `backend/middleware/session.ts` resolves exactly one per request.

## Architecture rules while writing code

The map is [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md). What follows is the part that is a **rule**:

- **Postgres is the source of truth; WebSocket frames are content-free pings.** A runner that misses a ping finds the
  work on its next heartbeat. A dashboard reconnect re-reads.
- **One non-terminal work item per agent session.** A turn ends in exactly one place (`WorkItemOps.finishWorkItem`, reached from `daemon:complete`, cancellation, and lease expiry), which
  releases the runner slot and settles the session's outbox.
- **A session is sticky to its runner** because its worktree lives there. Re-offering it elsewhere means a fresh
  worktree and replayed history, and is visible in the session as a thought.
- **History comes from activities, not comments.** Comments can be edited; activities are frozen.
- **Acknowledge within 10 seconds.** Every `created` session gets a server-emitted `thought` before routing, so a
  slow runner never makes the agent look unresponsive.
- **Respect disengagement.** `stop`, un-delegation, session dismissal, and an issue moving to a completed or canceled
  state each cancel the live turn, and nothing re-engages without a new prompt or delegation.
- **The daemon never holds a Linear token**, and the coding agent never sees the runner token: the MCP server
  reaches the server through the daemon's control socket.

## Testing

- **Backend:** `cd backend && bun test`. `buildTestUniverse()` seeds the ToolExec cast (Peach admin, Mario, Luigi,
  Toad, and Bowser the outsider) over real HTTP. `useFinear()` boots finear in process with an OAuth app whose
  webhook points at the test server, installs it with `actor=app`, and exposes finear's control routes.
- **CLI / daemon:** `cd cli && bun test` for unit tests; end-to-end suites in `backend/__tests__/e2e/` spawn the real
  `hypotenuse daemon` against the booted backend, finear, a temporary git origin, and the fake ACP agent.
- **Control time by writing columns or advancing finear's clock, never by waiting.**
- **Assert the property, not the symptom** — byte-identical refusal bodies, whole-set comparisons of allowlists,
  exact Linear activity sequences.
- **Docs are tested:** links, the Learnings heading, and the Linear coverage matrix.

## Commands

```bash
bun install                                   # root (workspaces)
bun dev                                       # backend :8080 + frontend :3000
bun run ngrok                                 # public URL for real Linear webhooks
bun run lint                                  # tsc + biome, every workspace
bun run test                                  # every workspace (not `bun test` at the root)

cd frontend && bun run theme:build            # regenerate tokens, mark, favicons, OAuth theme from design/tokens.ts
cd frontend && bun run test:e2e               # Playwright; PLAYWRIGHT_CHROMIUM_PATH for a preinstalled browser
cd frontend && bun run docs:illustrations     # light + dark screenshots (frontend running)
open http://localhost:3000/style-guide        # every primitive and fixture surface, both themes side by side
cd backend && bun run test                    # fetches finear, then real server + finear
cd backend && bun test path/to/file.test.ts   # one file (after a first `bun run finear:fetch`)
cd cli && bun test                            # CLI + daemon unit tests
bun run --cwd cli hypotenuse --help
bun run --cwd cli hypotenuse config validate -c ./examples/config.toml
cd cli && bun run build                       # compiled binary at dist/hypotenuse

curl localhost:8080/api/actions/permissions   # every action's RBAC level
```

## Working on this repository as an agent

Lessons from building it, kept here so the next session starts with them.

- **One phase, one PR.** Branch `phase-NN-<slug>` from `main`, build the phase, tick its Definition of done, write its
  **Learnings from the build**, and update this file and the live docs in the same PR. Each phase ends reviewable.
- **A mechanism described in two docs drifts.** Every review finding on the planning PR was one doc saying something
  another had already changed: the MCP token path in `ARCHITECTURE.md` against the MCP plan, or a lock rule in
  `CONFIG.md` against the daemon plan. When you change how something works, grep `docs/` for every place that
  describes it (`rg -n "<name>" docs AGENTS.md`) and fix them all in the same commit.
- **Enumerate every state.** A rule written as "if A and B, then X; if neither, then Y" leaves the two mixed cases
  undefined, and a reviewer will find them. Write state rules as a table with one row per combination.
- **Edit docs by exact anchor, never by first substring.** A script that finds `## Learnings from the build` by
  `str.index` matches the first mention, which may be inside a table, and silently truncates the doc. Anchor on
  `"\n## Heading\n"`, assert it occurs exactly once, and run `bun test __tests__/docs` in `backend/` after any
  scripted doc edit.
- **Sandboxed sessions:** GitHub's tarball API and settings APIs may be refused (finear is fetched with `git` for
  this reason; branch protection needs an admin); GitHub GraphQL may be unavailable (resolve review threads through
  the REST routes the error message names); `bun install` inside `docker build` may fail on an intercepting proxy
  (CI's Docker jobs are then the proof). Say so in the phase's learnings rather than working around a refusal.
- **Run every check locally before pushing — Bugbot reviews every push.** Each push to a PR starts a new review,
  and a finding means another round. Lint, the touched suites, and `bun test __tests__/docs` first; one validated push
  beats three speculative ones.
- **Green is not the same as right for anything a person looks at.** A self-referencing CSS variable sent every page
  to the browser's serif with lint, unit tests, build, and e2e all passing. Before opening a frontend PR, run
  `bun run docs:illustrations` (or open `/style-guide`) and look at both themes; then turn what you caught into a
  test.
- **Parallel sub-agents get disjoint files.** When a phase splits across forks in one worktree, name each fork's
  files explicitly, keep shared entry points (`App.tsx`, `package.json`, `app.scss`) with the parent, and let only
  the parent commit. Each fork checks its own files; the parent runs the whole suite once they land.
- **Signatures and footers** follow the repository owner's global rules for commits and PR text.

## Where the detail lives

| Topic | Doc |
|---|---|
| The system on one page | [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) |
| Server ⇄ daemon wire contract | [`docs/RUNNER_PROTOCOL.md`](./docs/RUNNER_PROTOCOL.md) |
| Daemon config file | [`docs/CONFIG.md`](./docs/CONFIG.md) |
| Every Linear agent feature and its test | [`docs/LINEAR_COVERAGE.md`](./docs/LINEAR_COVERAGE.md) |
| Design language, tokens, glyphs, the four signature surfaces | [`docs/DESIGN.md`](./docs/DESIGN.md) |
| Deploying the hosted service, creating the Linear app | [`docs/DEPLOY.md`](./docs/DEPLOY.md) |
| Build order and every plan | [`docs/plans/README.md`](./docs/plans/README.md) |
