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

Every `daemon:*` request is resolved by the principal hook (`backend/middleware/runnerToken.ts`): the token's hash
(or the WebSocket session's runner id) resolves to a non-revoked runner whose owner is still a member of its
project; an owner who is not is the runner revoked on the spot. A paused runner (`enabled: false`) may only
heartbeat. Any failure is one **401** with the same message and type. A runner token is refused (**403**) on every
non-`daemon:*` action, and every `daemon:*` action is refused to anything but a runner — 403 to a person's session
or CLI token, 401 to nobody. The protocol header is checked first, at the HTTP edge, so an unsupported daemon is
told to upgrade (**426**) whatever its token.

## Endpoints

All are `POST`, JSON in and out, under `/api`. Errors use Keryx's envelope `{ error: { message, type, … } }`;
check the envelope, not only the status.

### `daemon:connect`

`POST /api/daemon/connect` with `{ "machineId": "sha256:…" }`. Answers **409**
`{ error: { type: "MACHINE_IN_USE", message, runnerId, runnerName } }` when a different runner with that
`machineId` is live (`online` or `draining`): one daemon per machine. `runnerId` and `runnerName` are `null` when the
other runner is in another project and has another owner — machine ids are global, and a shared build box should
not name another tenant's runner.
`daemon:heartbeat` gives the same 409, with nothing written, so the rule holds whichever call a daemon makes
first.

```json
{ "runnerId": 5, "channel": "runner:5", "heartbeatIntervalMs": 15000, "leaseMs": 60000, "serverTime": 1792478400000 }
```

Sets the `__session` cookie (`Set-Cookie`). The session carries only the runner's id and is deleted when the runner
is revoked. Call it before every WebSocket connect.

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
    "subscriptions": { "teams": ["ENG"], "projects": [], "labels": ["frontend"] },
    "telemetry": { "enabled": true, "maxContent": "full", "agentNative": true }
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
| `capabilities.telemetry` | optional: the runner owner's `[telemetry]` cap. The claim lowers a turn's telemetry to it; absent (an older daemon) means the runner sends none, and the server exports its own spans only. Never a routing constraint |
| `dryRun` | optional. `true` validates and answers **without recording anything** — no presence, capabilities, leases, offers, or routing pass. `config validate --online` and `doctor` send it. A machine held by another live runner still gets the 409 |

Response (`HeartbeatResponse`):

```json
{
  "serverTime": 1792478415000,
  "heartbeatIntervalMs": 15000,
  "leaseMs": 60000,
  "offers": [{ "workItemId": 813, "agentSessionId": 92, "kind": "session_created", "role": "worker", "offerExpiresAt": 1792478425000 }],
  "cancels": [{ "workItemId": 812, "reason": "stop" }],
  "unknownActive": [],
  "answers": [{ "workItemId": 811, "activityId": 418, "body": "allow" }]
}
```

Capabilities and subscriptions are rewritten only when the hash of the normalized capabilities changes (remotes
as `hostname/owner/name`, labels lowercased, subscription values sorted and de-duplicated), so a steady daemon
costs one row update per beat.

`offers` lists every offer standing for this runner (unexpired), oldest first; `cancels` lists every item it holds
whose session asked to stop. A cancel a person made from the dashboard or the CLI (`reason: "dashboard"`) also
carries `by`, their name, which the daemon puts in its final activity; a Linear stop with text carries `said`, which
the daemon quotes. Both fields are additive and absent otherwise.
Every `active` item the runner does hold has its lease renewed.

A dry run's answer has empty `offers`, `cancels`, and `unknownActive`, plus two fields no other heartbeat carries:
`runner` — `{ id, name, projectId, projectSlug }`, who the token is — and `unknownSubscriptions` —
`{ teams: [...] }`, the subscribed team keys the project's Linear connection cannot see, or `null` when there is
no working connection to ask (the integration's cached catalog is read, never written).

`unknownActive` lists `active` items the server no longer considers this runner's (lease reaped, reassigned,
cancelled and closed). The daemon must stop work on them **without** emitting further events — someone else may
own the session now.

`answers` lists the replies people sent to questions held turns are waiting on (see
[Questions mid-turn](#questions-mid-turn)), oldest first, for items this runner holds and is not being asked to
cancel. They repeat on every heartbeat until the turn completes; the daemon reads each `activityId` once.

A heartbeat that changed what routing reads — the runner came online, went draining, freed capacity, or reported
new capabilities — runs a routing pass, so a freed slot is offered work at once.

### `daemon:claim`

`POST /api/daemon/claim` — `{ "workItemIds": [813] }` (optional; omitted means "anything offered to me").

Response: `{ "assignment": WorkAssignment | null }`. The oldest standing offer (among `workItemIds`, if given) is
taken `FOR UPDATE SKIP LOCKED`, so two claims never take one item, and the runner's capacity is re-checked under
its own row lock. A claim naming an item this runner already holds answers the same assignment with a renewed
lease, so a claim whose answer was lost is safe to repeat — and the daemon repeats it on its next heartbeat, offered
or not, after a network error or a 5xx. Nothing claimable is `{ "assignment": null }`, never an
error.

A claim also does two things in Linear, on the server, so a daemon never needs the rights to: it links the session
to its dashboard page (`addedExternalUrls` `{ label: "Hypotenuse", url: dashboardUrl }`, once per session), and, for
a session's first turn (`session_created`, `dispatch`), it applies **issue hygiene** after the claim commits and
before answering — the started-state move for a person's delegation, the app as delegate when the issue has none,
never the assignee. The outcome is recorded on the work item; a Linear failure becomes a thought in the session and
never fails the claim.

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
    "agentId": "claude",
    "fresh": true,
    "repository": { "remote": "github.com/acme/web", "baseBranch": "main" },
    "branch": "hypotenuse/eng-123-fix-checkout-rounding",
    "issue": {
      "id": "9a0…", "identifier": "ENG-123", "title": "Fix checkout rounding",
      "description": "…", "url": "https://linear.app/acme/issue/ENG-123/…",
      "teamKey": "ENG", "labels": ["bug"], "state": { "name": "Todo", "type": "unstarted" },
      "parent": null, "project": { "id": "…", "name": "Checkout" }
    },
    "instruction": null,
    "promptContext": "<issue identifier=\"ENG-123\">…</issue>",
    "guidance": [{ "origin": "team", "teamKey": "ENG", "body": "Always open a draft PR." },
                 { "origin": "workspace", "body": "Reference the issue id in commits." }],
    "previousComments": null,
    "history": [{ "seq": 1, "activityId": 330, "direction": "outbound", "type": "thought", "body": "On it — finding a runner for ENG-123.", "signal": null }],
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
| `agentId` | the runner's agent for this role, chosen when the item was offered and counted against `limits.agents` |
| `instruction` | what the mention said, with a matched role prefix stripped (`/manage plan the launch` → `plan the launch`); null for a delegation |
| `branch` | a hint, `hypotenuse/<identifier>-<title slug>`; null without a repository. The daemon names its own (its repository's `branch_prefix`, a suffix on collision, or the branch the session already has) and reports it in `daemon:complete` |
| `type`, `externalSessionId`, `externalSessionUrl` | the trigger the session came from (`linear` today) and the session's id and page there; the daemon never interprets them beyond display and logs |
| `fresh` | true when the daemon must create a new worktree and cannot `session/load` an ACP session — first turn, or a sticky session moved to this runner |
| `repository` | null for a manager working without one |
| `guidance` | already ordered: nearest team first, then parent teams, then workspace |
| `history` | the session's conversation from `agent_activities`, both directions, delivered/received only, in `seq` order — never from comments. It includes this turn's own prompts; `activityId` matches `prompt[].activityId` |
| `prompt` | for `prompt` kind: `[{ "activityId": 330, "body": "Also handle the EUR case" }]` (merged follow-ups); empty for a manager's change request, whose request is `dispatch` |
| `dispatch` | on a worker turn a manager dispatched (`dispatch` kind) or sent back (`prompt` kind): `{ mode: "new" \| "changes", reviewRound, instructions, agentPreference, parent: { agentSessionId, issueIdentifier, issueUrl } }`; absent or null otherwise. `reviewRound` counts change requests (0 for the first dispatch); `agentPreference` is an `[agents]` id the daemon may use instead of the role's agent |
| `review` | on a `review` turn: `{ childAgentSessionId, childIssueIdentifier, childIssueUrl, reviewRound, outcome, finalResponse, plan, pullRequests }` — the worker's last `response` or `error`, its plan, and its links labelled *Pull Request*; absent or null otherwise |
| `humanDelegated` | the session was started by a person delegating (not an automation) — read by issue hygiene |
| `creator` | `{ name, email }` of whoever started the session, or null when an automation did; the prompt template's `creator.*` |
| `telemetry` | `{ traceparent, sampled, content, agentNative }` when the project has an enabled [telemetry exporter](#daemontelemetry) and this runner reports `telemetry.enabled`; null otherwise. `traceparent` names the turn's trace and its root `turn` span (W3C, version `00`); `sampled` says whether any exporter keeps the turn's spans and logs (metrics are always sent); `content` is the level to collect at — the highest any exporter wants, lowered to the runner's `maxContent`; `agentNative` asks the daemon to capture the agent's own telemetry. An older daemon ignores it |

### `daemon:events`

`POST /api/daemon/events` — `{ "workItemId": 813, "events": SessionEvent[] }`, ≤ 100 events, ≤ 256 KiB. The daemon
sends at most 50 events or 64 KiB per call, from its persisted queue in `seq` order, and a work item's
`daemon:complete` only after its last event was acknowledged.

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
| `external_url` | `label`, `url` | `agentSessionUpdate { addedExternalUrls }`, never the whole list; the daemon sends one per pull request of the session's own repository (`Pull Request`, `Pull Request (2)`, …) |
| `usage` | `inputTokens?`, `outputTokens?`, `costUsd?`, `contextUsed?`, `contextSize?` | dashboard only |
| `status` | `state: starting \| running \| waiting_permission \| finishing` | dashboard only |

Rules, enforced by the schema and the server:

- `ephemeral` is legal only on `thought` and `action` — Linear's own rule.
- `signalMetadata` for `select` is `{ options: [{ label?, value }] }`; for `auth` it is
  `{ url?, provider?, providerName? }` with at least one of `url` and `provider`. `provider` is what needs a login —
  an agent id, `github`, or a git host. **The server decides the link and its audience:** a `url` that is public
  `https` passes through (an agent's own URL login); otherwise Linear gets the runner's auth page,
  `<FRONTEND_URL>/runners/<runnerId>/auth/<provider>`, which tells the runner's owner the command to run on that
  machine. `userId` is set by the server to the runner owner's linked Linear identity, else the session's creator;
  a daemon's own value is ignored.
- Markdown is allowed in every `body`. A Linear URL to an issue or profile renders as a mention.
- `eventId` is the idempotency key end to end: it becomes `agent_activities.clientActivityId` and Linear's
  `agentActivityCreate(input.id)`. Resend a batch freely.
- `seq` orders events within a work item; the server inserts in `seq` order and rejects a batch that goes
  backwards (409 `SEQ_REGRESSION`) — that would be a daemon bug, and resending the same batch is not one: an event
  already recorded counts as a `duplicate`, and a `usage` or `status` event at or below the highest `seq` taken is
  treated as one too, since it is recorded nowhere to compare with, and so is an event dropped by a stop. Two
  events in one batch sharing a `seq` are a 406. `seq` is per **claim**: a turn whose lease lapsed and was claimed
  again numbers from 1.
- The first `daemon:events` call for a claimed item moves it to `running`; every call renews its lease. One invalid
  event rejects the whole batch with a 406 whose `key` names it (`events.<index>`).

### `daemon:complete`

`POST /api/daemon/complete`:

```json
{ "workItemId": 813, "outcome": "completed", "acpSessionId": "sess_01…", "branch": "hypotenuse/eng-123-fix-checkout-rounding", "error": null }
```

`outcome`: `completed` \| `failed` \| `cancelled`. `answersConsumed` (optional, ≤ 100) lists the `activityId`s of
delivered [answers](#questions-mid-turn) the turn took as answers. Answers `{ "alreadyTerminal": false }`. Idempotent: completing a
terminal item answers 200 with `{ "alreadyTerminal": true }` — including a late completion of a turn the server
already ended after the stop grace. If the turn emitted no `response`, `error`, or `elicitation`, the server writes
one: "Done." for `completed` (a daemon bug, logged), the `error` text (or a generic one) for `failed`, "Stopped."
for `cancelled`. Routing runs next, so a queued follow-up is offered at once.

### `daemon:telemetry`

`POST /api/daemon/telemetry` — one OTLP/HTTP request of one signal for one turn: an `ExportTraceServiceRequest`,
`ExportMetricsServiceRequest`, or `ExportLogsServiceRequest`, as JSON (`application/json`, what the daemon sends)
or protobuf (`application/x-protobuf`), gzipped or not (`Content-Encoding: gzip`), at most 1 MiB as sent and 8 MiB
inflated. Headers:

| Header | Value |
|---|---|
| `X-Hypotenuse-Signal` | `traces` \| `metrics` \| `logs` |
| `X-Hypotenuse-Work-Item` | the turn's work item id |
| `traceparent` | the turn's trace, as the claim gave it (any span of it) |

Checked in order: the turn is one this runner claimed and the `traceparent` is its trace (409 `NOT_YOUR_WORK`);
the project has an enabled exporter (409 `TELEMETRY_NOT_WANTED`); the turn is live or finished less than
`TELEMETRY_LATE_WINDOW` ago — 5 minutes by default, because the daemon's queue and the agent's last flush land after
`daemon:complete`, which never waits for telemetry (410 `TELEMETRY_LATE`); the body decodes (400); the project's
byte budget has room (429 `TELEMETRY_RATE_LIMITED` with `Retry-After`). Spans and logs of another trace are
dropped, and the server stamps the project, work item, and runner on every resource. Answers 202
`{ "accepted": true }`; the batch is exported later, and the daemon never learns where.

The daemon queues what each turn collects in memory (`[telemetry] buffer_mb`) and posts it every 2 seconds, or
sooner at 1 MB, one request per turn and signal. A 409 or 410 drops the turn's telemetry for good; 429, 5xx, and
network errors retry with backoff inside the buffer. When the buffer is full the oldest log records go first, then
spans, never metrics; what was dropped is reported as the `hypotenuse.telemetry.dropped` counter.

**Every call made for a traced turn carries `traceparent`** — `daemon:events` and `daemon:complete` the
`daemon.turn` span, a tool's `daemon:linear-*` / `daemon:dispatch` its `mcp.call` span — and the server's span for
the call is that span's child, in the runner's own project only. A call without one is not traced.

### Questions mid-turn

A turn may ask a person something and **keep running** while it waits — an agent's permission request under an
`ask` policy, or an ACP `elicitation/create`. The daemon posts an `elicitation` event (with a `select` or `auth`
signal), and the agent process stays blocked on the answer.

| Step | Server | Daemon |
|---|---|---|
| the turn posts an `elicitation` | marks the held item awaiting an answer | keeps the agent waiting; its turn timer pauses, `idle_timeout` keeps running |
| the person replies (Linear `prompted`) | appends the reply to the item's answers instead of queueing a turn, says nothing, and pings the runner | — |
| the next heartbeat | carries it in `answers` | hands it to the waiting question: a choice it matches resumes the agent; anything else is free text |
| the turn ends | `daemon:complete` | lists the answers it took in `answersConsumed` |
| — | every delivered answer not consumed becomes the session's next `prompt` turn (a stopped turn's are dropped: a stop disengages) | — |

A second reply while the first is unread is an ordinary follow-up, queued behind the turn. A turn whose lease
lapses while waiting goes back to the queue with its answers turned into a `prompt` turn behind it.

**A login is a question that ends the turn.** A turn that finds a login missing — the agent's own (`auth_required`
with no method the daemon can run), the git remote's (`git ls-remote` refused on credentials), or the GitHub CLI's
for a worker on github.com — posts an `auth` elicitation naming the `provider` and completes; the agent is
reported unavailable for the agent's own login until `hypotenuse agents login` reloads the daemon. The person's
reply is the next turn, and a turn whose session's last outbound activity was an `auth` elicitation opens with the
thought "Signed in — continuing." (Linear's docs: resume with a thought) once the agent's session opens.

**A turn's final `response` is signed.** The agent's own end-of-turn answer ends with a collapsed block,
`+++ — Hypotenuse (<role>, <agent>)`, naming the agent, its version, and the runner (Linear's AIG #1). Stop and
error activities are not signed.

### `daemon:linear-*` and `daemon:dispatch`

The Linear proxy behind `hypotenuse mcp`: one `POST` action per agent tool, eighteen in all. The tool names,
routes (`/api/daemon/linear/<verb>`, `/api/daemon/dispatch`), roles, and input schemas are one table,
`protocol/src/tools.ts`, which the daemon's MCP server and the server both read. Same auth and header as every
daemon action; the body is the tool's input plus `agentSessionId`. Additive to protocol 1.

`daemon:dispatch` (`{ issue, instructions?, agentPreference?, mode?: "new" | "changes" }`) answers
`{ result: { text, data: { dispatch: { agentSessionId, externalSessionId, externalSessionUrl, issueIdentifier,
mode, reviewRound } } } }`. Beyond the checks below it refuses with 406 — saying why — the manager's own issue, an
issue already dispatched or with a session under way, `changes` for an issue this manager has not dispatched or whose
worker is still working, a round past `routing.maxReviewRounds`, and a dispatch past `manager.maxParallelDispatch`.
A worker session calling it gets the uniform 403 (the tool is not in its list).

The server re-derives the call's scope from the session row on every request:

| Check | Refused with |
|---|---|
| the session exists and is in the runner's project | the uniform 403 |
| its live turn (`claimed` or `running`, no stop requested) is held by **this** runner | the uniform 403 |
| its integration is `active` | the uniform 403 |
| the tool is in the session's role's list (worker ⊂ manager) | the uniform 403 |
| the target rule (`session-issue`, `readable`, `managed`) | 403 saying why |
| input the tool cannot use (an unknown state or label, a body over 64 KB, a pull request on another repository) | 406 saying why |
| something Linear has no record of, as the app sees it | 404 |
| the integration's Linear budget stayed empty (a read waits up to 5 s, a write 30 s) | 429 *"Linear rate limit reached; try again shortly"* |

The uniform 403 is byte-identical whatever the reason, so a runner cannot probe which sessions exist:

```json
{ "error": { "message": "not permitted for this session" } }
```

A success answers Markdown for the model (at most 16 KB, cut at a line boundary) and the same facts as data:

```json
{ "result": { "text": "# ENG-123: Fix checkout rounding\n…", "data": { "issue": { "identifier": "ENG-123" } } } }
```

The plan, a question (`daemon:linear-ask-user`), and a pull request link go through the activity outbox, in the
session's order. A question answers the turn and marks it waiting (so a reply before the turn ends is delivered,
reported unconsumed, and becomes the next turn); the daemon then ends the turn **without** a `response`, which
would take the session out of `awaitingInput`. Every successful write is appended to the work item's
`linearWrites`.

### The control socket's `mcp.hello` and `mcp.call`

`hypotenuse mcp` does not speak to the server: it calls the daemon over the `0600` control socket with the session
id and the turn's nonce (128 random bits, minted at claim and forgotten when the turn ends).

| Method | Params | Answers |
|---|---|---|
| `mcp.hello` | `{ agentSessionId, nonce }` | `{ role, tools, issueIdentifier }`, or JSON-RPC error `-32001` for an unknown nonce, another session's, or an ended turn |
| `mcp.call` | `{ agentSessionId, nonce, tool, input }` | `{ text, data?, isError? }` — a tool error is a result, not an RPC error; the nonce refusal is `-32001` |

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

1. sends ACP `session/cancel` and answers any pending `session/request_permission` with `cancelled` (and any
   pending `elicitation/create` with `cancel`);
2. waits up to `sessions.stop_grace` (config) for the agent's prompt to return `stopReason: cancelled`, then
   closes its stdin, then sends `SIGTERM` and, 5 seconds later, `SIGKILL` to its process group;
3. emits the final activity for the reason, and nothing else — after a `stop` Linear accepts only a `response` or
   an `error`;
4. calls `daemon:complete` with `outcome: "cancelled"`.

| `reason` | Final activity |
|---|---|
| `stop` | `response`: "Stopped at your request. Changes so far are …" — where the work is, and how many files changed — then the cancel's `said`, quoted (`stopQuote`) |
| `dashboard` | `error`: "Cancelled from the Hypotenuse dashboard by <`by`>. Changes so far are …" |
| `delegate_removed`, `issue_closed`, `unassigned`, `integration_revoked` | none — the person disengaged, so the daemon stays quiet. The server enforces it: once one of these is requested, every event for the item is dropped (`dropped` in the answer), and its end posts no fallback |
| `superseded` | none — the item is no longer this runner's |

The daemon ends turns of its own the same way: `agents kill` (an `error` naming it), a drain with `--cancel` or a
shutdown (an `error` saying the runner shut down mid-turn), and `turn_timeout` / `idle_timeout` (an `error`, and
`outcome: "failed"`).

`reason` values: `stop` (a person pressed Stop in Linear), `dashboard`, `delegate_removed` (un-delegated, or the
session dismissed), `issue_closed` (the issue moved to a completed or canceled state, or was deleted),
`unassigned` (the app was unassigned from the issue), `integration_revoked`, `superseded`. A `stop` cancel carries
`said` when the person typed something with the stop: the daemon quotes it in its final answer and never acts on
it, and a bare "Stop" is not quoted. The list may grow without a version bump: a daemon stops the turn for a reason
it does not know and says nothing.

## Error codes

| HTTP | `error.type` | Meaning | Daemon does |
|---|---|---|---|
| 401 | `CONNECTION_SESSION_NOT_FOUND` | bad, revoked, orphaned, or paused (on anything but a heartbeat) token | stop; tell the person to `hypotenuse runner register` |
| 403 | `CONNECTION_CHANNEL_AUTHORIZATION` | a runner token on a non-`daemon:*` action | log as a bug |
| 409 | `MACHINE_IN_USE` | another live runner holds this machine | exit; tell the person which runner |
| 406 | `CONNECTION_ACTION_PARAM_VALIDATION` | schema violation; `key` / event index included | log as a bug; drop the batch item; never retry unchanged |
| 409 | `NOT_YOUR_WORK` | the item is not claimed by this runner | stop work on it silently |
| 409 | `SEQ_REGRESSION` | events out of order | log as a bug |
| 413 | `PAYLOAD_TOO_LARGE` | batch over 256 KiB | split and resend |
| 409 | `TELEMETRY_NOT_WANTED` | `daemon:telemetry` for a turn no enabled exporter wants | drop the turn's telemetry |
| 410 | `TELEMETRY_LATE` | `daemon:telemetry` past the late window | drop the turn's telemetry, counted |
| 429 | `TELEMETRY_RATE_LIMITED` | the project's telemetry byte budget | back off to `Retry-After`; the buffer bounds what waits |
| 426 | `PROTOCOL_UNSUPPORTED` | version outside the server's range | drain; ask for an upgrade |
| 429 | `CONNECTION_RATE_LIMITED` | per-runner limit | back off to `Retry-After` |
| 5xx / network | — | transient | retry with backoff; events are idempotent |
