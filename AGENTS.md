# AGENTS.md — Hypotenuse

Hypotenuse is **a persistent multiplayer, multichannel agent for your team**. It is headless: people reach it where they already work — **Slack** (company
chat), **Linear** (issues), and **Pylon** (customer support) — and it answers there, with its own identity, its own
tools, and its own memory. Many bots run in many conversations at once, across many tenants. When a task needs code,
a bot hands it to an **ephemeral sandbox** that clones the repository, does the work, opens a pull request, and
reports back into the conversation it came from.

> **Status:** the foundation, the deployment, and the design system are built — three Bun workspaces (`backend/`,
> `frontend/`, `cli/`), Postgres with pgvector, CI behind **CI Complete**, a Render blueprint with staging live at
> `api.hypotenuse.cloud` ([`docs/DEPLOY.md`](./docs/DEPLOY.md)), and the look: tokens, the UI kit, the app shell, the
> public site and `/docs`, and `/style-guide` ([`docs/DESIGN.md`](./docs/DESIGN.md)). People can sign up, and
> organizations, projects, members, invites, tags, and notifications work under ToolExec's RBAC with organization
> owners above it; every write is an `AuditedAction`. There are no bots yet. The build order and every plan are in
> [`docs/plans/README.md`](./docs/plans/README.md); the system on one page is
> [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md). Hypotenuse **v1** — local coding agents answering
> Linear agent sessions through a runner daemon — is archived on the
> [`v1` branch](https://github.com/arcadeai-labs/hypotenuse/tree/v1). Its plans, learnings, and code remain the
> reference for everything 2.0 ports from it.

**This file is the working summary: the rules, the workflow, the conventions, and enough of the planned
architecture to find your way.** The reasoning behind each decision lives with the plan that builds it, in
[`docs/plans/`](./docs/plans/README.md). Every plan ends in a **Learnings from the build** section: read it before
changing something load-bearing, and write to it when you learn something new.

## Where it comes from

| Source | What Hypotenuse takes |
|---|---|
| [ToolExec](https://github.com/arcadeai-labs/toolexec) | The project template: the Keryx backend, users, projects and memberships, tag-based RBAC, `AuditedAction` and the audit log, middleware, MCP tool policy, the frontend shell, the docs site, the operator CLI, the sandbox provider interface, the in-sandbox supervisor and its protocol, credential containment, human help |
| [Hypotenuse v1](https://github.com/arcadeai-labs/hypotenuse/tree/v1) | The design system and look, the Linear OAuth / webhook / activity-outbox stack and its finear harness, OpenTelemetry export, cost records, CLI distribution |
| [botholomew](https://github.com/evantahler/botholomew) | The tick, terminal tools, approvals that park and resume, progressive MCP disclosure, code mode with resumable continuations, prompt files and skills |
| [membot](https://github.com/evantahler/membot) | Versioned memory documents, chunking, hybrid semantic + keyword search with rank fusion, the memory tool surface |
| [Pi Durable](https://earendil.com/posts/pi-durable/) | Intent written before every effect, replay only what is safe, idempotency from durable ids, typed waits, background compaction |
| [Keryx](https://www.keryxjs.com/) | One Action class is an HTTP endpoint, a CLI command, a background task, and an OAuth-protected MCP tool |

## Non-negotiable rules

These bind from the first line of code. A rule that names a thing not built yet binds from the phase that builds it.

1. **Tests required.** Every code addition ships with tests. Backend tests drive a **real booted server over HTTP**
   against an isolated test database — no mocks of our own code. What we do not own is faked **in process, over its
   real wire protocol**: Linear is [finear](https://github.com/pmdroid/finear); Slack and Pylon are fakes we build
   from their published API schemas, signing their webhooks for real; the model is a scripted server speaking the
   provider's HTTP API, so the real AI SDK provider code runs; a sandbox's coding agent is a scripted CLI. None of
   those is a mock of Hypotenuse: each speaks the protocol to it.
2. **JSDoc everywhere.** Every method and exported function has a JSDoc annotation/description.
3. **CRUD includes a paginated `list`.** Every CRUD action set includes a `list` action using Keryx's
   `paginationInputs({ defaultLimit: 25 })` / `paginate`, answering with a `pagination: { page, limit, total, pages }`
   envelope alongside the named collection.
4. **Upstream bugs go upstream.** If you hit a bug in **Keryx itself**, do **not** work around it — not even with a
   one-line config change that would make it go away. File an issue at
   [`actionhero/keryx`](https://github.com/actionhero/keryx/issues) with a minimal repro, then **stop and surface
   it** to the person you are working for. The same holds for finear
   ([`pmdroid/finear`](https://github.com/pmdroid/finear/issues)) and for any fake we depend on but do not own:
   when it lacks a behavior the real platform has, file it and drive that behavior through the fake's test-control
   routes meanwhile — **never fake platform behavior inside `backend/` to make a test pass**. Record every filed
   issue, with its number and status, in this rule and in the learnings of the phase that hit it. Filed so far:
   none for 2.0. (v1 filed [actionhero/keryx#550](https://github.com/actionhero/keryx/issues/550), fixed in 0.48.1,
   and [#552](https://github.com/actionhero/keryx/issues/552), fixed by #553 in 0.48.2 — our floor.)
5. **Every data-changing action is audited.** Any action that inserts, updates, or deletes extends `AuditedAction`
   and implements `runWithAudit(tx, params, connection)`, routing **every** write through `tx` and setting
   `connection.metadata.auditBefore` / `auditAfter` from `serializeX()` output. A new secret-bearing param means
   adding its key to `SENSITIVE_KEYS` in the same commit. The unaudited writers are a **closed list**, argued in
   [`phase-05-audit-logging.md`](./docs/plans/phase-05-audit-logging.md), and this list and that table change
   together: reads and `actions:permissions`; `session:create` / `session:destroy`; `notification:mark-read`;
   clocks and sweeps; the CLI's sign-in ingress (`cli-auth:device` / `cli-auth:exchange`, a token's sliding
   expiry); machine ingress (`webhooks:*`, recorded in `trigger_events`) and its processing
   (`triggers:process-event`, `triggers:process-pending`, recorded in `trigger_events` and `conversation_inbox`);
   `agent:tick` and every tool a bot runs (recorded in `conversation_entries`); outbox delivery (`outbox_messages`);
   the sandbox's machine half (`sandbox:events` / `heartbeat` / `complete` and the in-sandbox tools, recorded in
   `sandbox_jobs` and `sandbox_job_events`); and `cost_records`. The audited thing is always **the decision a
   person made** — editing a bot, binding it to a channel, approving a tool call, answering a help request,
   granting a repository. A decision a platform participant makes in a channel (an approval clicked in Slack) is
   audited too, as `actorType: "participant"`.
6. **Credentials never leave the server.** No action returns a platform token, signing secret, model key, MCP
   server credential, or GitHub App key, and no serializer has a field one fits in. A sandbox holds exactly one
   credential — its run token — and reaches models, MCP servers, and git through server-side proxies and
   repository-scoped tokens minted per command. Code mode reaches nothing the bot could not reach as a tool.
7. **Machine principals and human principals are disjoint.** A sandbox run token may call only the closed
   `SANDBOX_ONLY_ACTION_NAMES` list, and a human may call none of them — enforced by a `beforeAct` hook, never by
   name prefix alone. If a sandbox needs something a human action does, **duplicate it** as `sandbox:*`.
8. **Human MCP ≈ HTTP.** Almost every action with a `web.route` is published as an MCP tool for human OAuth
   clients. `applyMcpToolPolicy` / `shouldPublishAsMcpTool` in `backend/ops/McpToolPolicyOps.ts` is the source of
   truth, and `rbac.test.ts` asserts every action's live flag equals it. **Never MCP:** login/signup, browser hops
   (OAuth callbacks, app installs), `webhooks:*`, `sandbox:*` machine actions and `sandbox:git-credential`,
   proxies, unauthenticated introspection, clocks (`task.frequency > 0`), and anything with no `web.route`.
9. **The platform's permissions decide who may talk to a bot; the project's RBAC decides who may run it.** Anyone
   who can post in a Slack channel, comment on a Linear issue, or write on a Pylon ticket where a bot is bound may
   address that bot about that place — Hypotenuse adds no second gate and links no identities. Configuring a bot,
   reading its transcripts, editing its memory, or binding it anywhere is gated by project RBAC, ToolExec's model:
   membership, tags as roles with the reserved `admin` tag, each bot's `accessRead` / `accessWrite` tag lists
   (`canReadBot` / `canWriteBot`), and an organization owner's admin standing in every project of the
   organization.
10. **Every platform interaction is in that platform's coverage matrix.** A new webhook, API call, signal, or
    interactive element gets a row naming the module that handles it and the test that proves it, in the same
    commit. A docs test asserts every row's test file exists and mentions the row's id.
11. **Never name a plan phase outside `docs/plans/`.** No comment, JSDoc block, test name, config note, or user doc
    says "Phase 9" or "this phase". Say what a column, hook, or placeholder is *for* — "read by the schedule clock,
    which does not exist yet" — because that stays true after the schedule is forgotten.
    `backend/__tests__/docs/no-phase-names.test.ts` enforces it over every source tree (builder docs — this file and `docs/` — may name phases).
12. **User-facing docs ship with the feature.** Any change an operator or visitor can see or do — a settings
    section, a bot capability, a platform behavior, an RBAC rule, a CLI command — updates the markdown under
    `frontend/src/content/docs/` in the **same commit**.
13. **The CLI tracks the operator HTTP surface.** A new action with a `web` route is a candidate for a
    `hypotenuse <noun> <verb>` command. In the same commit, wrap it or decide it is out of scope. Out of scope by
    default: clocks, `agent:tick`, `webhooks:*`, `sandbox:*` machine actions, browser hops. A change to `cli/` that
    should reach users bumps `cli/package.json` `version`; merging to `main` releases it.
14. **The plans are kept current, and only half of each one is.** Everything above a phase doc's
    `## Learnings from the build` heading is the **plan** — a historical record of what was going to be built. Leave
    it alone even when it is wrong; it is the only account of why the shipped thing differs. The learnings section
    is the opposite — it describes what is true *now* — and so does every doc that is not one of those plan sections:
    this file, the [plans index](./docs/plans/README.md), [`ARCHITECTURE.md`](./docs/ARCHITECTURE.md), and
    [`DESIGN.md`](./docs/DESIGN.md). A change that makes any of those wrong fixes them **in the same commit**. When a
    later change invalidates a whole learnings section rather than a sentence, add a note and a translation table at
    its top instead of rewriting it in place. `backend/__tests__/docs/links.test.ts` resolves every relative link and
    anchor and asserts every plan doc carries the `## Learnings from the build` heading.
15. **A pull request is not the artifact.** A PR, issue, or comment is for a human who already has the diff. Keep it
    as short as it can be while still conveying the meaning. Load-bearing argument belongs in a code comment or a
    learnings section, not in the PR body. The same goes for what a bot writes into Slack, Linear, or Pylon: status
    is for the person watching, and a reply says what happened and where — not a file-by-file list.
16. **Every change ships with proof of work.** A pull request shows that the change does what it says, in a form a
    reviewer can check without running it: for anything a person looks at, **screenshots in light and dark**,
    committed to the branch and embedded in the PR body; for anything else, the commands run and what they printed
    (the suites, a `curl` against the booted server, the CLI's output). "Tests pass" is not proof on its own — say
    which checks ran and show what they showed. A step that could not be run is named as not run, with why.
17. **Paint with tokens, both themes.** Components use semantic tokens only — no color literals, no literal font
    sizes — and every surface is checked in light **and** dark. The look changes by changing an input in
    `design/tokens.ts`, never a generated file. A bot is always visibly a bot. [`docs/DESIGN.md`](./docs/DESIGN.md)
    is the spec.

## Working on this repository

### Always start from the plan

1. **Find the phase.** Every change belongs to a phase in [`docs/plans/`](./docs/plans/README.md). Read its plan
   *and* its learnings — and the learnings of the phases it builds on — before writing code. If the change belongs
   to no phase, it is either a fix to a built phase (its learnings get the note) or a new phase (write the plan
   first, and get it reviewed).
2. **One phase, one PR.** Branch `phase-NN-<slug>` from `main`. Build the phase, tick its **Definition of done**,
   write its **Learnings from the build**, flip its status line and the [index](./docs/plans/README.md), and update
   this file and every live doc the change touches — all in the same PR. Each phase ends reviewable and deployable.
   Phase 01 halts for review before Phase 02.
3. **A mechanism described in two docs drifts.** When you change how something works, grep for every place that
   describes it (`rg -n "<name>" docs AGENTS.md`) and fix them all in the same commit.
4. **Enumerate every state.** A rule written as "if A and B, then X; if neither, then Y" leaves the two mixed cases
   undefined. Write state rules as a table with one row per combination — the conversation state machine most of
   all.
5. **Write down what you learn.** A trap, a platform quirk, a decision the plan left open: it goes in the phase's
   learnings the day you find it. A plan doc whose learnings stop at ship is one nobody can trust next time.

### Filing upstream

When Keryx, finear, or another dependency misbehaves (rule 4):

1. Reduce it to a minimal repro outside Hypotenuse.
2. File it upstream with the repro, the version, and what you expected.
3. **Stop** and tell the person you are working for, with the issue link. Do not land a workaround.
4. When it is fixed, raise our version floor in its own commit and add a regression test on our side.
5. Keep the list in rule 4 and the phase's learnings current.

### Pull requests

- Title says what changed, in plain words; the body is a few lines. Link the phase doc.
- The body carries the proof of work (rule 16): screenshots in both themes for a visible change, commands and their
  output for the rest. `bun run --cwd frontend docs:illustrations` captures the standard pages in both themes.
- Run every check locally before pushing — lint, the touched suites, and the docs test. Each push starts a new
  review; one validated push beats three speculative ones.
- Never skip, disable, or quarantine a test to get green. A flake is not a root cause.
- Merge `main` into a branch someone else owns; never rewrite their history.
- Commit messages and PR text follow the repository owner's global rules for signatures and footers.

### Code conventions

**Actions.** One class per file, grouped by domain (`actions/bot/bot-create.ts`), auto-discovered.

```ts
export class BotCreate extends AuditedAction {
  name = "bot:create";                         // CLI: bun keryx.ts bot:create --projectId 1
  description = "…";                           // the MCP tool description the model reads
  middleware = [RateLimitMiddleware, ProjectMemberMiddleware()];
  web = { route: "/project/:projectId/bot", method: HTTP_METHOD.PUT };
  inputs = z.object({ /* Zod, every field .describe()d */ });
  async runWithAudit(tx, params, connection) { /* … */ }
}
```

- **HTTP verbs:** `PUT` = create, `GET` = read/list, `POST` = edit, `DELETE` = delete.
- **Responses are always a named object** (`{ bot }`, `{ bots, pagination }`), never a bare array.
- **Errors:** `TypedError({ message, type: ErrorType.* })`. Use `CONNECTION_ACTION_PARAM_VALIDATION` for input
  validation, never `ACTION_VALIDATION` (that maps to 500). An error a model will read names its next move.
- **Anything a client must decide with, the server decides** — a conversation's state, a bot's readiness.
- **`ops/*.ts`** hold pure logic and `serializeX()` functions, which strip secrets and emit epoch-ms timestamps.
  Helpers live in `ops/`, never in `actions/` (Keryx instantiates every export there).
- **`secret(z.string())`** marks a credential-bearing input for redaction.
- **Side effects belong in `afterCommit`** — enqueueing a tick, delivering the outbox, broadcasting to a channel.
- **Clocks are task-only — never a `web` route.** A clock re-enqueues itself after every run, so a per-item task
  is never reused as a clock; sweeps get their own `*-due` action.
- **Machine ingress answers fast and works later.** `webhooks:*` verifies the raw body, records a
  `trigger_events` row, answers 200, and enqueues. It never calls a platform or runs a model inline.
- **Everything written to a platform goes through the outbox**, with an idempotency key on each write.
- **Model-facing tools are `snake_case`** (`memory_search`, `mcp_exec`, `run_code`); Keryx actions are
  `noun:verb`.

**Schema.** Drizzle in `backend/schema/`; `serial` primary keys; **every timestamp column is
`timestamp(..., { withTimezone: true })`**. A row that mirrors something on a platform carries `type` and keeps that
platform's ids in `external*` columns (`externalChannelId`, `externalThreadId`, `externalUserId`) under a unique
`(type, external id)` index, so a replayed webhook is an upsert. `user_id` / `userId` always means a Hypotenuse user;
a platform sender is a `participants` row. External ids are `text`, never coerced. Ledger rows (cost, events) carry
copied ids rather than foreign keys, so they never take part in a lock.

**Locking.** The real guard is a `SELECT … FOR UPDATE` re-check, never the cheap early-out before it. Lock in one
order everywhere: conversation, then its sandbox jobs, then anything else. `FOR UPDATE` on a row that does not
exist locks nothing — `INSERT … ON CONFLICT DO NOTHING`, then lock.

## Local development

**Use the system's Postgres (with the `pgvector` extension) and Redis — never Docker or Docker Compose for them.**
Docker is used only to build deployment images and as the development **sandbox provider**.

```bash
brew install postgresql@18 pgvector redis        # once per machine
brew services start postgresql@18 redis
createdb hypotenuse && createdb hypotenuse_test  # once per checkout
bun install
cp backend/.env.example backend/.env && cp frontend/.env.example frontend/.env
bun run workspace:setup                          # only in a second checkout; see below
bun run lint && bun run test
bun dev                                          # backend :8080, frontend :3000
```

- **`bun run test` at the root, never `bun test`.** Bun's own runner shadows the script, skips each workspace's
  `bunfig.toml` (the backend's preloads the test harness), and runs every suite in one process.
- **The backend's tests boot a real server** against `hypotenuse_test` and Redis database 1, each file on a random
  free port. Migration 0000 creates the `vector` extension, and `GET /api/status` is unhealthy without it.
- **Several checkouts at once** (agent worktrees, Conductor, Orca) would truncate each other's test database.
  `bun run workspace:setup` gives a linked worktree its own test database, Redis index, and e2e ports, writes
  them into `.env`, and pins them as `HYPOTENUSE_WORKSPACE_ID`; `--dry-run` prints the plan, `--shared` opts out.
  A single clone skips it.
- **The browser suite boots its own backend** against `hypotenuse_e2e` (created on first run) and Redis database 2.
  Two checkouts running it at once share that database unless one sets `E2E_DATABASE_URL`.

## Planned stack

| Layer | Choice |
|---|---|
| Runtime / language | Bun + TypeScript (strict). No `npm`/`npx` in development — use `bun`/`bunx` |
| Hosted framework | Keryx ≥ 0.48.2 (actions, tasks, channels, MCP server, OAuth 2.1) |
| Database | Postgres via Drizzle, with `pgvector`; migrations via `drizzle-kit`, applied by the worker |
| Cache / queue | Redis — sessions, rate limits, `node-resque` task queues, WebSocket pub/sub, leases |
| Models | Vercel AI SDK (`ai`) — the provider and model are chosen per bot; `embed()` for memory |
| MCP | Keryx serves our MCP; `@modelcontextprotocol/sdk`'s client consumes the shared MCP servers |
| Code mode | QuickJS compiled to WebAssembly, inside the worker, with a curated host API |
| Sandboxes | ToolExec's `SandboxProvider` interface: Docker (development, CI), then Vercel (production) |
| Validation / lint | Zod v4; Biome |
| Frontend | Vite + React 19 + React Router 7; v1's design system (LCH tokens, light + dark, Inter, Lucide) |
| CLI | commander, as an operator client over HTTP; npm `@arcadeai/hypotenuse` + compiled binaries |
| Deploy | Render, one blueprint (api, worker, frontend, Redis, Postgres), staging first |

## Planned architecture

[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) is the map. The parts that are **rules**:

- **The data model.** Organization → Project → Bots, Channels, Conversations. A project also holds its global
  memory, shared MCP servers, shared skills, model connections, and platform installs. A **bot** has prompts, an
  identity (its own Slack app and Linear app), goals, and a model; it is attached to the project's shared skills
  and MCP servers. A **channel** is a memory boundary — a Slack channel, a Linear project (its team when the issue
  has none), a Pylon customer account. A **conversation** is one thread of work inside a channel — a Slack thread,
  a Linear agent session, a Pylon issue.
- **Postgres is the source of truth; the loop holds nothing in memory.** Every message, model step, and tool call
  is a `conversation_entries` row. Each `agent:tick` task leases a conversation, hydrates its history from those
  rows, takes one step, stores the result, and enqueues the next tick or parks. Any worker can run any tick; Keryx
  queues fan the load out.
- **Intent before effect.** A tool call is written before it runs. A call with an intent and no result was
  interrupted: it re-runs only if the tool is replay-safe, and otherwise the model is told it was interrupted.
- **A conversation is `working`, `hibernating`, `waiting`, or `ended`.** `waiting` always names what it waits on
  (an answer, an approval, a sandbox, a timer). A tick ends in a terminal tool; a model that stops without one is
  nudged once, then the turn fails. A tick never ends silently.
- **Memory has two scopes and decays.** Channel memory belongs to one channel and fades with disuse; project memory
  is shared by every bot and channel in the project and fades slowly. Facts are promoted from channel to project
  with their provenance.
- **Tools are disclosed progressively.** A bot sees `mcp_search` / `mcp_info` / `mcp_exec`, not every tool of every
  server; calls outside its allowlist need an approval, which parks the conversation until a person decides.
- **Code mode is a tool, not an escape hatch.** `run_code` runs TypeScript in a WASM sandbox whose host API is
  memory and MCP, through the same permission and approval gate as the direct tools. A gated call inside a program
  suspends it; approval resumes the same program, never a regenerated one.
- **Platforms are adapters.** Each implements verify, parse, send, and the interactive surface — status, streamed
  text, plan steps, questions, approvals, escalation — with the richest elements that platform offers.
- **Code work happens in sandboxes, never on the host.** A sandbox job belongs to the conversation that started it,
  reports status and asks questions back into it, and wakes it when it finishes.
- **WebSocket frames are content-free pings.** The dashboard re-reads over HTTP; a reconnect re-reads.

## Lessons carried forward

From v1 and ToolExec, each paid for once already:

- **Keryx validates params before `beforeAct` hooks,** and reports a schema failure by the param's first path
  segment.
- **Keryx instantiates every exported function under `actions/` and `initializers/`.**
- **A clock gets queue locks and re-enqueues itself after every run** — including a run enqueued with params.
- **No retry is applied to tasks by default.** A thrown job lands in Resque's failed queue; durability is ours.
- **Redis outlives `clearDatabase()`, and ids restart.** Anything keyed by a row id must be cleared with the tables.
- **Delivery after a claim is at-most-once.** Never replay a step that may have had side effects; re-read a lost
  claim rather than re-claim it.
- **A failed wait is not an error.** Answer `pending` or `timedOut` with a sentence a model can act on.
- **Webhook ingress:** verify the signature over the raw body, answer within the platform's clock (Slack 3 s,
  Linear 5 s), dedupe on the platform's delivery id, give byte-identical refusals, and never rate-limit a platform's
  deliveries into failures.
- **Linear:** a `created` agent session needs an activity within 10 seconds; nothing may follow an `elicitation`;
  never write a literal mention of the app; revoking any token of an `actor=app` install uninstalls it.
- **A refusal that must be byte-identical cannot be a `TypedError`** — its envelope carries a timestamp.
- **Edit docs by exact anchor, never by first substring,** and run the docs test after any scripted doc edit.
- **Parallel sub-agents get disjoint files;** the parent owns shared entry points and makes the commit.
- **Green is not the same as right for anything a person looks at.** Look at both themes before opening a frontend
  PR, then turn what you caught into a test.

## Commands

```bash
bun install
bun run lint             # tsc + biome in backend, frontend, and cli
bun run test             # every workspace's suites; the backend's need Postgres (with pgvector) and Redis
bun run test:e2e         # the browser suite (Playwright; boots the backend on hypotenuse_e2e and the Vite dev server)
bun dev                  # the backend on :8080 and the frontend on :3000
bun run workspace:setup  # give this checkout its own test database and Redis index
bun run ngrok            # the reserved public tunnels to the local backend and frontend

cd backend && bun run migrations     # generate a migration from schema/ changes, then `bun run format`
cd cli && bun run build              # compile dist/hypotenuse
cd frontend && bun run theme:build   # regenerate every design/tokens.ts output after changing an input
cd frontend && bun run docs:illustrations  # light + dark screenshots, with `bun dev` running
```

The docs tests run in the backend suite: every relative link and anchor in `AGENTS.md`, `README.md`, and `docs/`
resolves, every plan carries `## Learnings from the build`, and no source tree names a plan phase.

## Where the detail lives

| Topic | Doc |
|---|---|
| The system on one page | [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) |
| Build order, status, and every plan | [`docs/plans/README.md`](./docs/plans/README.md) |
| Design language, tokens, glyphs | [`docs/DESIGN.md`](./docs/DESIGN.md) |
| Deploying staging on Render, platform webhook URLs | [`docs/DEPLOY.md`](./docs/DEPLOY.md) |
| Hypotenuse v1, archived | [`v1` branch](https://github.com/arcadeai-labs/hypotenuse/tree/v1) |
