# Runner protocol

The contract between the hosted Hypotenuse service and a `hypotenuse daemon`. It is HTTP for everything that
matters, plus a WebSocket used only to wake the daemon up. Every message is a zod schema in `protocol/src/`,
imported by both `backend/` and `cli/`, so the schemas and this page describe the same thing — when they disagree,
the schema wins and this page is fixed in the same commit (rule 14 in [`AGENTS.md`](../AGENTS.md)).

This is a live reference, not a plan. The reasoning lives in [runners](./plans/phase-08-runners.md) and
[work routing](./plans/phase-09-work-routing.md); the daemon's side is in
[the daemon](./plans/phase-10-daemon-and-config.md) and [the ACP host](./plans/phase-11-acp-agent-host.md).

## Principles

1. **Postgres is the truth; the socket is a doorbell.** A WebSocket frame never carries work or state. It tells
   the daemon to heartbeat now. A daemon whose socket never connects still works, 15 seconds slower.
2. **The server derives authority from the token, never from parameters.** No `daemon:*` request names a project
   or a runner; the runner token does.
3. **Every write is idempotent.** Events carry a daemon-generated `eventId` that becomes the Linear activity's
   client id; claims and completions are safe to repeat.
4. **The daemon can always tell the person what happened.** Every terminal path ends in a `response` or `error`
   activity in Linear — written by the daemon if it can, by the server if it cannot.

## Versioning

| | |
|---|---|
| `PROTOCOL_VERSION` | `1` (`protocol/src/version.ts`) |
| Request header | `X-Hypotenuse-Protocol: 1` on every `daemon:*` request |
| Server support | a range `[min, max]`; outside it → **426** `{ error: { type: "PROTOCOL_UNSUPPORTED", supported: [1, 1] } }` |
| Compatibility rule | additive fields do not bump the version; zod schemas are `.passthrough()` on responses and strict on requests, so an older daemon ignores new response fields and a newer daemon cannot send fields an older server would drop silently |

On 426 the daemon stops claiming, keeps finishing what it holds, and logs *"The server needs protocol 2; run
`hypotenuse upgrade`."*

## Authentication

| Transport | Credential |
|---|---|
| HTTP | `Authorization: Bearer hyp_rt_<43 chars>` — the runner token from `~/.config/hypotenuse/credentials.json` |
| WebSocket | `Cookie: __session=<id>` obtained from `daemon:connect` |

Every `daemon:*` request is checked by `RunnerTokenMiddleware`: the token's hash resolves to a non-revoked runner
whose owner is still a member of its project. Any failure is one byte-identical **401**. A runner token is refused
on every non-`daemon:*` action, and every `daemon:*` action is refused to anything but a runner token.

## Endpoints

All are `POST`, JSON in and out, under `/api`. Errors use Keryx's envelope `{ error: { message, type, … } }`;
check the envelope, not only the status.

### `daemon:connect`

`POST /api/daemon/connect` with `{ "machineId": "sha256:…" }`. Answers 409 `machine_in_use` with
`{ runnerId, runnerName }` when a different runner with that `machineId` is live (`online` or `draining`): one
daemon per machine.
`daemon:heartbeat` gives the same 409, with nothing written, so the rule holds whichever call a daemon makes
first.

```json
{ "runnerId": 5, "channel": "runner:5", "heartbeatIntervalMs": 15000, "leaseMs": 60000, "serverTime": 1792478400000 }
```

Sets the `__session` cookie (`Set-Cookie`). Call it before every WebSocket connect; a session is revoked with
its runner.

### `daemon:heartbeat`

`POST /api/daemon/heartbeat` — every `heartbeatIntervalMs` (15 s), and immediately after any WebSocket frame.

Request (`HeartbeatRequest`):

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
    "agents": [
      { "id": "claude", "preset": "claude", "available": true, "roles": ["manager", "worker"] },
      { "id": "codex", "preset": "codex", "available": false, "roles": [], "error": "codex-acp not found" }
    ],
    "repositories": [{ "name": "web", "remote": "github.com/acme/web", "baseBranch": "main" }],
    "subscriptions": { "teams": ["ENG"], "projects": [], "labels": ["frontend"] }
  }
}
```

| Field | Notes |
|---|---|
| `active[].state` | `starting` \| `running` \| `cancelling` — each listed item's lease is renewed |
| `draining` | true while shutting down or upgrading: finish held work, receive no offers |
| `machineId` | stable hash of the OS machine id; the server allows one live (`online` or `draining`) runner per machine |
| `limits` | `maxParallelJobs` (the machine), and optional per-role and per-agent caps. Absent keys mean "no limit at that level". The server counts live work items per runner, per role, and per agent itself and never offers past any of them |
| `capabilities` | replaces the server's copy when its hash changes; `subscriptions` empty arrays mean "all" |

Response (`HeartbeatResponse`):

```json
{
  "serverTime": 1792478415000,
  "heartbeatIntervalMs": 15000,
  "leaseMs": 60000,
  "offers": [{ "workItemId": 813, "agentSessionId": 92, "kind": "session_created", "role": "worker", "offerExpiresAt": 1792478425000 }],
  "cancels": [{ "workItemId": 812, "reason": "stop" }],
  "unknownActive": []
}
```

`unknownActive` lists `active` items the server no longer considers this runner's (lease reaped, reassigned,
cancelled and closed). The daemon must stop work on them **without** emitting further events — someone else may
own the session now.

### `daemon:claim`

`POST /api/daemon/claim` — `{ "workItemIds": [813] }` (optional; omitted means "anything offered to me").

Response: `{ "assignment": WorkAssignment | null }`.

```json
{
  "assignment": {
    "workItemId": 813,
    "agentSessionId": 92,
    "type": "linear",
    "externalSessionId": "f6c1…",
    "externalSessionUrl": "https://linear.app/acme/issue/ENG-123#agent-session-f6c1",
    "dashboardUrl": "https://www.hypotenuse.cloud/sessions/92",
    "kind": "session_created",
    "role": "worker",
    "fresh": true,
    "repository": { "remote": "github.com/acme/web", "baseBranch": "main" },
    "branch": "hypotenuse/eng-123-fix-checkout-rounding",
    "issue": {
      "id": "9a0…", "identifier": "ENG-123", "title": "Fix checkout rounding",
      "description": "…", "url": "https://linear.app/acme/issue/ENG-123/…",
      "teamKey": "ENG", "labels": ["bug"], "state": { "name": "Todo", "type": "unstarted" },
      "parent": null, "project": { "id": "…", "name": "Checkout" }
    },
    "promptContext": "<issue identifier=\"ENG-123\">…</issue>",
    "guidance": [{ "origin": "team", "teamKey": "ENG", "body": "Always open a draft PR." },
                 { "origin": "workspace", "body": "Reference the issue id in commits." }],
    "history": [{ "seq": 1, "direction": "outbound", "type": "thought", "body": "On it — finding a runner for ENG-123." }],
    "prompt": null,
    "origin": "delegation",
    "humanDelegated": true,
    "leaseExpiresAt": 1792478475000
  }
}
```

| Field | Notes |
|---|---|
| `kind` | `session_created` \| `prompt` \| `dispatch` \| `review` |
| `type`, `externalSessionId`, `externalSessionUrl` | the trigger the session came from (`linear` today) and the session's id and page there; the daemon never interprets them beyond display and logs |
| `fresh` | true when the daemon must create a new worktree and cannot `session/load` an ACP session — first turn, or a sticky session moved to this runner |
| `repository` | null for a manager working without one |
| `guidance` | already ordered: nearest team first, then parent teams, then workspace |
| `history` | the session's conversation from `agent_activities`, both directions, delivered/received only, in `seq` order — never from comments |
| `prompt` | for `prompt` kind: `[{ "activityId": 330, "body": "Also handle the EUR case" }]` (merged follow-ups); for `review`: the dispatched worker's result |
| `humanDelegated` | the session was started by a person delegating (not an automation) — read by issue hygiene |

### `daemon:events`

`POST /api/daemon/events` — `{ "workItemId": 813, "events": SessionEvent[] }`, ≤ 100 events, ≤ 256 KiB.

Response: `{ "accepted": 12, "duplicates": 0, "dropped": 0, "cancelRequested": false }`. `dropped` counts events
refused because a cancel is in progress (only `response` and `error` are accepted then); `cancelRequested` lets a
daemon that missed the frame and the heartbeat learn of a stop on its next write.

#### `SessionEvent`

Every event: `{ "eventId": "<uuid v4>", "seq": <int, per work item, from 1>, "at": <epoch ms>, "type": … }`.

| `type` | Fields | Linear |
|---|---|---|
| `thought` | `body`, `ephemeral` | `agentActivityCreate` `{ type: "thought", body }` |
| `action` | `action`, `parameter`, `result?`, `ephemeral` | `{ type: "action", action, parameter, result }` |
| `elicitation` | `body`, `signal?` (`select` \| `auth`), `signalMetadata?` | `{ type: "elicitation", body }` + signal |
| `response` | `body` | `{ type: "response", body }` |
| `error` | `body` | `{ type: "error", body }` |
| `plan` | `entries: [{ content, status: pending \| in_progress \| completed \| canceled }]` | `agentSessionUpdate { plan }`, whole list, `in_progress` → `inProgress` |
| `summary` | `title` (1–255 chars, one line) | `agentSessionUpdate { summary }` |
| `external_url` | `label`, `url` | `agentSessionUpdate { addedExternalUrls }` |
| `usage` | `inputTokens?`, `outputTokens?`, `costUsd?`, `contextUsed?`, `contextSize?` | dashboard only |
| `status` | `state: starting \| running \| waiting_permission \| finishing` | dashboard only |

Rules, enforced by the schema and the server:

- `ephemeral` is legal only on `thought` and `action` — Linear's own rule.
- `signalMetadata` for `select` is `{ options: [{ label?, value }] }`; for `auth` it is
  `{ url, userId?, providerName? }`.
- Markdown is allowed in every `body`. A Linear URL to an issue or profile renders as a mention.
- `eventId` is the idempotency key end to end: it becomes `agent_activities.clientActivityId` and Linear's
  `agentActivityCreate(input.id)`. Resend a batch freely.
- `seq` orders events within a work item; the server inserts in `seq` order and rejects a batch that goes
  backwards (409 `SEQ_REGRESSION`) — that would be a daemon bug, and resending the same batch is not one.

### `daemon:complete`

`POST /api/daemon/complete`:

```json
{ "workItemId": 813, "outcome": "completed", "acpSessionId": "sess_01…", "branch": "hypotenuse/eng-123-fix-checkout-rounding", "error": null }
```

`outcome`: `completed` \| `failed` \| `cancelled`. Idempotent: completing a terminal item answers 200 with
`{ "alreadyTerminal": true }`. If the turn emitted no `response`, `error`, or `elicitation`, the server writes one.

### `daemon:linear-*` and `daemon:dispatch`

The Linear proxy behind `hypotenuse mcp`. Same auth, same header, one extra required field: `agentSessionId`,
which must name a session with a non-terminal work item claimed by this runner. The full list and each tool's
input are in [the Hypotenuse MCP plan](./plans/phase-13-hypotenuse-mcp.md).

## The WebSocket

```
daemon                                    hypotenuse-api
  │ POST /api/daemon/connect  (Bearer)        │
  │◄──────────── Set-Cookie: __session ───────│
  │ GET wss://…  Cookie: __session            │
  │ {"messageType":"subscribe","channel":"runner:5"}
  │◄──── {"subscribed":{"channel":"runner:5"}}│
  │                                           │
  │◄── {"message":{"channel":"runner:5","message":"{\"event\":\"work\"}"}}
  │ POST /api/daemon/heartbeat ──────────────►│   (offers: [813])
  │ POST /api/daemon/claim     ──────────────►│   (assignment)
```

| Frame (`message`, JSON-encoded string) | Daemon does |
|---|---|
| `{"event":"work"}` | heartbeat now, claim any offers |
| `{"event":"cancel"}` | heartbeat now, act on `cancels` |
| `{"event":"revoked"}` | stop claiming, cancel everything held, exit with *"This runner was revoked."* |

Rules:

- **Subscribe exactly once per connection; never unsubscribe.** To change anything, close and reconnect.
- **Reconnect** with exponential backoff from 1 s, doubling to 30 s, full jitter; reset after 60 s connected.
  Call `daemon:connect` again before each reconnect.
- Close code 1001 (server draining for a deploy) → reconnect after a random 1–5 s, without backoff.
- Heartbeats continue on their own timer whether or not the socket is up.

## Offers, claims, and leases

```
 work:route            runner A (sticky)       runner B
     │ offered→A, expires +10s │                     │
     │──── ping "work" ───────►│                     │
     │◄──── heartbeat ─────────│  offers:[813]        │
     │◄──── claim 813 ─────────│                     │
     │ claimed, lease +60s     │                     │
     │◄──── events (renews) ───│                     │
     │◄──── heartbeat (renews)─│                     │
     │◄──── complete ──────────│                     │

 offer lapses (A full, asleep, or never answered):
     │ offered→B, expires +10s ─────────────────────►│
 lease lapses (A's lid closed mid-turn):
     │ work:reap → queued, attempts+1, sticky kept → re-offered to A when it returns,
     │ or to others after the project's stickyTimeout, with fresh: true
```

| Timer | Default | Owner |
|---|---|---|
| heartbeat interval | 15 s | server-chosen, in every heartbeat response |
| offline after | 45 s without a heartbeat | `work:reap` |
| offer TTL | 10 s | project setting `routing.offerTtlMs` |
| lease | 60 s, renewed by heartbeats and events | server |
| sticky timeout | 10 min | project setting `routing.stickyTimeoutMs` |
| queue timeout | 30 min | project setting `routing.queueTimeoutMs` |
| stop grace | 30 s | project setting `routing.stopGraceMs` |

## Cancellation

A cancel reaches the daemon three ways — the `cancel` frame, the heartbeat's `cancels`, and `cancelRequested` on
any `daemon:events` response — so it is delivered as long as *any* request succeeds. On a cancel the daemon:

1. sends ACP `session/cancel` and answers any pending `session/request_permission` with `cancelled`;
2. waits up to `sessions.stop_grace` (config) for the agent's prompt to return `stopReason: cancelled`, then kills
   the process tree;
3. emits one `response` describing the state the work was left in — the branch, whether there are uncommitted
   changes, what was in progress — as Linear's stop guidance requires;
4. calls `daemon:complete` with `outcome: "cancelled"`.

`reason` values: `stop` (a person pressed Stop in Linear), `dashboard`, `delegate_removed`, `integration_revoked`,
`superseded`.

## Error codes

| HTTP | `error.type` | Meaning | Daemon does |
|---|---|---|---|
| 401 | `CONNECTION_SESSION_NOT_FOUND` | bad, revoked, or orphaned token | stop; tell the person to `hypotenuse runner register` |
| 406 | `CONNECTION_ACTION_PARAM_VALIDATION` | schema violation; `key` / event index included | log as a bug; drop the batch item; never retry unchanged |
| 409 | `NOT_YOUR_WORK` | the item is not claimed by this runner | stop work on it silently |
| 409 | `SEQ_REGRESSION` | events out of order | log as a bug |
| 413 | — | batch over 256 KiB | split and resend |
| 426 | `PROTOCOL_UNSUPPORTED` | version outside the server's range | drain; ask for an upgrade |
| 429 | `CONNECTION_RATE_LIMITED` | per-runner limit | back off to `Retry-After` |
| 5xx / network | — | transient | retry with backoff; events are idempotent |
