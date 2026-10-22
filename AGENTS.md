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
   Filed so far: Keryx handled a WebSocket connection's frames concurrently, so subscribe and unsubscribe
   could apply out of order — is [actionhero/keryx#550](https://github.com/actionhero/keryx/issues/550), fixed in
   Keryx 0.48.1, which is our floor; `project-notifications.test.ts` holds the regression test; and
   [actionhero/keryx#552](https://github.com/actionhero/keryx/issues/552), open — a malformed or empty JSON body
   escapes the web server as Bun's own 500 and leaks a `Connection` (the CLI sends a JSON content type only with a
   body).
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
   `session:create` / `session:destroy`, `webhooks:linear` and `triggers:process-event` (machine ingress, recorded in
   `trigger_events`), `cli-auth:device` / `cli-auth:exchange` and a CLI token's sliding-expiry touch (the CLI's
   sign-in ingress — the person's `cli-auth:approve` / `cli-auth:activate` is the audited decision), the outbox and
   clocks, and the daemon half (`daemon:*`, recorded in `agent_activities` and
   `work_items`) — save `daemon:dispatch`, which writes an `agent:dispatch` row through `writeAuditLog` because it
   delegates work to the app on a person's issue. The audited thing is always **the decision a person made** — connecting Linear, registering or
   revoking a runner, editing a routing rule, cancelling a session.
7. **Linear credentials never leave the server.** No action returns a Linear access token, refresh token, client
   secret, or webhook secret, and no serializer has a field one fits in. The daemon, the coding agent, and its MCP
   tools reach Linear only through `daemon:linear-*` actions, which re-derive their scope (integration, issue,
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
   `webhooks:linear`, `linear:callback` and `cli-auth:approve` / `cli-auth:activate` (browser hops),
   `cli-auth:device` / `cli-auth:exchange` (the CLI's sign-in ingress, which returns a token), `daemon:*`, unauthenticated introspection (`status`,
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
- **Side effects belong in `afterCommit`** — enqueueing `triggers:process-event`, pinging `runner:<id>`, broadcasting
  to dashboard channels.
- **Clocks are task-only — never a `web` route.**
- **Machine ingress answers fast and works later.** `webhooks:linear` verifies, records, answers 200, and enqueues;
  it never calls Linear or touches routing inline. Linear gives 5 seconds and retries at 1 minute, 1 hour, and
  6 hours.
- **Everything written to Linear goes through the activity outbox**, with a client-generated UUID on each
  `agentActivityCreate`. Nothing calls `agentActivityCreate` directly from an action.
- **Redis Lua lives in `backend/lua/*.lua`**, loaded at boot by `initializers/redisScripts.ts`.

## Schema conventions

`serial` primary keys; **every timestamp column is `timestamp(..., { withTimezone: true })`**.

**Triggers are typed; Linear is the first.** Every row that mirrors something in a trigger system carries `type`
(`TRIGGER_TYPES` in `schema/integrations.ts`) and keeps that system's ids in `external*` columns —
`externalSessionId`, `externalIssueId`, `creatorExternalUserId`, `externalUserId` — never `linear*`. `user_id` /
`userId` always means a Hypotenuse user. External ids are `text`, never coerced, and every mirroring table carries
`(type, external id)` under a unique index so a replayed webhook is an upsert, not a duplicate. A project's
connection to a trigger system is an `integrations` row (one per project and type), reached through the generic
`integration:*` actions; what only one type has lives in its `details`. Linear's own endpoints keep Linear's name
(`webhooks:linear`, `linear:callback`, `linear:manifest-url`, the GraphQL client in `ops/LinearOps.ts`).

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
(`hyp_rt_…`; `daemon:*` only). `backend/middleware/session.ts` resolves exactly one per request, in a `beforeAct`
hook: a cookie session wins; a live `hyp_cli_` bearer sets the person's `userId` in memory only, never in a Redis
session; a presented token that does not authenticate gets one 401 whatever the reason.

## Architecture rules while writing code

The map is [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md). What follows is the part that is a **rule**:

- **Postgres is the source of truth; WebSocket frames are content-free pings.** A runner that misses a ping finds the
  work on its next heartbeat. A dashboard reconnect re-reads.
- **A change to a turn tells the dashboard through `WorkEffects.sessions`.** Anything that writes a work item adds its
  session there, and `applyEffects` publishes `project:<id>:sessions` after commit. A turn that cannot be placed
  records why as a sentence and a code (`waitingCode`); the codes are `routing-rule:preview`'s, and both come from
  `RoutingOps.evaluateRunners`, which must keep `eligibleRunners`' conditions one for one (a test holds them).
- **One turn under way per agent session** (a partial unique index over `offered`, `claimed`, `running`). A turn ends in exactly one place (`WorkItemOps.finishWorkItem`, reached from `daemon:complete`, cancellation, lease expiry, and the queue timeout), which
  releases the runner slot and answers the session if the turn did not.
- **Lock a session before its work items, and both before a runner row.** Cancellation starts from the session and
  a daemon's writes from an item; any other order deadlocks a Stop against a running turn. Lock an item with
  `WorkItemOps.lockItemWithSession`. A dispatch locks the worker's session, then its manager's — before writing the
  child's parent column, whose key-share lock two dispatches would otherwise both try to upgrade.
- **Dispatch is one level deep, and a review is a turn, not a prompt.** A manager's `hypotenuse_dispatch` makes a
  worker child (`parentAgentSessionId`); its turns that end come back as `review` work items on the manager, their
  input in `work_items.payload`. A change request is a `prompt` item on the worker's own session with a visible
  thought. A cancelled worker turn, or one that ended on a question, wakes no review: that would re-engage what a
  person stopped or is answering.
- **A question mid-turn is answered in the turn.** A held turn that posts an `elicitation` is marked awaiting an
  answer; the person's next follow-up is appended to that item's `answers` (`WorkItemOps.answerWaitingTurn`) and
  delivered by heartbeat, not queued. Whatever the daemon does not report in `answersConsumed` becomes the next
  `prompt` turn when the item ends or is requeued (`releaseAnswers`) — except after a stop.
- **The agent host owns the ACP SDK through one module.** `cli/src/acp/connection.ts` is the only importer of
  `@agentclientprotocol/sdk` (pinned exactly); everything else imports its types from there.
- **A session is sticky to its runner** because its worktree lives there. Re-offering it elsewhere means a fresh
  worktree and replayed history, and is visible in the session as a thought.
- **History comes from activities, not comments.** Comments can be edited; activities are frozen.
- **Acknowledge within 10 seconds.** Every `created` session gets a server-emitted `thought` before routing, so a
  slow runner never makes the agent look unresponsive.
- **Respect disengagement.** `stop`, un-delegation, session dismissal, and an issue moving to a completed or canceled
  state (or being deleted) each cancel the live turn, and nothing re-engages without a new prompt or delegation.
  The ones where the person stepped away (`DISENGAGED_CANCEL_REASONS`) are silent **on the server**: later events
  are dropped and the turn's end posts no fallback, whatever the daemon does.
- **Issue hygiene is the server's, at claim.** `ops/IssueHygieneOps.ts` moves a person's delegation to started and
  sets a missing delegate; it never touches the assignee, never fails a claim, and no daemon gets `issueUpdate`.
- **A worktree is removed only when the safety rules allow** (`cli/src/worktree/cleanup.ts`): never one in use;
  uncommitted changes, unpushed commits, and a `.hypotenuse-keep` file keep it unless `--force`; branches go with
  `git branch -d`, never `-D`. Hypotenuse never stashes, resets, or cleans a person's checkout.
- **The daemon never holds a Linear token**, and the coding agent never sees the runner token: the MCP server
  reaches the server through the daemon's control socket.

## Testing

- **Backend:** `cd backend && bun test`. `buildTestUniverse()` seeds the ToolExec cast (Peach admin, Mario, Luigi,
  Toad, and Bowser the outsider) over real HTTP. `useFinear()` — called after the file's `buildTestUniverse()`
  `beforeAll` — boots finear in process with this server's OAuth client (the `LINEAR_*_TEST` values) registered
  against the server's real callback and webhook URLs, points `config.linear` at it, and exposes finear's control
  routes. `linear.install(projectId, sessionId)` drives connect → finear's consent screen → callback. finear sits
  behind a small proxy that records every request (with its variables) and can stamp Linear's rate-limit headers,
  answer one request `RATELIMITED`, or lose one response — the things finear does not do. It also stands in for
  finear's missing documents (validated against Linear's full schema first) and takes `createAsUser` off an
  `issueCreate`, which finear refuses. Every Linear call goes through
  `ops/LinearOps.ts` `linearRequest`, with documents in `ops/linear/operations.ts`, each executed against finear in
  `linear-ops.test.ts`. finear signs and delivers webhooks to the server for real; `__tests__/linear/inject.ts`
  signs what finear cannot send, typed with `@linear/sdk/webhooks`. Suites run processing and the outbox in-process
  with `settle()` (`__tests__/linear/sessions.ts`); `ack.test.ts` alone starts a real Resque worker, to measure the
  acknowledgement as deployed.
- **CLI / daemon:** `cd cli && bun test` for unit tests; `backend/__tests__/cli/` spawns the real CLI against the
  booted server, approving its sign-in over HTTP as a test user; `cli/test/e2e/test-upgrade.sh` installs the branch
  by npm, bun, and binary (it installs globally — CI or a throwaway machine only); `backend/__tests__/daemon/`
  spawns the real `hypotenuse daemon --foreground` against the booted backend and finear, in a temporary home
  with its own config, credentials, state, and a git clone, sometimes through `daemon/proxy.ts` — a recording
  HTTP + WebSocket proxy that can make the server vanish and come back. `HYPOTENUSE_MACHINE_ID` gives each such
  daemon its own machine. Its coding agent is the fake ACP agent (`cli/__tests__/fixtures/fake-acp-agent.ts`), a
  real ACP agent on the SDK's agent side playing a JSON scenario from `fixtures/scenarios/` (`FAKE_ACP_SCENARIO`)
  and recording every request it receives (`FAKE_ACP_RECORD`); `cli/__tests__/acp/` drives the agent host against
  it directly. No test in CI launches a real coding agent.
- **Control time by writing columns or advancing finear's clock, never by waiting.** A test that advances
  finear's clock aligns `webhookClock` (`ops/LinearWebhookOps.ts`) to it, or the server refuses finear's
  deliveries as replays.
- **Redis outlives `clearDatabase()`, and ids restart.** Anything keyed by a row id (a token bucket, a lease, a
  queued job, a dispatch reservation) must be cleared with the tables; `buildTestUniverse()` does it for the Linear,
  runner, and dispatch keys and the queue.
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
cd backend && bun keryx.ts linear:manifest-url  # the pre-filled Linear app-creation link (APPLICATION_URL must be public HTTPS)
cd backend && bun keryx.ts integrations:refresh-tokens # run the token refresh clock once
cd cli && bun test                            # CLI + daemon unit tests
cd backend && bun test __tests__/daemon       # the real daemon against the real server and finear
bun run --cwd cli hypotenuse --help
bun run --cwd cli hypotenuse -c ./examples/config.toml config validate --offline
bun run --cwd cli hypotenuse config schema > frontend/public/schemas/config-v1.json   # after a schema change
bun run --cwd cli hypotenuse doctor
bun run --cwd cli hypotenuse worktrees list                # and `worktrees cleanup --dry-run`
cd cli && bun run build                       # compiled binary at dist/hypotenuse
cd cli && bun run bundle                      # the npm bundle at dist/hypotenuse.js (prepack runs it)
bash cli/test/e2e/test-upgrade.sh             # npm + bun + binary installs, globally — CI or a throwaway box

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
  the parent commit. Each fork checks its own files; the parent runs the whole suite once they land. Suites running
  at once on one `hypotenuse_test` fail each other: give each its own `DATABASE_URL_TEST` and `REDIS_URL_TEST`.
- **Keryx validates params before `beforeAct` hooks.** The principal hook — and with it the daemon/human wall —
  only sees a request whose params already passed the action's schema; a test sweeping the registry through the
  wall must send valid params.
- **Keryx instantiates every exported function with a prototype under `actions/`**, not only classes. Helpers
  shared by actions live in `ops/`.
- **A daemon test waits on what crosses a process, never on a timer of ours.** Spawn the daemon, then poll the
  database or its log (`DaemonHome.waitForLog`, `until`); move leases by writing columns and running `work:reap`.
  A CLI process that holds a socket or timer open never exits — close every connection on every outcome.
- **A refusal that must be byte-identical cannot be a `TypedError`.** Keryx's error envelope carries a timestamp,
  and middleware can only throw. The agent tools' scope middleware records its verdict on the connection and the
  action answers the fixed 403 itself (`notPermittedResponse`).
- **Nothing may follow a question in a Linear session.** Linear derives the session's state from its last activity,
  so a thought or an action after an `elicitation` takes it out of `awaitingInput`. A turn that asked with
  `linear_ask_user` emits no further activity — not even a timeout's or a drain's stop message; only the
  person's own Stop is answered.
- **Keryx reports a schema failure by the param's first path segment.** When a caller must know which element of
  an array was refused (`daemon:events`), validate the elements in the action.
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
