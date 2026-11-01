# Phase 15 — Linear

> **Goal:** A bot is its own Linear agent. A workspace admin creates the bot's Linear OAuth app from a link Hypotenuse pre-fills, then installs it. After that, anyone in the workspace can delegate an issue to the bot or mention it. The bot acknowledges within seconds, then thinks, plans, calls tools, and answers inside the Linear agent session. It remembers the issue's Linear project.

> **Status: built.** Builds on [the channel framework](./phase-13-channel-framework.md) (adapter registry, `bot_installations`, `channels`, `channel_bindings`, `participants`, `trigger_events`, `outbox_messages`), the [durable agent loop](./phase-08-durable-agent-loop.md), and [memory](./phase-09-memory.md). Most of the Linear code already exists on the archived [`v1` branch](https://github.com/arcadeai-labs/hypotenuse/tree/v1) and is ported, not rewritten. [Slack](./phase-14-slack.md) and [Pylon](./phase-16-pylon.md) are siblings.

v1 *was* a Linear agent. Twenty-one phases taught it how Linear's agent sessions behave, where finear differs from real Linear, and which mistakes cost an uninstall. Two things change in 2.0:

- **What answers the session.** In v1, a turn routed to a coding agent on a teammate's machine. In 2.0, the server's own agent loop answers, and code work goes to a [sandbox](./phase-17-sandboxes.md).
- **Who the app is.** v1 had one Linear app per deployment. 2.0 has one per **bot**, so each bot is a distinct delegate, mention, and actor in Linear.

Everything between those two edges ports as is: OAuth with refresh rotation, signed webhook ingress, the rate-limit bucket, the activity outbox, the notification table, disengagement, and finear as the test Linear. The surviving lessons are listed in [What this must not weaken](#what-this-must-not-weaken).

## Scope

**In:**

- Linear OAuth app **per bot**:
  - Hypotenuse generates the pre-filled app-creation link (Linear's app manifest, `schemaVersion 1.0.0`) with the bot's name, icon, description, callback URL, and webhook URL (`/api/webhooks/linear/<routingKey>`).
  - The admin creates the app in Linear and pastes back `client_id`, `client_secret`, and the webhook signing secret.
  - The app is created `distribution: public`, or a second workspace cannot install it.
- Install per workspace with `actor=app`, PKCE, and scopes `read`, `write`, `app:assignable`, `app:mentionable`, `issues:create`, `comments:create`. Refresh rotation with a 30-minute replay grace; refresh under a row lock; only `invalid_grant` marks an installation `error`.
- `webhooks:linear`:
  - HMAC-SHA256 over the raw body; signed `webhookTimestamp` within ±60 s; `Linear-Delivery` dedupe; no rate-limit middleware; a body cap.
  - An unknown or disconnected workspace still gets 200 (recorded `unknown_installation`).
  - Events handled: `AgentSessionEvent` (`created`, `prompted`), `AppUserNotification`, `PermissionChange`, `OAuthApp` revoked, and issue state changes for disengagement.
- Mapping:
  - **channel** = the issue's Linear **project**; an issue with no project falls back to its **team**.
  - **conversation** = the agent session.
  - **participant** = the Linear user.
- The acknowledgement: every `created` session gets a server-emitted `thought` before the first tick, within 10 seconds.
- The interactive surface as Linear activities:

  | Interactive surface | Linear activity |
  |---|---|
  | status | ephemeral `thought` |
  | step | `action` (and its `result`) |
  | plan | the session's `plan` |
  | question | `elicitation`, with the `select` signal for options |
  | approval | `elicitation` with Approve/Deny options |
  | final | `response` |
  | failure | `error` |

  Also: `externalUrls` (a sandbox's PR as "Pull Request").
- Disengagement: Stop, un-delegation, session dismissal, unassignment, an issue completed or canceled or deleted, uninstall.
- Issue hygiene at the first tick (from v1): a person's delegation moves the issue to the team's first `started` state, and a missing delegate is set. The bot never touches the assignee.
- Linear read/write tools for the bot (`linear_*`, scoped server-side to the installation and the session's issue), from v1's `daemon:linear-*` set.
- `docs/LINEAR_COVERAGE.md` returns, with its docs test. Every row is re-pointed at 2.0 handling and tests.
- finear returns as the test Linear, fetched at a pinned commit.

**Out:**

- Routing work to people's machines. The v1 runner model is gone.
- Linear Asks, Customer Requests, Initiatives, and Cycles as conversation sources. Reading them is a tool question for [shared MCP servers](./phase-10-shared-mcp-servers.md) (Linear's own MCP server) and memory.
- Project-comment mentions as conversations. Linear opens no session for them (v1's finding, `projectCommentMention` + `Comment create`). They are recorded with a decided outcome and start nothing.
- A manager/worker dispatch hierarchy like v1's. A bot may hand work to a sandbox or to another bot through tools; that is not a Linear concept here.

## What already exists

Everything below is on the [`v1` branch](https://github.com/arcadeai-labs/hypotenuse/tree/v1):

| Piece | v1 path | Carry |
|---|---|---|
| OAuth (state+PKCE in Redis, exchange, refresh under row lock, rotation, replay grace, revoke rules) | `backend/ops/LinearOAuthOps.ts` | Port; credentials move from env to `bot_installations` |
| GraphQL client (`linearRequest`, typed errors, rate-limit headers, one retry for idempotent ops, `RATELIMITED` never retried) | `backend/ops/LinearOps.ts`, `backend/ops/linear/operations.ts` | Port as is |
| App manifest link | `backend/ops/LinearManifestOps.ts`, `actions/linear/linear-manifest-url.ts` | Port; now per bot |
| Token bucket (reserve for acks and stops) | `backend/ops/LinearBucketOps.ts`, `backend/lua/linear-token-bucket.lua` | Port; keyed per installation |
| Webhook verification and dedupe | `backend/actions/webhooks/webhooks-linear.ts`, `backend/ops/LinearWebhookOps.ts` | Port verification and recording; rewrite handling against conversations (v1's handler is coupled to work routing) |
| Notification outcomes | `backend/ops/LinearNotificationOps.ts` | Port the table; re-point outcomes at conversations |
| Activity outbox (client UUIDs, per-session lease, supersede ephemerals, refuse at enqueue) | `backend/ops/ActivityOutboxOps.ts` | Becomes the Linear `send` behind `outbox_messages` ([channel framework](./phase-13-channel-framework.md)) |
| Markdown and mention safety | `backend/ops/LinearMarkdownOps.ts` | Port |
| Issue hygiene | `backend/ops/IssueHygieneOps.ts` | Port |
| Linear tools for agents | `backend/actions/daemon/daemon-linear-*.ts` | Re-home as bot tools (`linear_issue_view`, `linear_comment_create`, `linear_issue_create`, `linear_document_*`) |
| finear harness | `backend/scripts/fetch-finear.ts`, `backend/__tests__/linear/{finear,inject,sessions,helpers}.ts` | Port as is |
| Coverage matrix | [`docs/LINEAR_COVERAGE.md`](https://github.com/arcadeai-labs/hypotenuse/blob/v1/docs/LINEAR_COVERAGE.md) | Returns; ids kept, handling/test cells rewritten |
| Learnings | [`v1 phase-06`](https://github.com/arcadeai-labs/hypotenuse/blob/v1/docs/plans/phase-06-linear-connection.md), [`phase-07`](https://github.com/arcadeai-labs/hypotenuse/blob/v1/docs/plans/phase-07-webhook-ingress-and-session-mirror.md), [`phase-16`](https://github.com/arcadeai-labs/hypotenuse/blob/v1/docs/plans/phase-16-signals-and-hardening.md) | Read before changing anything below |

## What this must not weaken

These are v1's lessons. Each cost a bug, an uninstall, or a day.

1. **Two clocks.** Answer a webhook within **5 s**; Linear retries at 1 minute, 1 hour, and 6 hours, and disables a webhook that keeps failing. Put an activity on a `created` session within **10 s**, or Linear shows the agent as unresponsive. The acknowledgement is a server-emitted `thought` enqueued during event processing, before any tick, on the reserved bucket.
2. **Never 4xx a workspace.** An unknown or disconnected workspace gets 200 and an `unknown_installation` record. A refusal counts as a failed delivery, and failed deliveries disable the webhook for everyone on that app.
3. **Verify the body, not the header.** Only the body is signed (LC-DIFF-04). Check `webhookTimestamp` ±60 s. A bad signature and a stale timestamp get byte-identical 401s. Use the raw bytes. During rotation, `webhookSecretPrevious` verifies too.
4. **Revoking any token of an `actor=app` install uninstalls the app.** Never revoke on a refused install or a reconnect.
5. **No literal `@<bot>` in anything we write.** Linear turns it into a real mention and opens a second session. `LinearMarkdownOps` escapes it.
6. **Nothing follows an `elicitation`.** Linear derives the session state from the last activity. A thought after a question takes the session out of `awaitingInput`. A turn that asked emits nothing more, not even a timeout or drain notice; only the person's own Stop is answered.
7. **Respect disengagement, silently.** Stop, un-delegation, dismissal, unassignment, a completed/canceled/deleted issue, and uninstall each cancel the live tick. Later events are dropped, and nothing re-engages without a new prompt or delegation. A Stop's text is quoted back, never acted on.
8. **History comes from activities, not comments.** Comments can be edited. Activities are frozen, and the session's own `prompt`s are the inbox.
9. **Never poll Linear.** Webhooks, then a `checkAfter` second look for notifications whose new state Linear does not send.
10. **Credentials never leave the server.** No action returns a Linear access token, refresh token, client secret, or webhook secret. Linear tools re-derive their scope (installation, issue) from the conversation row on every call.
11. **Every Linear interaction is in the coverage matrix**, with the test that proves it.
12. **Lock order.** Session events never lock the installation row (the refresh holds it across a Linear call). `INSERT … ON CONFLICT DO NOTHING`, then lock: `SELECT … FOR UPDATE` on a row that does not exist locks nothing.

## Design

### 1. One Linear app per bot

`linear:manifest-url` (per bot) produces Linear's pre-filled app-creation link:

- name = the bot's display name (Linear may suffix a collision, LC-OAUTH-23; we store the name Linear reports, `appUserName`);
- icon, description;
- `redirectUris` = `/api/linear/callback`;
- `webhookUrl` = `/api/webhooks/linear/<routingKey>`;
- webhooks enabled for `AgentSessionEvent`, `AppUserNotification`, `PermissionChange`, `OAuthApp`, `Issue`;
- `distribution: public`.

`APPLICATION_URL` must be public HTTPS, as in v1, because Linear refuses localhost webhook URLs.

The admin creates the app in Linear and pastes back `clientId`, `clientSecret`, and `webhookSecret` (`linear:app-register`). Each is sealed into a `bot_installations` row (`type: "linear"`, `status: "created"`). Linear has no app-creation API, so there is no automated path.

`<routingKey>` routes a delivery to the right app's webhook secret before parsing, just as in [Slack](./phase-14-slack.md). An unknown key is 404. This is the one refusal that is not a workspace refusal: no Linear app of ours has that URL.

### 2. Install

`linear:install-url` produces:

```
https://linear.app/oauth/authorize?client_id=…&redirect_uri=…&response_type=code&scope=read,write,app:assignable,app:mentionable,issues:create,comments:create&actor=app&state=…&code_challenge=…&code_challenge_method=S256
```

The `state` and verifier live in Redis, bound to `(installationId, userId)`. `linear:callback` (a browser hop) does the following:

1. Exchanges the code and stores sealed tokens and `accessTokenExpiresAt`.
2. Reads `viewer { id name }` (the app user id, unique per workspace) and `organization { id urlKey name }`.
3. Moves the installation to `installed`.

The same bot installed into a second workspace is a second installation row under the same app credentials: one OAuth app, many workspaces.

`installations:refresh-tokens` is a clock that refreshes access tokens 6 h before their 24 h expiry. It does so under a row lock and records the in-flight start time (never the token) so a lost response can use the 30-minute replay grace.

### 3. Ingress — `webhooks:linear`

`POST /api/webhooks/linear/:routingKey`, with `web.rawBody: true`, no rate limit, and never MCP:

1. Resolve the key to an app.
2. Verify `Linear-Signature` (HMAC-SHA256 hex of the raw body) in constant time.
3. Parse the body and check `webhookTimestamp` within ±60 s of Postgres's clock.
4. `INSERT INTO trigger_events (type 'linear', externalEventId = Linear-Delivery ?? sha256(body)) ON CONFLICT DO NOTHING`.
5. Answer 200 and enqueue `triggers:process-event` after commit.

Body cap: 5 MiB (413). The workspace is resolved during processing, by `organizationId`, to an installation of *this app*. A miss is recorded `unknown_installation` and answered with the same 200 it already got.

### 4. Processing — events into conversations

`LinearEventOps.process(event)`, one row per case:

| Event | Outcome |
|---|---|
| `AgentSessionEvent` `created` | Upsert the conversation (`externalId = agentSession.id`) and the channel (`issue.project.id`, else `issue.team.id`). Record the creator as a `participant`. The first inbox row is built from `promptContext` (the issue, its comments, `guidance[]`), with `deliveryKey = session:created`. **Enqueue the acknowledgement `thought`** (reserved bucket), then wake the conversation |
| `AgentSessionEvent` `prompted` | Inbox row from `agentActivity.content.body` (falling back to `body`, LC-DIFF-01), with `deliveryKey = activity.id`. If the conversation is `waiting` on an answer, it answers the waiting question. If the body carries the `stop` signal, Stop |
| `AgentSessionEvent` with an unknown `action` | Recorded, `ignored-unknown` |
| `AppUserNotification` (`issueMention`, `issueCommentMention`, `issueAssignedToYou`, `issueUnassignedFromYou`, `issueStatusChanged`, `issueNewComment`, reactions…) | v1's decided-outcome table (`LinearNotificationOps`). **None starts work.** Linear opens the session itself on a mention or delegation. Unassignment and un-delegation disengage. A status change sets `checkAfter` for `triggers:check-notifications`, which reads the issue's new state outside the transaction and disengages on completed or canceled |
| `Issue` `remove` | Disengage the issue's sessions |
| `PermissionChange` | Update the installation's team access. Sessions on teams the app lost are disengaged |
| `OAuthApp` `revoked` | Installation `uninstalled`; disengage everything; forget tokens (never call revoke) |

The bot is a delegate when someone delegates an issue to it. At that bot's first tick on such a session, issue hygiene runs:

- move the issue to the team's first `started` state (the lowest `position`) if it is not started, completed, or canceled;
- set a missing delegate.

Hygiene never fails the tick and never touches the assignee.

### 5. The interactive surface — Linear activities

`backend/channels/linear/` renders the contract through `outbox_messages`. v1's outbox semantics are preserved:

- each `agentActivityCreate` carries the outbox row's UUID as `input.id`; "already exists"/`CONFLICT` counts as sent;
- a per-session Redis lease keeps per-session order;
- what Linear would refuse is refused at enqueue (an ephemeral non-thought, an empty body, anything after an elicitation).

| Contract | Linear |
|---|---|
| ack | `thought` (not ephemeral): "On it." Server-emitted, before the first tick |
| `status(working)` | ephemeral `thought` with the step in progress. Superseded by the next activity |
| `step` (a tool call) | `action` `{ action, parameter }`, later with `result` |
| `plan` | `agentSessionUpdate(plan: [{ content, status }])`, the session's plan checklist |
| `question` | `elicitation { body }`. With options, the `select` signal and `signalMetadata.options`. **Ends the tick** |
| `approval` | `elicitation` with `select` options "Approve" / "Deny". Answered by the next `prompted` (an option value, or free text interpreted by the `fast` model) |
| `escalation` | `thought`: "I've asked a Hypotenuse admin about this", then the `help_requests` row |
| `response` | `response { body }` |
| `error` | `error { body }` |
| sandbox PR | `agentSessionUpdate(addedExternalUrls: [{ label: "Pull Request", url }])`. Never `externalLink` or a whole `externalUrls` list |
| session title | `agentSessionUpdate(summary)` once, from the `fast` model, 1–255 characters, single line |

Who may approve on Linear follows the bot's approval policy (see [Slack](./phase-14-slack.md) §6):

| Policy | Who may decide in Linear |
|---|---|
| `requester` | The session's creator |
| `anyone-in-channel` | Anyone who can prompt the session |
| `project-members` / `dashboard-only` | The elicitation links to the dashboard |

### 6. Memory boundary

A Linear project is the unit people already use for "a body of work". Its channel memory holds decisions, conventions, and facts learned on any of the project's issues. Issues with no project use their team's channel (`externalId = team:<id>`). If an issue moves to another project, later sessions on it see the new project's memory. The session keeps the conversation it has; its `channelId` does not change mid-conversation.

### 7. Linear tools for the bot

Server-side tools, from v1's `daemon:linear-*` set and documents (`backend/ops/linear/operations.ts`). Each re-derives its installation and issue from the conversation row, so a model cannot name someone else's issue:

- `linear_issue_view`
- `linear_issue_search`
- `linear_comment_create` (`parentId` allowed)
- `linear_issue_create` (with `createAsUser`/`displayIconUrl` attribution; never `assigneeId`)
- `linear_issue_relation_create`
- `linear_document_create` / `_update` / `_view`

They run through the same approval gate as MCP tools ([shared MCP servers](./phase-10-shared-mcp-servers.md)). Writes are `approval: policy`; reads are allowed.

### 8. Test Linear

finear, fetched at a pinned commit (`backend/scripts/fetch-finear.ts`), booted in process by `useFinear()`. It sits behind v1's recording proxy, which:

- stamps rate-limit headers;
- answers `RATELIMITED`;
- loses responses;
- stands in for documents finear lacks, validated against Linear's schema.

`__tests__/linear/inject.ts` signs what finear cannot send. finear gaps go upstream to [`pmdroid/finear`](https://github.com/pmdroid/finear/issues), per [`AGENTS.md`](../../AGENTS.md). With one app per bot, the harness registers **one finear OAuth client per bot fixture**.

## Schema sketch

No new tables:

- `bot_installations` (`type: "linear"`):
  - `externalTeamId` = Linear `organizationId`
  - `details`:
    - `appUserId`, `appUserName`, `urlKey`, `scopes[]` (the routing key is the framework's `routingKeyHash` column)
    - `teamAccess { canAccessAllPublicTeams, teamIds[] }`
    - sealed `{ clientId, clientSecret, webhookSecret, webhookSecretPrevious?, accessToken, refreshToken }`
    - `accessTokenExpiresAt`, `refreshStartedAt`
- `channels`:
  - `type: "linear"`
  - `externalId` = `project:<uuid>` or `team:<uuid>`
  - `details { name, url }`
- `conversations`:
  - `externalId` = `agentSession.id`
  - `details { issueId, issueIdentifier, sessionUrl, plan[] }`
- `trigger_events.checkAfter` (ported) for notification second looks.

## Actions and policy sketch

| Action | Route | RBAC | MCP | Audited |
|---|---|---|---|---|
| `linear:manifest-url` | `GET /bot/:botId/linear/manifest-url` | admin | yes | no |
| `linear:app-register` | `PUT /bot/:botId/linear/app` (`secret()` fields) | admin | yes | yes |
| `linear:install-url` | `GET /bot/:botId/linear/install-url` | admin | yes | no |
| `linear:callback` | `GET /linear/callback` | session (browser hop) | **never** | yes |
| `linear:uninstall` | `DELETE /bot/:botId/linear/installation/:id` | admin | yes | yes |
| `webhooks:linear` | `POST /api/webhooks/linear/:routingKey` | none (signed) | **never** | no (machine ingress) |
| `installations:refresh-tokens` | task-only clock | — | never | no (clock) |
| `triggers:check-notifications` | task-only clock | — | never | no (clock) |

`clientSecret`, `webhookSecret`, `accessToken`, and `refreshToken` stay in `SENSITIVE_KEYS`.

## Frontend and user docs

- Bot page, **Linear** tab:
  1. Copy the creation link.
  2. Paste the credentials.
  3. Install into a workspace.
  4. Installed workspaces with team access and health.
  5. Channels (projects/teams) the bot has worked in.
- `frontend/src/content/docs/linear.md`:
  - creating the app, installing, delegating vs mentioning;
  - what the session shows, approving by option, stopping;
  - memory follows the Linear project.
- Illustrations in both themes.

## Steps

### 1. Port — `backend/ops/{LinearOAuthOps,LinearOps,LinearManifestOps,LinearBucketOps,LinearMarkdownOps,LinearNotificationOps,IssueHygieneOps}.ts`, `backend/ops/linear/operations.ts`, `backend/lua/linear-token-bucket.lua`

From `v1`. Credentials are read from the installation row, never config. Any v1 comment that names work items or runners is rewritten.

### 2. Adapter — `backend/channels/linear/index.ts`

`verifyInbound`, `parseInbound`, `send` (the outbox semantics), and `capabilities`:

- streaming: no (activities instead)
- plan: yes
- buttons: options via `select`
- edits: no

### 3. Event processing — `backend/channels/linear/events.ts`

### 4. Tools — `backend/tools/linear/*.ts`

### 5. Actions — `backend/actions/linear/*.ts`, `backend/actions/webhooks/webhooks-linear.ts`, `backend/actions/installations/installations-refresh-tokens.ts`

### 6. Harness — `backend/scripts/fetch-finear.ts`, `backend/__tests__/linear/*`

### 7. Frontend — `frontend/src/pages/bots/BotLinearTab.tsx`

### 8. CLI — `cli/src/commands/linear.ts`

`hypotenuse bot linear manifest-url|register|install-url|status|uninstall`.

### 9. Docs — `docs/LINEAR_COVERAGE.md`, `backend/__tests__/docs/linear-coverage.test.ts`, `frontend/src/content/docs/linear.md`

## Test plan

- **Matrix:** every `LC-*` row from v1 is kept, re-pointed, or marked `not applicable` with "not used/needed" and a test asserting the non-use. The runner/daemon rows become `not applicable`.
- **Acknowledgement:** `ack.test.ts` with a real Resque worker. `created` → `thought` on finear in under 10 s, while the scripted model takes 30 s.
- **A whole session:** delegation → hygiene moves the issue to started → ack → plan → `action`s → `response`. Judged by the session as finear holds it.
- **Questions:** an elicitation ends the tick, and nothing follows it even when a sandbox finishes meanwhile. `prompted` answers it.
- **Approvals:** by option, by free text interpreted by the `fast` model, and by a non-requester under `requester` policy (refused, with an explanation).
- **Disengagement:** each of the seven triggers cancels silently. A later `prompted` re-engages.
- **Multiple bots:** two bots with two apps in one workspace. Each verifies with its own secret; a delivery signed by bot A's secret on bot B's URL gets 401.
- **Tokens:** refresh rotation, the lost refresh response (replay grace), `invalid_grant` → error, revoke never called on reconnect.
- **Rate limits:** `RATELIMITED` (HTTP 400 `extensions.code`) and the reserved acks.
- **Memory boundary:** an issue in project P writes channel memory that a session on another issue in P can read and a session in project Q cannot. An issue with no project uses the team channel.
- **Mentions:** no outbound text contains a literal mention of the bot (scan every recorded `agentActivityCreate`).

## Verification

```bash
cd backend && bun run finear:fetch && bun test __tests__/linear
cd backend && bun test __tests__/docs
bun run lint
```

By hand: create a bot's Linear app from the link; install it in a test workspace; delegate an issue; watch the session.

## Definition of done

- [x] Each bot has its own Linear OAuth app, created from a pre-filled link and installed per workspace with `actor=app`
- [x] `webhooks:linear` verifies per app, answers within 5 s, never refuses a workspace, and dedupes on `Linear-Delivery`
- [x] Every `created` session is acknowledged within 10 s
- [x] Sessions are conversations; activities, plan, elicitation, and `externalUrls` render the interactive surface
- [x] Every disengagement cancels silently; nothing follows an elicitation
- [x] Channel memory is the issue's Linear project, falling back to its team
- [x] Linear tools re-derive their scope from the conversation; no Linear credential leaves the server
- [x] `docs/LINEAR_COVERAGE.md` is back, every row has its test, and the docs test is green
- [x] Bot Linear tab, CLI, and `linear.md` ship in the same PR

## Open questions

- **finear and many apps.** v1's harness registered one OAuth client. Confirm finear handles many apps installed in one workspace, each with its own webhook URL. If not, file it upstream.
- **Real Linear and terminal sessions.** finear refuses an app's activity on a `complete`/`error` session. Whether real Linear does is still unconfirmed (v1 pinned it with `test.failing`). It matters more now, because sandbox results may arrive after a `response`.
- **Project moves.** Should a conversation whose issue changes project mid-session start reading the new project's memory at its next tick, or keep the old one until it ends? Default: keep the old one.
- **Linear's own MCP server.** Should a bot reach Linear for issues *outside* its session through our tools, or through Linear's MCP server registered as a [shared MCP server](./phase-10-shared-mcp-servers.md) with the bot's own token?

## Learnings from the build

### What is built

| Piece | Where |
|---|---|
| The adapter: `Linear-Signature` verification with the previous secret and the signed `webhookTimestamp` (60 s), the OAuth install with `actor=app` and PKCE, and the activities out | `backend/platforms/linear/{adapter,events}.ts`, registered in `backend/platforms/registry.ts` |
| The API client (GraphQL and the token endpoint, `RATELIMITED`, refresh under the row lock with the replay grace, never revoke) and the per-installation bucket with a reserve | `backend/ops/LinearOps.ts`, `backend/lua/linear-bucket.lua`, `config.platforms.linear` |
| The manifest and its pre-filled creation link; mention-safe, size-capped bodies | `backend/ops/LinearManifestOps.ts`, `backend/ops/LinearMarkdownOps.ts` |
| Contract additions: `acknowledgeWhileInactive`, `globalConversationKeys`, `workspaceOf`, `oauth.pkce` and `oauth.tokenKeys`, a manifest's `link`; inbound `conversationDetails`, `ackPayload`, a stop's `reply`, and the lifecycles `disengage`, `settings`, `noted` | `backend/platforms/types.ts`, `backend/ops/{TriggerEventOps,IngressOps,InstallationOps}.ts`, the generic OAuth hops |
| `conversations.details` (a session's issue, team, and project) | `backend/schema/conversations.ts`, migration `0013` |
| Actions: `webhooks:linear`; the clock `installations:refresh-tokens` | `backend/actions/webhooks/webhooks-linear.ts`, `backend/actions/installations/` |
| Tools: `linear_issue_view`, `linear_comment_create` (gated), offered only in a Linear session | `backend/tools/linear-*.ts` |
| finear as the test Linear, fetched at the pinned commit (`bun run finear:fetch`, run by `bun run test`), behind a recording proxy that also answers `RATELIMITED` and loses responses | `backend/scripts/fetch-finear.ts`, `backend/__tests__/linear/{finear,harness}.ts` |
| Proof | `backend/__tests__/linear/{install,session,conformance-linear}.test.ts`, `backend/__tests__/cli/linear-commands.test.ts`; the coverage matrix [`docs/platform-coverage/linear.md`](../platform-coverage/linear.md) |
| Dashboard | the Linear block on the bot's Channels section (`frontend/src/components/bots/LinearPlatformBlock.tsx`) |
| CLI 2.10.0 | `hypotenuse linear link\|connect\|install` (`cli/src/commands/linear.ts`); `installation manifest` prints a platform's `link`; `installation test`, `view`, and `disconnect` serve Linear |
| User docs | `frontend/src/content/docs/linear.md`; `connecting-a-platform.md` and `cli.md` updated |

### Decisions the plan left open, and where the build differs

| The plan says | As built |
|---|---|
| `backend/channels/linear/`, `backend/tools/linear/*.ts` | `backend/platforms/linear/` ([channel framework learnings](./phase-13-channel-framework.md#decisions-the-plan-left-open-and-where-the-build-differs)); `backend/tools/linear-*.ts`, beside every other tool |
| `linear:manifest-url`, `linear:app-register`, `linear:install-url`, `linear:callback`, `linear:uninstall` | the framework's `bot-installation:manifest` (answering the creation `link`), `:connect`, `:oauth-start` / `:oauth-callback` (now with PKCE for a platform that asks for it), and `:disconnect`. Linear has no action of its own but its webhook |
| a second workspace is a second installation under the same app credentials | one installation per bot per workspace, as Slack: the first install sets the workspace, and a delivery naming another `organizationId` is recorded `unknown-installation` with the 200 it already got. A second workspace needs a second app (a new creation link). The routing key names one installation, and an app's webhook URL is one URL, so serving many workspaces from one app needs routing by `organizationId` after verification — not built |
| a bad signature and a stale timestamp get byte-identical **401**s; an unknown or disconnected workspace gets 200 | every routing or signature failure is the framework's byte-identical 404. An installation that is not active but still holds its webhook secret (pending, errored, uninstalled) is verified and answered 200 (`acknowledgeWhileInactive`), so Linear never sees a failure from a workspace that once installed the bot. A disconnected one forgets its secret and is the 404 |
| body cap 5 MiB | the framework's `PLATFORM_MAX_BODY_BYTES` (1 MiB) |
| `AppUserNotification` `issueStatusChanged` sets `checkAfter` for `triggers:check-notifications` | not built: the app subscribes to `Issue` events, whose `update` carries the new state's `type` and the `updatedFrom` it changed, so completion, cancellation, and un-delegation (the delegate taken away, which a dismissed session also does) are read from that one event. Every notification starts nothing and is recorded with a decided outcome (`assigned-not-delegated`, `notification-<type>`) |
| the acknowledgement, a server-emitted `thought` ("On it.") | the framework's acknowledgement row (`Thinking…`, priority `ack`), which Linear renders as a non-ephemeral `thought` on the bucket's reserve. A person's prompt that answers an elicitation or decides an approval is acknowledged too (`acknowledgeInteraction`, on a platform with `elicitation`), because Linear clears a session's acknowledgement on every human prompt |
| issue hygiene at the bot's first tick; set a missing delegate | after the acknowledgement is delivered, by the adapter (the ack row carries `hygiene` when the issue's delegate is the bot): no tick waits on it and it never fails one. A missing delegate is not set: a session the bot was delegated already names it |
| `step` → `action` | an `action` (with its `result`) for each plan step that finished since the last plan row sent, with an id derived from the conversation and the step, so redelivery adds none |
| approvals by option or by free text the `fast` model reads; `requester` / `anyone-in-channel` / `project-members` / `dashboard-only` | the framework's binding policies: under `participants` (or `listed`), the elicitation offers `Approve #<id>` / `Deny #<id>` as `select` options, read by the existing `approve <id>` reply rule; under `dashboard`, it links to the request. Free text is a message to the bot, not a decision |
| session title from the `fast` model (`agentSessionUpdate(summary)`); a sandbox PR as `addedExternalUrls` | not built: no summary is written, and sandboxes do not exist yet |
| Linear tools `linear_issue_view`, `_search`, `linear_comment_create`, `linear_issue_create`, `_relation_create`, `linear_document_*` | `linear_issue_view` and `linear_comment_create`. A comment always waits for an approval (there is no Linear allowlist); reads run. The rest wait on whether a bot should reach Linear beyond its session through these tools or through Linear's own MCP server registered as a shared MCP server (the plan's open question) |
| `docs/LINEAR_COVERAGE.md` keeping v1's `LC-*` ids | [`docs/platform-coverage/linear.md`](../platform-coverage/linear.md) with `linear.*` ids, beside Slack's, read by the same `coverage.test.ts`; v1's runner and dispatch rows have nothing to point at |
| one finear OAuth client per bot fixture | finear takes clients only at boot; the harness registers each bot's at run time through finear's own exported `registerClient` |

- **A stop is answered.** finear (and Linear's docs) keep a stopped session `stopping` until the agent writes a
  `response` or `error`, and refuse anything else. A `stop` signal cancels the conversation and writes one
  `response` — the inbound's `reply`, quoting the person's note without acting on it — on the reserve.
- **A retried activity asks first.** finear refuses any app activity on a session a `response` completed, a replay of
  that same `response` included, before it checks the activity's id. An outbox row's second attempt therefore asks
  `agentActivity(id)` and counts it sent when it is there. Whether real Linear refuses the replay or answers the
  duplicate id is unconfirmed; asking first is right either way.
- **An issue that moves keeps its session's channel.** A Linear session id names one conversation everywhere
  (`globalConversationKeys`), so a `prompted` for an existing session reads its channel from the conversation, not
  from the issue's project now. The next session on the issue uses the new project.
- **Uninstall forgets the tokens and keeps the client credentials** (`oauth.tokenKeys`), so `oauth-start` installs
  the same app again. Nothing calls `oauth/revoke`.
- **Two finear quirks the tests read through:** the `plan` and `signalMetadata` fields are Linear's `JSON` scalar
  and come back as strings; and the fixture "projects" in finear's seed are project *statuses* — tests create
  projects with `projectCreate`.

### Upstream: finear gaps

Each is driven another way meanwhile — the test signs the body with the app's real secret, or the harness's proxy
answers — never by faking Linear in `backend/`. None is filed yet: a person files each at
[`pmdroid/finear`](https://github.com/pmdroid/finear/issues) and records the number here and in AGENTS.md rule 4.

| Gap | Meanwhile |
|---|---|
| No `AppUserNotification`, `PermissionChange`, `OAuthApp revoked`, or `Issue remove` delivery to an app's webhook | signed injection (`inject` in `__tests__/linear/harness.ts`) |
| No `RATELIMITED` and no `X-RateLimit-*` headers | the proxy answers one request with Linear's documented refusal |
| OAuth clients only at boot | `registerClient` in process |
| One person per workspace, so no listed or second approver | the conformance suite's `listed` case is not run for Linear |

### Traps found while building

- **An import cycle through the registry.** `platforms/registry.ts` → the Linear adapter → `LinearOps` →
  `InstallationOps` → the registry left `linearAdapter` uninitialized at boot. The credential helpers moved to
  `ops/InstallationCredentialOps.ts`, which reads no registry; `InstallationOps` re-exports them.
- **Two suites on one test database** — a third time: running one file while the full backend suite ran truncated
  its tables and failed unrelated CLI suites. One run at a time, or `bun run workspace:setup`.
- **`settle()` runs ticks before deliveries**, so a turn's acknowledgement and plan rows are superseded by its answer
  before the outbox walks. The acknowledgement test runs the tick on a hanging model and delivers while it hangs;
  the plan test writes rows (`emit`) and delivers between them, as Slack's do.
