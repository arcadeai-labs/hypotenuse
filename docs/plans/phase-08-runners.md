# Phase 8 — Runners: registration, authentication, presence

> **Goal:** A project member registers a machine as a **runner** with one CLI command, and that machine holds
> exactly one credential — a revocable runner token scoped to one project and one owner. The server always knows
> which runners are online, what each one can do, and how much room it has; a runner learns there is work for it
> within a second of the work existing, without the server ever trusting the socket to be the source of truth.

> **Status: planned, not built.** Builds on [users, tenancy, and audit](./phase-04-users-tenancy-and-audit.md) and
> [the CLI](./phase-05-cli-and-distribution.md). Nothing is routed to a runner yet — that is
> [work routing](./phase-09-work-routing.md). The daemon process that uses these endpoints is
> [phase 10](./phase-10-daemon-and-config.md); this phase builds the server half and the `hypotenuse runner`
> commands, and tests the server half with a scripted HTTP + WebSocket client.

A runner is the reason Hypotenuse exists: the coding agent runs on a person's own machine, with their own model
login and their own git credentials, and the hosted service only decides *what* it should work on. That makes the
runner the most trusted and the most exposed thing in the system at once. It is trusted, because whatever it
reports goes to Linear under the app's name. It is exposed, because it lives on a laptop.

ToolExec solved the same shape of problem for its sandboxes with the **run token**: one random value, stored
only as a hash, scoped to exactly what one run needs, checked by a middleware that derives every permission from
the row it resolves to, and kept off every surface a human uses by a closed allowlist. A runner token is that
token with a longer life — a runner outlives any one session — and this phase ports the pattern rather than
inventing one. Two things are new: the token is long-lived, so revocation has to be complete and immediate; and
a runner must be *woken*, which ToolExec's supervisor never needed because it polled.

## Scope

**In:**

- `runners` and `runner_subscriptions` tables.
- `runner:register`, `runner:list`, `runner:view`, `runner:edit`, `runner:revoke` (human actions).
- Runner tokens: generation, hashing, last four, one-time plaintext.
- `RunnerTokenMiddleware` and `DAEMON_ONLY_ACTION_NAMES` with the `beforeAct` hook that keeps runner and human
  surfaces disjoint.
- `daemon:connect` (runner token → WebSocket session cookie) and `daemon:heartbeat` (capabilities, liveness).
- The `runner:<runnerId>` channel and its authorization; the `project:<projectId>:runners` dashboard channel.
- Presence: online / offline / draining / revoked, from heartbeats, swept by `work:reap`.
- Per-runner rate limits.
- Membership removal revokes the member's runners.
- `hypotenuse runner {register,list,view,revoke}`; `register` writes `~/.config/hypotenuse/credentials.json`.
- `protocol/src/{version,heartbeat,capabilities}.ts`.
- The user docs page *Runners*.

**Out:**

- `daemon:claim`, `daemon:events`, `daemon:complete`, offers, and leases — [phase 9](./phase-09-work-routing.md).
  The heartbeat response carries empty `offers` and `cancels` arrays in this phase so the wire shape is final.
- The daemon process, config file, reconnect loop — [phase 10](./phase-10-daemon-and-config.md).
- `daemon:linear-*` tools — [phase 13](./phase-13-hypotenuse-mcp.md).
- The Runners dashboard page beyond a minimal list — [phase 15](./phase-15-dashboard.md).

## Design

### What a runner is

| Property | Decided by |
|---|---|
| **Project** | the `projectId` it was registered in; one runner, one project |
| **Owner** | the user who registered it. The owner's membership is re-checked on every request; losing it revokes the runner |
| **Name** | free text, unique per project (`evan-mbp`, `ci-box-2`); defaults to the host name |
| **Capabilities** | reported, not configured on the server: capacity, roles, agents, repositories, subscriptions — every heartbeat replaces them |

A person may register many runners (laptop, desktop, a build box). A machine running two daemons is two runners;
the daemon refuses to start a second time against the same credentials file, which is the common accident.

### `runners`

| Column | Notes |
|---|---|
| `id` serial | |
| `projectId` FK cascade, `userId` FK cascade | owner |
| `name` text | unique `(projectId, name)` |
| `tokenHash` text unique | `sha256(token)` hex |
| `tokenLastFour` text | |
| `status` text | `online` \| `offline` \| `draining` \| `revoked` |
| `enabled` boolean | an owner or admin can pause a runner without revoking it; a disabled runner is never offered work |
| `lastHeartbeatAt`, `lastConnectedAt` timestamptz | |
| `protocolVersion` int, `daemonVersion` text, `platform` text (`darwin-arm64`, …), `hostname` text | from the heartbeat |
| `limits` jsonb, `activeCount` int | `{ maxParallelJobs, roles?: { [role]: n }, agents?: { [agentId]: n } }` and the number of live jobs, from the heartbeat |
| `machineId` text | from the heartbeat. **One daemon per machine:** `daemon:heartbeat` and `daemon:connect` both refuse (409 `machine_in_use`, naming the other runner, nothing written) a runner whose `machineId` matches a different **live** runner — `online` **or `draining`**, because a draining runner is still heartbeating and finishing work. A partial unique index `runners_live_machine_idx ON (machineId) WHERE status IN ('online', 'draining')` makes the check atomic when two daemons start at once; the losing transaction maps the unique violation to the same 409 |
| `roles` jsonb | `["manager","worker"]` subset |
| `agents` jsonb | `[{ id, preset, available, version? }]` — `available` is the daemon's own probe (binary on PATH, `initialize` succeeded) |
| `repositories` jsonb | `[{ name, remote, baseBranch }]` — `remote` normalized to `hostname/owner/name` |
| `createdAt`, `updatedAt`, `revokedAt` | |

### `runner_subscriptions`

The Linear scopes a runner accepts work from, replaced wholesale on every heartbeat (a config file edit takes
effect on the next beat). A table, not a jsonb column, because routing queries it by value across every runner in
a project.

| Column | Notes |
|---|---|
| `id`, `runnerId` FK cascade | |
| `type` | the trigger type the subscription is for — `linear` today, the same `type` as `integrations` and `agent_sessions` |
| `kind` | `team` \| `project` \| `label` |
| `value` | team **key** (`ENG`), project **id**, or label **name** (lowercased) — what a person writes in a config file |
| unique `(runnerId, type, kind, value)` | |

**Empty means everything.** A runner with no `team` rows accepts every team the integration can see; likewise
projects and labels. Kinds intersect: `teams = ["ENG"]`, `labels = ["frontend"]` accepts ENG issues labelled
`frontend`. The daemon validates team keys against `integration:catalog` at startup and warns on unknown ones rather
than refusing — a team can be renamed under a running fleet.

### The runner token

- 32 random bytes (`crypto.getRandomValues`), base64url, prefixed `hyp_rt_` so a leaked token is greppable by
  secret scanners. Stored as `sha256`. Lookup is a single indexed equality on the hash, so — as ToolExec's phase
  10 notes — no per-byte comparison against a secret exists to leak timing.
- Returned **once**, by `runner:register`. There is no "show token" action and no rotate-in-place: re-registering
  with the same name (`--replace`) revokes the old runner row and creates a new one, so a token that leaked
  once is dead the moment its owner re-registers.
- Not a Keryx OAuth token and not registered with `/mcp`. Runners never speak MCP to the server; the agent's MCP
  server is a local stdio process that calls HTTP ([phase 13](./phase-13-hypotenuse-mcp.md)).

### `RunnerTokenMiddleware`

`backend/middleware/runnerToken.ts`, modelled on ToolExec's `middleware/runToken.ts`:

1. Read `Authorization: Bearer hyp_rt_…` from `connection.rawRequest` (`ops/RawRequestOps.ts` `bearerToken`), or,
   on a WebSocket connection, the session's `runnerId` (set by `daemon:connect`).
2. Resolve `runners` by `tokenHash` (or id). Missing, `revoked`, or `enabled = false` for anything but
   `daemon:heartbeat` → 401 with one byte-identical body. Disabled runners may still heartbeat, so the dashboard
   shows them online-but-paused.
3. Re-check the owner's membership in `projectId` (`project_memberships`). Gone → revoke the runner in the same
   transaction and answer 401. Membership removal also revokes eagerly (below); this is the backstop.
4. Require `X-Hypotenuse-Protocol` to be a version the server supports; otherwise 426 with
   `{ error: { type: "PROTOCOL_UNSUPPORTED", supported: [min, max] } }`, which the daemon turns into "run
   `hypotenuse upgrade`".
5. Set `connection.metadata.runner` (the row) and `connection.metadata.project`. Every `daemon:*` action reads
   these and **never** a `projectId` or `runnerId` param.

### Two surfaces, kept disjoint

`DAEMON_ONLY_ACTION_NAMES` in `backend/ops/DaemonPolicyOps.ts` is the closed list of every `daemon:*` action —
asserted equal to the set of registered actions whose name starts with `daemon:` (so the prefix and the list
cannot drift), and **not** to be confused with the human `runner:*` actions that manage runners. A `beforeAct`
hook (`backend/initializers/daemonPolicy.ts`), ported from ToolExec's `mcpAgentTools.ts` hook:

- refuses any `daemon:*` action to a connection without a resolved runner (a human session, a human MCP client);
- refuses **every other action** to a connection authenticated by a runner token.

The second half is the important one. A runner token carries its owner's identity, and without the hook it
would pass `ProjectMemberMiddleware` for `runner:register`, `integration:disconnect` (if the owner is an admin),
`routing-rule:edit`, and anything else the owner can do. The daemon never needs a human action; if it ever
does, the action is duplicated as a `daemon:*` twin, as ToolExec duplicates `sandbox:*` twins.

`daemon:*` is never MCP (asserted by prefix in `rbac.test.ts`), never audited (machine traffic; the audited
decision is `runner:register` / `runner:revoke`), and never wrapped by the operator CLI (rule 13's machine-half
exception) — the daemon calls them.

### Human actions

| Action | Route | Level | Audited | MCP | CLI |
|---|---|---|---|---|---|
| `runner:register` | `PUT /runner` | member | yes (token never in the row: `secret()` on nothing — the token is an output; `serializeRunner` has no token field) | **no** — a model holding it could mint a credential that outlives the conversation | `runner register` |
| `runner:list` | `GET /runners` | member | read | yes | `runner list` |
| `runner:view` | `GET /runner/:id` | member | read | yes | `runner view` |
| `runner:edit` | `POST /runner/:id` | owner or admin (`name`, `enabled`) | yes | yes | `runner edit` |
| `runner:revoke` | `DELETE /runner/:id` | owner or admin | yes | yes | `runner revoke` |

"Owner or admin" is a data-dependent check inside the action (`canManageRunner(connection, runner)` in
`RunnerOps`), on top of `ProjectMemberMiddleware()`, the same way ToolExec gates `canWriteAgent`.
`actions:permissions` reports `member` for these, and `runner:view` returns
`standing: { canManage }` so the frontend never restates the rule.

**Revocation is complete in one transaction plus one publish:** `status = revoked`, `revokedAt`, every
non-terminal work item claimed by it returned to `queued` (phase 9), and in `afterCommit` a `{ event: "revoked" }`
frame on `runner:<id>` and a Redis `DEL` of every Keryx session that `daemon:connect` minted for it (tracked in
`runner:sessions:<id>`, a set), which closes the socket's authority immediately rather than at session TTL.

**Membership removal** (`membership:delete`, ported) gains one step: revoke every runner the removed user owns in
that project, in the same audited transaction.

### `daemon:connect` — a cookie for the socket

Keryx authenticates a WebSocket from the `__session` cookie on the upgrade. Bun's `WebSocket` client accepts
headers, so the daemon:

1. `POST /api/daemon/connect` with its bearer token → the action calls `connection.updateSession({ runnerId })`
   and `connection.regenerateSession()` and answers `{ runnerId, channel: "runner:<id>", heartbeatIntervalMs,
   leaseMs }`; the response sets `__session`.
2. Opens `wss://…` with `Cookie: __session=<value>`.
3. Sends exactly one `{"messageType":"subscribe","channel":"runner:<id>"}`.

**One subscribe per connection.** Keryx currently processes one connection's frames concurrently, so a subscribe
and an unsubscribe can apply out of order (ToolExec's [phase 18](https://github.com/arcadeai-labs/toolexec)
records the defect). A runner socket subscribes once and never unsubscribes — it closes and reconnects instead —
so the defect cannot bite here. It is still a Keryx bug and goes upstream under rule 4; the daemon's
"subscribe once" is a property of its design, not a workaround, and the doc comment on it says so.

### The `runner:<runnerId>` channel

`backend/channels/runner.ts`: `name = /^runner:(\d+)$/`, middleware requires `connection.session.data.runnerId`
equal to the channel's id **and** a live runner row (the revocation check). A human session — even the owner's —
cannot subscribe: the channel is a wake-up for a machine, and nothing on it is for a person.

Frames are content-free (ToolExec's phase 18 rule): `{ event: "work" }`, `{ event: "cancel" }`,
`{ event: "revoked" }`. The daemon answers `work` and `cancel` by heartbeating immediately — the heartbeat is
where offers and cancels are actually read — so a frame that is lost, duplicated, or delivered to a stale
connection costs nothing. `presenceKey` is `runner:<id>`, so `api.channels.members("runner:5")` answers "is a
socket attached" across the cluster.

### `daemon:heartbeat` — liveness and capabilities

`POST /api/daemon/heartbeat`, every 15 s (`heartbeatIntervalMs`, server-chosen), and immediately on any frame.
Request body (`protocol/src/heartbeat.ts`, `HeartbeatRequest`):

```json
{
  "protocolVersion": 1,
  "daemonVersion": "0.4.2",
  "platform": "darwin-arm64",
  "hostname": "evan-mbp",
  "draining": false,
  "machineId": "sha256:4be1…",
  "limits": { "maxParallelJobs": 3, "roles": { "manager": 1 }, "agents": { "claude": 2 } },
  "active": [{ "workItemId": 812, "agentSessionId": 91, "role": "worker", "agentId": "codex", "state": "running" }],
  "capabilities": {
    "roles": ["manager", "worker"],
    "agents": [{ "id": "claude", "preset": "claude", "available": true }],
    "repositories": [{ "name": "web", "remote": "github.com/acme/web", "baseBranch": "main" }],
    "subscriptions": { "teams": ["ENG"], "projects": [], "labels": [] }
  }
}
```

Response (`HeartbeatResponse`): `{ serverTime, heartbeatIntervalMs, leaseMs, offers: [], cancels: [] }`. In this
phase `offers` and `cancels` are always empty; [phase 9](./phase-09-work-routing.md) fills them and uses
`active` to renew leases. The handler:

- updates the runner row and replaces `runner_subscriptions` in one transaction — **only when the capability
  hash changed** (a sha256 of the canonicalized `capabilities` object), so a steady fleet writes one timestamp per
  beat, not a dozen rows;
- sets `status` to `draining` when `draining` is true (the daemon is shutting down or upgrading: finish what you
  hold, take nothing new), else `online`;
- publishes `{ event: "runners" }` on `project:<id>:runners` only when status or capabilities changed.

### Presence

| Status | Means | Set by |
|---|---|---|
| `online` | a heartbeat within `runners.offlineAfterMs` (default 45 s = three missed beats) | `daemon:heartbeat` |
| `draining` | online, finishing current work, not offered new work | `daemon:heartbeat` with `draining: true` |
| `offline` | no heartbeat for `offlineAfterMs` | `work:reap` (15 s clock) |
| `revoked` | permanent | `runner:revoke`, membership removal, `--replace` |

The WebSocket being attached is **not** presence. A daemon behind a proxy that eats WebSockets still heartbeats
and still works, at up to 15 s more latency; a socket that is attached but whose daemon is wedged stops
heartbeating and goes offline. `runner:view` shows both (`online`, `socketAttached`) so the difference is visible.

`work:reap` is introduced here with only the presence half; phase 9 adds lease expiry to the same clock.

### Rate limits

Per runner, via `checkRateLimit("runner:<id>", …)` in `backend/middleware/runnerRateLimit.ts` (ported from
`runTokenRateLimit.ts`): heartbeat 12/min, everything else 600/min. The limits are deliberately loose — the
daemon is ours — and exist so a looping daemon bug costs one runner a 429, not the deployment its Linear budget.

### The `project:<projectId>:runners` channel

`backend/channels/projectRunners.ts`, membership-gated like ToolExec's `projectRuns`, frame `{ event: "runners" }`
with no ids. The runner list is visible to every member, so the frame leaks nothing the list does not.

### The CLI

`cli/src/commands/runner.ts`:

```bash
hypotenuse runner register [--name evan-mbp] [--project acme] [--replace]
#   → PUT /api/runner as the logged-in user; writes {url, projectId, runnerId, token}
#     to ~/.config/hypotenuse/credentials.json (dir 0700, file 0600); prints the runner id, never the token
hypotenuse runner list [--json]           # GET /api/runners — name, owner, status, capacity, agents, last beat
hypotenuse runner view <id|name>          # capabilities and subscriptions as the server last saw them
hypotenuse runner revoke <id|name> [--yes]
```

`register` refuses to overwrite an existing credentials file for a *different* server or project without
`--force`, because doing so silently orphans a working runner. `hypotenuse runner register` immediately calls
`daemon:heartbeat` once with the daemon's current config (if the config file exists) so the dashboard shows the
runner's real capabilities before the daemon is ever started — and fails loudly if the token does not work.

## Steps

### 1. Protocol — `protocol/src/{version,heartbeat,capabilities,connect}.ts`

`PROTOCOL_VERSION = 1`, `SUPPORTED_PROTOCOL_RANGE`, zod schemas `RunnerCapabilities`, `HeartbeatRequest`,
`HeartbeatResponse` (with `Offer` and `Cancel` declared now, empty in this phase), `ConnectResponse`. Exported for
both `backend/` and `cli/`. [`RUNNER_PROTOCOL.md`](../RUNNER_PROTOCOL.md) is written alongside.

### 2. Schema — `backend/schema/{runners,runner_subscriptions}.ts`

### 3. Ops — `backend/ops/{RunnerOps,DaemonPolicyOps}.ts`

`RunnerOps`: `generateRunnerToken`, `hashRunnerToken`, `serializeRunner`, `canManageRunner`, `revokeRunner(tx,
runner, reason)`, `applyHeartbeat(tx, runner, request)`, `capabilityHash`, `normalizeRemote`
(`git@github.com:acme/web.git`, `https://github.com/acme/web`, and `github.com/acme/web` all become
`github.com/acme/web`). `DaemonPolicyOps`: `DAEMON_ONLY_ACTION_NAMES`, `isDaemonOnly`.

### 4. Middleware and hook — `backend/middleware/{runnerToken,runnerRateLimit}.ts`, `backend/initializers/daemonPolicy.ts`

### 5. Actions — `backend/actions/runner/{runner-register,runner-list,runner-view,runner-edit,runner-revoke}.ts`, `backend/actions/daemon/{daemon-connect,daemon-heartbeat}.ts`, `backend/actions/work/work-reap.ts`

### 6. Channels — `backend/channels/{runner,projectRunners}.ts`

### 7. Membership hook — `backend/actions/membership/membership-delete.ts`

Revoke the removed user's runners in the same transaction; test in `membership.test.ts`.

### 8. CLI — `cli/src/commands/runner.ts`, `cli/src/config/credentials.ts`

Credentials file read/write with mode checks (refuse to read a group- or world-readable credentials file, as ssh
does, with the `chmod` to fix it).

### 9. Frontend — `frontend/src/pages/RunnersPage.tsx` (minimal)

A table: name, owner, status, capacity used/total, agents, last heartbeat; Revoke for owners and admins. Live
via `project:<id>:runners`. The full page is [phase 15](./phase-15-dashboard.md).

### 10. Docs — `frontend/src/content/docs/runners.md`

What a runner is, what it can and cannot do on your behalf, how to register one, what revocation does.

### 11. Tests — `backend/__tests__/runners/*.test.ts`, `backend/__tests__/cli/runner.test.ts`

| File | Asserts |
|---|---|
| `runner-register.test.ts` | token returned once, prefixed, never in `runner:view`/`list`/audit; hash stored; name unique per project; `--replace` revokes the old row; Bowser 403 |
| `runner-token-middleware.test.ts` | unknown, revoked, and malformed tokens → byte-identical 401; disabled runner may heartbeat but nothing else; owner removed from project → 401 and runner revoked; wrong protocol version → 426 with the supported range |
| `daemon-policy.test.ts` | every `daemon:*` action refused to Peach's session and to Peach's MCP token; every non-`daemon:*` action refused to a runner token (iterated over the whole registry, not a sample); `DAEMON_ONLY_ACTION_NAMES` equals the `daemon:` prefix set |
| `daemon-heartbeat.test.ts` | capabilities and subscriptions replaced; unchanged capabilities write no subscription rows (counted); `draining` sets status; `{event:"runners"}` published only on change; response shape is the final one |
| `machine.test.ts` | a second runner heartbeating **or** connecting with an online runner's `machineId` gets 409 `machine_in_use` naming it, including while the first is `draining`; `cap × 4` concurrent first heartbeats from different runners with one `machineId` leave exactly one online; the same runner reconnecting is fine; once the first goes offline the second may connect |
| `runner-channel.test.ts` | `daemon:connect` cookie subscribes to its own channel; another runner's channel refused; Peach's session refused; revocation sends `revoked` and the next subscribe on that session fails |
| `runner-presence.test.ts` | writing `lastHeartbeatAt` back 46 s then running `work:reap` → `offline` (time controlled by columns, not waits); a heartbeat brings it back |
| `runner-ratelimit.test.ts` | the 13th heartbeat in a minute → 429 for that runner only |
| `cli/runner.test.ts` | spawn the CLI: `register` writes a 0600 file and the first heartbeat lands; `list`, `view`, `revoke`; refusing to read a 0644 credentials file |

## Verification

```bash
cd backend && bun run migrations && bun run lint && bun test __tests__/runners __tests__/actions/rbac.test.ts
cd cli && bun run lint && bun test
cd backend && bun test __tests__/cli/runner.test.ts

# By hand, against `bun dev`:
hypotenuse login --url http://localhost:8080
hypotenuse runner register --name laptop
hypotenuse runner list
TOKEN=$(jq -r .token ~/.config/hypotenuse/credentials.json)
curl -s -X POST localhost:8080/api/daemon/heartbeat -H "Authorization: Bearer $TOKEN" \
  -H "X-Hypotenuse-Protocol: 1" -H 'Content-Type: application/json' \
  -d '{"protocolVersion":1,"daemonVersion":"dev","platform":"darwin-arm64","hostname":"laptop","draining":false,"machineId":"sha256:dev","limits":{"maxParallelJobs":2},"active":[],"capabilities":{"roles":["worker"],"agents":[],"repositories":[],"subscriptions":{"teams":[],"projects":[],"labels":[]}}}' | jq
# the same token against a human action must fail:
curl -s localhost:8080/api/runners?projectId=1 -H "Authorization: Bearer $TOKEN" | jq .error.type
```

## Definition of done

- [ ] `runners` and `runner_subscriptions`; capability hash avoids rewrite churn
- [ ] Tokens: prefixed, hashed, shown once, revocation complete (row, work, sessions, frame) in one transaction + publish
- [ ] `RunnerTokenMiddleware` re-checks owner membership and protocol version on every request
- [ ] `DAEMON_ONLY_ACTION_NAMES` + `beforeAct` hook; whole-registry tests in both directions
- [ ] `daemon:connect` cookie; one subscribe per socket; `runner:<id>` channel machine-only
- [ ] `daemon:heartbeat` with the final request/response shape; presence via `work:reap`
- [ ] Membership removal revokes runners
- [ ] Per-runner rate limits
- [ ] `hypotenuse runner` commands; credentials file 0600 with a mode check
- [ ] Minimal Runners page, live; user docs page
- [ ] `protocol/` heartbeat schemas and `RUNNER_PROTOCOL.md`

## Learnings from the build

_Nothing yet — this phase has not been built._
