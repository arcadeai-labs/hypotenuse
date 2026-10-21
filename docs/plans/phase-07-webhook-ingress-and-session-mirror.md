# Phase 7 — Webhook ingress and the session mirror

> **Goal:** Every delivery Linear sends to `@hypotenuse` is verified, recorded once, and answered inside five
> seconds. Every Linear agent session has a mirror row, every prompt a person types into it is recorded, and
> every activity Hypotenuse sends back goes through one ordered, idempotent, rate-budgeted outbox — starting
> with an acknowledgement `thought` that lands well inside Linear's 10-second window.

> **Status: planned, not built.** Builds on [Linear connection](./phase-06-linear-connection.md) (installations,
> `LinearOps`, the finear harness). Runners do not exist yet: in this phase a new session is acknowledged and
> then ended with an `error` saying no runner is connected. [Work routing](./phase-09-work-routing.md) replaces
> that ending with real work.

Linear talks to an agent in exactly one direction it controls — webhooks — and holds the agent to two clocks
while it does. The receiver must answer **within 5 seconds** or the delivery fails; failures are retried
**after 1 minute, 1 hour, and 6 hours**, and a webhook that keeps failing can be **disabled** until somebody
re-enables it by hand. And once a session is `created`, the agent must emit an activity (or set an external URL)
**within 10 seconds**, or Linear shows the session as unresponsive to the person who just asked for help.

Those two clocks shape everything here. The webhook endpoint does nothing slow: it checks a signature, writes a
row, and answers. Everything that talks back to Linear happens after commit, on the worker, through an outbox.
And the outbox has a priority lane, because the acknowledgement is the one write whose lateness a person sees.

There is a third consideration that is easy to miss: **this is one webhook for the whole deployment.** An OAuth
app's webhook URL is set on the app, and Linear creates the per-workspace subscription when each workspace
installs. A receiver that answers 4xx for one workspace's deliveries — say, a workspace that was disconnected
— risks Linear disabling the webhook for *every* workspace. So the rule here is the opposite of ToolExec's
token webhooks: once a delivery is proven to be from Linear, it is answered 200, even when we do nothing with it.

## Scope

**In:**

- `webhooks:linear` — `POST /api/webhooks/linear`, raw body, signature and timestamp checks, delivery dedupe,
  200 fast.
- `linear_events` — every verified delivery, with its processing outcome.
- `linear:process-event` — the per-delivery task that does the work.
- `agent_sessions` and `agent_activities` — the session mirror, inbound prompts, and the outbound outbox.
- `activities:deliver` — the outbox drain, with per-session ordering, client UUIDs, retries, ephemeral
  superseding, and a Redis token bucket per installation (`backend/lua/linear-token-bucket.lua`).
- The acknowledgement `thought` on every `created`.
- Handling for `PermissionChange`, `OAuthApp` `revoked`, `Issue` (delegate removed), `AppUserNotification`
  (recorded), `Comment` (recorded), and unknown types and actions (recorded, ignored).
- The interim ending: `error` — *"No runner is connected for this project yet."*
- `agent-session:list`, `agent-session:view`, `agent-session:activities` read actions (the dashboard pages come
  in [phase 15](./phase-15-dashboard.md); the actions and their tests come now).
- `linear-events:sweep` retention.

**Out:**

- Choosing a role, a repository, or a runner; work items; the stop signal reaching a running agent —
  [phase 9](./phase-09-work-routing.md). In this phase a `stop` prompt is recorded and answered with a `response`
  ("Stopped."), since nothing is running.
- Writing anything other than the acknowledgement and the interim error — the runner's events arrive in phase 9
  through `daemon:events`, into the outbox built here.
- Session `plan`, `summary`, and `externalUrls` writes are *supported by the outbox* here (the `session_update`
  kind) but have no producer until phase 9.
- `agent-session:cancel` — phase 9, where there is something to cancel.

## Design

### The endpoint

`backend/actions/webhooks/webhooks-linear.ts`:

```ts
export class WebhooksLinear implements Action {
  name = "webhooks:linear";
  web = { route: "/webhooks/linear", method: HTTP_METHOD.POST, rawBody: true };
  inputs = z.object({});
  middleware = [];                         // no session; Linear is the caller
  async run(_params, connection) { … }     // answers raw Response objects
}
```

The order of operations is the security argument, so it is fixed and tested step by step:

1. **Cap the body before reading it.** `readCappedBody(connection.rawRequest, LINEAR_WEBHOOK_MAX_BODY_BYTES)`
   (ported from ToolExec's `ops/WebhookOps.ts`), default 5 MiB — the same limit `@linear/sdk`'s
   `LinearWebhookClient` uses, because a session created in a long comment thread carries `previousComments`.
   Over the cap → 413.
2. **Signature on the raw bytes.** `Linear-Signature` is a hex HMAC-SHA256 of the raw body under
   `LINEAR_WEBHOOK_SECRET`. Compare with `crypto.timingSafeEqual` on equal-length buffers — this *is* a
   comparison against a secret, unlike ToolExec's token-hash lookup, so constant time matters. The body is never
   parsed and re-serialized before hashing. Missing or wrong → 401.
3. **Timestamp from the signed body.** Parse JSON; require `|now − webhookTimestamp| ≤ tolerance` (default
   60 000 ms). The `Linear-Timestamp` header is ignored, as the SDK's own `verify()` ignores it: only the body is
   signed. Out of tolerance → 401, **byte-identical** to the bad-signature 401, so a probe cannot tell "your
   signature was right but late" from "your signature was wrong".
4. **Dedupe.** `INSERT INTO linear_events … ON CONFLICT (deliveryId) DO NOTHING RETURNING id`. `deliveryId` is
   the `Linear-Delivery` header (a UUID v4, constant across Linear's retries). A conflict means this is a retry
   of a delivery we already took: answer 200 and do nothing else.
5. **Resolve the installation** by `organizationId` among live rows. Not found (never connected, disconnected,
   revoked) → still 200, `outcome = "unknown_installation"`. See the paragraph above about one webhook for every
   workspace.
6. **Commit, answer 200**, and in `afterCommit` enqueue `linear:process-event { eventId }` on the `linear` queue.
   The worker's sweep (`linear:process-event` also runs as a 5 s clock over `processedAt IS NULL`) picks up
   anything an enqueue missed — the row is the delivery and the job is an accelerant.

**The clock is injectable.** `config.linear.webhookToleranceMs` and `api.linear.now()` (a function the test
harness can replace) decide step 3. finear stamps deliveries with its *virtual* clock, so a test that advances
finear's clock to force a retry produces deliveries the real-time check would refuse. Tests that exercise
retries set the server's clock from finear's `GET /__test/clock`; nothing in production can change it.

Every refusal is logged with the delivery id and reason, never the body. The endpoint is rate-limited by
`RateLimitMiddleware` at the global unauthenticated limit, which Linear's volume never approaches; the real
protection is the signature, which is checked before any database work.

### Security properties, and their tests

| Property | Mechanism | Test (`webhooks-linear.test.ts`) |
|---|---|---|
| Only Linear can create work | HMAC over raw bytes, constant-time compare | a body re-serialized with different whitespace fails; a single flipped hex digit fails |
| Replays expire | signed `webhookTimestamp` within ±60 s | a correctly signed body 61 s old fails, byte-identical to a bad signature |
| Retries are free | unique `deliveryId` | the same delivery three times → one row, one `linear:process-event`, three 200s |
| The webhook is never disabled by our state | verified-but-unroutable → 200 | a delivery for a revoked installation → 200 with `outcome = unknown_installation` |
| Fast | no outbound call before answering | the handler makes no `fetch` (asserted with finear's request log) and answers before the job runs |
| Bounded | 5 MiB cap before reading | a 6 MiB body → 413 without buffering past the cap |
| No secrets or content in logs | log delivery id + reason only | log capture contains no body text |

### `linear_events`

| Column | Notes |
|---|---|
| `id` serial | |
| `deliveryId` text **unique** | `Linear-Delivery` |
| `installationId` int null, FK set null | null when `unknown_installation` |
| `eventType` text | `Linear-Event` / body `type`: `AgentSessionEvent`, `PermissionChange`, `OAuthApp`, `Issue`, `Comment`, `AppUserNotification`, … |
| `action` text | `created`, `prompted`, `teamAccessChanged`, `revoked`, `create`/`update`/`remove`, a notification type, … |
| `webhookTimestamp` timestamptz | from the body |
| `payload` jsonb | the verified body, minus nothing — Linear does not send secrets — but capped by step 1 |
| `receivedAt`, `processedAt` timestamptz | |
| `outcome` text | `pending` → `handled` \| `ignored` \| `unknown_installation` \| `failed` |
| `error` text | for `failed` |

Retention: `linear-events:sweep` deletes rows older than `LINEAR_EVENT_RETENTION_DAYS` (default 14). The
mirror tables, not this one, are the record.

### `agent_sessions` — the mirror

| Column | Notes |
|---|---|
| `id` serial | Hypotenuse's id; the dashboard URL and the `externalUrls` link use it |
| `projectId`, `installationId` | FKs |
| `linearSessionId` text **unique** | `agentSession.id` |
| `linearIssueId`, `issueIdentifier`, `issueTitle`, `issueUrl`, `teamId`, `teamKey` | from `agentSession.issue` |
| `linearCommentId` | the thread's root comment, when the session was started by a mention |
| `sourceCommentId` | the comment that mentioned the agent (child comment for mid-thread mentions) |
| `creatorLinearUserId`, `creatorName`, `creatorEmail` | `agentSession.creator`; **null when an automation or another agent started it** — a fact routing and issue hygiene both read |
| `origin` text | `delegation` \| `mention` \| `proactive` (created by Hypotenuse via `agentSessionCreateOnIssue`) |
| `promptContext` text | Linear's XML-ish context block, verbatim |
| `guidance` jsonb | `[{ body, origin: { type: "Organization" } \| { type: "Team", team: {…} } }]` |
| `previousComments` jsonb | present only for a mention in a child comment |
| `role` text null | `manager` \| `worker`; set by routing |
| `repository` text null | `hostname/owner/name`; set by routing |
| `runnerId` int null | the sticky runner; set by routing |
| `parentAgentSessionId` int null | the manager session that dispatched this one |
| `status` text | mirror of Linear's: `pending`, `active`, `awaitingInput`, `error`, `complete`, `stale`, `stopping` |
| `summary` text, `plan` jsonb, `externalUrls` jsonb | last values we wrote (Linear has no read-your-write lag for us to hide) |
| `createdAt`, `updatedAt`, `endedAt` | |

**Status is derived, never asserted.** Linear computes a session's status from its last activity; Hypotenuse
updates the mirror from (a) the `agentSession.status` on every inbound webhook and (b) the status the activity it
just delivered implies (`thought`/`action` → `active`, `elicitation` → `awaitingInput`, `response` → `complete`,
`error` → `error`). It never sends a status. `stale` arrives only from Linear.

### `agent_activities` — inbound prompts and the outbound outbox

One table, because the conversation is one sequence and rebuilding history (best practice: *from activities,
not comments* — comments can be edited) reads both directions in order.

| Column | Notes |
|---|---|
| `id` serial | |
| `agentSessionId` | FK cascade |
| `seq` int | per session, assigned under the session's row lock; the delivery order |
| `direction` | `inbound` \| `outbound` |
| `kind` | `activity` \| `session_update` (plan / summary / external URLs, via `agentSessionUpdate`) |
| `contentType` | `prompt` (inbound only), `thought`, `action`, `elicitation`, `response`, `error`; `null` for `session_update` |
| `content` jsonb | the exact `content` sent or received; for `session_update`, the `AgentSessionUpdateInput` |
| `ephemeral` boolean | only legal on `thought` and `action` — enforced in `ActivityOutboxOps.enqueue`, matching Linear's validation |
| `signal` text null, `signalMetadata` jsonb null | `stop` (inbound); `select`, `auth` (outbound); `continue` accepted inbound and recorded |
| `clientActivityId` uuid **unique** | generated at enqueue; sent as `agentActivityCreate(input.id)` — the idempotency key |
| `linearActivityId` text null | Linear's id once sent, or the inbound activity's id |
| `sourceCommentId`, `linearUserId` | inbound only |
| `priority` | `ack` \| `normal` \| `bulk` (ephemeral thoughts) |
| `deliveryStatus` | outbound: `pending` → `sent` \| `failed` \| `superseded`; inbound: `received` |
| `attempts`, `nextAttemptAt`, `lastError`, `sentAt` | |
| `createdAt` | |

**Inbound prompt bodies.** The docs say the follow-up text is at `agentActivity.body`; the schema puts it at
`agentActivity.content.body`. `LinearWebhookOps.promptBody(payload)` reads `content.body ?? body` and a test
feeds it both shapes.

### The outbox

`backend/ops/ActivityOutboxOps.ts`:

```ts
/** Append an outbound activity (or session update) to a session's outbox, inside the caller's transaction. */
enqueueActivity(tx, agentSessionId, { content, ephemeral?, signal?, signalMetadata?, priority? }): Promise<Row>
enqueueSessionUpdate(tx, agentSessionId, input: AgentSessionUpdateInput): Promise<Row>
```

`enqueue*` takes the session row `FOR UPDATE`, assigns the next `seq`, generates `clientActivityId`, and then
applies **superseding** in the same statement batch:

- Any still-`pending` **ephemeral** activity earlier in the session is marked `superseded`. Linear replaces an
  ephemeral activity with the agent's next activity anyway; sending it would spend a request to show something for
  a few milliseconds.
- Any still-`pending` `session_update` that sets `plan` is superseded by a newer one that sets `plan` (the plan is
  always replaced whole), likewise `summary`. `addedExternalUrls` are merged, never superseded.

In `afterCommit` the caller enqueues `activities:deliver { agentSessionId }`; the 1-second `activities:deliver`
clock sweeps anything an enqueue missed.

**Delivery** (`activities:deliver`) claims the **head** of each session's pending queue —
`SELECT DISTINCT ON ("agentSessionId") … WHERE "deliveryStatus" = 'pending' AND "nextAttemptAt" <= now()
ORDER BY "agentSessionId", seq FOR UPDATE SKIP LOCKED` — so sessions deliver in parallel and each session
delivers in order. For each head:

1. Take a token from the installation's bucket (below). None available → push `nextAttemptAt` to the bucket's
   next refill, release.
2. `agentActivityCreate({ id: clientActivityId, agentSessionId: linearSessionId, content, ephemeral, signal,
   signalMetadata })`, or `agentSessionUpdate(id, input)` for a `session_update`.
3. Success → `sent`, `linearActivityId`, `sentAt`; update the mirror's `status`/`plan`/`summary`/`externalUrls`.
4. A retry after a lost response sends the same `id`; Linear's answer that the id already exists is treated as
   success — that is what the client id is for.
5. `RATELIMITED` → back off to the reset time from the headers, don't count an attempt.
6. Other retryable errors (5xx, network) → exponential backoff from 1 s, capped at 5 minutes, up to 10 attempts,
   then `failed`.
7. Non-retryable GraphQL errors (validation: e.g. an `ephemeral` `response`, a `summary` with a newline) → `failed`
   immediately, logged with the operation and the error, and the session gets nothing further from that row. These
   are our bugs and the test suite exists to keep them at zero.
8. A session whose installation is `revoked` or `error` → every pending row `failed` with
   `lastError = "installation unavailable"`.

### The token bucket

`backend/lua/linear-token-bucket.lua` (loaded by the ported `initializers/redisScripts.ts`, invoked through
`runRedisScript`): one bucket per installation, key `linear:bucket:<installationId>`.

- **Refill** at Linear's documented OAuth-app limit, 5 000 requests per hour per app user (≈ 1.39/s), burst 60.
  `config.linear.requestsPerHour` overrides it — workspace-level `actor=app` installs get dynamic increases from
  Linear based on paid seats, and the observed `X-RateLimit-Requests-Remaining` from `LinearOps` (phase 6) is fed
  in: if Linear says fewer remain than the bucket thinks, the bucket drops to Linear's number.
- **Reserve.** The last 10 tokens are only available to `priority = ack`. Acknowledgements and stop responses
  never wait behind a busy session's chatter.
- **Complexity** (2 000 000 points/hour, 10 000 per query) is tracked from `X-Complexity` and only alarms — agent
  mutations are cheap and the bucket is request-bound in practice.

A Lua script and not two Redis calls because a check-then-decrement from two worker processes would spend the
same token twice; ToolExec's rule that Lua lives in `backend/lua/*.lua` applies unchanged.

### `linear:process-event`

`backend/actions/linear/linear-process-event.ts` (task-only, queue `linear`), dispatching on `type`/`action`
through `backend/ops/LinearWebhookOps.ts`:

| Event | Effect in this phase |
|---|---|
| `AgentSessionEvent` / `created` | upsert `agent_sessions` (`origin` = `mention` if `comment` present, else `delegation`; `proactive` if Hypotenuse already created a row for this `linearSessionId` — see [phase 14](./phase-14-manager-and-dispatch.md)); enqueue the **ack** `thought` with `priority = ack`; then enqueue the interim `error` (replaced in phase 9) |
| `AgentSessionEvent` / `prompted`, no signal | record the inbound `prompt` activity; reply with the interim `error` |
| `AgentSessionEvent` / `prompted`, `signal = stop` | record it; reply `response` "Stopped. Nothing was running." — AIG's *respect requests to disengage*, made true trivially here and for real in phase 9 |
| `AgentSessionEvent` / any other action | recorded, `outcome = ignored`, logged at warn — Linear types `action` as a free string and may add values |
| `PermissionChange` / `teamAccessChanged` | apply `addedTeamIds` / `removedTeamIds` / `canAccessAllPublicTeams` to the installation; mark mirrored sessions on removed teams `error` locally (we can no longer write to them) |
| `OAuthApp` / `revoked` | installation `revoked`, tokens nulled, every pending outbound row `failed`, admins notified |
| `Issue` / `update` where `updatedFrom.delegateId` was our `appUserId` and `delegateId` no longer is | recorded on the session (`delegateRemovedAt`); phase 9 cancels running work. Linear removes the delegate when a person **dismisses** a session, so this is how a dismissal reaches us |
| `AppUserNotification` / any | recorded, `outcome = handled`; surfaced in the dashboard later. No work starts — sessions are the trigger |
| `Comment`, other data events | recorded, `ignored` |

The ack's text is fixed and honest — *"On it — finding a runner for ENG-123."* in phase 9, and in this phase
*"Received."* — and it says nothing about a model. AIG: an agent always discloses that it is an agent; the app
user's name already does, and nothing we write may imply a person.

**The 10-second path, measured.** Webhook commit → `afterCommit` enqueue → worker picks up `linear:process-event`
→ enqueues the ack and its `activities:deliver` → worker sends. Each hop is a Redis queue round-trip. The test
`agent-session-ack.test.ts` measures webhook receipt to finear's recorded activity and asserts under 3 s on CI,
leaving the rest of the 10 s for a cold worker.

### Read actions

| Action | Route | Level | Returns |
|---|---|---|---|
| `agent-session:list` | `GET /agent-sessions` | member | paginated `{ agentSessions, pagination }`, filters `status`, `role`, `runnerId`, `issueIdentifier` |
| `agent-session:view` | `GET /agent-session/:id` | member | `{ agentSession }` incl. plan, external URLs, `linearUrl` |
| `agent-session:activities` | `GET /agent-session/:id/activities` | member | paginated by `afterSeq`, both directions, `deliveryStatus` visible to members |

All three are MCP tools under the human policy and wrapped by `hypotenuse session list/view` (phase 15 adds
`--follow`).

## Steps

### 1. Schema — `backend/schema/{linear_events,agent_sessions,agent_activities}.ts`

As designed. Indexes: `agent_activities (agentSessionId, seq)` unique; partial index on `(nextAttemptAt) WHERE
deliveryStatus = 'pending'`; `agent_sessions (projectId, status)`; `linear_events (processedAt) WHERE processedAt IS
NULL`.

### 2. Lua — `backend/lua/linear-token-bucket.lua`

Keys: bucket hash. Args: now (ms), refill rate, burst, reserve, priority, observed-remaining (optional). Returns
`{ granted, nextTokenAtMs }`. `__tests__/ops/redis-scripts.test.ts` (ported) picks it up automatically.

### 3. Ops — `backend/ops/{LinearWebhookOps,ActivityOutboxOps,AgentSessionOps}.ts`

`LinearWebhookOps`: `verifySignature(raw, header, secret)`, `checkTimestamp(body, now, tolerance)`,
`promptBody(payload)`, `handleAgentSessionEvent`, `handlePermissionChange`, `handleOAuthAppRevoked`,
`handleIssueEvent`. `AgentSessionOps`: `upsertFromWebhook`, `serializeAgentSession`, `serializeActivity`,
`statusImpliedBy(contentType)`.

### 4. Actions — `backend/actions/webhooks/webhooks-linear.ts`, `backend/actions/linear/linear-process-event.ts`, `backend/actions/activities/activities-deliver.ts`, `backend/actions/agent-session/{agent-session-list,agent-session-view,agent-session-activities}.ts`, `backend/actions/linear/linear-events-sweep.ts`

`webhooks:*` joins the never-MCP prefix assertion (ToolExec's `webhook:*` rule, renamed). `webhooks:linear` is on
the closed list of unaudited writers in [`AGENTS.md`](../../AGENTS.md), with the reason: it records a machine's
delivery, and the decision a person made happened in Linear.

### 5. Config — extend `backend/config/linear.ts`

`webhookMaxBodyBytes` (5 MiB), `webhookToleranceMs` (60 000), `eventRetentionDays` (14), `requestsPerHour`
(5 000), `bucketBurst` (60), `bucketReserve` (10), `deliverMaxAttempts` (10).

### 6. Queue — `backend/config/tasks.ts`

Add `linear` ahead of `default` in priority order: `["linear", "routing", "default"]` (routing arrives in phase 9).

### 7. Tests — `backend/__tests__/webhooks/*.test.ts`, `backend/__tests__/outbox/*.test.ts`

| File | Asserts |
|---|---|
| `webhooks-linear.test.ts` | the security table above, row by row |
| `agent-session-created.test.ts` | `linear.control.delegate(issue)` → one `agent_sessions` row with issue fields, `promptContext`, `guidance`, `creator`; mention via `/__test/agents/mention` → `origin = mention`, `previousComments` stored; finear shows the ack `thought` then the interim `error`; session `error` in finear and in the mirror |
| `agent-session-ack.test.ts` | receipt → finear-recorded ack under 3 s; ack sent even when the bucket is otherwise empty (reserve) |
| `agent-session-prompted.test.ts` | `/__test/agents/prompt` → inbound `prompt` row with the body from either payload shape; `/__test/agents/stop` → recorded with `signal = stop`, answered with a `response` |
| `agent-session-unknown.test.ts` | an unknown `AgentSessionEvent` action and an unknown event type → 200, `ignored` |
| `outbox-ordering.test.ts` | 50 activities across 5 sessions deliver in `seq` order per session and in parallel across sessions |
| `outbox-idempotency.test.ts` | a send whose response is dropped is retried with the same `clientActivityId`; finear holds one activity |
| `outbox-superseding.test.ts` | three pending ephemeral thoughts then a `response` → one request; two pending plan updates → one |
| `outbox-validation.test.ts` | `ephemeral` on `response` is refused at enqueue (never reaches Linear); a `summary` with a newline is refused |
| `outbox-ratelimit.test.ts` | bucket exhaustion defers rows; a `RATELIMITED` answer defers to the reset without counting an attempt |
| `permission-change.test.ts`, `oauth-app-revoked.test.ts`, `issue-delegate-removed.test.ts` | the event table rows (finear emits `OAuthApp revoked` on uninstall; `PermissionChange` and the delegate change are driven through finear mutations or, where finear lacks the event, filed upstream and covered by a signed fixture body) |
| `agent-session-read.test.ts` | the three read actions; pagination; Bowser 403; activities include `deliveryStatus` |

## Verification

```bash
cd backend && bun run migrations && bun run lint
cd backend && bun test __tests__/webhooks __tests__/outbox __tests__/ops/redis-scripts.test.ts
```

Against staging with a real workspace: delegate an issue to `@hypotenuse` → the session shows "Received." within
a second or two, then the "no runner" error; mention it in a comment → same, threaded; press **Stop** → "Stopped."

```bash
psql hypotenuse -c "select event_type, action, outcome, received_at, processed_at - received_at as lag from linear_events order by id desc limit 10;"
psql hypotenuse -c "select s.issue_identifier, a.seq, a.direction, a.content_type, a.delivery_status, a.sent_at - a.created_at as wait from agent_activities a join agent_sessions s on s.id = a.agent_session_id order by a.id desc limit 20;"
```

## Definition of done

- [x] `webhooks:linear`: cap → signature (constant time, raw bytes) → signed timestamp ±60 s → dedupe → 200
- [x] Verified deliveries for unknown or revoked installations answer 200
- [x] Bad signature and stale timestamp are byte-identical 401s
- [x] Injectable clock and tolerance for finear's virtual time
- [x] `linear_events`, `agent_sessions`, `agent_activities` with the indexes above
- [x] Outbox: per-session `seq`, client UUIDs as `agentActivityCreate.id`, superseding, retries, `RATELIMITED`
- [x] Token bucket in Lua with an `ack` reserve, fed by observed headers
- [x] Ack `thought` for every `created`, measured under 3 s on CI
- [x] `PermissionChange`, `OAuthApp revoked`, delegate removal, `AppUserNotification`, unknown types handled
- [x] Stop answered; prompt body read from both payload shapes
- [x] Read actions with pagination and RBAC; `webhooks:*` never MCP
- [x] Interim "no runner" error, named in Scope as replaced by work routing

## Learnings from the build

### What is built

All twelve Definition of done items. The backend gained three tables (`linear_events`, `agent_sessions`,
`agent_activities`; one migration), two Lua scripts (`linear-token-bucket.lua`, `release-lock.lua`), five ops
modules (`LinearWebhookOps`, `AgentSessionOps`, `ActivityOutboxOps`, `LinearBucketOps`, `LockOps`), nine actions
(`webhooks:linear`, `linear:process-event`, `linear:process-pending`, `linear-events:sweep`,
`activities:deliver`, `activities:deliver-due`, `agent-session:list`, `agent-session:view`,
`agent-session:activities`), and the `linear-revoked` notification. The CLI gained `hypotenuse session
list|view` at 0.3.0, and the public docs an *Agent sessions* page. Nothing has been tried against a real Linear
workspace yet: the staging check under Verification is still to do.

### Where the build departs from the plan

- **The suites live in `backend/__tests__/linear/`**, named as [`LINEAR_COVERAGE.md`](../LINEAR_COVERAGE.md)
  names them — `webhook-ingress`, `webhook-robustness`, `process-event`, `session-mirror`, `activity-outbox`, and
  `ack` (the real-worker latency test) — plus `__tests__/actions/agent-session.test.ts` for the read actions.
  The plan's `outbox-*` and `agent-session-*` files are folded into those. `inject.ts` signs what finear cannot
  send, typed with `@linear/sdk/webhooks`; `sessions.ts` holds `settle()`, which runs the processing and delivery
  jobs in-process until both report nothing to do.
- **The two sweeps are their own clock actions**, `linear:process-pending` (5 s) and `activities:deliver-due`
  (1 s), not `linear:process-event` and `activities:deliver` with a frequency. A Keryx clock gets the `JobLock`,
  `QueueLock`, and `DelayQueueLock` plugins and re-enqueues itself after *every* run, a run enqueued with params
  included, so one action doing both would start a new recurrence per webhook.
- **Per-session order is a Redis lease, not `DISTINCT ON … FOR UPDATE SKIP LOCKED`.** Postgres refuses `FOR
  UPDATE` with `DISTINCT`, and skipping a locked head would send the row behind it first. Holding the session's
  row lock across the call to Linear would block every enqueue on that session for as long as Linear takes, so
  `deliverSession` holds `activities:deliver:<id>` (released only by its holder, `release-lock.lua`) and the
  clock fans out across sessions, eight at a time.
- **The webhook has no rate-limit middleware.** The plan put it behind the unauthenticated limit, "which
  Linear's volume never approaches" — but that limit is 20 a minute per address, every workspace's deliveries come
  from Linear's few addresses, and one busy workspace's issue and comment events pass it. A 429 is a failed
  delivery, and enough of them disable the webhook for everyone. The signature is checked before any database
  work and the body capped before it is read; `webhook-robustness.test.ts` asserts the limit is live elsewhere
  and never answers a delivery.
- **A delivery run starts no row after a third of its lease** (six request deadlines), so a slow Linear cannot let
  the lease lapse mid-send and a second sender in behind it; the clock picks the rest up a second later.
- **Queue order is `["linear", "orchestrator", "default"]`.** The plan said `linear, routing, default`; the
  notification clocks already ran on `orchestrator`, and the old value was `*`. `tasks.test.ts` asserts every
  queue an action names is drained.
- **`bulk` keeps twice the reserve.** The plan named the priority without saying what it does; ephemeral chatter
  now yields first.
- **Linear's remaining count is applied once per observation, and only until Linear's reset** (an hour when no
  reset was sent). Otherwise a bucket that expired while idle is recreated pinned to a count from a window long
  over — which the suite found, one test's `RATELIMITED` starving the next.
- **The acknowledgement is sent once per session**: a `created` for a session that already has an outbound row
  (a replay, or a session Hypotenuse started) is mirrored and not acknowledged again.
- **A failed event is processed**, `outcome = failed` with the error: a delivery that fails the same way every
  time must not be retried every five seconds forever. An `unknown_installation` delivery is processed at
  ingress and gets no job.
- **Session events do not lock the installation row**; only `PermissionChange` and `OAuthApp` do. The token
  refresh holds that row lock across its call to Linear, and every session event would wait on it.
- **More than the plan's columns:** `agent_sessions.linearUrl` (Linear's page for the session) and
  `delegateRemovedAt` (read by cancellation). `parentAgentSessionId` is left to the manager, which adds it;
  `runnerId` has no foreign key until runners exist. `creatorEmail` is stored and not serialized.
- **`LINEAR_WEBHOOK_SECRET_PREVIOUS`** (LC-OAUTH-24): while set, a delivery signed with either secret verifies,
  and [`DEPLOY.md`](../DEPLOY.md)'s rotation runbook uses it. A body that verifies but is not a JSON object gets
  the same 401 as a bad signature; a delivery with no `Linear-Delivery` is deduplicated by its bytes' sha256.
- **The interim answers:** "Received." then "No runner is connected for this project yet." on `created`, the
  same error on `prompted`, and "Stopped. Nothing was running." (`ack` priority) on a stop. A team-access change
  marks sessions on removed teams `error` and fails their unsent rows; `OAuthApp` / `revoked` writes exactly what
  `linear:disconnect` writes.
- **The outbox refuses at enqueue** what Linear would refuse: an ephemeral non-thought, a `prompt`, an empty
  body, `stop` or a signal off an elicitation, a summary that is not one line of 1–255 characters, a malformed
  plan, an empty update, and `externalLink` or a whole-list `externalUrls` (only `addedExternalUrls` /
  `removedExternalUrls` are written). `LinearAgentSessionUpdateInput` lost its `externalLink` field.
- **Rule 13:** `hypotenuse session list` (`--status`, `--role`, `--issue`) and `session view <id>`; `--follow`
  waits for the dashboard. The task actions and clocks are out of scope.

### Traps found while building

- **finear refuses an agent's activity on a terminal session** until a person prompts it open again — so after
  the interim error every session is closed. Suites that write their own activities start from
  `mirroredQuietly()`, which mirrors a delegation without acknowledging it.
- **finear records an activity a moment before the worker records it sent.** The real-worker test waits for both.
- **finear's one-minute retry is still inside ±60 s of real time**; only the one-hour retry needs the clock
  aligned to finear's, so that is the retry the test drives.
- **finear answers a reused activity id with `CONFLICT`, "Agent activity ID already exists".** Linear does not
  document its wording, so the outbox counts either the code or "already exists" as sent.
- **Redis outlives `clearDatabase`.** Ids restart in every file, so the next file's installation 1 inherited an
  empty token bucket and its event 1 a queued job for someone else's. `buildTestUniverse()` now clears the
  `linear` queue and the `linear:*` / `activities:*` keys.
- **A config snapshot taken at module load is a previous file's.** `Object.assign(config.linear, saved)` in a
  `beforeEach` restored the last file's finear URL when files ran together; restore only the keys a test changes.
- **Drizzle's debug logger prints every query with its parameters**, webhook bodies included. Deployments run at
  `info`; the no-body-in-logs test filters to `info` and above, which is what a deployment emits.
- **`@linear/sdk`'s webhook payload types say `createdAt: Date`**, though the wire carries a string.
