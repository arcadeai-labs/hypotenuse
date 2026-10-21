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
   │ installations, sessions, │   │ WebSocket pub/sub, the Linear token bucket │
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
reach Linear through server actions that are scoped to one session's issue and one installation, and that are
a closed allowlist. A compromised laptop can act on the issues it was handed work for, for as long as its
runner token lives — not on the workspace.

| Credential | Lives | Minted by | Scope | Revoked by |
|---|---|---|---|---|
| Linear access + refresh token (`actor=app`) | `linear_installations`, AES-256-GCM via `ops/CryptoOps.ts` | Linear OAuth callback | the workspace's teams the admin granted | `linear:disconnect`, `OAuthApp revoked` webhook |
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

One Linear OAuth application per Hypotenuse deployment, configured by env (`LINEAR_CLIENT_ID`,
`LINEAR_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET`). A project admin connects **one Linear workspace** to **one
Hypotenuse project** with `actor=app` and scopes `read,write,app:assignable,app:mentionable,issues:create,
comments:create`. The app user's id (`viewer.id`) is unique per workspace and stored as `appUserId`.

Every webhook arrives at one endpoint, `POST /api/webhooks/linear`, and is identified to an installation by
`organizationId`. The handler verifies `Linear-Signature` (HMAC-SHA256 of the raw body), checks
`webhookTimestamp` is within ±60 s, deduplicates on `Linear-Delivery`, inserts a `linear_events` row, answers
200 well inside Linear's 5-second budget, and enqueues `linear:process-event` after commit.

What each event does:

| Event | Effect |
|---|---|
| `AgentSessionEvent` / `created` | upsert `agent_sessions`; enqueue an immediate acknowledgement `thought` (Linear marks a session unresponsive after 10 s without one); select a role and repository; insert a `work_items` row; ping eligible runners |
| `AgentSessionEvent` / `prompted` | record the inbound `prompt` activity; if `signal = stop`, cancel the live work item; otherwise insert a follow-up work item sticky to the session's runner |
| `PermissionChange` / `teamAccessChanged` | update the installation's team access; cancel sessions on teams it lost |
| `OAuthApp` / `revoked` | mark the installation revoked; cancel every live session; notify project admins |
| `Issue` / `update` with `delegateId` removed | cancel live work for that issue (a dismissed session removes the delegate) |
| `AppUserNotification` / * | recorded and surfaced in the dashboard; no work is started (sessions are the work trigger) |
| anything else | recorded, `outcome = ignored` |

**Everything written to Linear goes through the activity outbox** (`agent_activities` rows with
`direction = outbound`), drained by `activities:deliver`. Each row carries a client-generated UUID passed as
`agentActivityCreate(input.id)`, so a retried send is idempotent. A per-installation token bucket in Redis
keeps the deployment inside Linear's 5,000 requests/hour per app user; ephemeral activities are coalesced
before they spend budget.

## The roles: manager and worker

There is one Linear app user, `@hypotenuse`. **Which kind of agent answers is a routing decision, not an
identity.** A project's ordered `routing_rules` pick `manager` or `worker` for each new session from the issue's
labels, team, project, parent, and the first line of the prompt (`/manage`, `/work`). The default is `worker`.

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

A work item is **eligible** for a runner when the runner is online, not draining, has room at all three limits (machine, the role, and the agent it would use), serves the
role, has the chosen repository (or the work needs none), and its subscriptions match the issue. Among eligible
runners:

1. **Sticky first.** A follow-up turn in a session goes to the runner that holds the session's worktree. If that
   runner is offline, the session gets a visible "waiting for <runner>" thought, and after
   `routing.stickyTimeout` the work is re-offered to others as a fresh worktree with history replayed.
2. **The issuer's runners next.** The session's Linear `creator` is mapped to a Hypotenuse user through
   `linear_identities` (an explicit link, or a verified e-mail match), and that user's runners are offered the
   work first.
3. **Then anyone eligible**, least-loaded first.

Offers are pings, not assignments: the server publishes a content-free `{ event: "work" }` on `runner:<id>`, and
the daemon claims with `daemon:claim`, which takes the row with `SELECT … FOR UPDATE SKIP LOCKED`. A claim
carries a lease; the daemon's heartbeat renews it; an expired lease returns the item to `queued`.

**Repository choice.** Candidates are the union of every eligible runner's repositories. If there is more
than one, the server asks Linear's `issueRepositorySuggestions`; above `routing.repositoryConfidence` the top
suggestion wins, otherwise the session receives a `select` elicitation listing the candidates and the work waits
for the person's answer.

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
Exactly one work item per session may be non-terminal at a time; a prompt that arrives while a turn is running
is queued behind it (or, with `signal = stop`, cancels it).

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
- `~/.local/state/hypotenuse/daemon.sock` — the control socket the CLI's `agents`, `worktrees`, and `daemon`
  commands talk to.
- `~/.hypotenuse/worktrees/<repo>/<ISSUE-ID>` — default `sessions.worktree_root`.

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
row: which installation, which issue, which role. The two tool sets:

| Worker | Manager (adds) |
|---|---|
| `linear_get_issue`, `linear_list_comments`, `linear_comment`, `linear_set_issue_state` (own issue), `linear_set_plan`, `linear_ask_user` (elicitation, optional `select` options), `linear_report_pr`, `linear_search_issues` | `linear_create_issue`, `linear_update_issue`, `linear_create_sub_issue`, `linear_create_relation`, `linear_get_project`, `linear_update_project` (PRD), `linear_create_document`, `linear_update_document`, `linear_list_labels`, `hypotenuse_dispatch` (delegate an issue to a worker) |

## Tables

| Table | Holds |
|---|---|
| `users`, `projects`, `project_memberships`, `tags`, `user_tags`, `project_invites`, `audit_logs`, `notifications`, `project_settings` | ported from ToolExec: tenancy, RBAC, audit, notifications, and one settings row per project whose columns arrive with the features that read them (routing timeouts, thresholds) |
| `cli_tokens` | one per signed-in `hypotenuse` CLI: owner, device name, token sha256 and last four, last use, sliding expiry, revocation. The sign-in hand-offs themselves (one-time and device codes) live in Redis, by hash |
| `linear_installations` | one per project: workspace id, name, and URL key; the app user's id, name, and capabilities; sealed tokens, expiry, refresh error; when an admin last completed the install; scopes, team access, status; the last-seen rate-limit headers. Live workspace ids are unique; a disconnected row is kept `revoked` with its tokens nulled. The install's `state` and PKCE verifier live in Redis for ten minutes |
| `linear_events` | every verified webhook delivery, deduplicated on `deliveryId`, with its processing outcome |
| `linear_identities` | Linear user ⇄ Hypotenuse user links, per installation |
| `agent_sessions` | the mirror of each Linear agent session: issue, role, repository, sticky runner, parent (manager) session, plan, external URLs, status |
| `agent_activities` | inbound prompts and the outbound outbox, with client UUIDs, delivery status, and attempts |
| `runners` | registered daemons: owner, token hash, machine id, last heartbeat, parallel-job limits, roles, agents, repositories |
| `runner_subscriptions` | the Linear teams, projects, and labels each runner accepts, replaced on every heartbeat |
| `work_items` | one per turn: kind, role, status, offered/claimed runner, lease, attempts |
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
| `linear:process-event` | enqueued per delivery | the event table above |
| `activities:deliver` | 1 s | drains the outbound outbox under the token bucket |
| `work:route` | enqueued + 5 s | offers queued work; expires work with no eligible runner after `routing.queueTimeout` |
| `work:reap` | 15 s | returns work with expired leases to `queued`; marks runners offline after `runners.offlineAfter` |
| `sessions:keepalive` | 60 s | a server-side keepalive `thought` for sessions whose runner is waiting on a person or reconnecting |
| `linear:refresh-tokens` | 5 min | refreshes access tokens within 30 minutes of expiry under a row lock (refresh tokens rotate; a lost response is replayed inside Linear's 30-minute grace; `invalid_grant` marks the installation `error` and notifies its admins). A 401 anywhere refreshes inline through the same function |
| `notifications:dispatch` | 30 s | delivers queued notifications: a ping on the project channel, and the e-mail (logged when `SMTP_HOST` is empty) |
| `linear-events:sweep`, `audit:sweep`, `notifications:sweep`, `invites:sweep` | daily | retention |

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
