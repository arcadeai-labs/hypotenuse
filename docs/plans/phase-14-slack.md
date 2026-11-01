# Phase 14 — Slack

> **Goal:** A bot is its own Slack app. An admin creates it from a manifest Hypotenuse generates and installs it into a workspace, then invites it to channels. From then on, anyone who can post in one of those channels can mention the bot or reply in its thread. They see it think, plan, call tools, and answer in that thread, with Slack's own status, streaming, and buttons. The bot remembers the channel.

> **Status: built.** Builds on [the channel framework](./phase-13-channel-framework.md) (adapter registry, `bot_installations`, `channels`, `channel_bindings`, `participants`, ingress, outbox, interactive-surface contract), the [durable agent loop](./phase-08-durable-agent-loop.md) (`conversations`, `agent:tick`), and [memory](./phase-09-memory.md) (channel scope). Linear is [its own phase](./phase-15-linear.md); Pylon is [another](./phase-16-pylon.md).

Slack is the general company chat, so it is where most people meet the bot. It is also the platform with the least patience. Slack wants a 2xx within **three seconds**, retries a failed delivery three times (almost immediately, then after one minute, then after five), and turns off an app's event subscriptions when more than 95% of deliveries fail in an hour. A bot that thinks for forty seconds has to acknowledge immediately, show that it is working, and answer later through the outbox. That is the shape [the channel framework](./phase-13-channel-framework.md) already gives every platform. This phase fills it in for Slack.

**Every bot is its own Slack app.** A shared "Hypotenuse" app that changes its display name per message (`chat:write.customize`) would make every bot the same `@mention`, the same member of every channel, and the same row in Slack's audit log. A separate app per bot gives each bot its own handle, avatar, channel membership, and permissions. It costs one app creation and one install per bot. Hypotenuse removes most of that cost by generating the manifest and, where the admin provides an app configuration token, creating the app through `apps.manifest.create`.

## Scope

**In:**

- A Slack app manifest generated per bot, covering name, icon, scopes, event subscriptions, interactivity URL, and the assistant view. There are two ways to create the app:
  - Hypotenuse calls `apps.manifest.create` with an app configuration token the admin pastes in.
  - The admin pastes the generated JSON into Slack's "Create from manifest" screen and then pastes back the credentials.
- OAuth v2 install per workspace (`oauth.v2.access`), with credentials stored encrypted on `bot_installations`.
- `webhooks:slack`: Events API ingress with v0 request signing. It handles `url_verification`, `event_callback` (`app_mention`, `message.channels`, `message.groups`, `message.im`, `member_joined_channel`, `channel_left`, `app_uninstalled`, `tokens_revoked`, `app_home_opened`, `app_context_changed`, `agent_session_stopped`), and interactivity payloads (`block_actions`).
- Mapping:
  - A Slack channel (public, private, or a DM with the bot) is a `channels` row and the memory scope.
  - A thread (`thread_ts`, or the message `ts` that starts one) is a `conversations` row.
- The interactive surface:
  - **Status:** `agents.sessions.setStatus` (`processing` / `active` / `suspended`), with `assistant.threads.setStatus` as the fallback where the newer method is unavailable.
  - **Streamed answers:** `chat.startStream` / `chat.appendStream` / `chat.stopStream` with `markdown_text` chunks.
  - **Plans and steps:** `task_update` chunks under `task_display_mode: "plan"`.
  - **Questions and approvals:** Block Kit buttons answered through `block_actions`.
  - **Feedback:** `feedback_buttons`.
- Refusing Slack Connect (externally shared) channels.
- Uninstall and token revocation. Respecting disengagement when the bot is removed from a channel.
- An in-process Slack fake. A `docs/SLACK_COVERAGE.md` matrix with its docs test.
- RBAC, audit, MCP policy, CLI, UI, and user docs for each surface.

**Out:**

- Slash commands and shortcuts: a later phase may add them. The mention and the thread are the interface.
- Slack Marketplace distribution: each bot is an internal app of the installing workspace.
- Socket Mode: this is a hosted service with a public URL.
- Enterprise Grid org-wide installs: a single workspace per install for now (open question).
- Reading channel history beyond the thread the bot is in, or the messages that mention it. Memory, not scraping, is what the bot knows about a channel.
- Huddles, canvases, lists, and workflow steps.

## What already exists

| Piece | Where | Use here |
|---|---|---|
| Remote-interface design (Slack + iMessage), never built | [`toolexec: docs/plans/phase-32-remote-interfaces.md`](https://github.com/arcadeai-labs/toolexec/blob/main/docs/plans/phase-32-remote-interfaces.md) | Per-project internal app from a generated manifest, signed ingress, dedupe on message id, refusing Slack Connect, loop filtering, `agents.sessions.setStatus`. We drop its identity linking: the platform's own permissions are the gate ([channel framework](./phase-13-channel-framework.md)) |
| Webhook ingress discipline | [`v1: backend/actions/webhooks/webhooks-linear.ts`](https://github.com/arcadeai-labs/hypotenuse/blob/v1/backend/actions/webhooks/webhooks-linear.ts), [`v1: backend/ops/LinearWebhookOps.ts`](https://github.com/arcadeai-labs/hypotenuse/blob/v1/backend/ops/LinearWebhookOps.ts) | Verify the raw body, record a `trigger_events` row, answer 200, enqueue. Never rate-limit the platform's own deliveries |
| Activity outbox | [`v1: backend/ops/ActivityOutboxOps.ts`](https://github.com/arcadeai-labs/hypotenuse/blob/v1/backend/ops/ActivityOutboxOps.ts) | Generalised into `outbox_messages` by [the channel framework](./phase-13-channel-framework.md); Slack is one `send` |
| Encrypted credentials | `CryptoOps` (ported in [foundation](./phase-01-foundation.md)) | Bot token, signing secret, client secret, config token |
| Interactive-surface contract | `backend/channels/` from [the channel framework](./phase-13-channel-framework.md) | Status, streaming text, plan/steps, question, approval, escalation |

## What this must not weaken

1. **Answer within three seconds, always.** `webhooks:slack` verifies, records, answers, and enqueues. It never calls Slack, the model, or memory inline.
2. **No Slack token leaves the server.** No action returns a bot token, signing secret, client secret, or app configuration token, and no serializer has a field one could fit in.
3. **The platform is the gate.** Anyone who can post where the bot is bound may talk to it. Nobody else can reach it through Slack. A DM is a channel of one person.
4. **Respect disengagement.** When the bot is removed from a channel, uninstalled, or has its tokens revoked, the channel's live conversations are cancelled and nothing more is sent there.
5. **The bot never hears itself.** Messages from any of this project's bots (`bot_id` / `app_id` match) are dropped before they become inbox rows.
6. **Nothing is lost on retry, nothing is doubled.** A Slack retry (`X-Slack-Retry-Num`) of a delivery already recorded is answered 200 and dropped. Dedupe is on the message (`team_id`, `channel`, `ts`), not only on `event_id`, because one message can arrive as both `app_mention` and `message.channels`.

## Design

### 1. One app per bot, created from a manifest

`SlackManifestOps.buildManifest(bot, installation)` produces the JSON manifest:

- `display_information`: the bot's name, description, and background color from its identity.
- `features.bot_user`: `display_name` and `always_online: true`.
- `features.assistant_view`: so the bot appears in Slack's AI-app entry point and its DM opens as an assistant thread.
- `oauth_config.scopes.bot`:
  - `app_mentions:read`
  - `channels:history`, `groups:history`, `im:history` (thread replies only, read through `conversations.replies`)
  - `channels:read`, `groups:read`, `im:read`
  - `chat:write`
  - `assistant:write`
  - `users:read`
  - `reactions:write`
  - `files:read`
- `oauth_config.redirect_urls`: our callback.
- `settings.event_subscriptions.request_url`: `/api/webhooks/slack/<routingKey>`.
- `settings.event_subscriptions.bot_events`: the events in scope.
- `settings.interactivity.request_url`: the same URL.
- `org_deploy_enabled: false`, `socket_mode_enabled: false`.

The `<routingKey>` is an opaque per-installation token in the path. It tells ingress which `bot_installations` row's signing secret to verify with, before anything is parsed. One URL per app is what Slack expects, and it means a bad key and a bad signature can both be the same byte-identical 404 (see §3).

There are two ways to create the app, and both end in the same `bot_installations` row (`type: "slack"`, `status: "created"`):

| Path | Who does what | What we store |
|---|---|---|
| **Config token** | The admin pastes a Slack app configuration token (`app_configurations:write`). `slack:app-create` calls `apps.manifest.create`. | `app_id` and `credentials` (`client_id`, `client_secret`, `signing_secret`). The config token is used once and discarded; it is never stored. |
| **Manual** | `slack:manifest` returns the JSON. The admin creates the app in Slack and pastes back `app_id`, `client_id`, `client_secret`, and `signing_secret` (`slack:app-register`). | The same fields. |

`apps.manifest.create` is rate-limited at Tier 1 and answers `invalid_manifest` with `errors[].pointer`. The action surfaces those pointers verbatim, because the admin is the one who can fix them.

Editing a bot's name or avatar later calls `apps.manifest.update` on the config-token path. On the manual path it shows a "re-paste this manifest" notice. Either way the change is audited.

### 2. Install

`slack:install-url` returns `https://slack.com/oauth/v2/authorize?client_id=…&scope=…&redirect_uri=…&state=…`. The `state` is a single-use Redis nonce bound to `(installationId, userId)`, as v1's Linear OAuth was. `slack:callback` (a browser hop, never MCP) exchanges the code with `oauth.v2.access` and stores:

- the bot token (`xoxb-…`), sealed;
- `team.id` and `team.name`;
- `bot_user_id`.

It then calls `auth.test` to confirm the token and moves the installation to `status: "installed"`. One bot app installed in two workspaces is two installations; `bot_installations` is unique on `(botId, type, externalTeamId)`.

Bindings: a member of a Slack channel invites the bot (`/invite @bot`). That arrives as `member_joined_channel` for the bot user. Whether the bot then **listens** there is a `channel_bindings` row. The project's binding default (from [the channel framework](./phase-13-channel-framework.md)) decides the starting point:

| Binding default | Bot invited to a channel | Effect |
|---|---|---|
| `auto` | A binding is created at `mode: "mention"` | The bot answers mentions there |
| `manual` | No binding; the channel is recorded as `unbound` | Mentions are recorded and answered once with "I'm not enabled in this channel yet — ask a Hypotenuse admin", posted at most once per channel per day |

A DM with the bot is always bound (`mode: "all"`). The person chose to talk to it.

### 3. Ingress — `webhooks:slack`

`POST /api/webhooks/slack/:routingKey`, with `web.rawBody: true`, no rate-limit middleware, never MCP.

1. Resolve the `routingKey` to an installation row by its hash ([13](./phase-13-channel-framework.md)). If the key is unknown or the installation has been deleted, answer the byte-identical 404.
2. Read `X-Slack-Request-Timestamp`. If it is more than 300 s from Postgres's clock, answer the same 404 body.
3. Compute `v0=` + hex(HMAC-SHA256(signing_secret, `v0:<timestamp>:<raw body>`)) and constant-time compare it with `X-Slack-Signature`. During rotation, also try `signingSecretPrevious`. On mismatch, answer the same 404 body.
4. Content type `application/json`:
   - `type: "url_verification"`: answer `{ challenge }` (signed like any other request).
   - `type: "event_callback"`: insert into `trigger_events` with `type: "slack"`, `externalEventId: event_id`, and the raw body (`ON CONFLICT DO NOTHING`), answer 200, and enqueue `triggers:process-event` after commit.
5. Content type `application/x-www-form-urlencoded` (interactivity): the `payload` field is JSON. Record it the same way, keyed on the payload's `trigger_id`, and answer 200 with an empty body. Slack shows a button as pressed only while we answer; the visible result comes through the outbox.
6. Body cap 1 MiB (413), the same shape as v1's 5 MiB Linear cap.

A retry (`X-Slack-Retry-Num` present) is handled identically. The `ON CONFLICT` makes it a no-op, and the reason header is recorded on the event for diagnosis. We never send `x-slack-no-retry`: a retry that lands is a no-op, and one that rescues a lost delivery is the point.

### 4. Processing — Slack events into conversations

`SlackEventOps.process(event)` runs inside `triggers:process-event`. It never calls Slack inside its transaction; anything needing a Slack read becomes a follow-up job. It decides per event:

| Event | Condition | Outcome |
|---|---|---|
| `app_mention` | Bound channel, not Slack Connect | Find or create the conversation for `(channel, thread_ts ?? ts)`. Insert an inbox row (`deliveryKey = team:channel:ts`), record the sender as a `participant`, and wake the conversation |
| `message.*` in a thread the bot is part of | Not from a bot of ours; no `subtype` except `file_share`/`thread_broadcast` | Inbox row on that conversation (`queue`, or `steer` while a tick is running, per [the loop](./phase-08-durable-agent-loop.md)) |
| `message.im` | DM | One conversation per DM thread; a top-level DM message starts a new conversation |
| `message.*` with `subtype: message_changed`/`message_deleted` | Any | Recorded in `trigger_events` with the outcome `ignored-edit`. History is the inbox, and an edit does not rewrite what the bot already read (v1's "history comes from activities, not comments") |
| `member_joined_channel` (the bot) | — | Upsert `channels`; apply the binding default |
| `channel_left` / `group_left` | — | Binding to `removed`. Cancel the channel's live conversations with `disengaged: removed-from-channel` |
| `app_uninstalled`, `tokens_revoked` | — | Installation to `uninstalled`; every binding and live conversation disengages silently |
| `agent_session_stopped` | The user pressed stop in Slack's AI surface | The conversation's Stop: cancel the live tick, supersede queued non-final messages, and post nothing further |
| `app_home_opened` (`tab: messages`), `app_context_changed` | — | Recorded; `app_context` entities are attached to the next inbox row as context |
| `block_actions` | `action_id` names a question or approval of ours | Answer it (§6), attributed to the clicking `participant` |
| Shared channel (`is_ext_shared_channel: true`, or `context_team_id` ≠ the installation's team) | — | Outcome `refused-shared-channel`; one notice to project admins per channel |
| An event from one of this project's bots (`bot_id`/`app_id` in `bot_installations`) | — | Outcome `ignored-own-bot` |

**Who may talk** is answered by Slack. If the event arrived from a channel where the bot is bound, the sender could post there. The sender is upserted into `participants` (`type: "slack"`, `externalUserId`, display name from a cached `users.info`). That gives attribution, not authority.

### 5. The interactive surface — what a person sees

| Contract verb | Slack rendering | Notes |
|---|---|---|
| `status(working)` | `agents.sessions.setStatus(channel_id, thread_ts, "processing")`. Fallback: `assistant.threads.setStatus` with the bot's own loading line | Re-sent on every tick under an hour, because `processing` times out after one hour |
| `status(idle)` | `setStatus("active")` | **Always** sent when a tick ends, or Slack shows "thinking" until the timeout |
| `status(waiting)` | `setStatus("suspended")` | While parked on an answer, approval, or sandbox |
| `stream.start` | `chat.startStream(channel, thread_ts, task_display_mode: "plan")` | Returns `ts`, stored on the outbox row so later chunks append to it |
| `stream.text` | `chat.appendStream(ts, [{type: "markdown_text", text}])` | Batched to about one call per second per stream |
| `plan / step` | `task_update` chunks (`id`, `title`, `status` `pending`/`in_progress`/`complete`) | A tool call becomes a step; 256-character titles |
| `stream.end` | `chat.stopStream(ts, chunks, blocks)` with `feedback_buttons` | Streams cannot stay open past 10 minutes. A tick that outlives that ends its stream and starts another |
| `question` | A message with section text plus up to five `button`s (or a `static_select`), each `action_id = q:<questionId>:<option>` | Free-text replies in the thread also answer it |
| `approval` | A message with "Approve" / "Deny" buttons, `action_id = a:<approvalId>:<decision>`, and a context line naming the tool and why | Only a person allowed by the approval's policy may decide (see §6) |
| `escalation` | A short thread notice ("I've asked a Hypotenuse admin") | The escalation itself goes to `help_requests` + notifications |
| `response` (final) | The stopped stream's final text, or `chat.postMessage` when no stream was open | Slack `mrkdwn` is produced from markdown by `SlackMarkdownOps` |
| `error` | A message prefixed with the error glyph | |

Long outputs: anything over Slack's 40,000-character message limit is truncated with a link to the conversation's transcript page in the dashboard.

The bot never writes `<@U…>` for its own user, and it never writes `<!channel>` or `<!here>`. `SlackMarkdownOps.sanitize` escapes them. A bot that mentions itself would start another conversation, and a bot that pings a channel is a bot people uninstall.

### 6. Answering in Slack

A `block_actions` payload names `user.id`, `channel.id`, `message.ts`, and the action. The rules:

- **Questions** (`ask_question`): anyone in the channel may answer. The answer is appended to the waiting turn and wakes it (`waitingOn: answer`). The question message is updated in place (`chat.update`) to "Answered by @x: …" so a second click is visibly late. Late clicks are recorded and answered with an ephemeral "already answered".
- **Approvals** (the gate from [shared MCP servers](./phase-10-shared-mcp-servers.md) and [code mode](./phase-12-code-mode.md)): a bot's approval policy names who may approve in-channel:

  | Policy | Who can approve in Slack |
  |---|---|
  | `anyone-in-channel` | Any participant who can see the message |
  | `requester` | Only the participant whose message started the turn |
  | `project-members` | A participant whose Slack identity is linked to a Hypotenuse user with `canWriteBot`. Otherwise the button answers an ephemeral "approve this in Hypotenuse" with a link |
  | `dashboard-only` | No in-channel approval; the message carries a dashboard link |

  Optional identity linking (`participants.userId`) exists only to make `project-members` possible. It is minted from a signed-in Hypotenuse session, never the reverse. ToolExec's anti-phishing rule is kept. A decision is audited as the linked user when there is one, and recorded on the approval with the participant otherwise.

### 7. The Slack fake

There is no finear for Slack, so tests talk to `backend/__tests__/slack/fake-slack.ts`. It is an in-process HTTP server that:

- Signs and delivers Events API and interactivity payloads to our real `webhooks:slack`, with Slack's exact headers and retry semantics (it can resend with `X-Slack-Retry-Num`, or deliver late).
- Serves the Web API methods we call (`oauth.v2.access`, `auth.test`, `apps.manifest.create`/`update`, `chat.postMessage`/`update`/`startStream`/`appendStream`/`stopStream`, `agents.sessions.setStatus`, `assistant.threads.setStatus`, `conversations.replies`, `users.info`). It records every call, and can answer `ratelimited` with `Retry-After`, `invalid_auth`, or a lost response.
- Validates every request against Slack's published Web API spec (`slack-api-specs` OpenAPI, pinned by commit in `backend/scripts/fetch-slack-spec.ts`). A request that would be malformed against real Slack fails the test, not production. The same goes for our generated manifest against Slack's manifest schema.
- Holds threads as Slack would, so a test asserts what a person in the channel sees: messages, stream contents, task steps, and status.

This fake is ours, so its fidelity is ours. Every behavior it encodes cites the Slack doc it came from in a comment, and `docs/SLACK_COVERAGE.md` ties each to a test.

### 8. Rate limits

Slack limits per method and per workspace, by tier, and answers `ratelimited` with `Retry-After`. `chat.postMessage` is roughly one message per second per channel. The outbox's per-conversation ordering lease already serialises sends. `SlackOps.request` additionally holds a per-installation token bucket in Redis (`backend/lua/slack-bucket.lua`, the shape of v1's Linear bucket) and honours `Retry-After` by rescheduling the outbox row, never by sleeping in a worker.

## Schema sketch

No new tables. Slack fills generic ones:

- `bot_installations.details` (jsonb, per `type: "slack"`):
  - `appId`, `clientId`, `teamId`, `teamName`, `botUserId`
  - `scopes[]`
  - `routingKeyHash` (the channel framework's, indexed, unique)
  - `manifestRevision`
  - sealed `{ clientSecret, signingSecret, signingSecretPrevious?, botToken }`
- `channels`:
  - `type: "slack"`
  - `externalId: "<teamId>:<channelId>"`
  - `details { kind: "public" | "private" | "im", name, isShared }`
- `conversations`: `externalId: "<teamId>:<channelId>:<threadTs>"`.
- `outbox_messages.details`: `{ streamTs?, messageTs?, blocks? }`.
- `participants`: `type: "slack"`, `externalUserId: "<teamId>:<userId>"`.

## Actions and policy sketch

| Action | Route | RBAC | MCP | Audited |
|---|---|---|---|---|
| `slack:manifest` | `GET /bot/:botId/slack/manifest` | member + `canWriteBot` | yes | no (read) |
| `slack:app-create` | `PUT /bot/:botId/slack/app` (config token, `secret()`) | admin | yes | yes |
| `slack:app-register` | `PUT /bot/:botId/slack/app/register` (pasted credentials, `secret()`) | admin | yes | yes |
| `slack:install-url` | `GET /bot/:botId/slack/install-url` | admin | yes | no |
| `slack:callback` | `GET /slack/callback` | session (browser hop) | **never** | yes (the person's install) |
| `slack:manifest-sync` | `POST /bot/:botId/slack/manifest` | admin | yes | yes |
| `slack:uninstall` | `DELETE /bot/:botId/slack/installation/:id` | admin | yes | yes |
| `webhooks:slack` | `POST /api/webhooks/slack/:routingKey` | none (signed) | **never** | no (machine ingress, recorded in `trigger_events`) |
| `channel-binding:*` | from [the channel framework](./phase-13-channel-framework.md) | admin | yes | yes |

`clientSecret`, `signingSecret`, `botToken`, and `configToken` join `SENSITIVE_KEYS` in the same commit.

## Frontend and user docs

- Bot page, **Slack** tab:
  1. Create the app (config-token path, or copy the manifest).
  2. Install to a workspace.
  3. Installed workspaces with health (last event received, last send error).
  4. Channels the bot is in, each with a binding toggle.

  States follow [`DESIGN.md`](../DESIGN.md): disabled, never absent.
- `frontend/src/content/docs/slack.md`:
  - creating the app (both paths), installing, inviting to channels;
  - what people see, how to approve, how to stop the bot;
  - Slack Connect is refused;
  - troubleshooting ("Slack disabled our events" → re-enable in app settings).
- Illustrations of a thread with plan steps, in both themes.

## Steps

### 1. Ops — `backend/ops/SlackOps.ts`, `backend/ops/SlackManifestOps.ts`, `backend/ops/SlackMarkdownOps.ts`

`SlackOps.request(installation, method, body)` is the single caller of the Slack Web API: typed errors, `ok: false` mapping, `Retry-After`, and the token bucket. The manifest builder and validator (against the pinned schema). Markdown → `mrkdwn` plus sanitisation.

### 2. Adapter — `backend/channels/slack/index.ts`

`verifyInbound`, `parseInbound`, `send`, and `capabilities` (streaming: yes, plan steps: yes, buttons: yes, edits: yes, maxMessageChars: 40000), registered in `backend/channels/registry.ts`.

### 3. Event processing — `backend/channels/slack/events.ts`

The decision table in §4, one function per row, with an exhaustive `switch` on `event.type` whose default records `ignored-unknown`.

### 4. Actions — `backend/actions/slack/*.ts`, `backend/actions/webhooks/webhooks-slack.ts`

### 5. Lua — `backend/lua/slack-bucket.lua`

### 6. Frontend — `frontend/src/pages/bots/BotSlackTab.tsx`

### 7. CLI — `cli/src/commands/slack.ts`

`hypotenuse bot slack manifest|create|install-url|status|uninstall`.

### 8. Docs — `frontend/src/content/docs/slack.md`, `docs/SLACK_COVERAGE.md`, `backend/__tests__/docs/slack-coverage.test.ts`

### 9. Fake and tests — `backend/__tests__/slack/fake-slack.ts`, `backend/scripts/fetch-slack-spec.ts`, `backend/__tests__/slack/*.test.ts`

## Test plan

- **Signing:** valid; stale timestamp (±301 s); wrong secret; previous secret during rotation; unknown routing key. The three refusals have byte-identical bodies.
- **Three seconds:** `ack.test.ts` runs a real Resque worker and measures `webhooks:slack` end to end under a slow model fixture.
- **Retries:** the fake delivers the same event three times with `X-Slack-Retry-Num`. There is one inbox row and one answer.
- **Double delivery:** `app_mention` plus `message.channels` for one message gives one inbox row.
- **A whole thread:** mention → `processing` status → stream with plan steps → final answer → `active` status. The fake's thread holds exactly that sequence.
- **Questions and approvals by button:** under each approval policy, including a late click, an unlinked participant, and a `dashboard-only` link.
- **Stop:** `agent_session_stopped` mid-tick cancels the tick, sends nothing further, and leaves status `active`.
- **Disengagement:** `channel_left`, `app_uninstalled`, `tokens_revoked`.
- **Refusals and loop filtering:** a Slack Connect refusal; one bot's message mentioning another bot of the same project is dropped (loop filtering covers every project bot, not only the sender).
- **Manifest validation:** the generated manifest validates against Slack's schema for every bot fixture. `apps.manifest.create` `invalid_manifest` pointers surface.
- **Rate limits:** `ratelimited` with `Retry-After` reschedules the outbox row and never blocks a worker.
- **Long streams:** a stream past 10 minutes (clock moved by writing columns) is closed and a new one started.
- **Secrets:** no response, log line, or audit row contains a token (assert by scanning).
- **Coverage:** every `SC-*` row in `docs/SLACK_COVERAGE.md` names a test that mentions it.

## Verification

```bash
cd backend && bun run slack:fetch-spec && bun test __tests__/slack
cd backend && bun test __tests__/docs
bun run lint
```

Then by hand against a real workspace:

1. Create a bot's app with a config token.
2. Install it and invite it to a test channel.
3. Mention it and watch status, plan steps, and the answer stream into the thread.
4. Press an approval button.
5. Remove it from the channel and confirm silence.

## Definition of done

- [x] A bot's Slack app is created from a generated manifest by either path, and installed by OAuth v2
- [x] `webhooks:slack` verifies v0 signatures, answers within three seconds, and dedupes retries and double deliveries
- [x] A mention in a bound channel starts a conversation; thread replies continue it; DMs work
- [x] Status, streamed text, plan steps, questions, approvals, and the final answer render as Slack-native elements
- [x] Stop, removal, uninstall, and token revocation disengage silently
- [x] Slack Connect channels are refused; the bot never hears itself or a sibling bot
- [x] The Slack fake validates every call against Slack's published spec
- [x] `docs/SLACK_COVERAGE.md` exists, every row has a passing test, and its docs test is green
- [x] Bot Slack tab, CLI commands, and `slack.md` user docs ship in the same PR

## Open questions

- **Enterprise Grid.** Org-wide installs deliver events for many workspaces through one installation (`authorizations[]`, `context_enterprise_id`). Supporting it means keying installations by enterprise too. Is any early customer on Grid?
- **`agents.sessions.*` availability.** The docs present `agents.sessions.setStatus` as replacing `assistant.threads.setStatus`, and say the old method keeps working through a compatibility bridge. Confirm which a newly created app gets, and whether `assistant:write` is still required.
- **`task_update` vs `plan_update` chunk shapes.** Slack's examples disagree (`task_update` with `title`, vs a `task` chunk with `text`). Pin the shape against the live API on the first real install and record it in the coverage matrix.
- **App configuration tokens expire after 12 hours** and rotate with refresh tokens (`tooling.tokens.rotate`). We use one once and discard it, so this should not matter. Confirm admins can produce one without a developer.
- **Channel history as memory.** Should a bot, on first binding, summarise the last N messages of a channel into channel memory? Default: no (privacy and cost). Revisit with users.

## Learnings from the build

### What is built

| Piece | Where |
|---|---|
| The adapter: v0 verification (with the previous secret), the form-encoded interactivity body, `url_verification`, the events table, the OAuth install, and the outbound surface | `backend/platforms/slack/{adapter,events,render}.ts`, registered in `backend/platforms/registry.ts` |
| The Web API client (the single caller, `ok: false` mapping, `Retry-After`) and the per-installation token bucket | `backend/ops/SlackOps.ts`, `backend/lua/slack-bucket.lua`, `config.platforms.slack` |
| The manifest, and markdown to `mrkdwn` with sanitizing and truncation | `backend/ops/SlackManifestOps.ts`, `backend/ops/SlackMarkdownOps.ts` |
| Contract additions every OAuth platform will use: `decodeBody`, `handshakeWhilePending`, `oauth` (`authorizeUrl`, `exchange`), `readyToActivate`; lifecycle `channel_joined` / `channel_left` | `backend/platforms/types.ts`, `backend/ops/{IngressOps,InstallationOps,TriggerEventOps}.ts` |
| Actions: `slack:app-create`; `bot-installation:oauth-start` and `bot-installation:oauth-callback`; `webhooks:slack`; `bot-installation:connect` taught OAuth platforms | `backend/actions/slack/`, `backend/actions/bot-installation/`, `backend/actions/webhooks/webhooks-slack.ts` |
| The Slack fake, Slack's pinned Web API spec and manifest schema, and the script that pins them | `backend/__tests__/fakes/slack/`, `backend/scripts/fetch-slack-spec.ts` (`bun run slack:fetch-spec`) |
| Proof | `backend/__tests__/slack/{install,thread,conformance-slack,secrets}.test.ts`, `backend/__tests__/cli/slack-commands.test.ts`; the coverage matrix [`docs/platform-coverage/slack.md`](../platform-coverage/slack.md) |
| Dashboard | the Slack block on the bot's Channels section (`frontend/src/components/bots/SlackPlatformBlock.tsx`) |
| CLI 2.9.0 | `hypotenuse slack create\|connect\|install` (`cli/src/commands/slack.ts`); `installation manifest --type slack`, `test`, `view`, and `disconnect` serve Slack too |
| User docs | `frontend/src/content/docs/slack.md`; `connecting-a-platform.md` and `cli.md` updated |

### Decisions the plan left open, and where the build differs

| The plan says | As built |
|---|---|
| `backend/channels/slack/` | `backend/platforms/slack/` ([channel framework learnings](./phase-13-channel-framework.md#decisions-the-plan-left-open-and-where-the-build-differs)) |
| `slack:manifest`, `slack:app-register`, `slack:install-url`, `slack:callback`, `slack:uninstall` | the framework's `bot-installation:manifest`, `:connect`, `:disconnect`, and two new generic hops, `bot-installation:oauth-start` and `:oauth-callback` (Linear will use them too). Only `slack:app-create` is Slack's own |
| `slack:manifest-sync` (`apps.manifest.update` on a rename) | not built: the configuration token is never stored, so there is nothing to call it with. Renaming a bot does not rename its Slack app; create the app again |
| `agents.sessions.setStatus`, falling back to `assistant.threads.setStatus` | `assistant.threads.setStatus` only — the one documented method the fake can describe. There is no explicit "idle": Slack clears the status when the bot posts in the thread, and every turn ends in a post. A stopped or cancelled turn leaves the status until Slack's own timeout |
| plan steps as `task_update` stream chunks | one plan message per turn, `chat.postMessage` then `chat.update` per plan row. The chunk shapes are unpinned (open question); this uses only methods in Slack's published spec |
| streaming | each `stream` row carries the step's whole text; the adapter appends the delta to the open stream (the newest sent `stream` row with a `ts`, when nothing final was sent after it). A row that does not extend the stream (a retried model call) closes it and starts another; so does a stream past `SLACK_STREAM_MAX_AGE_MS` (9 minutes), read from the stream's own `ts`. A final row closes the open stream with `chat.stopStream`, then posts |
| a DM is always bound (`mode: all`) | DMs follow the bot's `autoBind.dm`, off by default, as every platform's do; `slack.md` says to turn it on |
| a project binding default `auto` / `manual`, and a once-a-day "not enabled here" reply | the framework's per-bot `autoBind`. `member_joined_channel` for the bot binds a public channel at once under it (a shared channel never auto-binds); nothing is posted in an unbound channel |
| removal sets the binding to `removed` | `channel_left`: an auto-created binding is deleted, a person's is disabled (re-enable it after inviting the bot back); the bot's conversations in the channel are cancelled. `app_uninstalled` / `tokens_revoked` cancel every conversation of the bot in the workspace |
| loop filtering on this project's bots | every bot's message is dropped (rule 1 of the processing table), which covers siblings |
| one notice to admins per refused Slack Connect channel | not built: the refusal is the event's outcome, `shared-channel`, on the Events page |
| the question message updated to "Answered by @x", an ephemeral "already answered" for a late click | not built: a late click is recorded `stale-interaction` and changes nothing. Approval cards keep their buttons after a decision for the same reason. `feedback_buttons` are not built either |
| `app_context_changed` entities attached to the next inbox row | not subscribed; `app_home_opened` is recorded and changes nothing |
| channel and sender names from Slack | events carry ids only: channels are named by id, and a sender is named by id until a `block_actions` payload (which carries `user.name`) refreshes the participant. `conversations.info` and `users.info` are not called yet |
| the installation is unique on `(botId, type, externalWorkspaceId)` from the start | the workspace is a placeholder (`default`, or the one named) until the **first** install, which rewrites it to the team id; a reinstall into a different team is refused, because channels are keyed by the workspace |
| `docs/SLACK_COVERAGE.md` | [`docs/platform-coverage/slack.md`](../platform-coverage/slack.md), beside the webhook platform's, read by the same `coverage.test.ts` |
| the spec pinned by commit | pinned by the SHA-256 of each file (the session that built this could not reach the GitHub API to resolve a commit). `slackapi/slack-api-specs` predates streaming, the assistant status, and app manifests; those methods are in `supplement.ts`, each citing its documentation page |

- **An installation waiting to be installed answers `url_verification`** (`handshakeWhilePending`): Slack verifies the
  request URL when `apps.manifest.create` (or the manual "From a manifest") saves the app, before anyone installs it.
  Its other deliveries are acknowledged and dropped.
- **Connecting an OAuth platform keeps what the install stored.** `bot-installation:connect` merges the new
  credentials over the sealed ones, keeps the old signing secret as `signingSecretPrevious` when it changes (so a
  rotation verifies both), and leaves the installation `pending` until it has a bot token. A pasted `xoxb-` token is
  probed with `auth.test` at once, which also records the bot's user id.
- **`bot-installation:oauth-start` is a read**: it writes no row, only a ten-minute `state` in Redis bound to the
  installation and the person. The callback is audited as that person, like `mcp-server:oauth-callback`, and both
  are never MCP tools.
- **A message carried by two events counts once** against the rate limits: processing skips the count when the
  message is already in the conversation's inbox (Slack sends a channel mention as `app_mention` and `message`).
- **An uninstalled app is installed again** by `bot-installation:oauth-start` on the same installation, which kept
  its client credentials; the dashboard offers it. `member_joined_channel` names its channel `C` or `G`, not
  `channel` / `group`: `G` is private, so the public auto-bind leaves it alone.
- **The token bucket** (`slack-bucket.lua`) is per installation, 20 deep and refilling one call a second by default.
  An empty bucket and an HTTP 429 are the same thing to the outbox: `retry` with the wait. There is no reserve for
  `ack` rows yet.
- **Keryx logs the request URL of every action**, path included, so an installation's routing key reaches the log
  line of each delivery; `secret()` on the `routingKey` input (now on both `webhooks:*` actions) redacts it only from
  the logged params. The routing key selects an installation and the signature still gates every delivery, but the
  key was meant to stay out of logs. This is upstream behavior (rule 4): an issue with a minimal repro is drafted for
  `actionhero/keryx` and must be filed by a person; no workaround is in place. `secrets.test.ts` asserts the
  credentials are in no log line and the routing key in no logged params.

### Traps found while building

- **Slack's manifest schema is not all of Slack's rules.** A manifest with `features.assistant_view` and no
  `assistant_thread_started` bot event passes the published schema, yet Slack's app editor flags it ("Assistant View
  should use `assistant_thread_started` bot event subscription"). The manifest now subscribes to
  `assistant_thread_started` and `assistant_thread_context_changed`, both recorded and changing nothing (the first
  message in the assistant pane arrives as `message.im`), and the fake's `validateManifest` enforces the rule on top
  of the schema. The manifest answer also carries a pre-filled creation link,
  `api.slack.com/apps?new_app=1&manifest_json=<manifest>` (`config.platforms.slack.appCreationUrl`), as Linear's does.
- **Two suites on one test database** — again: running a single file while the full backend suite ran truncated its
  tables mid-run and failed unrelated state-machine tests. One run at a time, or `bun run workspace:setup`.
- **The suites' `settle()` runs ticks before deliveries**, so a turn's `status`, `stream`, and `plan` rows are all
  superseded by its answer before the outbox walks. Test the progress kinds by writing rows (`emit`, `emitStream`)
  and enqueueing `outbox:deliver` between them; `emitStream` does not enqueue a delivery itself.
- **A binding's default approval policy is `dashboard`**: an approval card has no buttons until the binding allows
  the channel to decide.
- **The coverage-matrix parser splits on every `|`**, escaped or not: an interaction cell cannot contain one.
- **`reply_and_wait` takes at most 40,000 characters**, so a truncation test grows the text in conversion (`&` becomes
  `&amp;`) rather than sending more.
