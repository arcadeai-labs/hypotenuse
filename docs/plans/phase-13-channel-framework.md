# Phase 13 — Channel framework

> **Goal:** Any chat or ticketing platform can carry a bot's conversations through one contract. A platform
> adapter verifies and parses what the platform sends and delivers what the bot says. Each bot is its own app
> on each platform. Who may talk to a bot is decided by the platform: whoever can post where the bot is can
> talk to it. While the bot works, people see its status, its streamed answer, its plan, its questions, and
> its approval requests, in whatever form that platform supports best. When nobody in the channel can help, the
> bot can escalate to the project's people. The dashboard is a platform too: a member can chat with a bot there and
> see exactly what a teammate on a platform would, which is how a bot is tested before any platform is connected.

> **Status: built.** Builds on the [durable agent loop](./phase-08-durable-agent-loop.md) (the
> inbox, the wake operation, the first cut of `channels` and `outbox_messages`),
> [memory](./phase-09-memory.md) (channel scope), and [shared MCP servers](./phase-10-shared-mcp-servers.md)
> (approvals). Its first two adapters are a generic signed **webhook** platform and the dashboard's own **`web`**
> platform, the chat; [Slack](./phase-14-slack.md),
> [Linear](./phase-15-linear.md), and [Pylon](./phase-16-pylon.md) are the next three, each against this
> contract.

The three target platforms differ in almost every detail:

- **Slack** has channels, threads, Block Kit buttons, streamed messages, and an assistant status line.
- **Linear** has agent sessions on issues, with typed activities (thought, action, elicitation, response) and a
  10-second acknowledgement clock.
- **Pylon** has customer accounts, issues, internal notes, and replies a customer will read.

What a bot needs from each is the same short list: receive a message, know where it came from, say something
back, and show that it is working, asking, or waiting. This phase writes that list down as an interface.

ToolExec planned this layer as its remote interfaces design
([`phase-32-remote-interfaces.md`](https://github.com/arcadeai-labs/toolexec/blob/main/docs/plans/phase-32-remote-interfaces.md)):

- a transport registry;
- signed ingress that answers fast and dedupes on the message rather than the event;
- an outbox whose row id is the idempotency key;
- loop filtering;
- channel audience as a recorded decision.

Hypotenuse takes all of that, and changes one thing on purpose. ToolExec required every sender to link their
platform identity to a ToolExec user, and gave authority only to linked people. Hypotenuse 2.0 is a shared agent
that relies on the platform's permission model: being in the channel is the permission. That makes the
*binding*, where a bot is allowed to listen, the decision that carries the weight. It also makes rate limits and
budgets the defense against abuse, because identity is not.

## Scope

**In:**

1. **The platform adapter registry**, `backend/channels/registry.ts`. Each adapter provides:
   - `verifyInbound`, `parseInbound`, `resolveChannel`, `send`, `validateOutbound`;
   - `manifest`, the per-bot app definition;
   - `capabilities`;
   - the **interactive-surface contract**: status, streaming text, plan, question, approval, error.
2. `bot_installations`: one row per bot per platform workspace. Each bot is its own app, holding its own
   encrypted credentials and a random `routingKey` that names it in its webhook URL.
3. `channels`, generalized beyond `api`: Slack channels, Linear projects or teams, Pylon accounts, and webhook
   channel keys.
4. `channel_bindings`: where a bot listens and how. The mode is `mentions`, `all`, or `dm`, plus the default
   delivery, the approval policy, whether promotion is allowed, and enabled/disabled. An audited decision.
5. `participants`: the platform people who talk to bots, recorded by external id and display name, with no
   linking to Hypotenuse users.
6. `trigger_events`, which records every inbound delivery; `triggers:process-event`; the
   `triggers:process-pending` clock.
7. Ingress: `webhooks:<platform>` actions on a raw body, checking the signature first. They answer within the
   platform's deadline and dedupe on the message key. One byte-identical 404 covers unknown routing keys,
   disabled installations, and disabled bindings.
8. `outbox_messages` generalized: an adapter target, kinds, priorities, supersession of ephemeral rows, a
   per-conversation ordering lease, `outbox:deliver`, and `outbox:deliver-due`.
9. Loop filtering: our own bots' messages, other bots, edits and deletes.
10. Interactions: buttons and replies that answer a question or decide an approval, routed back to the waiting
    conversation.
11. `help_requests` and `escalate_to_human`. These notify holders of the bot's `helpNotifyTag` in the dashboard
    and by email, and the answer resumes the conversation.
12. Rate limits per participant, per channel, and per bot.
13. **The generic `webhook` platform:**
    - signed JSON in and out, so any system can be a channel;
    - the first adapter;
    - the conformance target for the contract.
14. **The fake-platform harness:** a pattern and a base class for in-process platform fakes over the real wire
    protocol. [14](./phase-14-slack.md) through [16](./phase-16-pylon.md) build on it.
15. **The `web` platform, the dashboard chat** (§11): a member talks to a bot in the dashboard and sees the
    interactive surface rendered with every capability — streamed text, a status line, plan steps, questions as
    buttons, approvals decided in place — in `web` channels whose memory is their own, with fresh scratch channels
    for a clean test.

**Out:**

- Slack, Linear, and Pylon themselves: [14](./phase-14-slack.md), [15](./phase-15-linear.md),
  [16](./phase-16-pylon.md).
- Linking a participant to a Hypotenuse user. Not needed for authority; an open question for attributing cost
  and audit to people.
- A shared, marketplace-listed app per platform. One app per bot is the decision. A shared app would be a later
  phase if installs become the bottleneck.
- Mirroring a conversation into a second channel. A conversation lives in exactly one channel.
- A dashboard chat for anyone outside the project. The `web` platform is a member's tool, gated by project RBAC.

## What already exists

| Thing | Where | Use here |
|---|---|---|
| ToolExec's remote interfaces design | [`docs/plans/phase-32-remote-interfaces.md`](https://github.com/arcadeai-labs/toolexec/blob/main/docs/plans/phase-32-remote-interfaces.md) | The transport registry (§8), ingress discipline (§5), outbox (§4), loops (§7), audience as a decision (§6), threads with one subject (§3). Its identity linking (§1, §2) is replaced by participants |
| ToolExec's human help | [`docs/plans/phase-12-human-help.md`](https://github.com/arcadeai-labs/toolexec/blob/main/docs/plans/phase-12-human-help.md), [`backend/ops/HelpOps.ts`](https://github.com/arcadeai-labs/toolexec/blob/main/backend/ops/HelpOps.ts) | `resolveHelpRecipients` (the `helpNotifyTag` holders who can also read the agent, falling back to admins), the cap per conversation, expiry, and notifications through browser and email |
| v1's Linear ingress and outbox | [`docs/plans/phase-07-webhook-ingress-and-session-mirror.md`](https://github.com/arcadeai-labs/hypotenuse/blob/v1/docs/plans/phase-07-webhook-ingress-and-session-mirror.md), [`backend/ops/ActivityOutboxOps.ts`](https://github.com/arcadeai-labs/hypotenuse/blob/v1/backend/ops/ActivityOutboxOps.ts), [`backend/ops/TriggerEventOps.ts`](https://github.com/arcadeai-labs/hypotenuse/blob/v1/backend/ops/TriggerEventOps.ts) | `trigger_events` with `type` and `external*` ids; a webhook with no rate-limit middleware; an `INSERT … ON CONFLICT DO NOTHING` then lock; the per-conversation Redis lease; refuse-at-enqueue; `ack` and `bulk` priorities; supersession of ephemerals; separate `*-due` clocks |
| v1's notification table outcomes | [`backend/ops/LinearNotificationOps.ts`](https://github.com/arcadeai-labs/hypotenuse/blob/v1/backend/ops/LinearNotificationOps.ts) | Every inbound event type has a decided outcome, written as a table |
| finear's control routes | [`docs/LINEAR_COVERAGE.md`](https://github.com/arcadeai-labs/hypotenuse/blob/v1/docs/LINEAR_COVERAGE.md) | The model for every fake: real wire protocol, `/__test/*` control routes, and a recording proxy |
| The wake operation, inbox, and outbox | [08](./phase-08-durable-agent-loop.md) | Inbound messages enter through `ConversationOps.wake`; outbound messages through `outbox_messages` |
| The dashboard's composers and live transcript | [08](./phase-08-durable-agent-loop.md): `conversation:create` / `conversation:message`, `useConversation`, `components/transcript/` | The `web` platform's inbound path and the data the chat folds; today's page is an operator's log, with no streaming, no status, disabled option buttons, and approvals as links |

## What this must not weaken

1. **The platform's permission is the only authority to talk to a bot,** and a binding is the only way a bot
   listens. A message from a channel without an enabled binding is recorded and ignored.
2. **Platform credentials never leave the server,** and no serializer has a field for them (as v1's rule 7 for
   Linear). The daemon's absence makes this simpler. It does not make it optional.
3. **Ingress answers within the platform's deadline and never calls the platform inline.** It verifies,
   records, answers, and enqueues.
4. **One inbound message is one inbox row,** however many events or retries carry it.
5. **One outbox row is delivered at most once,** where the platform accepts an idempotency key. Where it does
   not, the window is narrowed and stated (recording `externalMessageId` before `sent`).
6. **A bot never answers itself or another bot.** This is a test, not a comment.
7. **Channel memory and transcripts stay with their channel.** The binding records the audience decision: the
   bot's readers in the dashboard can read what the channel said to the bot.

## Design

### 1. The adapter contract

```ts
interface PlatformAdapter {
  type: "webhook" | "slack" | "linear" | "pylon";
  installationSchema: z.ZodType;            // non-secret config
  credentialSchema: z.ZodType;              // secret config, encrypted
  manifest(bot: Bot, urls: InstallationUrls): AppManifest;   // one app per bot
  capabilities: SurfaceCapabilities;
  verifyInbound(req: RawInbound, inst: Installation): Verified | Refusal;
  parseInbound(body: unknown, inst: Installation): NormalizedInbound[];
  resolveChannel(inbound: NormalizedInbound): ChannelRef;     // the memory boundary
  validateOutbound(row: OutboxDraft): OutboxDraft | OutboundRefusal;  // refuse at enqueue
  send(row: OutboxRow, inst: Installation): Promise<SendResult>;
}

type NormalizedInbound = {
  kind: "message" | "interaction" | "signal" | "lifecycle";
  messageKey: string;                         // dedupe: the message, not the event
  channel: ChannelRef;                        // externalId + display name + private/shared flags
  conversationKey: string;                    // thread, session, issue
  sender: { externalUserId: string; displayName: string; isBot: boolean; isSelf: boolean };
  addressed: boolean;                         // mentions the bot, DM, or delegated to it
  text?: string; attachments?: Attachment[];
  interaction?: { kind: "answer" | "approval"; targetId: string; value: string };
  signal?: "stop" | "disengage" | "uninstall";
  ackDeadlineMs?: number;                     // the platform's acknowledgement clock
};
```

`SurfaceCapabilities` declares what each surface can do: `threads`, `streaming`, `status`, `plan`, `buttons`,
`ephemeral`, `edits`, `elicitation`, `typing`. The adapters set them; the outbox reads them; no call site asks
which platform it is talking to.

### 2. The interactive surface

Six kinds of outbound row, each with a fallback for a platform that lacks the capability:

| Kind | Written by | Rich form (by capability) | Fallback |
|---|---|---|---|
| `status` | tick start; long tool calls ("Searching memory…"); waits ("Waiting for approval to run github/merge_pull_request") | Slack's assistant status, Linear's ephemeral `thought` | none (skipped) |
| `stream` | model text deltas, accumulated | Slack's `chat.startStream` / `appendStream` / `stopStream` | none; the final `message` carries the text |
| `plan` | tool steps of the running turn | Slack's plan/task chunks, Linear's `plan` | none |
| `message` | `reply_and_wait`, `complete`, `fail` | a reply in the thread / a Linear `response` / a Pylon note or reply | plain text |
| `question` | `ask_question` | buttons for `options` (Slack), an `elicitation` (Linear) | text listing options; the next message is the answer |
| `approval` | an `approvals` row in this conversation | Approve / Deny / Always buttons | text with a dashboard link; "reply `approve 41`" when the policy allows it in-channel |

- **Ephemeral rows.** `status`, `stream`, and `plan` are ephemeral: a newer one supersedes the older pending one
  for the same conversation. A cancellation supersedes all three ([08](./phase-08-durable-agent-loop.md)).
- **Order.** Rows deliver in `seq` order per conversation, so a question is never posted before the status that
  led to it.
- **Nothing follows a question.** Rows written while the conversation is `waiting` on an answer are dropped at
  enqueue unless they are the answer's acknowledgement. Linear derives a session's state from its last activity,
  and v1 learned that anything after an `elicitation` breaks it. The rule is general enough to hold everywhere.

### 3. Installations: one app per bot

`bot_installations` is one row per bot per platform workspace. It carries:

- `type`, `externalWorkspaceId`, and `externalAppId`;
- `externalBotUserId`, the identity loop filtering checks;
- encrypted `credentials` (bot token, signing secret, OAuth tokens, as the adapter defines them);
- `routingKeyHash`, `status`, and `installedByUserId`.

The flow for every platform is the same. Each adapter fills in the specifics.

1. **`bot-installation:manifest`** returns the app definition for this bot: name, avatar, scopes, the event and
   interactivity URLs (`/api/webhooks/<type>/<routingKey>`), and OAuth redirect URLs.
   - For Slack it is an app manifest; for Linear, an OAuth app creation link; for Pylon, setup instructions.
   - The routing key is minted here, and only its hash is stored.
2. **The person creates the app on the platform,** then either completes the platform's OAuth install
   (`bot-installation:oauth-start` → the platform → `bot-installation:oauth-callback`) or pastes the credentials
   the platform shows (`bot-installation:connect`).
3. **`bot-installation:test`** probes the credentials and records `externalBotUserId`.

### 4. Ingress

`webhooks:<type>` is a Keryx action with `web.rawBody: true`, at `POST /api/webhooks/<type>/:routingKey`, with
no middleware except body size. In order, it:

1. Reads the routing key from the raw path and looks up the installation by hash. An unknown, disabled, or
   uninstalled installation gets one byte-identical 404, which ends retries on platforms that stop on 4xx.
2. Runs `verifyInbound` on the raw bytes, with constant-time comparison and a timestamp window. A failure gets
   the same 404 body for the same reason.
3. Answers any platform handshake (Slack's `url_verification`), only after verification.
4. Inserts a `trigger_events` row `(type, installationId, externalEventId)`, with `ON CONFLICT DO NOTHING`, then
   answers 200, all within the deadline.
5. After commit, enqueues `triggers:process-event`. `triggers:process-pending` (5 s) sweeps whatever that
   missed.

The webhook has **no rate-limit middleware**: v1 found a platform's deliveries come from a few addresses, and a
429 counts as a failed delivery that can disable the webhook for everyone.

### 5. Processing an event

`triggers:process-event` runs `TriggerEventOps.process(row)`. The rules are applied in order, and each outcome
is recorded on the row:

| # | Condition | Outcome |
|---|---|---|
| 1 | `sender.isSelf` or `sender.isBot`, or an edit or delete subtype | `ignored: loop` |
| 2 | the channel is externally shared (Slack Connect), unless the binding opts in | `ignored: shared-channel` |
| 3 | no binding for (bot, channel), and the bot's `autoBind` is off | `ignored: unbound`; the channel is upserted so a person can bind it |
| 4 | no binding, and `autoBind` is on | create an enabled binding with the bot's defaults (`autoBound: true`, recorded on the trigger event), continue |
| 5 | binding disabled | `ignored: disabled` |
| 6 | `kind: message`, not `addressed`, and the binding's mode is `mentions` | `ignored: not-addressed`, unless the conversation already exists (a reply in a thread the bot is in) |
| 7 | `kind: signal` (`stop`, `disengage`) | cancel or end the conversation through [08](./phase-08-durable-agent-loop.md); `processed: signal` |
| 8 | `kind: lifecycle` (uninstall, channel archived) | mark the installation or channel; `processed: lifecycle` |
| 9 | `kind: interaction` | resolve the question or approval it targets (§7); `processed: interaction` |
| 10 | participant rate limit or channel rate limit exceeded | `ignored: rate-limited`; one ephemeral note to the sender where the platform has ephemeral messages |
| 11 | otherwise | upsert the participant; find or create the conversation by `(botId, channelId, conversationKey)`; insert a `conversation_inbox` row with `deliveryKey = messageKey` and the binding's delivery mode; `wake`; write the acknowledgement `status` row (priority `ack`) in the same transaction |

- **`autoBind`.** It defaults to on for public channels and off for private channels and DMs. The
  platform-native act of inviting the bot is the permission. A bot that should listen in private places needs a
  person with `canWriteBot` to bind it, which records that the bot's readers can read that channel.
- **Transactions and locks.** Each event processes in one transaction. It locks the conversation, never the
  installation row, so a token refresh that holds the installation row across a platform call cannot block
  messages (a v1 lesson).
- **Failures.** A failed event is marked `failed` with its error and is not retried forever.

### 6. The outbox, generalized

`outbox_messages` gains:

- `botInstallationId` and `target` (the adapter's address: channel, thread, session, or issue);
- `kind` (§2), `priority` (`ack`, `normal`, `bulk`), and `supersedes` (the ephemeral key);
- `externalMessageId`.

Delivery works as follows:

1. `outbox:deliver` (enqueued after the commit that writes a row) takes the Redis lease
   `outbox:deliver:<conversationId>` (`release-lock.lua`, released only by its holder).
2. It sends that conversation's pending rows in `seq` order through the adapter, skipping superseded rows.
3. It records `externalMessageId` before marking a row `sent`.
4. It releases the lease.

Around that:

- `outbox:deliver-due` (1 s) fans out over conversations with due rows, 8 at a time.
- A send that gets a platform answer meaning "never" (channel not found, token revoked, the platform refusing
  the shape) ends the row `undeliverable` with the reason. A transient error backs off.
- `validateOutbound` runs at enqueue, so a malformed row is refused where it was written, with a stack trace
  that points at the writer.
- Rate-limit headers feed a per-installation token bucket, as v1's Linear bucket did, with a reserve for `ack`
  rows.

### 7. Questions, approvals, and their answers

- **An answer as a reply.** An `ask_question` puts the conversation in `waiting` / `answer`. The next inbound
  message in the conversation is the answer (rule 11 delivers it, and `wake` clears the wait).
- **An answer as an interaction.** A button sends an interaction whose `targetId` is the question entry. It is
  delivered as a message whose text is the option's label, and marked `source: interaction`.
- **An approval decided in-channel.** An approval button's `targetId` is the `approvals` row. Whether the
  pressing participant may decide is the binding's `approvalPolicy`:
  - `dashboard` (the default): no in-channel decision; the message links to the approval page, where
    `canWriteBot` decides.
  - `participants`: anyone in the channel may decide, which is the platform-permission model applied to
    approvals.
  - `listed`: only the external user ids in `approverExternalIds`.
  
  A permitted decision calls `ApprovalOps.decide` with `decidedByParticipantId` and `decidedVia: <type>`, and
  writes an `audit_logs` row with `actorType: "participant"` and the `participantId`, inside the same processing
  transaction ([05](./phase-05-audit-logging.md)). It is recorded on the approval row and the trigger event too.
  Setting the policy is also an audited decision.

### 8. Escalation

`escalate_to_human` is a model tool (`replay: "unsafe"`, terminal → `waiting` / `answer` when `blocking`). It
takes `question`, `context`, `urgency`, `blocking`, and `timeoutSeconds`.

1. It writes a `help_requests` row, and notifications to recipients from `HelpOps.resolveHelpRecipients`
   (holders of the bot's `helpNotifyTag` who can read the bot, else admins), in one transaction.
2. It writes a `status` row in the channel: "I've asked a person on the team." It never posts the question to
   the channel, because the escalation may be about the channel.
3. `help:answer` (audited) answers the request. The answer is delivered as a `system`-source inbox message,
   "Answer from <name>: …", and wakes the conversation. A non-blocking request lets the turn continue; its
   answer arrives as a queued message.
4. `help:expire` (clock) expires requests past their timeout. The tool's description says what the bot will hear
   if nobody answers.
5. Requests are capped at 5 per conversation (ToolExec's cap), re-checked under the conversation's lock.

### 9. The webhook platform

`type: "webhook"` makes any system a channel.

- **Inbound** is `POST /api/webhooks/webhook/<routingKey>` with `{channel, conversation, messageId, sender:
  {id, name}, text}`, signed by `Hypotenuse-Signature: t=…,v1=hmac(secret, t.body)`, the same scheme as
  [08](./phase-08-durable-agent-loop.md)'s callbacks.
- **Outbound** goes to the installation's `deliveryUrl`, signed the same way, with every surface kind as JSON
  (`status`, `stream` coalesced, `plan`, `message`, `question` with options, `approval` with an
  `approve`/`deny` callback URL), and `Hypotenuse-Delivery` as the idempotency key.
- It is the smallest real adapter, and the conformance suite's reference.

### 10. The fake-platform harness

`backend/__tests__/fakes/base.ts` is the pattern every platform fake follows. A fake is an in-process HTTP
server that:

- implements the slice of the platform's API the adapter uses, validating each request against the platform's
  **published schema** (Slack's OpenAPI spec, Pylon's OpenAPI spec; for Linear, finear itself);
- signs and delivers webhooks exactly as the platform does, including retries with the platform's own retry
  headers;
- records every request, and exposes `/__test/*` control routes to:
  - post a message as a person;
  - press a button;
  - lose a response, answer 429 with the platform's headers, or uninstall the app.

A fake is not a mock of our code. It is the platform's wire protocol, held to the platform's schema. A behavior
a fake cannot show yet is filed against the fake (or finear), and driven through a control route meanwhile.

The **conformance suite** (`__tests__/channels/conformance.ts`) is one set of tests every adapter runs against
its fake:

- loop filtering;
- dedupe of a message carried by two events;
- ordering;
- supersession;
- nothing after a question;
- the 404 on an unknown routing key;
- signature failure;
- uninstall;
- question round trip;
- approval round trip under each `approvalPolicy`.

### 11. The `web` platform: the dashboard chat

[08](./phase-08-durable-agent-loop.md) let a member write to a bot from the dashboard, onto the bot's `api` channel,
and shows them a log. The `web` adapter makes the dashboard a platform, so the person configuring a bot can check
that a prompt edit, a memory, an MCP server, or a skill does what they meant, and see what a teammate on Slack would.

It differs from every other adapter in one way: **its people are Hypotenuse members, not participants.** Who may
talk is project RBAC (`canReadBot`), as for the API channel today, and the sender is the user.

| Contract piece | `web` |
|---|---|
| Installation | none: built in for every bot (`botInstallationId` null) |
| Inbound | `conversation:create` with `channelType: "web"` and `conversation:message`, audited as today; no `webhooks:web`, no `trigger_events` |
| Channel | `type: "web"`, `externalId` = `bot:<botId>:<key>` as `api` channels encode it (channels are unique per project, not per bot); the key is `dashboard` by default, or `scratch-<8 hex>` when created with `fresh: true` — a memory boundary with nothing in it |
| Binding | none: a member's RBAC is the permission, so §5's binding rows do not apply |
| Capabilities | all true: `threads`, `streaming`, `status`, `plan`, `buttons`, `edits` |
| `send` | marks the row `sent` at once: the dashboard reads Postgres, so there is nothing to post |
| Answer as interaction | an option button is a `conversation:message` with the option's label, `source: interaction` |
| Approval | decided in the card through `approval:decide`, under its own gate; the binding's `approvalPolicy` does not apply |
| Callback URL | refused with `channelType: "web"` |

**The live read.** `conversation:live` (`GET /project/:projectId/conversation/:id/live`) answers the newest
unsuperseded `status`, `stream`, and `plan` rows for the conversation, and the page reads it with entries on each
content-free ping. Streamed text therefore lives in a Postgres row (§6's ephemeral `stream` row, coalesced at most
every 250 ms), never on a WebSocket frame. A step's committed `message` row supersedes its `stream` row, so an
interrupted step's partial text disappears when the step is retried. `conversation:view`'s `standing` gains
`canAnswer` and `canDecideApprovals`, so the client never decides whether a button is live.

**The chat view** is a second fold of the same entries, beside today's transcript view, one row per entry kind:

| Entry | Chat item |
|---|---|
| `message` from a person | a bubble with their name |
| `message` from the system (a timeout, a wake, a help answer) | a centred system line |
| terminal call (`reply_and_wait`, `complete`, `fail`) with an ok result | a bot bubble, with the bot's avatar and badge; `complete` and `fail` add an outcome chip |
| `ask_question` with an ok result | a question card; options are buttons while `standing.canAnswer` |
| an approval wait | an approval card, decidable while `standing.canDecideApprovals` |
| any other tool call, model step, context update, thinking | counted into the turn's "worked through N steps" line, which opens the transcript view at that turn (`?seqs=`) |
| a terminal call that errored or was interrupted | counted into the steps line, which then carries the warning glyph |
| compaction | an "earlier messages summarized" divider |

Each bot bubble has collapsed diagnostics: the step's model alias, tokens, duration, and prompt hash.

**Conformance.** The `web` adapter runs the conformance cases that need no wire — ordering, supersession, nothing
after a question, the question and approval round trips — with the dashboard's own reads as the platform.

## Schema sketch

```ts
// backend/schema/bot_installations.ts
bot_installations: id serial pk, projectId, botId, type text,
  externalWorkspaceId text, externalAppId text null, externalBotUserId text null,
  config jsonb, credentials jsonb,             // CryptoOps; never serialized
  credentialVersion int, routingKeyHash text,  // unique
  status text ('pending'|'active'|'error'|'uninstalled'), lastError text null,
  installedByUserId int, createdAt tstz, updatedAt tstz
  unique (botId, type, externalWorkspaceId)

// backend/schema/channels.ts (generalized; type gains 'web', whose rows have no installation)
channels: id serial pk, projectId, type text, botInstallationId int null,
  externalId text, parentExternalId text null,  // e.g. Linear team for a project
  name text, isPrivate bool, isShared bool, archived bool default false,
  createdAt tstz, updatedAt tstz                 // unique (projectId, type, externalId)

// backend/schema/channel_bindings.ts
channel_bindings: id serial pk, projectId, botId, channelId,   // unique (botId, channelId)
  mode text ('mentions'|'all'|'dm'), defaultDelivery text ('steer'|'queue'),
  approvalPolicy text ('dashboard'|'participants'|'listed'), approverExternalIds jsonb,
  allowPromotion bool default false, allowShared bool default false,
  enabled bool, autoBound bool, createdByUserId int null, createdAt tstz, updatedAt tstz

// backend/schema/participants.ts
participants: id serial pk, projectId, type text, externalWorkspaceId text,
  externalUserId text, displayName text, isBot bool,
  firstSeenAt tstz, lastSeenAt tstz              // unique (projectId, type, externalWorkspaceId, externalUserId)

// backend/schema/trigger_events.ts
trigger_events: id serial pk, projectId int null, type text, botInstallationId int null,
  externalEventId text, messageKey text null, receivedAt tstz, payload jsonb,
  status text ('pending'|'processed'|'ignored'|'failed'), outcome text null,
  error text null, processedAt tstz null, checkAfter tstz null
  unique (type, botInstallationId, externalEventId)

// backend/schema/outbox_messages.ts (generalized)
  + botInstallationId int null, priority text, supersedesKey text null

// backend/schema/help_requests.ts
help_requests: id serial pk, projectId, botId, conversationId, entryId,
  question text, context text, urgency text, blocking bool,
  status text ('pending'|'answered'|'expired'|'cancelled'),
  answer text null, answeredByUserId int null, expiresAt tstz, createdAt tstz, answeredAt tstz null

// bots gain: autoBind jsonb ({public: true, private: false, dm: false}), helpNotifyTag text null,
//            participantRateLimit, channelRateLimit
```

## Actions and policy sketch

| Action | Route | RBAC | MCP | Audited |
|---|---|---|---|---|
| `bot-installation:manifest` | `GET /bot/:id/installation/:type/manifest` | `canWriteBot` | yes | yes (mints a routing key) |
| `bot-installation:connect` | `PUT /bot/:id/installation` | `canWriteBot` | yes | yes (credentials in `SENSITIVE_KEYS`) |
| `bot-installation:oauth-start` | `GET /bot/:id/installation/:type/oauth` | `canWriteBot` | **never** (browser hop) | yes |
| `bot-installation:oauth-callback` | `GET /installation/oauth/callback` | state-bound | **never** | yes |
| `bot-installation:test` | `POST /bot-installation/:id/test` | `canWriteBot` | yes | no |
| `bot-installation:disconnect` | `DELETE /bot-installation/:id` | `canWriteBot` | yes | yes |
| `bot-installation:list` / `view` | `GET …` | `canReadBot` | yes | no |
| `channel:list` / `view` | `GET /channels`, `GET /channel/:id` | member | yes | no |
| `channel-binding:create` / `edit` / `delete` | `PUT` / `POST` / `DELETE /channel-binding…` | `canWriteBot` | yes | yes |
| `channel-binding:list` | `GET /bot/:id/channel-bindings` | `canReadBot` | yes | no |
| `participant:list` / `view` | `GET …` | member | yes | no |
| `trigger-event:list` / `view` | `GET …` | admin | yes | no |
| `help:list` / `view` | `GET /help…` | member, filtered by `canReadBot` | yes | no |
| `help:answer` | `POST /help/:id` | `canReadBot` and recipient-eligible | yes | yes |
| `help:cancel` | `DELETE /help/:id` | `canWriteBot` | yes | yes |
| `webhooks:webhook` (and later `webhooks:slack`, …) | `POST /api/webhooks/<type>/:routingKey` | none (signature) | **never** | no (machine ingress, recorded in `trigger_events`) |
| `triggers:process-event` | — (task) | — | no | no |
| `triggers:process-pending` | — (clock, 5 s) | — | no | no |
| `outbox:deliver` / `outbox:deliver-due` | — (task / clock) | — | no | no |
| `help:expire` | — (clock, 1 min) | — | no | no |
| `conversation:create` | unchanged; gains `channelType` (`api` default, `web`) and `fresh` | member + `canReadBot` | yes | yes (as today) |
| `conversation:live` | `GET /project/:projectId/conversation/:id/live` | member + `canReadBot` | yes | no (read) |

`rbac.test.ts` asserts every `webhooks:*` action is never an MCP tool, by prefix. The OAuth hops are named in
`NEVER_MCP_ACTION_NAMES`.

## Frontend and user docs

- **Bot → Channels tab:**
  - installations per platform, with the manifest, a copy button, connection status, and test;
  - bound channels with mode, delivery, approval policy, and promotion;
  - unbound channels that have messaged the bot, with a "bind" action;
  - private-channel binding requires a confirmation that names the audience in so many words ("everyone who
    can read this bot in Hypotenuse will be able to read this channel's conversations and memory").
- **Project → Help inbox,** where `help:answer` is answered.
- **Project → Events:** a `trigger_events` log for admins, with an outcome filter.
- **The conversation page** shows the platform, a link to the thread, session, or issue, and participant names
  on messages, and toggles between the **Chat** and **Transcript** views of any conversation.
- **Chat** (§11): a Chat button on the bot page and each bot's row; `/bots/:botId/chat` opens the newest `web`
  conversation the viewer started with that bot, or a blank composer; `/chat` picks a bot first; a palette command
  "Chat with …"; "New chat in a fresh channel". `/` completes the bot's skills in the composer.
- **User docs:**
  - `frontend/src/content/docs/{channels,connecting-a-platform,escalation,webhook-platform,chat}.md` — `chat.md`
    covers starting a chat, fresh channels and what they do to memory, the status line, and answering and approving
    in place;
  - `rbac.md` gains the binding and approval-policy rules.
- **CLI:** `hypotenuse installation manifest|connect|test|list`, `hypotenuse binding …`,
  `hypotenuse help list|answer`; `conversation create --web [--fresh]`, and `conversation follow` prints the
  `stream` row's text as it grows on a TTY. `conversation:live` has no command of its own.

## Steps

### 1. Schema — `backend/schema/{bot_installations,channel_bindings,participants,trigger_events,help_requests}.ts`, plus migrations widening `channels` and `outbox_messages`

### 2. Registry and contract — `backend/channels/{registry,types,surface}.ts`

### 3. Webhook adapter — `backend/channels/webhook/adapter.ts`

### 4. Ingress — `backend/actions/webhooks/webhooks-webhook.ts`, `backend/ops/IngressOps.ts`

Byte-identical refusal; raw path read.

### 5. Processing — `backend/ops/TriggerEventOps.ts`, `backend/actions/triggers/*.ts`

### 6. Outbox — `backend/ops/OutboxOps.ts`, `backend/ops/LockOps.ts`, `backend/lua/release-lock.lua`

`OutboxOps` gets adapter delivery, supersession, the leases, and the buckets. `LockOps` and the Lua script are
ported from v1.

### 7. Surfaces — `backend/ops/SurfaceOps.ts`

Turns tick events (status, deltas, plan, question, approval) into outbox drafts according to capabilities. Wired
into [08](./phase-08-durable-agent-loop.md)'s stream sink.

### 8. Interactions and escalation — `backend/ops/InteractionOps.ts`, `backend/ops/HelpOps.ts`, `backend/tools/escalate-to-human.ts`, `backend/actions/help/*.ts`

### 9. Rate limits — `backend/lua/participant-bucket.lua`, `backend/ops/ChannelRateOps.ts`

### 10. Harness — `backend/__tests__/fakes/base.ts`, `backend/__tests__/fakes/webhook/server.ts`, `backend/__tests__/channels/conformance.ts`

### 11. The `web` adapter and the chat — `backend/channels/web/adapter.ts`, `backend/actions/conversation/conversation-live.ts`, `frontend/src/components/chat/*`, `frontend/src/pages/bots/ChatPage.tsx`

Built right after the outbox and surfaces, before the webhook harness, so every later step can be tried in the
dashboard.

### 12. Frontend, CLI, docs — as above

## Test plan

- `__tests__/channels/conformance-webhook.test.ts`: the whole conformance suite against the webhook fake.
- `__tests__/channels/ingress.test.ts`:
  - Unknown routing key, bad signature, stale timestamp, and disabled installation all give **byte-identical**
    404 bodies.
  - The answer comes within 200 ms under load.
  - Two events for one message give one inbox row.
- `__tests__/channels/processing.test.ts`: **one test per row** of the table in §5, named by row.
- `__tests__/channels/binding.test.ts`:
  - `autoBind` defaults per channel kind.
  - Private binding needs a person.
  - A shared channel is refused unless allowed.
  - Audit rows for each change.
- `__tests__/channels/outbox.test.ts`:
  - Order under concurrency.
  - Supersession.
  - Nothing after a question.
  - Refuse-at-enqueue.
  - An undeliverable reason.
  - Backoff.
  - A lost response retried with the same delivery id.
- `__tests__/channels/approval-policy.test.ts`: `dashboard`, `participants`, and `listed`, each through a button
  press on the fake. The approval row records the participant.
- `__tests__/channels/escalation.test.ts`:
  - Recipients from `helpNotifyTag`, filtered by `canReadBot`, falling back to admins.
  - An answer resumes the conversation.
  - Expiry.
  - The cap.
- `__tests__/channels/rate-limit.test.ts`: per participant and per channel, with an ephemeral note once.
- `__tests__/security/no-secrets.test.ts` (extended): installation credentials appear nowhere.
- `__tests__/channels/web.test.ts`:
  - `channelType: "web"` creates a `dashboard` channel; `fresh` a new one each time; a `callbackUrl` is refused
    naming the field; an API call without `channelType` is unchanged.
  - A fact learned in a fresh channel is not found from `dashboard`.
  - The scripted model streams slowly: `conversation:live` returns a growing prefix, every frame is content-free,
    and the committed message supersedes the stream row; a dropped stream's partial text is replaced by the retry's.
  - `standing.canAnswer` and `canDecideApprovals`, each true and false.
  - The `web` conformance cases.
- `frontend/src/__tests__/chat.test.ts`: one test per row of §11's chat table.
- `frontend/e2e/chat.spec.ts`: start a chat from the bot page, watch the reply stream in, answer a question by
  button, approve a gated MCP call from its card, open the steps line into the transcript; both themes
  screenshotted.

## Verification

```bash
cd backend && bun test __tests__/channels __tests__/security
bun run --cwd cli hypotenuse installation manifest --bot 1 --type webhook
bun run test:e2e -- chat
```

On staging, a small script acting as the webhook platform holds a conversation with a bot, answers a question
by button, and approves a call in-channel under the `participants` policy.

## Definition of done

- [x] The adapter contract and registry exist, and the webhook adapter passes the conformance suite.
- [x] Installations, channels, bindings, participants, trigger events, and help requests are migrated; every
      timestamp column has a time zone.
- [x] Ingress verifies first, answers within the deadline, dedupes on the message, and refuses byte-identically.
- [x] Processing implements every row of §5, one test each.
- [x] The outbox delivers in order per conversation, with supersession, refuse-at-enqueue, and the
      nothing-after-a-question rule.
- [x] Questions and approvals round-trip through interactions; `approvalPolicy` is enforced.
- [x] Escalation notifies the right people and resumes the conversation.
- [x] Rate limits per participant and channel.
- [x] The fake-platform base and conformance suite are documented for [14](./phase-14-slack.md) through
      [16](./phase-16-pylon.md).
- [x] A member chats with a bot in the dashboard, in its `dashboard` channel or a fresh one: replies stream, the
      status line and plan come from the surface rows, questions and approvals are answered in place, and the chat
      and transcript are two views of one conversation.
- [x] The Channels tab, Help inbox, Events log, Chat, CLI, and docs ship; both themes are checked.

## Open questions

- Whether a participant should be optionally linkable to a Hypotenuse user, to attribute cost and to let a
  linked person's approvals count as theirs under `dashboard` policy. Not needed for authority.
- Whether `autoBind` should default to on for private channels, since inviting the bot is already a deliberate
  platform act. Default off until a team asks otherwise.
- Per-binding model budgets, beyond per-bot budgets: [22](./phase-22-telemetry-and-cost.md).
- Whether a bot's `dashboard` channel is shared by the project's members or one per person. Shared is what a Slack
  channel is, and lets a team build up a test bot's memory together; fresh channels cover a private test. The
  proposal is shared.

## Learnings from the build

### What is built

| Piece | Where |
|---|---|
| `bot_installations`, `channel_bindings`, `participants`, `trigger_events`, `help_requests`; `channels` (installation, parent, private, shared, archived), `outbox_messages` (installation, priority, supersession key), `bots` (`auto_bind`, the two rate limits); conversations unique per `(bot, channel, thread)` (migration `0012`) | `backend/schema/`, `backend/drizzle/0012_*.sql` |
| The contract, the registry, the surface fallbacks, and three adapters: `api` (the signed callback, moved out of `OutboxOps`), `web` (the dashboard), `webhook` | `backend/platforms/{types,registry,surface}.ts`, `backend/platforms/{api,web,webhook}/adapter.ts` |
| Installations: routing keys (hashed), sealed credentials, URLs, manifests | `backend/ops/InstallationOps.ts`, `backend/actions/bot-installation/` |
| Ingress and processing (the rules table, interactions, in-channel approvals audited as a participant) | `backend/ops/{IngressOps,TriggerEventOps}.ts`, `backend/actions/webhooks/`, `backend/actions/triggers/` |
| The interactive surface — status, stream, plan, message, question, approval — and the live read | `backend/ops/SurfaceOps.ts`, wired into `backend/ops/TickOps.ts`; `conversation:live` |
| The outbox: per-conversation delivery in order under a Redis lease, supersession, `Retry-After` | `backend/ops/{OutboxOps,LockOps}.ts`, `backend/lua/release-lock.lua` |
| Channels, participants, bindings; rate limits | `backend/ops/{ChannelOps,ChannelBindingOps,ChannelRateOps}.ts`, `backend/lua/rate-window.lua`, `backend/actions/{channel,channel-binding,participant,trigger-event}/` |
| Escalation | `backend/tools/escalate-to-human.ts`, `backend/ops/HelpOps.ts`, `backend/actions/help/`, the `help-requested` notification template |
| Config | `backend/config/platforms.ts` (`config.platforms`) |
| The fake-platform base, the webhook fake, the conformance suite | `backend/__tests__/fakes/{base,webhook/server}.ts`, `backend/__tests__/channels/conformance.ts` |
| The coverage matrix and its test | [`docs/platform-coverage/webhook.md`](../platform-coverage/webhook.md), `backend/__tests__/docs/coverage.test.ts` |
| CLI 2.8.0 | `cli/src/commands/{installation,channel,help-request,platform-log}.ts`; `conversation create --web [--fresh]`; `conversation follow` streams on a terminal; `bot edit --auto-bind` and the rate limits |
| Dashboard | the Chat (`pages/bots/ChatPage.tsx`, `/chat`, the fold in `components/chat/model.ts`), the conversation page's Chat / Transcript toggle and participant names, the bot's Channels and Listening sections, the Help inbox (`/help`), Events (`/events`); `web` and `webhook` platform chips in `design/states.ts` |
| Proof | `backend/__tests__/channels/{processing,conformance-webhook,ingress,binding,outbox,escalation,rate-limit,web}.test.ts`, `__tests__/security/no-installation-secrets.test.ts`, `__tests__/cli/channel-commands.test.ts`, `frontend/src/__tests__/{chat,channels}.test.ts`, `frontend/e2e/chat.spec.ts`; the `chat`, `bot-channels`, and `help` illustrations |

### Decisions the plan left open, and where the build differs

- **Adapters live in `backend/platforms/`, not `backend/channels/`.** Keryx globs `channels/` recursively and
  instantiates every exported class there as a WebSocket channel. Later platform plans that say `backend/channels/`
  mean `backend/platforms/<type>/`.
- **`bot-installation:manifest` answers `POST`.** It mints the routing key, so it is an audited write, and audited
  writers never answer `GET`. Asking again for a pending installation mints a new key (the old URL becomes the 404);
  an active one must be disconnected first.
- **`bot-installation:test` is audited.** It writes the installation's status, `lastError`, and the bot's platform
  id, which a person reads.
- **The OAuth hops are not built.** No adapter installs by OAuth yet; `bot-installation:oauth-start` and
  `oauth-callback` arrive with the first platform that does, and join `NEVER_MCP_ACTION_NAMES` then.
- **The webhook platform has one shared secret** (`signingSecret`), chosen by the person, signing both directions.
  The bot's own platform id is `botUserId` at connect (default `bot:<slug>`), or whatever the probe's answer names.
- **A platform channel's `externalId` is `<externalWorkspaceId>/<the platform's id>`**, so two workspaces never
  collide within a project. A bot speaks in a channel through *its own* installation in that workspace
  (`SurfaceOps.installationFor`), not the one that first saw the channel.
- **Conversations are unique per `(bot, channel, thread)`**, not `(channel, thread)`: two bots bound to one channel
  each hold their own conversation for a thread.
- **Lifecycle is rule 2, not rule 8.** An uninstall is about the installation; applied after the channel rules it
  would be ignored when sent from an unbound channel. The table in `TriggerEventOps.ts` is the order as built.
- **`autoBind` binds on any message in a public channel**, addressed or not, because inviting the bot is the
  permission; rule 7 then ignores the unaddressed message. Deleting a binding the bot would re-create is pointless:
  disable it instead (the action's description says so).
- **Ingress verifies over the bytes** (`SignatureOps.verifySignatureBytes`), and its refusal is a plain `Response`,
  never a `TypedError`, whose envelope carries a timestamp. A body past `PLATFORM_MAX_BODY_BYTES` is a 413.
- **Outbox rows deliver in `id` order, not `seq` order.** A `stream` row has no entry of its own, and ids are
  monotonic; `seq` stays the citation. `outbox:deliver` takes a `conversationId`; a row that must wait (backed off,
  or claimed by a deliverer that died) stops the walk, so nothing overtakes it.
- **Supersession**: an ephemeral row supersedes the undelivered rows of its key (`status`, `stream`, `plan:<epoch>`);
  a `message` or `question` supersedes every undelivered ephemeral row; an `approval` supersedes nothing. A committed
  step supersedes undelivered `stream` rows.
- **The live read** (`SurfaceOps.liveSurface`): nothing while resting or ended; per kind, the newest unsuperseded row
  newer than the newest `message` / `question` row; a `stream` row only while no entry has been written since it
  began (its `seq` equals the conversation's `lastSeq`). A retried model call writes an empty `stream` row first, so
  a dropped attempt's partial text disappears at once.
- **A `message` row's payload names its `messageKind`** (`reply`, `complete`, `fail`, `error`); `kind` is the
  surface kind. The API channel's callback body keeps `kind: reply` and the rest, as before.
- **The per-installation token bucket is not built.** The webhook platform publishes no rate-limit headers; its
  `Retry-After` is honoured per row. The bucket, with its reserve for `ack` rows, lands with Slack's tiered limits.
- **Rate limits are a fixed one-minute window** per bot and participant, and per bot and channel
  (`rate-window.lua`). The one notice per window is recorded on the event (`noticeOwed`), and only where the platform
  has ephemeral messages — the webhook platform has none, so nothing is sent yet.
- **`escalate_to_human` is a terminal tool with a new transition, `{ to: "working" }`**, for a non-blocking request:
  the turn goes on. A blocking one waits on `answer` (its intent as `questionEntryId`), so any message — the help
  answer, or a person in the channel — ends the wait. `help:cancel` tells the conversation the request was withdrawn
  rather than leave it waiting. The question is never posted to the channel.
- **Who may answer help**: the people it would notify (holders of the bot's `helpNotifyTag`, or admins) and the
  bot's writers, among its readers (`HelpOps.canAnswerHelp`).
- **An in-channel approval can be typed** — `approve 41` / `deny 41` — under a policy other than `dashboard`, for a
  platform without buttons.
- **The plan's `approval-policy.test.ts` is the conformance suite's policy cases**: each policy through a button
  press on the fake, with the approval's participant and the `participant` audit row checked.
- **A bot's slug is now immutable once it has an installation**, as the bots schema promised.
- **The CLI's signing secret is never a flag value** (`--signing-secret-stdin`, `--signing-secret-env`, or a hidden
  prompt), and the help inbox is `hypotenuse help-request …`, keeping `help` meaning help. The CLI's client stopped
  reading a string `error` field on a 2xx answer (a failed probe) as an error envelope.

- **Each assistant step records its model alias** (`content.alias`) beside the model id, for the Chat's
  diagnostics; `conversation:list` gained `channelType` and `mine`, so the Chat finds a member's newest dashboard
  chat on the server.
- **A turn's plan spans a question.** Answering a question resumes the same turn (same epoch), so the plan shown
  while it then waits on an approval still lists the `ask_question` step. That is the turn as it happened.

### Traps found while building

- **Concurrent suites share `hypotenuse_test`.** Two agents running tests at once truncated each other's tables and
  produced unrelated failures. Point one at its own database and Redis index (`DATABASE_URL_TEST`,
  `REDIS_URL_TEST`), or use `bun run workspace:setup` in a worktree.
- **`rows.at(-1)` on an unordered select** read the wrong audit row. Every "newest row" read in a test orders.
- **Playwright needs `PLAYWRIGHT_CHROMIUM_PATH`** in the cloud container (the headless shell under
  `/opt/pw-browsers/`) for the browser suite to find its build.
- **`.gitignore` ignores every `coverage/` directory**, so the coverage matrices live in `docs/platform-coverage/`;
  under `docs/coverage/` they passed locally and were missing in CI.
- **A row's `nextAttemptAt` defaults from Postgres's clock**, so the outbox compares it with `now()` in SQL, never a
  `Date` from the worker: in CI the database's clock ran ahead, a row just written read as not yet due, and the walk
  stopped before it.
- **A fake's request log includes the installation's probe** from `beforeAll`: count `deliveries` (which skip the
  `ping`), not raw requests.
