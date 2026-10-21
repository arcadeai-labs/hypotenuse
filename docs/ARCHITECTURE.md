# Architecture

Hypotenuse connects coding agents that run on people's own computers — Claude Code, Codex, Gemini CLI, goose,
OpenCode, and anything else that speaks the [Agent Client Protocol](https://agentclientprotocol.com) — to
[Linear](https://linear.app/developers/agents) as a Linear **agent**. A person delegates an issue to
`@hypotenuse`, or mentions it in a comment, and a coding agent on a teammate's machine picks the work up in a
fresh git worktree, reports its thinking, plan, and tool calls back into the Linear agent session, opens a pull
request, and answers.

This document is the map: the processes, the tables, the state machines, the wire contract between them, and
where every credential lives. It describes the system **as designed and, once built, as it stands** — it is a
live document under rule 14 of [`AGENTS.md`](../AGENTS.md), not a plan. The reasoning behind each piece lives
with the plan that builds it, in [`plans/`](./plans/README.md); the last section here points at the right one.

Companion references:

- [`RUNNER_PROTOCOL.md`](./RUNNER_PROTOCOL.md) — the exact server ⇄ daemon contract.
- [`CONFIG.md`](./CONFIG.md) — every key in the daemon's config file.
- [`LINEAR_COVERAGE.md`](./LINEAR_COVERAGE.md) — every Linear agent feature, where it is handled, which test
  proves it.
- [`DEPLOY.md`](./DEPLOY.md) — the hosted service's runbook.
- [`DESIGN.md`](./DESIGN.md) — the design language: Linear-native, light and dark, and the four signature surfaces.

## The whole thing on one page

```
        Linear (one OAuth app: @hypotenuse, installed per workspace with actor=app)
            │  webhooks (AgentSessionEvent, PermissionChange, OAuthApp, Issue, …)
            │  ▲ GraphQL (agentActivityCreate, agentSessionUpdate, issueUpdate, …)
            ▼  │
   ┌──────────────────────────────────────────────────────────────────────────────┐
   │  hypotenuse-api                         WEB_SERVER=on   TASKS=off            │
   │  Keryx actions: HTTP + WebSocket + MCP. Holds every Linear token.            │
   │  /api/webhooks/linear   /api/*   /mcp   ws://… (dashboard + runner pings)    │
   └──────────────────────────────────────────────────────────────────────────────┘
            │                                   │
            ▼                                   ▼
   ┌──────────────────────────┐   ┌────────────────────────────────────────────┐
   │ Postgres                 │   │ Redis                                      │
   │ the source of truth for  │   │ sessions, rate limits, node-resque queues, │
   │ integrations, sessions,  │   │ WebSocket pub/sub, the Linear token bucket │
   │ activities, work, runners│   │                                            │
   └──────────────────────────┘   └────────────────────────────────────────────┘
            ▲                                   ▲
   ┌──────────────────────────────────────────────────────────────────────────────┐
   │  hypotenuse-worker                      WEB_SERVER=off  TASKS=on             │
   │  processes webhook events, routes work, drains the activity outbox,          │
   │  refreshes Linear tokens, expires leases, sends keepalives. Runs migrations. │
   └──────────────────────────────────────────────────────────────────────────────┘
            ▲  HTTPS (runner token)  +  WebSocket ping channel runner:<id>
            │
   ┌──────────────────────────────────────────────────────────────────────────────┐
   │  hypotenuse daemon      (a person's laptop or a build box; one per machine)  │
   │  claims work → creates a git worktree → spawns an ACP agent → maps its       │
   │  session/update stream to protocol events → posts them to the server         │
   │                                                                              │
   │   ┌────────────────────────┐  stdio JSON-RPC  ┌───────────────────────────┐  │
   │   │ ACP agent subprocess   │◄────────────────►│ ACP client (daemon)       │  │
   │   │ claude-agent-acp,      │                  │ fs/*, permissions, cancel │  │
   │   │ codex-acp, gemini --acp│                  └───────────────────────────┘  │
   │   │      │ stdio MCP       │                                                 │
   │   │      ▼                 │                                                 │
   │   │ hypotenuse mcp         │── control socket ─► daemon ─► daemon:linear-*   │
   │   └────────────────────────┘                                                 │
   └──────────────────────────────────────────────────────────────────────────────┘

        browser (React dashboard)  ·  hypotenuse CLI (operator commands)
```

Three deployable things, one repository:

| Workspace | Ships as | What it is |
|---|---|---|
| `backend/` | Docker image, two Render services (`hypotenuse-api`, `hypotenuse-worker`) | Keryx app: Linear ingress, routing, the activity outbox, users/projects/RBAC, the runner-facing API |
| `frontend/` | Docker image (nginx) | React dashboard and public `/docs` |
| `cli/` | npm `@arcadeai/hypotenuse` **and** six compiled binaries on GitHub Releases | The `hypotenuse` command: operator CLI, the daemon, the stdio MCP server, config validation, self-upgrade |
| `protocol/` | Bundled into `cli/`, imported by `backend/` | Zod schemas for every server ⇄ daemon message. The one place the wire contract is written |

## Trust boundaries and credentials

**Linear credentials never leave the server.** The daemon, the coding agent, and the agent's MCP tools all
reach Linear through server actions that are scoped to one session's issue and one integration, and that are
a closed allowlist. A compromised laptop can act on the issues it was handed work for, for as long as its
runner token lives — not on the workspace.

| Credential | Lives | Minted by | Scope | Revoked by |
|---|---|---|---|---|
| Linear access + refresh token (`actor=app`) | `integrations`, AES-256-GCM via `ops/CryptoOps.ts` | Linear OAuth callback | the workspace's teams the admin granted | `integration:disconnect`, `OAuthApp revoked` webhook |
| Linear webhook signing secret | env `LINEAR_WEBHOOK_SECRET` | Linear app settings | verifies every inbound delivery | rotate in Linear + env |
| Linear OAuth client secret | env `LINEAR_CLIENT_SECRET` | Linear app settings | token exchange and refresh | rotate in Linear + env |
| Human session | Redis (`__session` cookie) | `session:create`; Keryx OAuth for human MCP clients | the person's memberships | `session:destroy`, TTL |
| CLI token (`hyp_cli_…`) | CLI: `credentials.json` (0600); server: sha256 in `cli_tokens` | `cli-auth:exchange`, after the person approves in the dashboard | the person's memberships; never `daemon:*` | `cli-token:revoke`, `hypotenuse logout`, 90-day sliding expiry |
| Runner token | daemon: `~/.config/hypotenuse/credentials.json` (0600); server: sha256 in `runners.tokenHash` | `runner:register` — plaintext shown once | one runner, one project, the owner's standing at call time | `runner:revoke`, membership removal |
| Daemon WebSocket session | Redis | `daemon:connect` (runner token → cookie) | subscribe to `runner:<id>` only | runner revoke drops it |
| Coding-agent model credentials | the person's machine (Claude login, `OPENAI_API_KEY`, …) | the person | the agent | the person |
| Git credentials | the person's machine | the person | the person's repos | the person |

Hypotenuse deliberately does **not** hold model or git credentials: the daemon runs on the machine of the
person whose credentials those are, which is the point of a local runner.

## Linear, from the server's side

**Linear is the first trigger type, not the only one the model allows.** Everything that mirrors a trigger system
is typed: an `integrations` row (a project's connection to one workspace of one type), each `trigger_events`
delivery, each `agent_sessions` row, each `external_identities` link, and each runner subscription carries
`type = linear`, and keeps the trigger's own ids in `external*` columns (`externalWorkspaceId`,
`externalSessionId`, `externalIssueId`, `externalUserId`, …). `user_id` always means a Hypotenuse user. The human
API is generic too (`integration:list|view|connect|disconnect|catalog`, `type` as an input). What stays Linear's
own is what talks to Linear: `webhooks:linear`, `linear:callback`, `linear:manifest-url`, the GraphQL client, the
`daemon:linear-*` proxy, and the `linear_*` agent tools. A second trigger type adds its own ingress and client, and
reuses the tables.

One Linear OAuth application per Hypotenuse deployment, configured by env (`LINEAR_CLIENT_ID`,
`LINEAR_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET`). A project admin connects **one Linear workspace** to **one
Hypotenuse project** with `actor=app` and scopes `read,write,app:assignable,app:mentionable,issues:create,
comments:create`. The app user's id (`viewer.id`) is unique per workspace and stored as the integration's `externalAppUserId`.

Every Linear webhook arrives at one endpoint, `POST /api/webhooks/linear`, and is identified to a `linear`
integration by its `organizationId` (the integration's `externalWorkspaceId`). The handler caps the body (5 MiB, 413 beyond), verifies `Linear-Signature` (HMAC-SHA256 of the
raw body, constant time; `LINEAR_WEBHOOK_SECRET_PREVIOUS` also verifies during a rotation), checks the signed
body's `webhookTimestamp` is within ±60 s, deduplicates on `Linear-Delivery`, inserts a `trigger_events` row,
answers 200 well inside Linear's 5-second budget, and enqueues `triggers:process-event`. A bad signature and a stale
timestamp are the same 401, byte for byte. A verified delivery for no live integration is still answered 200
and recorded `unknown_integration`: one webhook serves every workspace, and Linear disables a webhook that keeps
failing. The row is the delivery; the `triggers:process-pending` clock processes any row whose job was lost.

What each event does:

| Event | Effect |
|---|---|
| `AgentSessionEvent` / `created` | upsert `agent_sessions`; enqueue an immediate acknowledgement `thought` (Linear marks a session unresponsive after 10 s without one); select a role and repository; insert a `work_items` row; ping eligible runners |
| `AgentSessionEvent` / `prompted` | record the inbound `prompt` activity; if `signal = stop`, cancel the live work item; otherwise insert a follow-up work item sticky to the session's runner |
| `PermissionChange` / `teamAccessChanged` | update the integration's team access; cancel sessions on teams it lost |
| `OAuthApp` / `revoked` | mark the integration revoked; cancel every live session; notify project admins |
| `Issue` / `update` with `delegateId` removed | cancel live work for that issue (a dismissed session removes the delegate) |
| `AppUserNotification` / * | recorded and surfaced in the dashboard; no work is started (sessions are the work trigger) |
| anything else | recorded, `outcome = ignored` |

The acknowledgement is *"On it — finding a runner for ENG-123."*; routing then names the role it chose, the
repository, and — while no runner can take the turn — why it waits, so a session never looks unresponsive. A
`stop` with nothing running is answered *"Stopped. Nothing was running."*; a team-access change marks sessions on
removed teams `error` and cancels their work; a removed delegate is recorded on the session (`delegateRemovedAt`)
and its work cancelled without a word, because the person disengaged.

**Everything written to Linear goes through the activity outbox** (`agent_activities` rows with
`direction = outbound`), drained by `activities:deliver`. Rows get a per-session `seq` under the session's row
lock; each session is sent in `seq` order by one process at a time (a Redis lease), and sessions in parallel.
Each row carries a client-generated UUID passed as `agentActivityCreate(input.id)`, so a retried send is
idempotent and Linear's "already exists" counts as sent. A per-integration token bucket in Redis
(`backend/lua/linear-token-bucket.lua`) keeps the deployment inside Linear's 5,000 requests/hour per app user,
pulled down to Linear's own `X-RateLimit-Requests-Remaining` when that is lower, with the last 10 tokens reserved
for acknowledgements and stop answers. A still-pending ephemeral activity is superseded by the next one, and a
pending plan or summary by a newer one, before they spend budget. `RATELIMITED` waits for Linear's reset without
counting an attempt; a 5xx or lost response backs off from 1 s to 5 min, ten attempts; any other GraphQL error
fails the row at once (it is our bug).

## The roles: manager and worker

There is one Linear app user, `@hypotenuse`. **Which kind of agent answers is a routing decision, not an
identity.** A project's ordered `routing_rules` pick `manager` or `worker` for each new session from the issue's
labels, team, project, parent, how the session started, and the start of the mention's text (`/manage`, `/work`,
seeded as the first two rules when a project connects Linear). The default is `worker`, and the role is fixed for
the session's life.

- A **worker** implements one issue in one worktree and opens a pull request.
- A **manager** owns the shape of a project: it writes PRDs (project descriptions and Linear documents), breaks
  them into issues and sub-issues, and **dispatches** issues to workers. When a dispatched worker session
  finishes, the server enqueues a **review turn** on the manager's session with the worker's result, and the
  manager accepts, asks for changes, or files follow-ups.

Each role has its own entry prompt, coding agent, permission policy, and MCP tool set, defined in the daemon's
config file (see [`CONFIG.md`](./CONFIG.md)). A runner advertises which roles it serves.

## Runners and routing

A **runner** is one registered daemon. It belongs to one project and one person (its owner), and every
heartbeat reports what it can do: its parallel-job limits (machine, per role, per agent), roles, agent kinds, repositories (by remote), and Linear
subscriptions (team keys, project ids, labels).

A work item is **eligible** for a runner when the runner is online (not draining) and enabled, has room at all three limits (machine, the role, and the agent it would use — counted by the server over live work items, an offer included), serves the
role with an available agent, has the chosen repository (or the work needs none), and its subscriptions match the issue. One SQL query
(`RoutingOps.eligibleRunners`) decides it. Among eligible runners:

1. **Sticky first.** A follow-up turn in a session goes to the runner that holds the session's worktree. If that
   runner is offline, the session gets a visible "waiting for <runner>" thought, and after
   `routing.stickyTimeout` the work is re-offered to others as a fresh worktree with history replayed.
2. **The issuer's runners next.** The session's Linear `creator` is mapped to a Hypotenuse user through
   `external_identities` (an admin's link, or an e-mail match to a project member, recorded so it is visible and
   removable), and that user's runners are offered the work first. It is a preference, never an authorization.
3. **Then anyone eligible**, least-loaded first.

Offers are pings, not assignments: the server publishes a content-free `{ event: "work" }` on `runner:<id>`, and
the daemon claims with `daemon:claim`, which takes the row with `SELECT … FOR UPDATE SKIP LOCKED`. An offer not
claimed within `routing.offerTtlMs` goes to the next runner. A claim carries a lease; the daemon's heartbeats and
events renew it; an expired lease returns the item to `queued`, still sticky, and a fourth lapse fails it.

**Repository choice.** Candidates are the union of every eligible runner's repositories. If there is more
than one, the server asks Linear's `issueRepositorySuggestions`; above `routing.repositoryConfidence` the top
suggestion wins, otherwise the session receives a `select` elicitation listing the candidates and the work waits
for the person's answer, which arrives as an ordinary prompt and is matched without a model (a value, a label,
`owner/name`, or exactly one repository named in the text; two misses end the turn with an `error`). A rule may
pin the repository instead, and a manager with no candidates works without one.

## State machines

### `work_items.status`

```
 queued ──offer──► offered ──daemon:claim──► claimed ──first event──► running ──► completed
   ▲                  │                         │                       │      ├──► failed
   │                  └──── offer TTL ──────────┤                       │      └──► cancelled
   └──────────────── lease expired ─────────────┴───────────────────────┘
 queued ──no eligible runner for routing.queueTimeout──► expired   (session gets an `error`)
```

A work item is one **turn**: the session's creation, one follow-up prompt, a dispatch, or a manager review.
At most one work item per session may be under way (`offered`, `claimed`, `running`) at a time; a prompt that
arrives meanwhile is queued behind it, merged with any follow-up already queued (or, with `signal = stop`, cancels
it and supersedes what is queued). The queue and sticky timeouts count from when an item was last queued.

### `agent_sessions.status`

Mirrors Linear's own state, which Linear derives from the last activity: `pending`, `active`, `awaitingInput`,
`error`, `complete`, `stale`, and the schema-only `stopping`. Hypotenuse never sets it directly — it emits the
activity that implies it.

| Activity Hypotenuse emits | Linear status |
|---|---|
| `thought` / `action` | `active` |
| `elicitation` | `awaitingInput` |
| `response` | `complete` |
| `error` | `error` |
| (nothing for 30 min) | `stale` — the daemon sends a keepalive `thought` every `sessions.keepalive_interval` during long turns |

## The daemon

**One process per machine**, enforced by a fixed-path lock and by the server refusing a second live (online or draining) runner
with the same machine id. `hypotenuse daemon start` (or a launchd / systemd user service installed by
`hypotenuse service install`). It holds no state the server cannot rebuild except the worktrees themselves:

- `~/.config/hypotenuse/config.toml` — the config file ([`CONFIG.md`](./CONFIG.md)).
- `~/.config/hypotenuse/credentials.json` — keyed by server: the operator's CLI sign-in and the runner's id and
  token, kept apart so `logout` never de-registers a machine (0600).
- `~/.local/state/hypotenuse/state.db` — `bun:sqlite`: local sessions, their worktrees, ACP session ids (for
  `session/load` after a restart), and process ids.
- `~/.local/state/hypotenuse/state.db` also holds the **offline queue**: every event a turn produces is written
  there (with its `eventId` and per-claim `seq`) before it is sent, so a server deploy or a train tunnel costs
  latency and nothing else; a newer ephemeral event supersedes older unsent ones.
- `~/.local/state/hypotenuse/daemon.sock` — the control socket (`0600`, newline-delimited JSON-RPC) the CLI's
  `daemon`, `doctor`, `upgrade`, `agents`, and `worktrees` commands talk to.
- `~/.local/state/hypotenuse/daemon.pid` — the machine lock, at that path whatever `-c` or `--state-dir` say; it
  records the running daemon's own socket.
- `~/.hypotenuse/worktrees/<repo>/<ISSUE-ID>` — default `sessions.worktree_root`.

Inside, a **supervisor** owns `runner.max_parallel_jobs` slots (counted again per role and per agent), **ServerLink**
heartbeats and holds the one-subscription socket, and the **EventSink** drains the queue. A slot runs a turn
through a `SessionExecutor`; until the ACP host exists that is a null executor that answers and completes. On
start, a turn a previous process left running is marked `interrupted` and left to the server's lease to re-offer.

For each claimed work item it:

1. creates (or, for a sticky follow-up, reuses) a git worktree on branch `hypotenuse/<issue-identifier>-<slug>`
   from the repository's `base_branch`, and runs the repository's `setup` commands;
2. spawns the role's ACP agent with `cwd` set to the worktree and `mcpServers` containing
   `hypotenuse mcp --session <agentSessionId> --nonce <per-turn nonce>`;
3. `initialize`s, authenticates if the agent asks, then `session/new` (or `session/load` / `session/resume` for a
   follow-up);
4. sends one `session/prompt` built from the role prompt, Linear's `promptContext`, guidance (team before
   workspace), and the conversation rebuilt from **activities, not comments**;
5. maps every `session/update` to protocol events (table below) and posts them in batches with `daemon:events`;
6. finishes with `daemon:complete`, and applies the cleanup policy to the worktree.

### ACP → Linear mapping

| ACP `session/update` (or method) | Protocol event | Linear |
|---|---|---|
| `agent_thought_chunk` | `thought` (coalesced, ephemeral) | `thought`, ephemeral |
| `tool_call` (`pending` / `in_progress`) | `action` without `result`, ephemeral | `action` |
| `tool_call_update` (`completed` / `failed`) | `action` with `result` | `action` (persisted) |
| `plan` | `plan` | `agentSessionUpdate(plan)` — the whole list; `in_progress` → `inProgress` |
| `agent_message_chunk` | buffered; `response` at `end_turn` | `response` |
| `session/request_permission` under policy `ask` | `elicitation` + `select` | `elicitation`, `signal: select` |
| `elicitation/create` (form or url) | `elicitation` (+ `auth` for url mode) | `elicitation`, `signal: select` or `auth` |
| `stopReason: refusal / max_tokens / max_turn_requests`, crash, timeout | `error` | `error` |
| `session_info_update.title` | `summary` | `agentSessionUpdate(summary)` |
| a PR URL in a tool result or `daemon:linear-report-pr` | `external_url` | `agentSessionUpdate(addedExternalUrls)` labelled "Pull Request" |
| `usage_update` | `usage` | dashboard only |
| Linear `prompted` with `signal: stop` | `cancel` frame → `session/cancel` | final `response` saying it stopped and where things stand |

## The Hypotenuse MCP server

`hypotenuse mcp --session <id> --nonce <n>` is a stdio MCP server the daemon hands to the coding agent. It holds
**no token**: it calls the daemon over the `0600` control socket (`mcp.hello`, `mcp.call`) with the session id and a
per-turn nonce, and the daemon forwards each call to `daemon:linear-*` with the runner token it keeps to itself.
The agent's process tree therefore never sees the runner token in argv or env. The server re-derives every
permission from the session
row: which integration, which issue, which role. The two tool sets:

| Worker | Manager (adds) |
|---|---|
| `linear_get_issue`, `linear_list_comments`, `linear_comment`, `linear_set_issue_state` (own issue), `linear_set_plan`, `linear_ask_user` (elicitation, optional `select` options), `linear_report_pr`, `linear_search_issues` | `linear_create_issue`, `linear_update_issue`, `linear_create_sub_issue`, `linear_create_relation`, `linear_get_project`, `linear_update_project` (PRD), `linear_create_document`, `linear_update_document`, `linear_list_labels`, `hypotenuse_dispatch` (delegate an issue to a worker) |

## Tables

| Table | Holds |
|---|---|
| `users`, `projects`, `project_memberships`, `tags`, `user_tags`, `project_invites`, `audit_logs`, `notifications`, `project_settings` | ported from ToolExec: tenancy, RBAC, audit, notifications, and one settings row per project whose columns arrive with the features that read them (`routing`: the routing timers and thresholds, sparse over their defaults) |
| `cli_tokens` | one per signed-in `hypotenuse` CLI: owner, device name, token sha256 and last four, last use, sliding expiry, revocation. The sign-in hand-offs themselves (one-time and device codes) live in Redis, by hash |
| `integrations` | one per project and trigger `type`: the external workspace id, name, and URL key; the app user's external id, name, and capabilities (in the per-type `details`, with team access); sealed tokens, expiry, refresh error; when an admin last completed the install; scopes, team access, status; the last-seen rate-limit headers. Live workspace ids are unique; a disconnected row is kept `revoked` with its tokens nulled. The install's `state` and PKCE verifier live in Redis for ten minutes |
| `trigger_events` | every verified webhook delivery of any trigger type, deduplicated on `(type, deliveryId)`, with its processing outcome |
| `external_identities` | trigger-system user (`externalUserId`) ⇄ Hypotenuse user (`userId`) links, per integration |
| `agent_sessions` | the mirror of each agent session, typed (`type`, `externalSessionId`): issue (and the snapshot routing read), role, the mention's instruction, repository, a pending repository question, sticky runner, plan, external URLs, status |
| `agent_activities` | inbound prompts and the outbound outbox, with client UUIDs, delivery status, and attempts |
| `runners` | registered daemons: owner, token sha256 and last four, status (`online`, `offline`, `draining`, `revoked`) and `enabled`, machine id, last heartbeat and connect, parallel-job limits, roles, agents, repositories, the hash of the last reported capabilities. A name is unique among a project's unrevoked runners; a machine id among its live (`online` or `draining`) ones. A revoked row is kept with its reason |
| `runner_subscriptions` | the teams, projects, and labels (per trigger `type`) each runner accepts, replaced whenever a heartbeat's capability hash changes |
| `work_items` | one per turn: kind, role, repository, status, the merged follow-ups, issuer, offered/claimed runner and agent, lease, attempts, the cancel, the daemon's usage and state, the outcome |
| `routing_rules` | a project's ordered role-selection rules |

## WebSocket channels

Frames are **content-free**: they name what changed and the client re-reads over HTTP. Postgres is the source of
truth and a reconnect hydrates.

| Channel | Subscriber | Frames |
|---|---|---|
| `runner:<runnerId>` | the daemon holding that runner's session cookie | `{ event: "work" }`, `{ event: "cancel" }`, `{ event: "revoked" }` |
| `project:<projectId>:sessions` | project members | `{ event: "sessions" }`, `{ event: "session", id }` |
| `project:<projectId>:runners` | project members | `{ event: "runners" }` |
| `project:<projectId>:notifications` | project members | `{ event: "notifications" }` |

The daemon's heartbeat (`daemon:heartbeat`, every 15 s) also returns pending offers and cancels, so a lost socket
costs latency, never correctness.

## Clocks (task-only, never a web route)

| Task | Every | Does |
|---|---|---|
| `triggers:process-event` | enqueued per delivery; `triggers:process-pending` every 5 s for a lost job | the event table above |
| `activities:deliver` | enqueued per session; `activities:deliver-due` every 1 s | drains the outbound outbox under the token bucket |
| `work:route` | enqueued + 5 s | lapses expired offers; prepares new sessions (reads the issue, chooses the role and repository); offers each session's next queued turn; expires work with no eligible runner after `routing.queueTimeoutMs` |
| `work:reap` | 15 s | marks runners `offline` after `runners.offlineAfterMs` (45 s) without a heartbeat; returns claims with lapsed leases to `queued`; ends stopped turns whose runner did not confirm within `routing.stopGraceMs` |
| `sessions:keepalive` | 60 s | an ephemeral `thought` for sessions waiting on Hypotenuse (a queued turn) that have been quiet for 25 minutes; never for one waiting on a person |
| `integrations:refresh-tokens` | 5 min | refreshes access tokens within 30 minutes of expiry under a row lock (refresh tokens rotate; a lost response is replayed inside Linear's 30-minute grace; `invalid_grant` marks the integration `error` and notifies its admins). A 401 anywhere refreshes inline through the same function |
| `notifications:dispatch` | 30 s | delivers queued notifications: a ping on the project channel, and the e-mail (logged when `SMTP_HOST` is empty) |
| `trigger-events:sweep`, `audit:sweep`, `notifications:sweep`, `invites:sweep` | daily | retention |

Trigger jobs — processing a delivery, sending an outbox — run on the `triggers` queue, which workers drain before
`routing`, `orchestrator`, and `default`, so nothing else queued delays an acknowledgement. The routing jobs and
clocks run on `routing`, next.

## Where the detail lives

| Topic | Plan |
|---|---|
| Workspaces, scaffolds, CI gate, test harness | [`phase-01-foundation.md`](./plans/phase-01-foundation.md) |
| The Render blueprint | [`phase-02-deployment.md`](./plans/phase-02-deployment.md) |
| The look: tokens, light/dark, glyphs, shell, CLI palette | [`phase-03-design-system.md`](./plans/phase-03-design-system.md), [`DESIGN.md`](./DESIGN.md) |
| Users, projects, RBAC, audit, notifications | [`phase-04-users-tenancy-and-audit.md`](./plans/phase-04-users-tenancy-and-audit.md) |
| The `hypotenuse` CLI, binaries, install scripts, self-upgrade | [`phase-05-cli-and-distribution.md`](./plans/phase-05-cli-and-distribution.md) |
| Linear OAuth install, token refresh, the finear harness | [`phase-06-linear-connection.md`](./plans/phase-06-linear-connection.md) |
| Webhook ingress, the session mirror, the activity outbox | [`phase-07-webhook-ingress-and-session-mirror.md`](./plans/phase-07-webhook-ingress-and-session-mirror.md) |
| Runner registration, tokens, presence | [`phase-08-runners.md`](./plans/phase-08-runners.md) |
| Work items, role and repository selection, routing | [`phase-09-work-routing.md`](./plans/phase-09-work-routing.md) |
| The daemon process and its config file | [`phase-10-daemon-and-config.md`](./plans/phase-10-daemon-and-config.md) |
| ACP: spawning agents, the mapping, permissions, stop | [`phase-11-acp-agent-host.md`](./plans/phase-11-acp-agent-host.md) |
| Worktrees, timeouts, cleanup, issue hygiene | [`phase-12-worktrees-and-session-lifecycle.md`](./plans/phase-12-worktrees-and-session-lifecycle.md) |
| The stdio MCP server and the Linear proxy | [`phase-13-hypotenuse-mcp.md`](./plans/phase-13-hypotenuse-mcp.md) |
| The manager role, dispatch, review turns | [`phase-14-manager-and-dispatch.md`](./plans/phase-14-manager-and-dispatch.md) |
| Dashboard, live channels, operator CLI parity | [`phase-15-dashboard.md`](./plans/phase-15-dashboard.md) |
| Signals, notifications, rate limits, AIG | [`phase-16-signals-and-hardening.md`](./plans/phase-16-signals-and-hardening.md) |
| Coverage conformance and the end-to-end suite | [`phase-17-conformance-and-e2e.md`](./plans/phase-17-conformance-and-e2e.md) |
| Per-project OpenTelemetry export | [`phase-18-opentelemetry-export.md`](./plans/phase-18-opentelemetry-export.md) |
