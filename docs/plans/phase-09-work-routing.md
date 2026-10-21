# Phase 9 — Work routing

> **Goal:** Every turn of every Linear agent session becomes a **work item** that lands on exactly one suitable
> runner — the issuer's own machine when it can take it, any eligible runner when it cannot, and the same runner
> again for every follow-up in that session. The role (manager or worker) and the repository are chosen before the
> work is offered, by rules an admin can read and by Linear's own repository suggestions, and a person is asked only
> when the answer is genuinely ambiguous. Nothing is ever silently dropped: work that cannot be placed says so in
> Linear, and work that is stopped stops.

> **Status: planned, not built.** Builds on [the session mirror and outbox](./phase-07-webhook-ingress-and-session-mirror.md)
> and [runners](./phase-08-runners.md). Replaces phase 7's interim "no runner is connected" ending. The daemon that
> claims and executes the work is [phase 10](./phase-10-daemon-and-config.md) and
> [phase 11](./phase-11-acp-agent-host.md); this phase is tested with a scripted daemon client.

This is the phase the user-visible promise rests on: *I delegated an issue, and the right agent on the right
machine picked it up.* "Right" has four parts, decided in this order, each by the cheapest source that can decide
it:

1. **Which role** answers — a manager or a worker. A project's ordered routing rules decide from facts on the
   issue and the prompt; the default is worker.
2. **Which repository** the work happens in. The union of what eligible runners have checked out bounds the
   choice; Linear's `issueRepositorySuggestions` ranks it; a person picks only when Linear is unsure.
3. **Which runners** could take it — online, enabled, not draining, a free slot, the role, the repository, and
   subscriptions matching the issue.
4. **Which one of those** — the one already holding the session's worktree, then the issuer's, then the
   least-loaded.

Placement is an *offer*, not an assignment. The server never pushes work into a runner; it pings, and the runner
claims under a row lock. A claim carries a lease that the runner's heartbeat keeps alive, and a lease that lapses
puts the work back. Postgres is the source of truth at every step, so a dropped socket, a crashed worker, or a
laptop lid closing mid-turn costs time, never a turn.

## Scope

**In:**

- `work_items`, `routing_rules`, `external_identities` tables; the `routing` section of project settings.
- `RoutingOps`: role selection, repository selection, eligibility, ranking.
- The `select` elicitation for repository choice, and parsing the person's answer from the next prompt.
- Issuer preference via `external_identities` (explicit link, or e-mail match to a project member).
- Sticky follow-ups and the `stickyTimeout` fallback.
- `work:route` (offers), `work:reap` (gains lease expiry), `sessions:keepalive`.
- `daemon:claim`, `daemon:events`, `daemon:complete`; `daemon:heartbeat` starts returning `offers` and `cancels`
  and renewing leases.
- Cancellation: the Linear `stop` signal, delegate removal, integration revoke, runner revoke, and
  `agent-session:cancel` from the dashboard or CLI.
- Prompts that arrive during a running turn are queued (merged) behind it.
- `routing-rule:*`, `external-identity:*`, `agent-session:cancel` actions; `hypotenuse routing`, `identity`, and
  `session cancel` commands.
- `protocol/src/{work,events,complete}.ts`.

**Out:**

- Executing the work: worktrees, ACP, the event mapping on the daemon side —
  [phases 10–12](./phase-10-daemon-and-config.md).
- Moving the issue to a `started` state and setting the delegate —
  [phase 12](./phase-12-worktrees-and-session-lifecycle.md).
- `dispatch` and `review` work-item kinds are declared here (the enum is final) and produced by
  [phase 14](./phase-14-manager-and-dispatch.md).
- The routing-rules editor UI beyond a simple list form — [phase 15](./phase-15-dashboard.md).

## Design

### `work_items`

One row per **turn**: the session's creation, a follow-up prompt (possibly several merged), a manager's dispatch,
or a manager review.

| Column | Notes |
|---|---|
| `id` serial | |
| `projectId`, `agentSessionId` | FKs cascade |
| `kind` | `session_created` \| `prompt` \| `dispatch` \| `review` |
| `role` | `manager` \| `worker` — copied from the session; fixed for the session's life |
| `status` | `queued`, `offered`, `claimed`, `running`, `completed`, `failed`, `cancelled`, `expired` |
| `repository` | `github.com/acme/web` or null (a manager may work without one) |
| `prompt` jsonb | for `prompt` kind: `[{ activityId, body }]` — merged follow-ups in order |
| `preferredUserId` | the issuer's Hypotenuse user, if resolved |
| `stickyRunnerId` | the runner holding the session's worktree, if any, when this item was created |
| `offeredToRunnerId`, `offerExpiresAt` | current offer |
| `runnerId`, `claimedAt`, `leaseExpiresAt` | current claim |
| `agentId` | the runner's agent for this role, recorded when the item is offered; counted against `limits.agents` |
| `cancelRequestedAt`, `cancelReason` | `stop`, `delegate_removed`, `integration_revoked`, `runner_revoked`, `dashboard`, `superseded` |
| `attempts` | claims that ended without completion (lease lapses) |
| `outcome` jsonb | from `daemon:complete`: `{ outcome, error?, acpSessionId?, branch? }` |
| `createdAt`, `updatedAt`, `finishedAt` | |

**At most one active turn per session**: a partial unique index on `(agentSessionId) WHERE status IN ('offered',
'claimed', 'running')`. Queued items wait their turn in `id` order. This is what makes a follow-up see the
previous turn's result, and what keeps two runners from editing one worktree.

```
 queued ──work:route──► offered ──daemon:claim──► claimed ──first daemon:events──► running ──daemon:complete──► completed
   ▲                       │                         │                               │                          failed
   │                       └── offerExpiresAt ──────►│ (back to queued, next runner)  │                          cancelled
   └─────────── leaseExpiresAt (work:reap) ──────────┴───────────────────────────────┘
 queued ── routing.queueTimeout with no eligible runner ──► expired            (session gets an `error`)
 queued/offered ── cancel ──► cancelled                     claimed/running ── cancel ──► cancelRequestedAt, then the
                                                                                          runner completes `cancelled`
```

### `routing_rules` — choosing the role

| Column | Notes |
|---|---|
| `id`, `projectId` | |
| `position` int | evaluation order; `routing-rule:reorder` rewrites them |
| `name` text | shown in the dashboard and in the session's first thought |
| `enabled` boolean | |
| `match` jsonb | all present fields must match (AND); absent fields match anything |
| `role` | `manager` \| `worker` |
| `repository` text null | optional pin; bypasses repository selection |

`match` fields (zod `RoutingMatch` in `backend/ops/RoutingOps.ts`):

| Field | Matches when |
|---|---|
| `labels: string[]` | the issue carries **any** of these labels (case-insensitive) |
| `teamKeys: string[]` | the issue's team key is one of these |
| `projectIds: string[]` | the issue is in one of these Linear projects |
| `promptPrefix: string` | the triggering text starts with this token, e.g. `/manage` or `/work` |
| `hasParent: boolean` | the issue is (or is not) a sub-issue |
| `origin: "delegation" \| "mention"` | how the session started |

**The triggering text** is the body of the comment that mentioned the agent (`sourceComment`), or for a
delegation, nothing — a delegation has no prompt, and `promptPrefix` rules simply do not match it. A matched
prefix is stripped before the text reaches the agent.

**Seeded rules.** When an integration is created, two rules are inserted at positions 0 and 1:
`{ promptPrefix: "/manage" } → manager` and `{ promptPrefix: "/work" } → worker`. Admins can edit, disable, or
delete them; they are seeded rather than hard-coded so the whole decision is visible in one list.
**The fallthrough is `worker`.** The session's first activity names the decision —
*"Routing as **manager** (rule: Labelled PRD)."* — because AIG asks an agent to be transparent about its state,
and a person who wanted the other role should be able to see why without opening Hypotenuse.

**The role is fixed for the session's life.** A `/manage` in a follow-up prompt does not change roles; the session
answers with a thought saying so. Changing role is a new session (a new mention).

### Repository selection

`RoutingOps.selectRepository(session, eligibleRunnersIgnoringRepository)`:

1. A matched rule's `repository` pin wins.
2. Otherwise the **candidates** are the union of `repositories[].remote` across runners eligible for this role and
   these subscriptions. Zero candidates and role `worker` → the work cannot be placed yet: it stays `queued`
   with a waiting thought (below). Zero candidates and role `manager` → `repository = null`; a manager can work on
   Linear alone, in a scratch directory.
3. One candidate → chosen.
4. More than one → `issueRepositorySuggestions(issueId, agentSessionId, candidateRepositories:
   [{ hostname, repositoryFullName }])`. Linear ranks them with an LLM over the issue, the session, guidance, and its
   own signals (linked issues, recent PRs). The top suggestion with `confidence ≥ routing.repositoryConfidence`
   (default `0.7`) is chosen.
5. Otherwise the session receives an **`elicitation`** with `signal: "select"` and
   `signalMetadata: { options: [{ label: "acme/web", value: "https://github.com/acme/web" }, …] }` (Linear renders
   GitHub repository URLs with extra detail), ordered by Linear's confidence, capped at 8. The session row
   records `pendingRepositoryChoice` (jsonb: the candidates), and **no work item is created yet**.

**The answer comes back as an ordinary `prompt`.** Linear sends a `select` choice as the prompt's body, and a
person may also ignore the options and type. `RoutingOps.parseRepositoryAnswer(body, candidates)` accepts, in
order: an exact match on a value, a label, or `owner/name` (case-insensitive, trailing `.git` and slashes
ignored); then exactly one candidate's `owner/name` or `name` appearing as a word in the text. No match → one
more `select` elicitation (*"I couldn't match that to a repository I can work in…"*); a second miss → `error`
naming the candidates. There is no server-side LLM, deliberately: guessing which repository a person meant is
the one decision where a wrong guess costs a whole turn in the wrong codebase.

### Eligibility

`RoutingOps.eligibleRunners(tx, workItem, session)` — one SQL query, not a loop over rows:

- `runners.projectId = session.projectId`, `status = 'online'`, `enabled`
- `roles ? workItem.role`
- `repository IS NULL OR runners.repositories @> [{ remote: repository }]`
- an agent configured for the role is `available` (the daemon reports per-role agent availability)
- **subscriptions**: for each kind (`team`, `project`, `label`), either the runner has no rows of that kind, or
  one matches (team key; project id; any of the issue's labels)
- **capacity, at three levels**, all counted on the server over `work_items` in `offered` / `claimed` / `running`
  for this runner (the heartbeat's `activeCount` is for display, because it lags by up to a beat):
  - machine: `count(all) < limits.maxParallelJobs`
  - role: `count(role = item.role) < limits.roles[item.role]`, when that key is set
  - agent: `count(agentId = A) < limits.agents[A]`, when set, where `A` is the agent this runner uses for
    `item.role` (from `capabilities.agents[].roles`). `work_items.agentId` is recorded at offer time, so an
    offered-but-unclaimed item already counts against its agent.

### Ranking: sticky, then issuer, then anyone

`RoutingOps.rankRunners` orders the eligible set:

1. **Sticky.** `session.runnerId` — the runner holding this session's worktree — first, always. If it is **not
   eligible** (offline, full, draining): the item waits, the session gets a thought — *"Waiting for **evan-mbp**,
   which has this session's worktree."* — and after `routing.stickyTimeout` (default 10 minutes; `0` disables the
   wait) stickiness is dropped: the item is offered to others, `session.runnerId` moves to whoever claims it, and the
   assignment says `fresh: true` so the new runner creates a new worktree and rebuilds history from activities.
2. **The issuer's runners.** `preferredUserId`'s runners next, least-loaded first.
3. **Everyone else**, least-loaded (lowest used / `maxParallelJobs`) first, ties broken by longest-idle.

### Who the issuer is: `external_identities`

| Column | Notes |
|---|---|
| `id`, `type`, `integrationId`, `userId` | `type` is the trigger type (`linear`); `userId` is always the Hypotenuse user |
| `externalUserId`, `externalName`, `externalEmail` | the person in the trigger system (a Linear user's id, name, e-mail) |
| `linkedVia` | `email` \| `oauth` \| `admin` |
| unique `(integrationId, externalUserId)` | one Hypotenuse user per trigger-system user per workspace |

Resolution, in `RoutingOps.resolveIssuer(session)`: an existing row for `creatorExternalUserId`; else a project
member whose e-mail equals `creatorEmail` (case-insensitive) — recorded as `linkedVia = email` so it is visible
and removable; else none. `creator` is null when an automation or another agent started the session, and then
there is no issuer.

The e-mail match is a **preference**, never an authorization: it only reorders runners that are already eligible
in the same project. That is why an unverified e-mail is acceptable here and would not be anywhere else.
`external-identity:link` lets a member prove their Linear account with a Linear **user** OAuth round-trip
(`actor=user`, scope `read`, `viewer { id email name }`, token discarded immediately) — `linkedVia = oauth` — and
lets an admin link anyone (`admin`).

### Offers and claims

`work:route` (enqueued after any change that could make work placeable — a new item, a completion, a heartbeat
that freed capacity or came online — and as a 5 s clock):

1. For each `queued` item in `id` order whose session has no active item: compute eligibility and ranking.
2. Pick the first ranked runner that has **not** declined or let an offer to this item lapse in the last
   `routing.offerTtl × 3`. Set `status = offered`, `offeredToRunnerId`, `offerExpiresAt = now + offerTtl`
   (default 10 s).
3. In `afterCommit`, publish `{ event: "work" }` on `runner:<id>`. The runner's immediate heartbeat lists it in
   `offers`.
4. No eligible runner: keep `queued`; if `routing.queueTimeout` (default 30 minutes) has passed since `createdAt`,
   set `expired` and enqueue an `error`: *"No runner took this within 30 minutes. 2 runners are subscribed to ENG;
   both are offline."* — naming the reason the data supports (none subscribed, none online, none with the
   repository, all full).

`daemon:claim` (`POST /api/daemon/claim`, body `{ workItemIds?: number[] }`):

```sql
SELECT … FROM work_items
 WHERE status = 'offered' AND "offeredToRunnerId" = $runner AND "offerExpiresAt" > now()
   [AND id = ANY($ids)]
 ORDER BY id
 FOR UPDATE SKIP LOCKED
 LIMIT 1
```

then re-checks capacity under the lock, sets `claimed`, `runnerId`, `claimedAt`, `leaseExpiresAt = now + leaseMs`
(60 s), `session.runnerId = runner` (stickiness established on first claim), and answers a `WorkAssignment`
([`RUNNER_PROTOCOL.md`](../RUNNER_PROTOCOL.md#daemonclaim)): ids, kind, role, repository and branch hint, `fresh`,
the issue snapshot, `promptContext`, guidance (team before workspace), `history` rebuilt from `agent_activities`
(both directions, `sent`/`received` only, in `seq` order), the prompt for this turn, and the lease. Nothing to
claim → `{ assignment: null }`, not an error.

The lease is renewed by every heartbeat whose `active` list names the item and by every `daemon:events` call.
`work:reap` (15 s) returns `claimed`/`running` items whose lease lapsed to `queued`, `attempts + 1`, keeping
`stickyRunnerId` (a laptop that slept for a minute should get its session back). `attempts > 3` → `failed` with an
`error` activity.

### `daemon:events` — the runner's voice

`POST /api/daemon/events`, `{ workItemId, events: SessionEvent[] }`, ≤ 100 events and 256 KiB per call. Each
event has an `eventId` (UUID v4, generated by the daemon) and a `seq` (per work item, monotonic). The server:

1. Verifies the item is claimed by this runner (else 409 `NOT_YOUR_WORK`), moves `claimed → running` on the first
   call, renews the lease.
2. Validates every event against `protocol/src/events.ts` (the union below). One invalid event rejects the batch
   with 406 and the index, so the daemon's mapping bugs surface in its log rather than in Linear.
3. Writes each event into the outbox with **`clientActivityId = eventId`**. The daemon's retry of a batch whose
   response it lost is therefore idempotent end to end — the duplicate insert is ignored, and if it was already
   sent, Linear holds one activity.
4. Applies the stop rule: once `cancelRequestedAt` is set, only `response` and `error` are accepted (Linear's
   `stopping` state allows nothing else); other events are dropped and counted in the response.

| `SessionEvent.type` | Outbox entry |
|---|---|
| `thought { body, ephemeral }` | `thought` activity |
| `action { action, parameter, result?, ephemeral }` | `action` activity |
| `elicitation { body, signal?: "select" \| "auth", signalMetadata? }` | `elicitation` activity |
| `response { body }` | `response` activity |
| `error { body }` | `error` activity |
| `plan { entries: [{ content, status }] }` | `session_update { plan }` (status mapped: `in_progress` → `inProgress`) |
| `summary { title }` | `session_update { summary }` (1–255 chars, single line — enforced) |
| `external_url { label, url }` | `session_update { addedExternalUrls }` |
| `usage { … }`, `status { state }` | stored on the work item for the dashboard; not sent to Linear |

### `daemon:complete`

`POST /api/daemon/complete`, `{ workItemId, outcome: "completed" | "failed" | "cancelled", error?, acpSessionId?,
branch? }`. Marks the item terminal, stores `outcome`, and then **guarantees the session is not left hanging**: if
no `response`, `error`, or `elicitation` was emitted during this turn, the server enqueues one — `response`
"Done." for `completed` (a daemon bug, logged), `error` with the given message for `failed`, `response` "Stopped."
for `cancelled`. Then `work:route` runs, so a queued follow-up starts immediately.

### Follow-ups, merging, and the stop signal

On `prompted` without a signal: record the inbound activity; if the session has `pendingRepositoryChoice`, parse
it (above); else if a `queued` `prompt` item exists for the session, **append** to its `prompt` array (two
messages typed while the agent was busy are one turn's input); else insert a `prompt` item. If a turn is
running, the person gets a thought: *"Got it — I'll read this when the current step finishes."*

On `prompted` with `signal: "stop"`, and on every other cancel reason:

| Item status | Effect |
|---|---|
| `queued`, `offered` | `cancelled` immediately; `response` "Stopped before starting." |
| `claimed`, `running` | `cancelRequestedAt`; `{ event: "cancel" }` on `runner:<id>`; next heartbeat's `cancels` lists it; the daemon sends ACP `session/cancel`, emits a final `response` saying what state the work is in, and completes `cancelled` |
| no answer within `routing.stopGraceMs` (30 s) | the server enqueues `response` *"Stopped. The runner didn't confirm; its last state is unknown."* and marks the item `cancelled`; a late `daemon:complete` is accepted and ignored |

Queued items behind a cancelled turn are cancelled too (`superseded`) — Linear's stop means *stop*, and AIG asks
the agent to re-engage only on a clear new signal, which is the next prompt.

Other cancel sources: `Issue` delegate removed (a person dismissed the session) and `OAuthApp revoked` cancel every
non-terminal item for the issue/integration; `runner:revoke` cancels nothing but returns its items to `queued`
(the *work* is still wanted); `agent-session:cancel` behaves like `stop`.

### Keeping sessions alive

Linear marks a session `stale` after 30 minutes without an activity. `sessions:keepalive` (60 s) finds sessions
whose newest outbound activity is older than 25 minutes and which are **waiting on Hypotenuse** — queued, sticky
waiting, lease lapsed — and enqueues an ephemeral thought saying what they are waiting for. Sessions waiting on a
**person** (`awaitingInput`) are left alone: stale is the right state for a question nobody has answered. The daemon
sends its own keepalives during long turns ([phase 12](./phase-12-worktrees-and-session-lifecycle.md)).

### Project settings — the `routing` section

`project_settings.routing` jsonb, edited through `project:settings-edit` (admin, audited):

| Key | Default |
|---|---|
| `queueTimeoutMs` | 1 800 000 (30 min) |
| `stickyTimeoutMs` | 600 000 (10 min) |
| `offerTtlMs` | 10 000 |
| `repositoryConfidence` | 0.7 |
| `stopGraceMs` | 30 000 |
| `maxReviewRounds` | 3 (read by [phase 14](./phase-14-manager-and-dispatch.md)) |

### Actions

| Action | Route | Level | Audited | MCP | CLI |
|---|---|---|---|---|---|
| `routing-rule:list` | `GET /routing-rules` | member | read | yes | `routing list` |
| `routing-rule:create` | `PUT /routing-rule` | admin | yes | yes | `routing add` |
| `routing-rule:edit` | `POST /routing-rule/:id` | admin | yes | yes | `routing edit` |
| `routing-rule:delete` | `DELETE /routing-rule/:id` | admin | yes | yes | `routing remove` |
| `routing-rule:reorder` | `POST /routing-rules/order` | admin | yes | yes | `routing reorder` |
| `external-identity:list` | `GET /external-identities` | member | read | yes | `identity list` |
| `external-identity:link` | `PUT /external-identity` | member (self, via Linear user OAuth) / admin (anyone) | yes | self-link no (browser hop); admin link yes | `identity link` |
| `external-identity:unlink` | `DELETE /external-identity/:id` | self or admin | yes | yes | `identity unlink` |
| `agent-session:cancel` | `POST /agent-session/:id/cancel` | member | yes — a person's decision | yes | `session cancel` |
| `daemon:claim`, `daemon:events`, `daemon:complete` | `POST /daemon/*` | runner token | no (machine half) | never | — |
| `work:route`, `work:reap`, `sessions:keepalive` | — | task | no | never | — |

## Steps

### 1. Protocol — `protocol/src/{work,events,complete}.ts`

`WorkAssignment`, `ClaimRequest/Response`, `SessionEvent` (discriminated union), `EventsRequest/Response`,
`CompleteRequest`. Heartbeat's `Offer` = `{ workItemId, agentSessionId, kind, role, offerExpiresAt }`; `Cancel` =
`{ workItemId, reason }`.

### 2. Schema — `backend/schema/{work_items,routing_rules,external_identities}.ts`; `agent_sessions.pendingRepositoryChoice`

### 3. Ops — `backend/ops/{RoutingOps,WorkItemOps,IdentityOps}.ts`

`RoutingOps`: `selectRole`, `selectRepository`, `parseRepositoryAnswer`, `eligibleRunners`, `rankRunners`,
`explainUnplaceable`. `WorkItemOps`: `createForCreated`, `createOrMergePrompt`, `offer`, `claim`, `renewLeases`,
`reapLeases`, `requestCancel`, `complete`, `serializeWorkItem`, `buildAssignment`, `rebuildHistory`.
`IdentityOps`: `resolveIssuer`, `linkByEmail`, `linkByOAuth`.

### 4. Replace the interim ending — `backend/ops/LinearWebhookOps.ts`

`created` → ack (*"On it — finding a runner for ENG-123."*) → role → repository → work item → `work:route`.
`prompted` → as above. `stop` → cancel.

### 5. Actions — `backend/actions/daemon/{daemon-claim,daemon-events,daemon-complete}.ts`, `backend/actions/work/{work-route,work-reap}.ts`, `backend/actions/agent-session/{agent-session-cancel,sessions-keepalive}.ts`, `backend/actions/routing-rule/*.ts`, `backend/actions/external-identity/*.ts`

`daemon:heartbeat` gains `offers`, `cancels`, and lease renewal. `routing` joins the task queue list after `linear`.

### 6. Seeding — `backend/ops/LinearOAuthOps.ts`

Insert the two prefix rules on first install.

### 7. CLI — `cli/src/commands/{routing,identity,session}.ts`

`routing add --role manager --label PRD --name "PRDs"` (labels and teams validated against `integration:catalog`);
`identity link` opens the browser; `session cancel <id>`.

### 8. Frontend — routing rules list and form in `frontend/src/components/settings/sections/Routing.tsx`; identities in `Account`

### 9. Docs — `frontend/src/content/docs/{routing,manager-and-worker}.md`

How role, repository, and runner are chosen, in that order, with the seeded rules and the defaults; what the
person sees in Linear at each step.

### 10. Tests — `backend/__tests__/routing/*.test.ts`

A `ScriptedDaemon` helper (`backend/__tests__/helpers/scriptedDaemon.ts`) registers a runner over HTTP, heartbeats
with given capabilities, holds a socket, claims, posts events, and completes — the real wire, no daemon process.

| File | Asserts |
|---|---|
| `role-selection.test.ts` | rule order; each `match` field; prefix stripped; default worker; seeded rules exist; role fixed on follow-up |
| `repository-selection.test.ts` | pin wins; single candidate; finear `/__test/repository-suggestions` above and below threshold; `select` elicitation shape with GitHub URLs; answer parsing (value, label, `owner/name`, free text with one name, two misses → error) |
| `eligibility.test.ts` | each condition in isolation, as a whole-set equality on the eligible ids; empty subscription kind matches all; capacity counted server-side at all three levels (a runner with machine room but a full role, or a full agent, is not eligible; an offered item already counts) |
| `ranking.test.ts` | sticky first; sticky offline → waiting thought, then after `stickyTimeoutMs` (column-controlled) offered elsewhere with `fresh: true`; issuer's runner before a less-loaded stranger; e-mail match recorded as `linkedVia = email`; null creator → no preference |
| `claim.test.ts` | only the offered runner can claim; expired offer → re-offered to the next; `cap × 4` concurrent claims from many runners never exceed any runner's capacity and never double-claim |
| `lease.test.ts` | heartbeats renew; lapse → `queued` with `attempts + 1` and stickiness kept; fourth lapse → `failed` + `error` |
| `events.test.ts` | each event type reaches finear as the right activity or session update; replayed batch → no duplicates; invalid event → 406 with index; not-your-work → 409 |
| `complete.test.ts` | the hanging-session guarantee for each outcome; queued follow-up starts on completion |
| `follow-ups.test.ts` | two prompts during a running turn merge into one `prompt` item; the queued thought |
| `stop.test.ts` | queued → cancelled + response; running → cancel frame + heartbeat cancel + daemon's final response; no daemon answer → server response after `stopGraceMs`; events after cancel limited to response/error; queued items superseded |
| `queue-timeout.test.ts` | each unplaceable reason produces its own error text |
| `keepalive.test.ts` | a waiting session older than 25 min gets an ephemeral thought; an `awaitingInput` session does not |
| `routing-rule-actions.test.ts`, `external-identity-actions.test.ts` | CRUD + list + reorder; RBAC; audit rows |

## Verification

```bash
cd backend && bun run migrations && bun run lint && bun test __tests__/routing __tests__/runners __tests__/webhooks
cd cli && bun run lint && bun test
```

The whole loop with a scripted daemon, against finear, in one test (`routing/loop.test.ts`): delegate → ack →
offer → claim → `thought`, `plan`, `action`, `response` → `complete` → finear shows the session `complete` with
the plan; prompt → same runner claims the follow-up with history; stop mid-turn → final response.

```bash
psql hypotenuse -c "select w.id, s.issue_identifier, w.kind, w.role, w.status, r.name as runner, w.attempts from work_items w join agent_sessions s on s.id = w.agent_session_id left join runners r on r.id = w.runner_id order by w.id desc limit 20;"
```

## Definition of done

- [ ] `work_items` with the one-active-turn partial unique index; `routing_rules`; `external_identities`
- [ ] Role selection by ordered rules with seeded prefixes, default worker, decision named in the session
- [ ] Repository selection: pin → single → `issueRepositorySuggestions` ≥ threshold → `select` elicitation → answer parsing
- [ ] Eligibility as one query; capacity counted server-side
- [ ] Ranking: sticky (with timeout and fresh worktree), issuer, least-loaded
- [ ] Offers via ping + heartbeat; `daemon:claim` with `FOR UPDATE SKIP LOCKED`; leases renewed and reaped
- [ ] `daemon:events` validated, idempotent by `eventId`, stop-filtered; `daemon:complete` never leaves a session hanging
- [ ] Follow-ups merged; stop and every other cancel source handled within `stopGraceMs`
- [ ] Queue timeout explains why; keepalive only for sessions waiting on Hypotenuse
- [ ] `routing-rule:*`, `external-identity:*`, `agent-session:cancel` with CLI commands, settings UI, and user docs
- [ ] Phase 7's interim "no runner" ending removed

## Learnings from the build

_Nothing yet — this phase has not been built._
