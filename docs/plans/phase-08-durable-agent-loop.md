# Phase 08 — Durable agent loop

> **Goal:** A bot can hold a conversation that survives anything the process does. Every message, model step,
> and tool call is a row in Postgres before and after it happens. A Keryx task called a *tick* reloads the
> conversation from those rows, takes the next step, stores the result, and either schedules the next tick or
> parks the conversation. The first way to talk to a bot is plain HTTP: create a conversation, send it a
> message, and read the reply, or have the reply posted to a signed callback URL.

> **Status: built.** Builds on [model providers and bots](./phase-07-model-providers-and-bots.md)
> (a bot, its model connection, and its prompt text) and [audit logging](./phase-05-audit-logging.md). Memory,
> MCP servers, skills, code mode, and chat platforms plug into the tool registry and the inbox this phase
> defines; they arrive in [09](./phase-09-memory.md) through [16](./phase-16-pylon.md).

This is the phase the rest of Hypotenuse 2.0 stands on. The service will run many bots in many conversations at
once, on however many worker processes Render gives it, and any of them can be killed mid-step by a deploy. A
loop that keeps its state in memory loses work on every deploy, and a loop that replays from the top repeats
side effects: it posts the same Slack reply twice, or files a second Linear issue.

The design takes three ideas and puts them on Keryx's queue:

- **From [pi-durable](https://earendil.com/posts/pi-durable/):** store a tool call's intent *before* running it.
  On recovery, a call with an intent and no result is re-run only if the tool declares itself replay-safe. A
  client's `requestId` makes a retried submission return the original result. A conversation parks on a typed
  wait, not a free-text reason. Compaction is background work placed at a turn boundary.
- **From [botholomew](https://github.com/evantahler/botholomew/blob/main/src/worker/tick.ts):** the tick is a
  short-lived unit that claims work, opens what it needs, and closes everything in `finally`. A turn ends only
  through a *terminal tool*. A model that stops without one is nudged once and then fails, because "an implicit
  tick-end is treated as unfinished work, never silent success". Every interaction is logged as it happens
  ([`src/worker/llm.ts`](https://github.com/evantahler/botholomew/blob/main/src/worker/llm.ts)).
- **From [ToolExec](https://github.com/arcadeai-labs/toolexec/blob/main/docs/plans/phase-31-sleep-and-wake.md):**
  Postgres rows are the orchestration state and every queued job is an accelerant. Delivery after a claim is
  at-most-once. One operation does the waking, so its lock order cannot drift. A clock sweeps up whatever an
  accelerant missed.

## Scope

**In:**

1. `conversations`, `conversation_inbox`, `conversation_entries`, `cost_records`, and the first cut of
   `channels` and `outbox_messages`. `channels` holds only `api` channels here; `outbox_messages` serves only
   the API channel's callback. [13](./phase-13-channel-framework.md) generalizes both.
2. The tick: `agent:tick`, a task-only action on the `agents` queue with `timeout = 0`.
3. The tool registry and the tool contract: `replay`, `terminal`, `parallelSafe`, Zod in and out, and an error
   envelope a model can act on.
4. The built-in tools: the terminal tools `reply_and_wait`, `complete`, `fail`, and `wait_for`, plus
   `search_history` and `ask_question`. In this phase an `ask_question` answer can arrive only through the API.
5. The conversation state machine, with every state × event combination decided.
6. Crash recovery and replay rules; the `agents:reap` and `agents:wake-due` clocks.
7. Steer and queue delivery for messages that arrive mid-turn; cancellation.
8. Background compaction.
9. One `cost_records` row per model step, copied from AI SDK usage.
10. The **API channel:**
    - the actions `conversation:create`, `conversation:message`, `conversation:list`, `conversation:view`,
      `conversation:entries`, and `conversation:cancel`;
    - an optional signed callback URL;
    - the CLI commands and the MCP tools that wrap them.
11. The scripted model server, a test fixture that speaks the providers' real HTTP APIs.
12. A read-only transcript page in the dashboard, and the user doc *Talking to a bot over the API*.

**Out:**

- Memory tools: [09](./phase-09-memory.md).
- MCP servers, the approval gate, and `large_results`: [10](./phase-10-shared-mcp-servers.md).
- Prompt sections, skills, goals, and the generated capabilities section:
  [11](./phase-11-skills-prompts-and-goals.md). This phase assembles the prompt from what
  [07](./phase-07-model-providers-and-bots.md) stores.
- `run_code`: [12](./phase-12-code-mode.md).
- Platforms, `trigger_events`, participants, and `help_requests`: [13](./phase-13-channel-framework.md) through
  [16](./phase-16-pylon.md).
- Sandboxes: [17](./phase-17-sandboxes.md).
- Pricing tokens, and enforcing budgets: [22](./phase-22-telemetry-and-cost.md). This phase records usage and
  any cost the provider reports, and refuses a tick only when a bot's hard budget is already spent.
- Forking a conversation from a point in another one (pi's `channel.fork`). The schema leaves room for it
  (`conversations.forkedFrom*`), and nothing writes those columns yet.

## What already exists

| Thing | Where | Use here |
|---|---|---|
| ToolExec's run ledger, inbox, and wake operation | [`backend/ops/SessionOps.ts`](https://github.com/arcadeai-labs/toolexec/blob/main/backend/ops/SessionOps.ts) (`deliverSessionMessage`), [`schema/agent_run_messages.ts`](https://github.com/arcadeai-labs/toolexec/blob/main/backend/schema/agent_run_messages.ts) | The lock order (bot, then conversation, then inbox), `deliveryKey` dedupe, claim-stamps-`deliveredAt`, and one operation that wakes |
| ToolExec's queue and steer | [`docs/plans/phase-21-queue-and-steer.md`](https://github.com/arcadeai-labs/toolexec/blob/main/docs/plans/phase-21-queue-and-steer.md) | The two delivery modes, and the rule that a steer never replays an in-flight step |
| ToolExec's reaper | [`docs/plans/phase-20-interactive-agent-sessions.md`](https://github.com/arcadeai-labs/toolexec/blob/main/docs/plans/phase-20-interactive-agent-sessions.md) | Separate liveness clocks for the worker (lease) and for activity (stall) |
| botholomew's tick and loop | [`src/worker/tick.ts`](https://github.com/evantahler/botholomew/blob/main/src/worker/tick.ts), [`src/worker/llm.ts`](https://github.com/evantahler/botholomew/blob/main/src/worker/llm.ts), [`src/worker/context.ts`](https://github.com/evantahler/botholomew/blob/main/src/worker/context.ts) | Terminal tools, nudge-once-then-fail, `max_turns`, parallel tool calls in one step. Its weaknesses are the things to avoid: chat resume restored only text, and `fitToContextWindow` dropped messages instead of summarizing |
| v1's activity outbox | [`docs/plans/phase-07-webhook-ingress-and-session-mirror.md`](https://github.com/arcadeai-labs/hypotenuse/blob/v1/docs/plans/phase-07-webhook-ingress-and-session-mirror.md) | Per-conversation order through a Redis lease (Postgres refuses `FOR UPDATE` with `DISTINCT`); separate `*-due` clocks because a Keryx clock re-enqueues itself after every run |
| v1's cost ledger | [`docs/plans/phase-21-cost-attribution.md`](https://github.com/arcadeai-labs/hypotenuse/blob/v1/docs/plans/phase-21-cost-attribution.md) | One row per unit of spend; attribution copied, not joined; ids without foreign keys |
| Keryx tasks | [Tasks guide](https://www.keryxjs.com/guide/tasks) | `enqueue`, `enqueueIn`, `fanOut`, `beforeJob`/`afterJob` hooks. No retry plugin by default, so retry is ours |

## What this must not weaken

1. **Postgres is the source of truth.** A job, a Redis key, or a WebSocket frame can be lost, and the
   conversation's next tick must still happen: `agents:wake-due` finds it from the rows alone.
2. **An effect is recorded before it happens.** No tool with a side effect runs unless its `tool_call_intent`
   entry has committed.
3. **A non-replay-safe tool runs at most once per intent.** After a crash, the model is told the call was
   interrupted. It is never silently re-run.
4. **One tick per conversation at a time.** The lease is the only way a tick may write a conversation's
   entries.
5. **A turn ends only through a terminal tool, a failure, or a cancellation.** It never ends because the model
   went quiet.
6. **The transcript is append-only.** Entries are never edited. Compaction adds a summary entry and never
   deletes the entries it summarizes.
7. **Credentials never reach the model or the transcript.** Tool results pass through the `SENSITIVE_KEYS`
   scrubber before they are stored.

## Design

### 1. The three tables a tick reads

- **`conversations`** holds one row per conversation between a bot and a channel. Its key columns:
  - `state`: `working`, `hibernating`, `waiting`, or `ended`.
  - `waitingOn`: a typed jsonb, set only in `waiting`. It is one of `{kind: "answer", questionEntryId}`,
    `{kind: "approval", approvalIds}`, `{kind: "sandbox", sandboxJobId}`, or `{kind: "timer", at}`.
  - the lease: `leaseOwner` and `leaseExpiresAt`.
  - `epoch`, which counts turns.
  - `wakeRequestedAt`, the durable "a tick is owed" flag.
  - `cancelRequestedAt`.
  - `outcome`: `completed`, `failed`, or `cancelled`.
- **`conversation_inbox`** holds inbound messages that the transcript has not taken in yet:
  - `deliveryKey` is unique per conversation, so a retried submission or webhook collapses to one row.
  - `delivery` is `queue` or `steer`.
  - `deliveredAt` is stamped when a tick claims the row into the transcript.
- **`conversation_entries`** is the transcript, append-only, ordered by `seq`. The entry kinds:

| `kind` | Written when | Hydrates to |
|---|---|---|
| `message` | an inbound message is claimed (`role: user`), or a model step produces text (`role: assistant`) | a `user` or `assistant` model message |
| `thinking` | the model returns reasoning | a reasoning part, when the provider accepts it back |
| `tool_call_intent` | **before** a tool runs. It carries `toolCallId`, `toolName`, `input`, and `replay` | an assistant tool-call part |
| `tool_result` | after a tool returns, fails, or is declared interrupted | a `tool` message |
| `context_update` | the rendered system prompt changes between steps, or the bot edits its own prompt ([11](./phase-11-skills-prompts-and-goals.md)) | nothing; it is for people and for replay |
| `status_change` | the state machine moves (`working → waiting`, a nudge, a cancellation, a failure) | a short `user`-role system note, for the two kinds the model must see (a nudge, an interrupted call) |
| `compaction` | a background compaction finishes. It carries `throughSeq` and the summary | a single `user` message, "Summary of the earlier conversation: …", replacing every entry at or before `throughSeq` |

Every entry also records `epoch`, `stepId`, `promptHash`, `inputTokens`, `outputTokens`, `durationMs`, and, for
messages, `participantRef` (a Hypotenuse `userId` in this phase; a `participants` row id from
[13](./phase-13-channel-framework.md) on).

**Hydration rebuilds the full `ModelMessage[]`, tool calls and results included.** Botholomew's chat resume
rebuilt only message text, and a model that cannot see its own tool results repeats them. The query is: the
latest `compaction` entry, then every entry with `seq > throughSeq`, in order, mapped by the table above.

### 2. The tick contract

`agent:tick` runs with params `{conversationId, wake}`. `wake` is the `wakeRequestedAt` it was enqueued for.
It runs on the `agents` queue, with `timeout = 0` and no web route.

1. **Claim.** One `UPDATE … WHERE id = $1 AND state = 'working' AND (leaseExpiresAt IS NULL OR leaseExpiresAt <
   now()) RETURNING`. It sets `leaseOwner = <worker id>:<job id>`, sets `leaseExpiresAt = now() + LEASE_MS`
   (90 s), and clears `wakeRequestedAt`. If no row comes back, the tick exits: another tick holds the lease,
   or the conversation is not `working`. A duplicate job therefore costs one query.
2. **Recover.** Any `tool_call_intent` without a `tool_result` from an earlier lease is settled by the
   [replay rules](#4-crash-recovery-and-replay).
3. **Deliver the inbox.** Claim the undelivered `conversation_inbox` rows (`FOR UPDATE SKIP LOCKED`, stamp
   `deliveredAt`) and append them as `message` entries, in one transaction.
   - At a turn's start, every pending row is delivered.
   - Between steps of a running turn, only `steer` rows are delivered; `queue` rows wait for the turn to end.
4. **Assemble the prompt.** The bot's system prompt comes from the prompt assembler (a stub reading
   [07](./phase-07-model-providers-and-bots.md)'s fields here; [11](./phase-11-skills-prompts-and-goals.md)'s
   sections later). Its sha256 is the step's `promptHash`; if it differs from the last step's, write a
   `context_update` entry.
5. **One model step.** AI SDK `streamText` with `stopWhen: stepCountIs(1)`, the hydrated messages, the bot's
   tools, and an `AbortSignal` that fires on cancellation or when the lease is about to expire. Text deltas go
   to the conversation's *stream sink*:
   - Here the sink is a content-free WebSocket ping to the transcript page.
   - In [13](./phase-13-channel-framework.md) it becomes the platform's streaming surface.
   - Deltas are an accelerant. The stored `message` entry is the reply.
6. **Persist the step and the intents.** In one transaction:
   - the assistant `message` entry and any `thinking` entry;
   - one `tool_call_intent` per tool call;
   - the step's `cost_records` row;
   - an extended lease.
   
   No tool has run yet.
7. **Run the tools.** Calls whose tools are `parallelSafe` run together under `Promise.all`; the rest run in
   order. Each result, error, or interruption is written as its own `tool_result` entry the moment it settles,
   so a crash in the middle keeps the results that are already in. A gated call (from
   [10](./phase-10-shared-mcp-servers.md)) writes an `approvals` row instead of running.
8. **Decide what comes next.**

| After the step | Then |
|---|---|
| A terminal tool ran (`reply_and_wait`, `complete`, `fail`, `wait_for`, or `ask_question`) | Apply its transition (§3) and release the lease |
| An approval is pending | Move to `waiting` with `{kind: "approval"}`; release |
| Non-terminal tool calls ran and the step budget is not spent | Loop back to step 3 within this tick |
| The model produced only text, no tool call, and this turn has not been nudged | Write a `status_change` nudge ("End your turn with `reply_and_wait`, `complete`, `fail`, or `wait_for`. To send the text above, call `reply_and_wait` with it.") and loop once |
| Only text again after the nudge | Fail the turn: `fail` with "the model stopped without ending its turn", and an error message to the channel |
| The tick has used `MAX_STEPS_PER_TICK` (8) steps or `TICK_BUDGET_MS` (60 s) | Set `wakeRequestedAt = now()`, release the lease, and `enqueue` the next tick after commit. This yields the worker to other tenants' conversations. Nothing about the turn changes |
| The turn has used `bots.maxStepsPerTurn` (default 50) steps | Fail the turn with a message saying how many steps it took |

The lease is extended at every commit. A tool expected to outlast the lease, such as a slow MCP call, extends
it from a timer while it waits, as ToolExec's waiting tools do. A tick that loses its lease (the extension
`UPDATE` matches no row) aborts at once and writes nothing more.

### 3. The state machine, every combination

The states:

- **`working`:** a tick holds the lease, or one is owed (`wakeRequestedAt` is set).
- **`hibernating`:** the normal rest state. The bot has answered and nothing is owed until someone writes.
- **`waiting`:** parked on a typed `waitingOn`.
- **`ended`:** the bot or a person closed the conversation. It records an `outcome`.

| State ↓ / Event → | Inbound message | `reply_and_wait` | `complete` / `fail` | `wait_for(timer)` / `ask_question` / approval pending | `waitingOn` satisfied | Timer due | Cancel | Lease expired |
|---|---|---|---|---|---|---|---|---|
| `working` | inbox row; a `steer` row enters at the next step, a `queue` row at the turn's end | → `hibernating`; reply to outbox. If `queue` rows are pending → stay `working`, new turn | → `ended` (`completed` / `failed`); reply or error to outbox. If inbox rows are pending → stay `working`, new turn, epoch + 1 | → `waiting` with the typed `waitingOn` | not reachable (only `waiting` has a `waitingOn`) | not reachable | abort the step; settle open intents as interrupted; → `ended` (`cancelled`); supersede non-final outbox rows | `agents:reap` → `wakeRequestedAt = now()`; the next tick recovers |
| `hibernating` | → `working`, epoch + 1, wake | not reachable | not reachable | not reachable | not reachable | not reachable | → `ended` (`cancelled`) | not reachable (no lease) |
| `waiting` (answer) | the message **is** the answer: → `working`, `waitingOn` cleared, wake | not reachable | not reachable | not reachable | an `ask_question` answer arrives through an interaction ([13](./phase-13-channel-framework.md)) → `working`, wake | if `ask_question` set a timeout: → `working` with a `tool_result` "no answer within 1h" | → `ended` (`cancelled`) | not reachable |
| `waiting` (approval / sandbox / timer) | inbox row kept; delivered when the wait ends (a `steer` row also, since no turn is running) | not reachable | not reachable | not reachable | → `working`, wake | timer: → `working`. Approval: past `expiresAt` it counts as denied (→ `working`) | → `ended` (`cancelled`); pending approvals → `expired`; a sandbox job is cancelled ([17](./phase-17-sandboxes.md)) | not reachable |
| `ended` | → `working`, epoch + 1, `outcome` cleared, wake. A thread a person returns to is a new turn, unless the platform marks the conversation disengaged ([13](./phase-13-channel-framework.md)) | not reachable | not reachable | not reachable | not reachable | not reachable | no-op | not reachable |

The single **wake operation**, `ConversationOps.wake(tx, conversationId, reason)`, is the only code that moves a
conversation into `working`:

1. It locks the bot row `FOR SHARE`, then the conversation `FOR UPDATE`.
2. It sets `state = 'working'` and `wakeRequestedAt = now()`.
3. It enqueues `agent:tick` in `afterCommit`.

Every caller goes through it: inbound messages, approval decisions, sandbox completions, timers, and answers.

### 4. Crash recovery and replay

Every tool declares `replay: "safe" | "unsafe"`. The default is `unsafe`.

| Found at claim | Rule |
|---|---|
| A step's model call was in flight (no assistant entry for the step) | Re-run the step. A model call is replay-safe; it costs tokens and changes nothing. A cost row was never written for the lost call, and that loss is stated, not estimated |
| `tool_call_intent` with no `tool_result`, tool `replay: "safe"` | Re-run it. Memory reads, `mcp_search`, `mcp_info`, `search_history`, and `read_large_result` are safe |
| `tool_call_intent` with no `tool_result`, tool `replay: "unsafe"` | Write a `tool_result` with `{error: {type: "interrupted", message: "This call may or may not have run before the worker stopped. Check before repeating it.", next_action_hint}}`, and let the model decide (pi's rule) |
| An intent whose `approvals` row is `approved` and not `consumed` | Run it now, and mark the approval `consumed` in the same transaction as the result |
| An intent whose approval is `denied` or `expired` | `tool_result` error "denied by <who>; do not retry this call" |
| Outbox rows for the step | Already committed with the step. Delivery is the outbox's job, deduped by row id (§8) |

**Idempotency keys come from durable ids.** A tool with an external side effect gets
`idempotencyKey = "hyp-" + conversationId + "-" + toolCallId`, and passes it on wherever the target accepts one.
Two examples are an MCP tool argument the server documents, and Linear's client-supplied activity id.

### 5. Tools

A tool is a `ToolDefinition`, defined once in `backend/tools/` and used by the tick, by the MCP tools, and by
tests ([botholomew's `ToolDefinition`](https://github.com/evantahler/botholomew/blob/main/src/tools/tool.ts)).

```ts
interface ToolDefinition<I, O> {
  name: string;               // snake_case, model-facing
  description: string;        // what the model reads; a familiar command prefix where one fits
  inputSchema: z.ZodType<I>;
  outputSchema: z.ZodType<O>;
  replay: "safe" | "unsafe";
  parallelSafe: boolean;
  terminal?: (output: O) => Transition;  // only the terminal tools
  available(ctx: ToolContext): boolean;  // bot config, channel capabilities
  run(input: I, ctx: ToolContext): Promise<O>;
}
```

**Errors come back as data, not as exceptions:**

```
{ is_error: true, error_type, message, next_action_hint }
```

The model is the reader of every error. "A failed wait is not an error" (ToolExec): a timeout returns `timedOut:
true` with a sentence that says what to do next.

The built-in tools:

| Tool | Replay | Terminal | Does |
|---|---|---|---|
| `reply_and_wait` | unsafe | → `hibernating` | Posts `text` (markdown) to the conversation and ends the turn |
| `complete` | unsafe | → `ended` (`completed`) | Posts a final `summary` and closes the conversation |
| `fail` | unsafe | → `ended` (`failed`) | Posts a `reason` the person can act on |
| `wait_for` | safe | → `waiting` (`timer`) | Sleeps until `at` or for `seconds` (≤ 7 days), with an optional note. Longer pauses belong to [schedules](./phase-20-schedules.md) |
| `ask_question` | unsafe | → `waiting` (`answer`) | Posts a question with optional `options[]` and `timeoutSeconds`. The next message or interaction is the answer |
| `search_history` | safe | — | Searches this conversation's earlier entries, including those behind a compaction, and returns `seq` ranges to read with `offset` |

`escalate_to_human` arrives with `help_requests` in [13](./phase-13-channel-framework.md). `sandbox_*` arrive in
[17](./phase-17-sandboxes.md).

### 6. Steer, queue, and cancel

- **Steer** (the default for a message in the conversation's own thread): the message is delivered at the next
  step boundary of the running turn. A model call or tool already running is never interrupted; the model sees
  the message before its next step.
- **Queue** (the default for `conversation:message` with `delivery: "queue"`, and for system events): the message
  waits until the turn ends, then starts the next turn in the same tick.
- **Cancel** (`conversation:cancel`, and later the platforms' stop signals):
  1. It sets `cancelRequestedAt` and calls `wake`, so a waiting conversation is reached too.
  2. The tick checks the flag before each step and each tool and aborts the model stream through the
     `AbortSignal`.
  3. Open intents are settled as interrupted.
  4. The conversation is set to `ended` / `cancelled`.
  5. Non-final outbox rows (status, stream) are `superseded`.

### 7. Background compaction

- Every step records its input tokens. When a conversation's last input-token count passes
  `contextWindow − COMPACT_BACKGROUND_TOKENS` (32 768), the tick enqueues `conversation:compact` after commit.
- That task summarizes, with the bot's `fast` model, the entries from the last compaction up to the most recent
  turn boundary. It writes a `compaction` entry with `throughSeq` and touches no lease. It runs beside the
  conversation, not inside it.
- A tick waits for a compaction (by re-enqueueing itself after 2 s) only if the hydrated prompt would leave
  less than `COMPACT_RESERVE_TOKENS` (16 384) of the window.
- Nothing is deleted. `search_history` still reaches every entry, as pi's design keeps old messages.

### 8. The API channel

The API channel is the first channel and stays a permanent one. A person or program with access to the bot
talks to it over the HTTP actions; Keryx makes the same actions CLI commands and MCP tools.

- `conversation:create` takes `{projectId, botId, text, channelKey?, callbackUrl?, requestId?, title?}`.
  - It upserts the `api` channel `(botId, channelKey ?? "default")`, inserts the conversation and its first
    inbox row, and wakes it.
  - `requestId` is the dedupe key: a retry with the same `requestId` returns the conversation the first call
    created (pi's `submit({requestId})`).
- `conversation:message` takes `{conversationId, text, delivery?, requestId?}`. It inserts an inbox row
  (`deliveryKey = requestId ?? uuid`) and wakes the conversation unless a turn is running.
- `conversation:entries` returns the paginated transcript; `since: seq` lets a poller read only new entries.
- **Callbacks.** When `callbackUrl` is set, every outbound message (`reply_and_wait`, `complete`, `fail`,
  `ask_question`) writes an `outbox_messages` row in the step's transaction.
  - `outbox:deliver` POSTs it after commit, and `outbox:deliver-due` sweeps whatever that missed.
  - The body is `{conversationId, entrySeq, kind, text, options?}`.
  - The headers are `Hypotenuse-Signature: t=<unix>,v1=<hex hmac-sha256(secret, t + "." + body)>` and
    `Hypotenuse-Delivery: <outbox row id>`. The secret is per bot (`bots.apiCallbackSecret`, encrypted with
    `CryptoOps`, shown once).
  - The URL must pass `assertPublicUrl` and goes through the SSRF-safe `postToEndpoint` (ported from
    [v1's `EndpointSafetyOps`](https://github.com/arcadeai-labs/hypotenuse/blob/v1/backend/ops/EndpointSafetyOps.ts)).
  - Retries back off over 24 h. The delivery id lets the receiver drop duplicates.
- **Authority.** Talking to a bot over the API requires `canReadBot`. A platform channel gives anyone in it the
  same power, so the API should not ask for more. Changing the bot requires `canWriteBot`.

### 9. Cost records

Each model step writes one `cost_records` row in the step's transaction. The attribution is copied, not joined:
project, bot, channel, conversation, epoch, step, model connection, provider, and model. The spend is
`inputTokens`, `outputTokens`, `cachedInputTokens`, `reasoningTokens`, and `costUsd` (set only if the provider
reports it; [22](./phase-22-telemetry-and-cost.md) prices the rest). Ids carry no foreign keys, so the ledger
outlives a deleted bot and never takes a key-share lock on a hot row.

### 10. The scripted model server

`backend/__tests__/fixtures/model-server.ts` is an in-process HTTP server that speaks the **Anthropic Messages
API** (`POST /v1/messages`, SSE streaming included) and the **OpenAI-compatible Chat Completions API**
(`POST /v1/chat/completions`). A test's `model_connections` row points the real AI SDK provider
(`@ai-sdk/anthropic`, `@ai-sdk/openai-compatible`) at it.

- It plays a JSON scenario (`fixtures/model-scenarios/*.json`): an ordered list of responses, each text, tool
  calls, or both. Each response may also carry `expect` assertions on the request (the last message's text,
  the tool names offered).
- It records every request, so a test can assert exactly what was hydrated.
- It can hang a response, fail with 429/529/500, or drop the connection mid-stream on demand. That is how
  replay is tested.
- It reports usage in the provider's own fields, so cost rows are tested against what the provider would send.

This is not a mock of our code: the AI SDK's provider code runs unchanged over HTTP, as finear does for Linear.

## Schema sketch

```ts
// backend/schema/conversations.ts
conversations: id serial pk, projectId, botId, channelId,
  externalConversationKey text null,       // unique (channelId, externalConversationKey)
  title text null, state text, waitingOn jsonb null, outcome text null,
  epoch int default 0, wakeRequestedAt tstz null, cancelRequestedAt tstz null,
  leaseOwner text null, leaseExpiresAt tstz null, lastActivityAt tstz,
  stepsThisTurn int default 0, nudgedThisTurn bool default false,
  lastInputTokens int null, requestId text null,  // unique (botId, requestId)
  callbackUrl text null, createdByUserId int null,
  forkedFromConversationId int null, forkedFromSeq int null,
  createdAt tstz, updatedAt tstz

// backend/schema/conversation_inbox.ts
conversation_inbox: id serial pk, conversationId, deliveryKey text,  // unique (conversationId, deliveryKey)
  delivery text ('queue' | 'steer'), source text ('user' | 'participant' | 'system' | 'event'),
  userId int null, participantId int null, text text, attachments jsonb, metadata jsonb,
  deliveredAt tstz null, createdAt tstz

// backend/schema/conversation_entries.ts
conversation_entries: id serial pk, conversationId, seq int,          // unique (conversationId, seq)
  epoch int, stepId text null, kind text, role text null,
  content jsonb,                        // text, tool input/output, summary, …
  toolCallId text null, toolName text null, replay text null,
  promptHash text null, inputTokens int null, outputTokens int null, durationMs int null,
  userId int null, participantId int null, createdAt tstz
  index (conversationId, kind) where kind = 'tool_call_intent'

// backend/schema/channels.ts (first cut; generalized in the channel framework)
channels: id serial pk, projectId, type text ('api'), externalId text,  // unique (projectId, type, externalId)
  botId int null, name text, createdAt tstz, updatedAt tstz

// backend/schema/outbox_messages.ts (first cut)
outbox_messages: id serial pk, projectId, conversationId, seq int, kind text, payload jsonb,
  target jsonb,                         // { type: 'api-callback', url }
  status text ('pending'|'sending'|'sent'|'failed'|'undeliverable'|'superseded'),
  attempts int, nextAttemptAt tstz, externalMessageId text null, error text null,
  createdAt tstz, sentAt tstz null

// backend/schema/cost_records.ts
cost_records: id serial pk, projectId, botId, channelId, conversationId, epoch, stepId,
  modelConnectionId, provider, model, inputTokens, outputTokens, cachedInputTokens,
  reasoningTokens, costUsd numeric null, createdAt tstz
```

Every timestamp column is `timestamp(…, { withTimezone: true })`.

## Actions and policy sketch

| Action | Route | RBAC | MCP | Audited |
|---|---|---|---|---|
| `conversation:create` | `PUT /conversation` | member + `canReadBot` | yes | yes (text recorded as length and sha256) |
| `conversation:message` | `PUT /conversation/:id/message` | member + `canReadBot` | yes | yes (same) |
| `conversation:list` | `GET /conversations` | member; filtered to bots the caller can read | yes | no (read) |
| `conversation:view` | `GET /conversation/:id` | member + `canReadBot` | yes | no |
| `conversation:entries` | `GET /conversation/:id/entries` | member + `canReadBot` | yes | no |
| `conversation:cancel` | `POST /conversation/:id/cancel` | member + `canReadBot` | yes | yes |
| `bot:rotate-callback-secret` | `POST /bot/:id/callback-secret` | member + `canWriteBot` | yes | yes (secret in `SENSITIVE_KEYS`) |
| `agent:tick` | — (task) | — | no | no: the tick is machine work, recorded in `conversation_entries` |
| `conversation:compact` | — (task) | — | no | no |
| `outbox:deliver` | — (task) | — | no | no |
| `outbox:deliver-due` | — (clock, 1 s) | — | no | no |
| `agents:reap` | — (clock, 15 s) | — | no | no |
| `agents:wake-due` | — (clock, 5 s) | — | no | no |

- `agents:reap` finds `working` conversations with an expired lease and sets `wakeRequestedAt`.
- `agents:wake-due` finds:
  - `working` conversations with `wakeRequestedAt` older than 10 s and no live lease;
  - `waiting` conversations whose timer is due;
  - expired approvals and question timeouts.
  
  It wakes each one.
- Both clocks fan out with `api.actions.fanOut` in batches. Neither is ever a `web` route.
- The closed list of unaudited writers ([05](./phase-05-audit-logging.md)) gains the tick, compaction, the
  outbox, and the two clocks, each argued there.

## Frontend and user docs

- **Bot → Conversations:** a paginated list showing state, outcome, last activity, and channel.
- **Conversation page:** the transcript, rendered by entry kind.
  - Tool calls are collapsed, showing their intent and result.
  - An interrupted intent is marked.
  - A compaction is shown as a divider.
  - The page is live through the content-free `project:<id>:conversation:<id>` channel and re-reads entries
    `since` its last `seq`.
  - Cancel is gated by `can()`.
- **User docs:**
  - `frontend/src/content/docs/talking-to-a-bot-over-the-api.md` covers creating a conversation, sending,
    polling, callbacks, and verifying the signature, with a TypeScript snippet.
  - `conversations.md` covers the states and what each means for a person.
- **CLI:** `hypotenuse conversation create|message|list|view|cancel`, and `hypotenuse conversation follow <id>`,
  which tails entries.

## Steps

### 1. Schema — `backend/schema/{conversations,conversation_inbox,conversation_entries,channels,outbox_messages,cost_records}.ts`

### 2. Tool contract and built-in tools — `backend/tools/{types,registry,reply-and-wait,complete,fail,wait-for,ask-question,search-history}.ts`

### 3. Ops — `backend/ops/{ConversationOps,TranscriptOps,TickOps,ReplayOps,CompactionOps,OutboxOps,CostOps}.ts`

- `ConversationOps`: `wake` and the transitions.
- `TranscriptOps`: append entries, hydrate, `serializeEntry`.
- `TickOps`: claim, the step loop, release.
- `ReplayOps`: the rules in §4.
- `CompactionOps`.
- `OutboxOps`: the API-callback target only.
- `CostOps`.

### 4. Model step — `backend/ops/ModelOps.ts`

Builds the AI SDK provider from the bot's `model_connections` row, and wraps `streamText` with the abort signal
and the stream sink.

### 5. Actions — `backend/actions/conversation/*.ts`, `backend/actions/agent/agent-tick.ts`, `backend/actions/agent/agents-{reap,wake-due}.ts`, `backend/actions/outbox/outbox-{deliver,deliver-due}.ts`, `backend/actions/conversation/conversation-compact.ts`

### 6. Queue config — `backend/config/tasks.ts`

Queues `["triggers", "agents", "orchestrator", "outbox", "default"]`. `tasks.test.ts` asserts every queue an
action names is drained.

### 7. Fixture — `backend/__tests__/fixtures/model-server.ts`, `backend/__tests__/fixtures/model-scenarios/*.json`

### 8. Frontend — `frontend/src/pages/bots/ConversationsPage.tsx`, `frontend/src/pages/bots/ConversationPage.tsx`, `frontend/src/components/transcript/*`

### 9. CLI — `cli/src/commands/conversation.ts`

### 10. Docs — `frontend/src/content/docs/{talking-to-a-bot-over-the-api,conversations}.md`, `docs/ARCHITECTURE.md`

## Test plan

- `__tests__/agent/tick.test.ts`:
  - A scripted reply → `reply_and_wait` → `hibernating`, with the exact entry sequence.
  - A tool step then a terminal step inside one tick.
  - The `MAX_STEPS_PER_TICK` yield re-enqueues the tick and leaves the turn unchanged.
  - `maxStepsPerTurn` fails the turn.
- `__tests__/agent/nudge.test.ts`: text with no tool → one nudge → success. Text twice → `failed` with the
  stated reason.
- `__tests__/agent/state-machine.test.ts`: **one test per non-"not reachable" cell** of the table in §3, named
  by the cell.
- `__tests__/agent/replay.test.ts`:
  - The model server drops mid-stream → the step re-runs, and there is one assistant entry.
  - The worker is killed (lease forced to expire) between an intent and its result:
    - a safe tool re-runs;
    - an unsafe tool yields the interrupted error;
    - the model's next request contains it.
- `__tests__/agent/lease.test.ts`:
  - Two ticks enqueued for one conversation → one claims and the other exits.
  - A tick whose lease was stolen writes nothing more.
- `__tests__/agent/steer-queue.test.ts`: a steer delivered between steps; a queue delivered after the turn; a
  message to a `waiting(answer)` conversation is the answer.
- `__tests__/agent/cancel.test.ts`: cancel mid-step aborts the model request (the server sees the disconnect);
  cancel while waiting.
- `__tests__/agent/compaction.test.ts`: the threshold triggers a compaction. Hydration then sends the summary
  plus the tail. `search_history` finds a compacted message.
- `__tests__/actions/conversation.test.ts`:
  - CRUD, pagination, `requestId` dedupe, RBAC (Bowser refused; a reader without the bot's read tag refused).
  - Byte-identical refusals.
- `__tests__/outbox/api-callback.test.ts`:
  - A receiving server verifies the signature.
  - A lost response leads to a retry with the same delivery id.
  - A private address is refused by `assertPublicUrl`.
- `__tests__/agent/cost.test.ts`: one row per step, with usage exactly as the model server reported it.
- `__tests__/agent/clocks.test.ts`: `agents:reap` and `agents:wake-due`, with time moved by writing columns.

## Verification

```bash
cd backend && bun test __tests__/agent __tests__/actions/conversation.test.ts __tests__/outbox
bun run --cwd cli hypotenuse conversation create --bot 1 --text "hello" --follow
```

Against staging with a real Anthropic key, a conversation created through the CLI answers. Killing the worker
mid-turn (a Render restart) does not lose the turn.

## Definition of done

- [x] The six tables are migrated; every timestamp column has a time zone.
- [x] `agent:tick` implements the contract in §2, including the yield and nudge-once-then-fail.
- [x] Every reachable cell of the state table has its own test.
- [x] Replay rules hold under a forced crash between intent and result, for both safe and unsafe tools.
- [x] Steer, queue, and cancel work as specified.
- [x] Background compaction writes summaries and never deletes entries.
- [x] One `cost_records` row per model step.
- [x] The API channel's six actions, callback signing, CLI commands, and MCP tools work, and the docs ship.
- [x] The scripted model server covers the Anthropic and OpenAI-compatible APIs and is used by every agent
      test.
- [x] The transcript page is live and checked in light and dark.
- [x] `docs/ARCHITECTURE.md` describes the tick as built.

## Open questions

- Whether `MAX_STEPS_PER_TICK` should depend on queue depth, yielding sooner when many tenants wait. Measure in
  [23](./phase-23-scale-and-conformance.md) before tuning.
- Whether reasoning content from one provider should be replayed when a bot's model changes mid-conversation.
  The proposal: drop `thinking` entries from hydration whenever the provider differs.
- Whether a `requestId` dedupe window should expire. The proposal: never; the unique index is cheap.

## Learnings from the build

### What is built

| Piece | Where |
|---|---|
| `conversations`, `conversation_inbox`, `conversation_entries`, `channels`, `outbox_messages`, `cost_records`; `bots.max_steps_per_turn` and `bots.api_callback_secret` (migration `0006`) | `backend/schema/`, `backend/drizzle/0006_*.sql` |
| The tool contract, the registry, and the six built-in tools | `backend/tools/` |
| The wake operation, inbound messages, cancel, and the state table | `backend/ops/ConversationOps.ts` |
| The tick: claim, recover, deliver, step, persist, run, decide, yield | `backend/ops/TickOps.ts` |
| Append, hydrate, serialize | `backend/ops/TranscriptOps.ts` |
| The prompt assembler, compaction, the outbox and callback signing, cost rows, the two clocks | `backend/ops/{PromptOps,CompactionOps,OutboxOps,CostOps,AgentClockOps}.ts`, `backend/config/agents.ts` |
| Actions | `backend/actions/{conversation,agent,outbox}/`, `backend/actions/bot/bot-rotate-callback-secret.ts` |
| The live transcript channel | `backend/channels/projectConversation.ts` |
| The scripted model server, streaming, with scenarios | `backend/__tests__/fixtures/model-server.ts`, `fixtures/model-scenarios/` |
| CLI | `cli/src/commands/conversation.ts`, `bot callback-secret`; 2.2.0 |
| Dashboard: Conversations (project and per bot), the live transcript page, Budget's steps per turn, the Callback secret card | `frontend/src/pages/bots/{ConversationsPage,ConversationPage}.tsx`, `frontend/src/components/transcript/`, `components/bots/{BudgetSection,CallbackSecretSection}.tsx` |
| The browser suite's scripted model, as a process with a control port | `backend/__tests__/fixtures/model-server-process.ts`, spawned by `frontend/scripts/e2e-backend.ts` and the illustration script |
| User docs and illustrations | `frontend/src/content/docs/{conversations,talking-to-a-bot-over-the-api}.md`; `bots.md` and `cli.md` updated; the `conversations`, `conversation`, and `bot` illustrations |
| Proof | `backend/__tests__/agent/*.test.ts` (tick, nudge, state machine, replay, lease, steer and queue, cancel, compaction, cost, clocks, the OpenAI-compatible API, MCP), `__tests__/actions/conversation.test.ts`, `__tests__/outbox/api-callback.test.ts`, `__tests__/channels/project-conversation.test.ts`, `__tests__/cli/conversation-commands.test.ts`, `frontend/e2e/conversations.spec.ts`, `frontend/src/__tests__/transcript.test.ts` |

### Decisions the plan left open

- **Routes live under the project**, like every other action: `PUT /project/:projectId/bot/:botId/conversation`,
  `PUT /project/:projectId/conversation/:id/message`, `GET /project/:projectId/conversations`, and so on, so
  `ProjectMemberMiddleware` scopes them. The plan's `PUT /conversation` would have needed a second tenancy path.
- **Queues stay as the earlier phases set them**: `ingress`, `outbox`, `agents`, `orchestrator`, `default`. Ticks and
  compaction run on `agents`, delivery on `outbox`, the clocks on `orchestrator`.
- **The wake is told its prior state by the row**: a new conversation is inserted `hibernating` at epoch 0 and woken
  like any other (its `status_change` reads `from: "new"`). From `hibernating` or `ended` a wake starts a turn (epoch
  + 1, counters reset, outcome cleared); from `waiting` it resumes the same turn. `turnBoundary` records that the next
  step must deliver every pending inbox row, which is how a resumed wait delivers what it kept.
- **Every model step writes its assistant `message` entry**, even with empty text: it is the step's record (prompt
  hash, tokens, duration, model). The transcript page and CLI print nothing for an empty one.
- **Tools are offered to `streamText` without `execute`**, so the SDK stops at the model's calls and the tick records
  every intent before it runs anything. `maxRetries: 0`: the tick retries 408, 409, 429, 5xx, and a stream cut short
  (`AGENT_MODEL_ATTEMPTS`, default 3) and fails the turn on anything else, saying why. A host the SSRF guard refuses
  is never retried.
- **A terminal tool's effect is its transaction.** The result, the transition, and the outbound outbox row commit
  together, so an open terminal intent means nothing was posted. They still declare `replay: "unsafe"`, as the plan
  says; recovery reports them interrupted and the model decides.
- **One terminal call per step.** It runs after the step's other calls — in recovery too, which re-runs a step's
  open safe calls with the terminal one last, so a recovered `wait_for` never parks with a call still open. A second
  terminal call in the same step gets a `not_run` error result, so every intent still has a result and hydration
  stays well formed.
- **A tool result is matched to its intent by `(stepId, toolCallId)`**, not the call id alone, since a provider may
  reuse ids across steps.
- **`ask_question` writes its result at once** (`asked: true`) and parks on `{kind: "answer", questionEntryId,
  timeoutAt}`; the answer is the next message. A timeout cannot be a late `tool_result` (it would follow a user
  message, which providers refuse), so `agents:wake-due` delivers a `system` inbox row saying nobody answered. A
  question asked while a message is already pending is answered at once, in the same tick.
- **The step limits.** `bots.max_steps_per_turn` (default 50) is editable on `bot:edit`. `maxStepsPerTick` (8) and
  `tickBudgetMs` (60 s) are deployment settings in `config/agents.ts`, with the lease (90 s), the heartbeat (1 s), and
  the compaction thresholds.
- **The heartbeat** re-reads the lease and the cancel flag every `heartbeatMs` while a model call or tool runs, and
  extends the lease every third of it. Losing the lease or seeing a cancel aborts the tick's `AbortSignal`, which aborts
  the model's HTTP request (the provider sees the disconnect) and any tool that listens.
- **Cancel** ends a conversation in the request unless a tick holds a live lease; then it sets
  `cancelRequestedAt`, wakes, and the holder finalizes. Pending inbox rows are kept: the next message is a new turn.
- **The context window is one setting** (`AGENT_CONTEXT_WINDOW_TOKENS`, 200,000) until aliases carry their model's
  window. Compaction cuts just before the newest person's message, never splitting a call from its result, and
  summarizes nothing when the cut would hold no message — it then forgets the size that asked, so a waiting tick goes
  on. A queued or running compaction is a Redis key (`hyp:compaction:<id>`, ten-minute expiry).
- **Titles are never derived from the text**: the audit row keeps only the text's length and sha256, and a title
  taken from the first line would have put the words in its `after` snapshot. A conversation has a title only when the
  caller gives one.
- **The callback secret** is per bot, sealed with `CryptoOps`, and returned once by `bot:rotate-callback-secret`
  (`callbackSecret` joined `SENSITIVE_KEYS`). It is the receiver's verification key, so returning it once is the
  design, not an exception to rule 6. A conversation cannot take a `callbackUrl` until its bot has one; the URL must
  pass the SSRF guard at creation, and delivery goes through `guardedFetch`, so a host refused later is
  `undeliverable`. A 2xx is `sent`; 408, 429, 5xx, a timeout, or a lost response is retried with back-off for
  `OUTBOX_RETRY_WINDOW_MS` (a day); any other 4xx gives up.
- **The budget is enforced against reported cost.** A tick whose bot's `cost_records` this month (UTC) sum to its
  `monthlyBudgetUsd` fails the turn before stepping. Only the Vercel AI Gateway reports a cost, so for other providers
  the budget counts nothing yet; pricing is later work.
- **Reasoning from another provider is dropped** in hydration (the open question's proposal): a `thinking` entry
  carries its provider and is replayed only to the same one.
- **`requestId` dedupe never expires** (the open question's proposal). A repeated `conversation:create` still
  writes an audit row and may enqueue an idle tick; both are harmless.
- **Talking to a bot is `canReadBot`**, and so is cancelling: anyone who may talk to it may stop it.

### The state table in tests

`state-machine.test.ts` has one test per reachable cell, named `<state> × <event>`. The `waiting (approval / sandbox
/ timer)` row is proven there with the timer; its approval cells (decided, expired, an inbound message kept, cancel)
are proven in `__tests__/mcp/approval.test.ts`, which [phase 10](./phase-10-shared-mcp-servers.md) added. The sandbox
cells, and the `waiting (answer) × waitingOn satisfied` cell (an answer through a platform interaction), wait for
their phases.

### The frontend

- **Routes:** `/conversations` (the project's, with state filter chips), `/bots/:botId/conversations` (one bot's, with
  a composer that starts one), and `/conversations/:conversationId`. The Conversations destination in the sidebar,
  `g c`, and its palette command are live.
- **The list is flat and paginated by the server**, newest activity first, not grouped by state as `DESIGN.md`'s
  list views describe: grouping does not combine with server-side paging. Filter chips stand in until it does.
- **The transcript draws the bot's words from its terminal calls**: `reply_and_wait`, `complete`, `fail`, and
  `ask_question` (a question is a card with its options) read as the bot speaking when their result is ok; with an
  error or an interruption they stay a tool row. Other assistant text is shown as "not posted". Tool calls are
  collapsed `<details>` rows joining intent and result; an interrupted call carries the stale glyph and a sentence.
  A compaction is a dashed divider; state changes are small system lines. An untitled conversation is named by its
  first message's first line on its page and "Conversation #id" in lists.
- **Live:** `useConversation` subscribes to `project:<id>:conversation:<id>` and re-reads entries `since` the newest
  seq it holds, on every frame and on reconnect, never two reads at once.
- **The browser suite runs one real queue worker** (`TASK_PROCESSORS=1`, `TASK_TIMEOUT=100` in `e2e/env.ts`), so a
  tick is a real `agent:tick` job; its model is `model-server-process.ts`, driven over a control port
  (`MODEL_SERVER_CONTROL_PORT`). The conversations spec runs serially, since the scripted queue is shared.
- **The illustration script seeds five conversations** by title (completed, waiting on an answer, waiting on a
  timer, failed, cancelled), pointing the Anthropic connection at the scripted model only while seeding; it needs the
  dev backend started with `NETWORK_ALLOW_PRIVATE_HOSTS=true`.

### The CLI

Rule 13 decisions:

| Routed action | Command |
|---|---|
| `conversation:create` | `conversation create --bot <id\|slug> --text <text\|->` with `--channel`, `--callback-url`, `--request-id`, `--title`, `--follow` |
| `conversation:message` | `conversation message <id> --text <text\|->` with `--queue`, `--request-id`, `--follow` |
| `conversation:list` / `view` / `cancel` | `conversation list` (`--bot`, `--state`, paging) / `view <id>` / `cancel <id>` |
| `conversation:entries` | `conversation follow <id>` (`--since`, `--interval`), and `--follow` on create and message |
| `bot:rotate-callback-secret` | `bot callback-secret <bot>`; refuses to replace an existing secret without `--yes`, prints only the secret on stdout |

- Following polls `entries` with `since` and stops once a page is short and the conversation is not `working`; it
  exits 1 when the conversation ended `failed`.
- The bot's words are the inputs of its terminal calls, so `reply_and_wait`, `complete`, `fail`, and `ask_question`
  are printed as its messages; other calls are one dim line each.

### Traps found while building

- **A stream cut mid-body is an `APICallError` with status 200** ("Failed to process successful response"). A
  retry rule keyed on 5xx alone treated it as permanent; a 2xx with a broken body is now retryable.
- **`streamText` prints every error by default**, even ones the caller handles from the stream; the tick passes
  `onError: () => {}` and reads the `error` part itself.
- **A test that captures `config.*` at module load captures nothing**: config is filled in by `api.start()`. Suites
  snapshot it in `beforeAll` and restore it after each test.
- **Ticks a test enqueued outlive it in Redis**: the harness takes a tick for a named conversation off the queue
  (`startTick(id)`), and suites clear the loop's queues after each test.
- **Keryx sends its own presence frames** (`join`, `leave`) on every channel; a test that asserts every frame is
  content-free must skip those.
- **Bun prints the scripted drop**: `model-server.ts` cuts a stream by erroring its body, which Bun reports on the
  console. It is the honest way to cut the connection; a clean close of a short stream would prove nothing.
- **Design outcomes differ from the server's by one word.** `design/states.ts` names `complete`; the server says
  `completed`. The dashboard and CLI translate that one. `cancelled` joined the design table with the faded `stale`
  glyph: a person's decision to stop a bot is not an error, so it spends no error colour.

- **A tick that throws something unexpected** gives its lease back and owes a tick, then rethrows into Resque's
  failed queue; `agents:wake-due` retries it ten seconds later. A bug that throws every time loops at that pace, loudly
  in the logs, without failing the conversation — a person sees it stuck `working` and can cancel it.

### Not verified here

- No real provider answered a conversation: every agent test runs the real `@ai-sdk/anthropic` and
  `@ai-sdk/openai-compatible` providers against the scripted server. Staging with a real key, and a Render restart
  mid-turn, are the plan's verification and have not been run.
- The gateway's reported cost (`providerMetadata.gateway.cost`) is read but not exercised: the scripted server does
  not speak the gateway's language-model API.
