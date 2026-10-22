# Phase 16 — Signals, notifications, and hardening

> **Goal:** Every interaction Linear defines between a person and an agent works the way Linear's docs say it
> should, including the rare ones: a stop request ends work immediately and says where things stand; an agent that
> needs a login asks for it with an `auth` signal and resumes when it gets it; choices are `select` elicitations;
> every inbox notification has a decided handling; and the service stays inside Linear's rate limits, survives
> duplicated and replayed webhooks, refreshes tokens without racing itself, and meets each of Linear's six Agent
> Interaction Guidelines with a test that proves it.

> **Status: planned, not built.** Earlier phases built the happy path and the main signals as they needed them:
> `stop` cancels work ([phase 7](./phase-07-webhook-ingress-and-session-mirror.md),
> [phase 11](./phase-11-acp-agent-host.md)), permission prompts become `select` elicitations
> ([phase 11](./phase-11-acp-agent-host.md)), repository choice can elicit
> ([phase 9](./phase-09-work-routing.md)). This phase completes the signal surface, decides every remaining webhook,
> and turns "it worked when we tried it" into invariants with tests.

Linear's agent docs are short, and most of what they ask for is easy to do once and easy to break later: answer
within 10 seconds, stop when asked, don't re-engage uninvited, keep the session from going stale, rebuild history
from activities. Each of those is a property of the whole system — webhook handler, router, outbox, daemon, agent —
not of one function, which is why a feature-by-feature build leaves gaps between features. This phase walks the
docs line by line ([`LINEAR_COVERAGE.md`](../LINEAR_COVERAGE.md) is the checklist) and closes them.

## Scope

**In:**

- **Signals**, all four `AgentActivitySignal` values: `stop` (inbound) end to end including the `stopping` status and
  a deadline; `auth` (outbound) with `signalMetadata { url, userId, providerName }` and the resume flow; `select`
  (outbound) for every place a choice is offered, with GitHub repository URLs as values; `continue` (schema-only)
  accepted and documented.
- **`AppUserNotification`**: a decided handling for each of the eight documented actions and a catch-all.
- **Disengagement** (AIG #5): stop, unassign, undelegate, dismissal, issue completed/canceled by a person — each ends
  work and none is followed by re-engagement without a new delegation or prompt.
- **Keepalive and stale recovery.**
- **Rate limiting**: the per-integration request bucket, complexity tracking from response headers, `RATELIMITED`
  backoff, and outbox prioritization under pressure.
- **Webhook robustness**: duplicates, retries (1 m / 1 h / 6 h), replays outside ±60 s, bad signatures, oversized
  bodies, unknown `type`s and `action`s.
- **Token refresh** under concurrency (refresh tokens rotate; a 30-minute replay grace exists).
- **Security review checklist** and **AIG checklist**, each item mapped to a test.

**Out:**

- New Linear features beyond the documented agent surface (customers, initiatives, releases).
- `client_credentials` tokens — decided against in [phase 6](./phase-06-linear-connection.md) and recorded in
  [`LINEAR_COVERAGE.md`](../LINEAR_COVERAGE.md).
- Hypotenuse-hosted login flows for third-party agents. The `auth` signal points the person at instructions for their
  own machine; Hypotenuse never holds model or git credentials ([`ARCHITECTURE.md`](../ARCHITECTURE.md#trust-boundaries-and-credentials)).

## Design

### `stop`

Linear sends `AgentSessionEvent` / `prompted` with `agentActivity.signal = "stop"` when a person chooses "Send stop
request". The docs: the agent must stop immediately — no further code changes, updates, or API calls — and emit a
final `response` or `error` saying it stopped and what state it is in. The schema has a `stopping` session status.

End to end:

1. `webhooks:linear` verifies and records; `triggers:process-event` records the inbound `prompt` activity with its
   `signal`, and in the same transaction marks the session's live work item `cancelRequestedAt = now()`. No new work
   item is created for a stop prompt, and its body (if any) is not sent to the agent as a prompt.
2. **Every outbound activity for that session still `pending` in the outbox is marked `superseded`** — except
   `response` and `error`. A queued "Editing src/cart.ts" action delivered after the stop would read, in Linear, as
   the agent ignoring the person. This is the server's half of "no further updates".
3. The server publishes `{ event: "cancel" }` on `runner:<id>`; the next heartbeat also carries it in `cancels`.
4. The daemon sends ACP `session/cancel`, answers every pending `session/request_permission` with `cancelled` (the ACP
   spec requires it), stops forwarding events for the session except a final one, and starts `sessions.stop_grace`
   (default 10 s). If the agent's `session/prompt` has not returned `stopReason: cancelled` by then, the daemon kills
   the process group.
5. The daemon posts one final `response` through `daemon:events`: "Stopped at your request." plus where things stand —
   the worktree path and branch, whether there are uncommitted changes (`git status --porcelain` count), the last
   completed plan item, and any PR already open. Then `daemon:complete` with `outcome = cancelled`.
6. **Server deadline.** If no final activity arrives within `stop_grace + 20 s` (runner offline, daemon wedged),
   `sessions:keepalive` emits a server-side `response`: "Stop requested; the runner <name> did not confirm. Work may
   have continued on <owner>'s machine until it was stopped." The work item is marked `cancelled`. The deadline is a
   column (`cancelRequestedAt`), so tests control it by writing the column, never by waiting.

**`stopping`.** Linear may report `stopping` between the stop request and the agent's final activity. Hypotenuse
mirrors it in `agent_sessions.status` when a webhook or read reports it; it never sets it. While a session is
`stopping`, `daemon:events` accepts only `response` and `error` for it (finear enforces the same rule, which is how
the test catches a daemon that leaks an action after stop).

**A stop with a body.** A person may type text along with the stop. The text is shown in the final response's quote
("You said: …") and is otherwise not acted on. Acting on it would be re-engaging on the stop prompt itself.

### `auth`

An agent that cannot work because it is not logged in — Claude Code without a login, Codex without
`OPENAI_API_KEY`, `gh` unauthenticated when the worker wants to open a PR — must say so in Linear in a way that leads
the person to fix it. Linear's `auth` signal on an `elicitation` is built for this: `signalMetadata.url` (the link),
`userId` (show the link only to that Linear user), `providerName`.

Sources:

| Detected by | When | `providerName` |
|---|---|---|
| ACP `initialize` returns `authMethods` and `session/new` fails with `-32000 auth_required` | the agent itself needs a login | the agent preset's display name ("Claude Code", "Codex", …) |
| ACP `elicitation/create` with `mode: "url"` | the agent asks for a URL-based login mid-turn | from the elicitation's message, else the preset |
| the daemon's preflight `gh auth status` / `git ls-remote` fails for the repository | git or GitHub push will fail | "GitHub" / the remote's host |

Emission: the daemon sends an `elicitation` protocol event with `signal: "auth"` and
`signalMetadata: { providerName, url, userId }`:

- `url` is **a Hypotenuse dashboard page**, `/runners/<runnerId>/auth/<provider>`, that shows the runner's owner the
  exact command to run on that machine (`claude /login`, `codex login`, `export OPENAI_API_KEY=…` in the daemon's
  environment, `gh auth login`). It is not the provider's own login page: the login has to happen on the runner's
  machine, which is not the machine the person clicking in Linear is necessarily on. For an ACP `mode: "url"`
  elicitation, whose URL *is* a provider login the agent can complete itself, the daemon passes that URL through
  unchanged, after the server checks it is `https` and public (`assertPublicUrl`).
- `userId` is the Linear user id of the **runner owner's linked identity** when there is one (the person who can fix
  it), else the session creator.
- The session is now `awaitingInput`; the work item stays `running` and holds its slot. The ACP agent is left alive
  for an `elicitation/create` (it is waiting for our answer); for a failed `session/new` there is no agent to keep.

Resume: the next `prompted` for the session ("done", or anything) is delivered to the daemon as a follow-up turn. The
daemon re-runs the failed check; on success it emits a `thought` ("Signed in to Codex — continuing.") — Linear's docs
say to resume with a thought, which also dismisses the auth UI — and retries `session/new` or answers the ACP
elicitation with `accept`. On failure it emits the `auth` elicitation again. An `auth` elicitation unanswered for
`sessions.idle_timeout` ends the turn with an `error` and frees the slot.

### `select`

Every choice Hypotenuse offers a person is a `select` elicitation with `signalMetadata.options: [{ label?, value }]`:

| Choice | Raised by | Options |
|---|---|---|
| Tool permission under `permission_policy = "ask"` | daemon, from ACP `session/request_permission` | the ACP `options` (`allow_once`, `allow_always`, `reject_once`, `reject_always`) — `label` = option name, `value` = `optionId` |
| Repository | server, when `issueRepositorySuggestions` confidence is below `routing.repositoryConfidence` | `value` = the repository's **GitHub URL** (`https://github.com/<owner>/<repo>`), no label — Linear renders GitHub URLs with extra detail |
| Agent-asked choice | ACP `elicitation/create` `mode: "form"` with one enum field | `value` = enum value, `label` = `oneOf` title |
| Manager clarifying question | `linear_ask_user` with `options` ([phase 13](./phase-13-hypotenuse-mcp.md)) | as given |

The answer comes back as an ordinary `prompt`. Linear also lets a person ignore the options and type anything, which
dismisses the elicitation. Mapping a reply back to an option (`ops/ElicitationOps.ts` `matchSelectReply`):

1. exact `value` match → that option;
2. case-insensitive exact `label` match → that option;
3. a reply that is a single option's `value` or `label` with surrounding punctuation or whitespace → that option;
4. otherwise **free text**: for a permission, the pending ACP request is answered `cancelled` (not `reject`), and the
   text is delivered to the agent as the next prompt; for a repository choice, the text is matched against the
   candidates' names, and if exactly one matches it is chosen, else the server asks again; for an agent elicitation,
   `decline` with the text sent as the next prompt.

Linear's docs suggest interpreting free-text replies with an LLM. Hypotenuse does not run a model of its own on the
server; the free-text path hands the text to the coding agent, which is a model, with the context of what it asked.
That is the decision recorded here.

The elicitation's pending state lives in `agent_sessions.pendingElicitation` (jsonb:
`{ kind, activityId, options, acpRequestId? }`), so a reply that arrives after a daemon restart, or on a different
runner after reassignment, can still be matched.

### `continue`

`continue` is in Linear's `AgentActivitySignal` enum and not in the docs. finear accepts it. Hypotenuse:

- **inbound**: a `prompted` event whose `signal` is `continue` is treated as a prompt with body "continue" (or its
  body, if present). It is not a resume-from-stopped: a stopped session needs a new prompt, and treating `continue` as
  one is exactly that.
- **outbound**: never emitted.
- recorded as `LC-SIG-04` in [`LINEAR_COVERAGE.md`](../LINEAR_COVERAGE.md) with status "handled as a plain prompt
  until Linear documents it". A test proves it does not throw and produces one follow-up turn.

### `AppUserNotification`

Inbox notifications are not the work trigger — agent sessions are — but each has a decided handling, because "we
ignore it" is a decision too and it should be visible in `trigger_events.outcome`:

| `action` | Handling | Outcome |
|---|---|---|
| `issueMention` | Linear creates an agent session for a mention by itself; the notification is informational. If no session exists for the issue within 30 s (checked by a delayed `triggers:process-event` re-run), record `mention_without_session` — the dashboard surfaces it, because it usually means the app lost `app:mentionable` | `noted` / `mention_without_session` |
| `issueCommentMention` | same as `issueMention` | same |
| `issueAssignedToYou` | Hypotenuse works by **delegation**. If an issue is *assigned* to the app user (possible through the API or old workflows), record `assigned_not_delegated` and surface it in the dashboard with the explanation; do not start work — the person did not use the agent flow | `assigned_not_delegated` |
| `issueUnassignedFromYou` | cancel any live work on that issue as a disengagement ("Unassigned — stopping."); the work item ends `cancelled` | `disengaged` |
| `issueEmojiReaction`, `issueCommentReaction` | ignored | `ignored` |
| `issueNewComment` | ignored for work (comments are not prompts, and the best practices say not to read history from them); recorded | `ignored` |
| `issueStatusChanged` | if the issue moved to a state of type `completed` or `canceled` **by someone other than the app user** while a work item is live, cancel it as a disengagement ("<name> marked this issue Done — stopping.") | `disengaged` / `ignored` |
| any other (`OtherNotificationType`: `agentConversationMention`, `documentMention`, `projectMention`, `issueReopened`, `pullRequest*`, …) | recorded | `ignored` |

The same disengagements are also triggered from `Issue` / `update` data-change events when they carry the change
(`delegateId` removed — a dismissed session removes the delegate; `stateId` to a completed/canceled type), so that
either subscription alone is enough. The handler is idempotent across both sources: the second one finds no live work.

### Disengagement and re-engagement

AIG #5: *respect requests to disengage; re-engage only after a clear signal*. The disengagement triggers are stop,
undelegation (including session dismissal), unassignment, and a person completing or canceling the issue. After any
of them:

- the live work item is cancelled and pending outbound non-final activities are superseded (as for stop);
- the session is marked `disengagedAt`, and **no server-originated work item may be created for it**: no review turn
  ([phase 14](./phase-14-manager-and-dispatch.md)), no sticky retry, no keepalive, no repository re-ask;
- a dispatch from a manager onto that issue is refused until a person delegates it again.

Re-engagement happens only through a new `created` (a new delegation or mention) or a person's `prompted` on the
session. A test runs every trigger against every server-originated path and asserts no work item is created.

### Keepalive and stale recovery

Linear marks a session `stale` after 30 minutes without an activity, and a new activity recovers it. Long turns
(a big refactor, a slow test suite) can go quiet longer than that between tool calls.

- **Daemon keepalive.** During a running turn, if no event has been sent for `sessions.keepalive_interval`
  (default 10 min), the daemon sends an ephemeral `thought` with what it is waiting on ("Still running `bun test`
  (12 min)…"). Ephemeral, so it replaces itself instead of piling up.
- **Server keepalive.** `sessions:keepalive` covers the cases the daemon cannot: a work item `queued` or `offered`
  with no eligible runner ("Waiting for a runner — <reason>"), a sticky follow-up waiting for an offline runner, and a
  runner reconnecting. Once per 20 minutes per session at most, persisted (not ephemeral) only on state changes.
- **Recovery.** A session Linear already marked `stale` simply recovers on the next activity; nothing special is
  needed, and the mirror updates when the next read or webhook reports the new status.
- **Not for awaiting input.** A session in `awaitingInput` is waiting on a person and is deliberately not kept alive
  by anyone — keepalive there would bury the question.

### Rate limiting

Linear's limits for OAuth apps: 5,000 requests/hour and 2,000,000 complexity points/hour per app user, at most 10,000
points per query; `actor=app` installs get dynamic increases by seat count. Over the limit, GraphQL answers HTTP 400
with `extensions.code: "RATELIMITED"`. Headers: `X-RateLimit-Requests-{Limit,Remaining,Reset}`,
`X-RateLimit-Complexity-{Limit,Remaining,Reset}`, `X-Complexity`, and `X-RateLimit-Endpoint-*`.

- **The bucket.** `ops/LinearRateOps.ts` keeps, per integration, Linear's own last-reported `Remaining` and `Reset`
  for both requests and complexity (Redis hash, updated from every response's headers) and a local token bucket
  seeded from them. Every call through `ops/LinearOps.ts` takes a token first. The bucket script lives in
  `backend/lua/linear-token-bucket.lua` (ToolExec's convention: Lua is a file, loaded at boot).
- **Priorities.** Under pressure (remaining < 10%), `activities:deliver` sends in priority order: `response`, `error`,
  `elicitation`, acknowledgement `thought` (the 10-second one), `agentSessionUpdate` (plan / URLs), persisted
  `action`, ephemeral `thought` / `action`. Ephemeral rows older than the newest ephemeral row for the same session are
  `superseded` without being sent — Linear would replace them anyway.
- **Backoff.** `RATELIMITED` sets the integration's bucket empty until the reported reset, and the row's
  `nextAttemptAt` to that reset; the outbox retries. A daemon proxy call (`daemon:linear-*`) that hits an empty bucket
  returns 429 with `Retry-After`, which the stdio MCP server surfaces to the model as a tool error naming the wait.
- **Complexity.** Queries are written with explicit `first:` limits so `X-Complexity` stays small; a test asserts
  every query in `ops/LinearQueries.ts` reports complexity under 1,000 against finear's schema estimator when finear
  provides one, else by static counting of connection sizes.

### Webhook robustness

| Case | Behaviour | Test |
|---|---|---|
| same `Linear-Delivery` twice | second insert conflicts on `trigger_events.deliveryId`; 200, `outcome = duplicate`, no side effect | yes |
| Linear retry after our 5xx | same delivery id; processed once on the retry | yes |
| `webhookTimestamp` outside ±60 s | 401, no row (replay) | yes, with an injected clock |
| bad / missing `Linear-Signature` | 401, no row; the body is never parsed | yes |
| body over `WEBHOOK_MAX_BODY_BYTES` (1 MiB) | 413 before reading further | yes |
| unknown `type` | 200, recorded, `outcome = ignored` | yes |
| `AgentSessionEvent` with unknown `action` | 200, recorded, `outcome = ignored`; never a 500 (Linear retries a 500, and an unknown action will not get better) | yes |
| `organizationId` matching no live Linear integration | 200, recorded with null `integrationId`, `outcome = unknown_integration` | yes |
| slow processing | the HTTP answer never waits on processing; p99 of the handler < 500 ms in the test suite | yes |
| `prompted` arriving before its `created` was processed | `triggers:process-event` jobs for one `agentSession.id` are serialized (Redis lock on the session id); a `prompted` that finds no session row re-enqueues itself with a short delay, up to a bound | yes |

The ±60 s window uses the **signed body's** `webhookTimestamp` (the SDK's choice, and the header is not covered by the
signature). The clock is injectable (`config.linear.clock` in tests) because finear's virtual clock otherwise fails
verification on retried deliveries — a gap recorded in [`LINEAR_COVERAGE.md`](../LINEAR_COVERAGE.md#known-finear-gaps).

### Token refresh under concurrency

Linear access tokens last 24 h; refresh tokens rotate on use; a lost refresh response can be replayed for 30 minutes.
Two workers refreshing the same integration at once would each present the same refresh token; the second would get
the replayed response (within the grace) — correct, but only by luck of timing.

- `integrations:refresh-tokens` refreshes integrations within 30 minutes of expiry, each under a transaction-scoped
  Postgres advisory lock on the integration id, re-reading the row after taking the lock (another worker may have
  just refreshed it).
- An on-demand refresh (a call that gets 401) takes the same lock.
- The new token pair is written in the same transaction as the lock; a crash after Linear answered and before commit
  is covered by the 30-minute replay grace on the next attempt.
- A refresh that fails with `invalid_grant` marks the integration `error`, notifies admins, and stops outbox delivery
  for it (rows stay `pending`, not `failed`, so reconnecting resumes them).

### Security review checklist

| Item | Where | Test |
|---|---|---|
| Linear tokens never returned by any action | `serializeIntegration` has no token field | a test walks every action's response for each fixture and asserts no value equals a token plaintext |
| `SENSITIVE_KEYS` includes `accessToken`, `refreshToken`, `token`, `runnerToken`, `code`, `client_secret` | `ops/AuditOps.ts` | audit rows for `runner:register` and `linear:callback` contain none |
| Every outbound fetch of a person-supplied URL goes through `assertPublicUrl` | `auth` pass-through URLs; any URL in an MCP tool argument the server fetches | network-guard tests |
| Runner tokens stored as sha256, compared in constant time | `RunnerTokenMiddleware` | yes |
| Daemon-only actions refuse human sessions; humans' actions refuse runner tokens | `beforeAct` hook | `rbac.test.ts` walks every action |
| A runner token cannot act on another project's session or on an issue outside its session | `daemon:linear-*` scope checks | Bowser's runner against Peach's session |
| Webhook handler parses nothing before the signature check | `webhooks:linear` | a malformed body with a bad signature is 401, not 400 |
| Every human mutation is audited; the unaudited list is closed | `AuditedAction` | `rbac.test.ts` |
| The daemon's control socket is `0600` and owned by the user | `cli/src/daemon/control-socket.ts` | cli test |
| `credentials.json` is `0600`; refuses to start if group/world-readable | `cli/src/daemon/server-link.ts` | cli test |
| Model-authored Markdown never rendered as raw HTML | `MarkdownBlock` | frontend test |

### AIG checklist

Linear's [Agent Interaction Guidelines](https://linear.app/developers/aig), each mapped to behaviour and a test id in
[`LINEAR_COVERAGE.md`](../LINEAR_COVERAGE.md):

| # | Principle | Hypotenuse behaviour | Test |
|---|---|---|---|
| 1 | Always disclose that it is an agent | Linear shows the app badge on every activity and comment the app authors; the role prompts tell the model to say it is an AI agent when asked; final responses are signed "— Hypotenuse (<role>, <agent>)" in a collapsed `+++` details block with runner and agent | `LC-AIG-01` |
| 2 | Inhabit the platform natively | work through delegation, sessions, activities, plans, and `externalUrls`; PRs as "Pull Request" external URLs; no comment-scraping; mentions as plain Linear URLs | `LC-AIG-02` |
| 3 | Instant feedback | acknowledgement `thought` from the **server** on `created`, independent of any runner; asserted < 10 s end to end in e2e, < 2 s in the backend suite | `LC-AIG-03` |
| 4 | Transparent internal state | thoughts, actions with parameters and results, the plan, elicitations; dashboard shows ephemeral history and turn reasons | `LC-AIG-04` |
| 5 | Respect disengagement | the disengagement section above; no server-originated re-engagement | `LC-AIG-05` |
| 6 | Cannot be held accountable | delegate not assignee; no agent merges; completing issues gated ([phase 14](./phase-14-manager-and-dispatch.md)); every dispatch audited | `LC-AIG-06` |

## Steps

### 1. Schema — `backend/schema/{work_items,agent_sessions,trigger_events}.ts`

- `work_items.cancelRequestedAt`, `cancelledBy` (nullable user id), `cancelReason` (`stop` | `dashboard` |
  `undelegated` | `unassigned` | `issue_closed` | `revoked` | `superseded`).
- `agent_sessions.pendingElicitation` (jsonb), `disengagedAt`.
- `trigger_events.outcome` gains the values in the tables above (plain `text`, documented in the schema file).

### 2. Ops — `backend/ops/{SignalOps,ElicitationOps,DisengageOps,LinearRateOps}.ts`, `backend/lua/linear-token-bucket.lua`

- `SignalOps.handleStop(tx, session, promptActivity)`; `DisengageOps.disengage(tx, session, reason, actor)` — the one
  funnel every disengagement goes through (cancel live item, supersede outbox, set `disengagedAt`, publish cancel).
- `ElicitationOps.matchSelectReply(pending, body)` — pure, table-tested.
- `LinearRateOps` as designed.

### 3. Event handling — `backend/actions/linear/linear-process-event.ts`

Wire `stop`, `continue`, the `AppUserNotification` table, `Issue` / `update` delegate and state changes, per-session
serialization, and the unknown-action path.

### 4. Outbox — `backend/actions/activities/activities-deliver.ts`

Priorities, supersession of stale ephemerals, `RATELIMITED` backoff, `stopping` acceptance rule.

### 5. Clocks — `backend/actions/sessions/sessions-keepalive.ts`, `backend/actions/linear/linear-refresh-tokens.ts`

The stop deadline, server keepalive, and the locked refresh.

### 6. Daemon — `cli/src/acp/host.ts`, `cli/src/acp/permissions.ts`, `cli/src/daemon/supervisor.ts`, `cli/src/acp/preflight.ts`

- Stop: cancel, answer pending permissions `cancelled`, grace, kill the process group, the "where things stand"
  response.
- Auth: `preflight.ts` (`gh auth status`, `git ls-remote` for the worktree's remote, per-preset checks), `auth`
  elicitation events, resume.
- Keepalive timer per running turn.

### 7. Dashboard auth-help page — `frontend/src/pages/RunnerAuthPage.tsx`

`/runners/:runnerId/auth/:provider` — instructions per provider, shown to the runner's owner (others see "ask <owner>").
Public provider instructions also live in `frontend/src/content/docs/install-a-runner.md`.

### 8. Tests

- `backend/__tests__/linear/signals.test.ts` — stop end to end against finear with a daemon stub: outbox
  supersession, cancel frame, final response; the server deadline path by writing `cancelRequestedAt`; `stopping`
  rejects a non-final event; `continue` → one follow-up turn.
- `backend/__tests__/linear/elicitation.test.ts` — `matchSelectReply` table; repository select with GitHub URL values;
  free-text paths for each kind; reply after reassignment.
- `backend/__tests__/linear/notifications.test.ts` — each `AppUserNotification` action → expected outcome;
  `issueUnassignedFromYou` and `issueStatusChanged` disengage.
- `backend/__tests__/linear/disengagement.test.ts` — every trigger × every server-originated path → no work item.
- `backend/__tests__/linear/webhook-robustness.test.ts` — every row of the robustness table.
- `backend/__tests__/linear/rate-limit.test.ts` — bucket from headers; `RATELIMITED` backoff; priority order under
  pressure; ephemeral supersession; daemon proxy 429.
- `backend/__tests__/linear/token-refresh.test.ts` — `cap * 4` concurrent refreshes → one Linear refresh call; crash
  between Linear's answer and commit → replay within grace succeeds; `invalid_grant` → integration `error`.
- `backend/__tests__/security/*.test.ts` — the checklist rows.
- `cli/__tests__/acp/stop.test.ts`, `auth.test.ts` — the fake ACP agent ignoring cancel → killed after grace; auth
  required → `auth` elicitation; resume after "done".

## Verification

```bash
cd backend && bun run lint && bun test __tests__/linear __tests__/security
cd ../cli && bun run lint && bun test __tests__/acp
```

Manually, against finear and the fake agent scripted for a long turn:

1. Delegate; while the agent is mid-turn, `POST /__test/agents/stop` on finear. Within `stop_grace` the session's last
   activity is the "Stopped at your request" response with branch and dirty-file count; no `action` follows it.
2. Configure the fake agent preset to require auth. Delegate: the session shows an `auth` elicitation linking the
   runner's auth page. Flip the fake to authenticated, prompt "done": a "continuing" thought, then normal work.
3. Set `routing.repositoryConfidence = 1.01` with two repositories: the session shows a `select` with two GitHub URLs;
   prompt one URL; work proceeds in that repository.
4. Undelegate mid-turn in finear: work stops with "Undelegated — stopping."; manager review is not enqueued.

## Definition of done

- [x] `stop`: supersession, cancel, grace + kill, final status response, server deadline, `stopping` rule
- [x] `auth`: three detection sources, dashboard auth page, resume with a thought, idle timeout
- [x] `select`: four sources, GitHub URL values, `matchSelectReply`, free-text handling, survives reassignment
- [x] `continue` handled as a plain prompt and documented
- [x] Every `AppUserNotification` action has a decided outcome; disengagement from either subscription
- [x] One `disengage` funnel; no server-originated re-engagement
- [x] Daemon and server keepalives; none in `awaitingInput`
- [x] Rate bucket from headers, priorities, backoff, proxy 429
- [x] Webhook robustness table fully tested
- [x] Locked token refresh with the replay-grace path tested
- [x] Security and AIG checklists each mapped to passing tests and to `LINEAR_COVERAGE.md` rows

## Learnings from the build

**Built.** The Definition of done, at CLI 0.12.0, with the departures below. Much of the plan was already in place
when the phase started — the stop path end to end with its server deadline and `stopping` rule, permission and
form `select`s, repository choice, both keepalives, the token bucket with priorities and `RATELIMITED` backoff, the
locked token refresh, and the webhook robustness table — built by the phases that needed them. This phase closed
the gaps between them and made each guideline a test. The manual walk-through under Verification has not been run
by hand; `backend/__tests__/daemon/acp.test.ts` drives the auth path against the real daemon and finear.

### Where the pieces live

- **Server:** `ops/LinearNotificationOps.ts` (the notification table, `checkNotification`) and the
  `triggers:check-notifications` clock; `ops/AuthSignalOps.ts` (`resolveAuthMetadata`, `isPublicUrl`,
  `runnerAuthUrl`), called from `recordEvent` in `ops/WorkItemOps.ts`; `supersedeNonFinal` in
  `ops/ActivityOutboxOps.ts`, called by `cancelSessionWork`; `ipAllowed` / `webhookSender` in
  `ops/LinearWebhookOps.ts`. Migration `0012` (`trigger_events.check_after`, `work_items.cancel_note`).
- **Protocol:** `Cancel.said`, the `unassigned` cancel reason, `stopQuote`, and `AuthMetadata.provider` (with `url`
  now optional) — all additive; no version bump.
- **Daemon:** `cli/src/acp/preflight.ts` (git remote and GitHub CLI checks); `AuthRequired` and
  `resumesAfterAuth` in `cli/src/acp/host.ts`; `responseSignature` in `cli/src/acp/mapping.ts`; the worker template
  says it is an AI agent.
- **Frontend:** `pages/RunnerAuthPage.tsx` with `utils/runnerAuth.ts`; delivery outcome hints
  (`utils/deliveryOutcomes.ts`) on the Linear card.
- **Tests:** `backend/__tests__/linear/{signals,notifications,aig}.test.ts`, `backend/__tests__/security/`,
  `backend/__tests__/ops/auth-signal.test.ts`, and additions to the disengagement, robustness, rate-limit, and
  daemon suites; `cli/__tests__/acp/preflight.test.ts`; frontend `markdown-safety`, `runner-auth`,
  `delivery-outcomes`, and an e2e spec for the auth page.

### Where the build departs from the plan

| Plan | Built | Why |
|---|---|---|
| `agent_sessions.pendingElicitation` (jsonb) and `ElicitationOps.matchSelectReply` on the server | **not built**: a question waits on its held work item (`awaitingAnswerSince`, `answers`), and the daemon matches replies (`matchReply` in `cli/src/acp/permissions.ts`); the repository choice keeps `pendingRepositoryChoice` | the ACP host built it that way, it survives a daemon restart (the answers are on the item) and a reassignment (unconsumed answers become the next prompt), and the agent's own question is only meaningful to the agent that asked it |
| `agent_sessions.disengagedAt`, and a `disengage` funnel in `DisengageOps` | **`DISENGAGED_CANCEL_REASONS` plus `delegateRemovedAt`**, through the one existing funnel, `cancelSessionWork` | the cancel reason already says which disengagement it was and is what `finishWorkItem`, `applyEvents`, and the review loop read; a second marker would be one more thing to keep in step |
| Disengagement is announced ("Unassigned — stopping.", "<name> marked this issue Done — stopping.") | **quiet**, like every other disengagement | a person who stepped away is not spoken to (the rule the earlier phases settled); the dashboard and the delivery outcome record it |
| `issueStatusChanged` decides from the notification | **the clock reads the issue's state from Linear** (`checkAfter = now`) | the notification carries the issue, not its state, and processing never calls Linear inside its transaction |
| A delayed `triggers:process-event` re-run checks a mention | **a `checkAfter` column and a 10-second clock** | a column is what tests move instead of waiting, and a lost delayed job would lose the check |
| `auth`: the work item stays `running`, holding its slot, until a reply or `idle_timeout` | **a login is a question that ends the turn**: the turn completes on the `auth` elicitation, the reply is the next turn, and it opens with *"Signed in — continuing."* | for a failed `session/new` there is no agent to keep, and holding a slot for a login that may take a day starves the runner; an ACP `mode: "url"` elicitation still waits mid-turn as before |
| `url` built by the daemon | **the daemon names a `provider`; the server builds the link** (and sets `userId`) | only the server knows the dashboard's address and the Linear identities, and it must not trust a daemon to choose who sees a link |
| `assertPublicUrl` | **`isPublicUrl`**, a syntactic check (https, no credentials, no local names, no private, loopback, link-local, or CGNAT literals) | nothing fetches the URL — it is shown to a person — so there is no DNS to rebind |
| Signature "— Hypotenuse (<role>, <agent>)" | `+++ — Hypotenuse (<role>, <agent>)` folding *"An AI coding agent: `<id>` <version> on runner `<name>`, delegated through Hypotenuse."*, on the agent's end-of-turn response only | stops and errors are Hypotenuse's own words; the signed answer is what gets copied out of Linear |
| Server keepalive persisted on state changes, at most every 20 minutes | unchanged from earlier phases: an ephemeral thought after 25 quiet minutes | it already keeps a waiting session out of `stale` and never buries a question |
| A test of every query's complexity against finear's estimator | **every connection in every document carries `first:`** (`LC-RATE-02`) | finear has no estimator; an unbounded connection is what would make complexity large |
| Rows "Every outbound fetch of a person-supplied URL goes through `assertPublicUrl`" | no server code fetches a person-supplied URL; the auth link check stands in | — |

### Decisions the plan left open

| Question | Decision |
|---|---|
| A bare "Stop" typed with the stop | not quoted — it is the button's own word |
| What a stop withdraws | every pending outbound **activity** that is not a `response` or `error` — including an unsent elicitation — but not session updates (a plan, a pull request link), which are state; a lost integration (team access removed, an uninstall) fails the outbox instead, so its rows say why |
| A mention's "session followed" | a session on the issue created, or prompted, within a minute before the notification arrived |
| A status check whose Linear read fails | retried a minute later, given up (`ignored`) after an hour |
| The IP allowlist's refusal | the unverified 401, byte for byte, before the body is read |
| Which address the allowlist reads behind a proxy | the **last** `X-Forwarded-For` entry, only with `LINEAR_WEBHOOK_TRUST_FORWARDED` — the one the deployment's own proxy appended |
| GitHub CLI check for managers | skipped: a manager opens no pull requests |

### Things that bit

- **Two suites on one test database fail each other in ways that look like regressions.** Running the daemon suite
  in the background while another file ran turned eight daemon tests red; alone they passed. The parallel-forks
  rule in `AGENTS.md` applies to a single person's terminal too.
- **A migration regenerated after one was applied leaves the test database ahead of the journal.** Folding two new
  migrations into one meant dropping and recreating `hypotenuse_test`.
