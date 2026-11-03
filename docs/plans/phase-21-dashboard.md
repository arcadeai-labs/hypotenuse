# Phase 21 — Dashboard

> **Goal:** A project member opens Hypotenuse and sees, at a glance, what every bot they may read is doing right now: which conversations are working, waiting, or hibernating, where, and why. One click opens a live transcript of any conversation — messages, thinking, tool calls, sandbox jobs, approvals — as it happens. They can also browse and correct what a bot remembers, and answer every approval and help request waiting on a person, all in one place.

> **Status: built.** Builds on everything that produces state: the [durable agent loop](./phase-08-durable-agent-loop.md), [memory](./phase-09-memory.md), [shared MCP servers](./phase-10-shared-mcp-servers.md) (approvals), [the channel framework](./phase-13-channel-framework.md) (help requests, channels), and [sandboxes](./phase-17-sandboxes.md). The visual language is [the design system](./phase-03-design-system.md); RBAC is [organizations, users and RBAC](./phase-04-organizations-users-and-rbac.md).

Earlier phases each ship the page for their own objects: a bot's settings, a schedule list, a repository grant. That is enough to configure Hypotenuse, but not enough to *watch* it. A headless agent working in many Slack threads, Linear sessions, and Pylon issues at once is invisible from any single one of them. This phase is the place to see all of it: mission control.

The rule from v1 and ToolExec holds: **Postgres is the source of truth, and WebSocket frames carry no content.** A frame says which read went stale, the client re-reads through the same RBAC-gated HTTP action, and a reconnect re-reads everything.

## Scope

**In:**

- **Project home** (`/p/:projectId`):
  - bots with live counts by conversation state (`working`, `waiting` by kind, `hibernating`) and today's spend;
  - a live feed of conversations that changed state;
  - the "needs a person" inbox (pending approvals, help requests, and sandbox questions the reader can answer).
- **Conversations** (`/p/:projectId/conversations`):
  - a paginated, filterable list (bot, platform, channel, state, waiting kind, participant, date);
  - each row links to the platform (Slack permalink, Linear session URL, Pylon issue link).
- **Live transcript** (`/p/:projectId/conversations/:id`):
  - `conversation_entries` rendered by kind: message, thinking (collapsed), tool call with intent and result, code-mode runs with host calls, memory reads/writes, sandbox jobs (collapsible, with their own events), approvals and their decisions, compaction markers;
  - what was sent to the platform (outbox rows with delivery status);
  - the prompt hash per tick, linking to the rendered prompt;
  - actions: **Stop** (the same cancellation as a platform Stop), **answer** a pending question or approval, **retry** a failed tick.
- **Memory explorer** (`/p/:projectId/memory`):
  - browse by scope (project, channel) and path;
  - hybrid search with the same ranking the bot uses, including the decay factor shown per hit;
  - version history and diff;
  - edit (a new version with a change note), forget (tombstone), promote a channel fact to project scope;
  - provenance links back to the conversation entry that wrote a memory.
- **Inbox** (`/p/:projectId/inbox`): approvals, help requests, and sandbox questions, answerable here. Answers flow back to the conversation and its platform message (the Slack button becomes "Answered by …").
- **Sandboxes** (`/p/:projectId/sandboxes`): jobs and the ledger, live.
- **Bot activity** on the bot page: the conversation list, memory size, and spend for that bot.
- **Live channels:**
  - `project:<id>:conversations` (list stale),
  - `conversation:<id>` (entries, outbox, or state stale),
  - `project:<id>:inbox`,
  - `project:<id>:sandboxes`.

  Each is authorized per subscriber through the read action's RBAC.
- **Gating:** everything a reader sees about a conversation or memory is gated by `canReadBot` on its bot (ToolExec's `accessRead` tags). Lists filter in SQL (`readableBotIds`). Write actions (Stop, answer, edit memory) require `canWriteBot`. The frontend's `can()` is the only place UI gating decides, and unresolved standing never renders as a denial.
- **Keyboard:** the command palette (`cmdk`) jumps to any bot, conversation, or channel.

**Out:**

- A chat client of its own. The chat is the `web` platform of [the channel framework](./phase-13-channel-framework.md#11-the-web-platform-the-dashboard-chat); this phase's views link to it.
- Analytics beyond the counts above. Spend and telemetry are [their own phase](./phase-22-telemetry-and-cost.md).
- Editing a bot's prompts or skills: already on the bot pages.

## What already exists

| Piece | Where | Use |
|---|---|---|
| Content-free channels, reconnect re-reads | [`toolexec: docs/plans/phase-18-dashboard-websockets.md`](https://github.com/arcadeai-labs/toolexec/blob/main/docs/plans/phase-18-dashboard-websockets.md), `channels/projectRun.ts`; v1 `WorkEffects.sessions` → `applyEffects` | Same pattern; frames name the stale read |
| Live socket context, notification bell | [design system](./phase-03-design-system.md) port of `LiveSocketContext`, `NotificationContext` | Reused |
| Transcript rendering | [`toolexec: docs/TRANSCRIPT_UI.md`](https://github.com/arcadeai-labs/toolexec/blob/main/docs/TRANSCRIPT_UI.md), `components/RunTranscript.tsx`; v1's session view | A transcript is a log, not a chat; one row per entry kind |
| Help inbox | ToolExec `HelpInboxPage` | Generalised to approvals + help + sandbox questions |
| Signature surfaces | [`DESIGN.md`](../DESIGN.md) | An agent is always visibly an agent; status uses the shared glyphs |

## What this must not weaken

1. **Frames carry no content.** A frame is `{ stale: "conversation" | "entries" | "outbox" | "inbox", id }`. A subscriber who loses read access mid-stream gets nothing new, because the re-read refuses.
2. **One read path.** The dashboard reads through the same actions as the CLI and MCP (`conversation:view`, `conversation:entries`, `memory:search`, …). There is no dashboard-only query.
3. **Dashboard interventions are the same operations as platform interventions.** Stop here and Stop in Slack are one function. An answer here and an answer by button are one function. Each is audited as the person's decision.
4. **Gating is by bot.** A member without `canReadBot` on a bot cannot learn that its conversations exist. Not from a list count, a channel frame, or a search hit.
5. **Three loading states, disabled never absent** (ToolExec's frontend rules).

## Design

### State badges

A conversation's state is shown with the shared status glyphs ([`DESIGN.md`](../DESIGN.md)):

| State | Glyph | Detail line |
|---|---|---|
| `working` | spinner | "tick N · calling `mcp_exec` (linear/search)" |
| `waiting` · answer | question | "asked in #support 4m ago" |
| `waiting` · approval | shield | "needs approval: `pylon_reply_to_customer`" |
| `waiting` · sandbox | box | "sandbox job 'fix flaky test' · running tests" |
| `waiting` · timer | clock | "wakes 09:00" |
| `hibernating` | moon | "last message 2h ago" |
| `ended` | check / cross | outcome |

### Transcript paging

Entries are paged by `seq`. The view loads the last 200 and pages backwards. Live updates append by re-reading `seq > lastSeen`. A compaction marker shows where the model's context was summarised; the raw entries above it stay readable (they are never deleted).

### Memory explorer and decay

Every search hit shows its raw hybrid score, its decay factor (`exp(-Δt/halfLife)`), and the final score, so a person can see why a stale fact ranked low. Editing writes a new version (`changeNote` required). Forgetting tombstones. Both are audited as the person's decision.

## Schema sketch

No new tables. New indexes as the lists need them:

- `conversations (projectId, state, updatedAt)`
- `conversations (botId, updatedAt)`
- `conversation_entries (conversationId, seq)` (already unique)
- `approvals (projectId, status, createdAt)`
- `help_requests (projectId, status, createdAt)`

## Actions and policy sketch

| Action | Route | RBAC | MCP | Audited |
|---|---|---|---|---|
| `project:overview` | `GET /project/:projectId/overview` | member (filtered by `canReadBot`) | yes | no |
| `conversation:list` | `GET /project/:projectId/conversations` (paginated) | member, filtered | yes | no |
| `conversation:view` | `GET /conversation/:id` | member + `canReadBot` | yes | no |
| `conversation:entries` | `GET /conversation/:id/entries` (paged by seq) | member + `canReadBot` | yes | no |
| `conversation:outbox` | `GET /conversation/:id/outbox` (paginated) | member + `canReadBot` | yes | no |
| `conversation:stop` | `POST /conversation/:id/stop` | member + `canWriteBot` | yes | yes |
| `conversation:retry` | `POST /conversation/:id/retry` | member + `canWriteBot` | yes | yes |
| `inbox:list` | `GET /project/:projectId/inbox` (paginated) | member, filtered | yes | no |
| `approval:decide`, `help:answer`, `sandbox-job:answer` | from their phases | member + `canWriteBot` | yes | yes |
| `memory:*` (browse/search/versions/edit/forget/promote) | from [memory](./phase-09-memory.md) | read: `canReadBot`; write: `canWriteBot` (project scope: admin) | yes | writes |

Channels `project:<id>:conversations`, `conversation:<id>`, `project:<id>:inbox`, and `project:<id>:sandboxes` authorize by calling the corresponding read gate.

## Frontend and user docs

Pages under `frontend/src/pages/`: `ProjectHome`, `conversations/{ConversationsPage,ConversationPage}`, `memory/MemoryExplorer`, `inbox/InboxPage`, `sandbox/SandboxesPage`. Fixtures for every state in `/style-guide`, in both themes. `bun run docs:illustrations` produces light and dark screenshots for `frontend/src/content/docs/dashboard.md` (watching, intervening, correcting memory).

## Steps

### 1. Read actions and channels — `backend/actions/conversation/*.ts`, `backend/actions/inbox/*.ts`, `backend/channels/{projectConversations,conversation,projectInbox,projectSandboxes}.ts`

### 2. Effects — `backend/ops/DashboardEffectsOps.ts`

Every writer of conversations, entries, outbox rows, approvals, help requests, and jobs adds the stale ids to its effects. They are published after commit.

### 3. Pages — `frontend/src/pages/**`

### 4. Docs — `frontend/src/content/docs/dashboard.md`

### 5. Tests — `backend/__tests__/dashboard/*`, `frontend/src/__tests__/*`, `frontend/e2e/dashboard.spec.ts`

## Test plan

- **Gating:** a member without `canReadBot` sees no rows, no counts, no frames, and no search hits for that bot. This is a whole-set assertion over every list and channel.
- **Frames:** each writer publishes the right stale frame after commit and never inside the transaction. Frames contain no text (assert keys).
- **Same operation:** Stop from the dashboard and `agent_session_stopped` from Slack produce identical rows. An approval decided here updates the Slack message.
- **Transcript:** paging across a compaction marker; live append during a running tick (Playwright against the scripted model).
- **Memory explorer:** edit → new version; forget → gone from bot search; promote → visible in project scope.
- **Visual:** light and dark screenshots of each page and state; no raw colors (the token guard tests).

## Verification

```bash
cd backend && bun test __tests__/dashboard
cd frontend && bun run test && bun run test:e2e
cd frontend && bun run docs:illustrations   # then look at both themes
```

## Definition of done

- [x] Project home, conversations, live transcript, memory explorer, inbox, and sandboxes pages exist and update live
- [x] Every read is gated by `canReadBot`, every intervention by the rule its own action applies (see the learnings), and the reads are proven whole-set
- [x] Interventions here are the same operations as on the platforms, and audited
- [x] Both themes are checked; `dashboard.md` ships with illustrations

## Open questions

- **Cross-project home.** Should an organization owner see every project's bots on one page?
- **Retention.** How long are `conversation_entries` kept for ended conversations? Compaction keeps raw entries forever today. A per-project retention setting likely belongs in [scale and conformance](./phase-23-scale-and-conformance.md).

## Learnings from the build

What shipped, where it differs from the plan above, and why.

### What is where

| Piece | Where |
|---|---|
| `project:overview`, its counts, spend, inbox totals, memory sizes, and feed | `backend/actions/project/project-overview.ts`, `backend/ops/DashboardOps.ts` |
| `inbox:list` (one SQL union) and who may answer each kind | `backend/actions/inbox/inbox-list.ts`, `DashboardOps.readInbox` / `canAnswerInbox` |
| `conversation:outbox`, `conversation:retry`, the list's new filters, entries paging back | `backend/actions/conversation/*`, `OutboxOps.serializeOutboxMessage` |
| Platform links | `backend/ops/ConversationLinkOps.ts` |
| The per-bot channel and its frames | `backend/channels/botDashboard.ts`, `backend/ops/DashboardEffectsOps.ts` |
| Indexes | `conversations (projectId, state, updatedAt)`, `conversations (botId, updatedAt)` — migration `0020` |
| Pages | `frontend/src/pages/home/ProjectHomePage.tsx`, `pages/inbox/InboxPage.tsx`, `pages/bots/Conversation{,s}Page.tsx`, `components/bots/ActivitySection.tsx`, `components/dashboard/*` |
| Proof | `backend/__tests__/dashboard/dashboard.test.ts`, `frontend/src/__tests__/dashboard.test.ts`, `frontend/e2e/dashboard.spec.ts` |

### Where it differs from the plan

- **Routes have no `/p/:projectId` prefix.** Every product page reads the active project from the switcher (phase
  03's shell), so Home is `/home` and the inbox `/inbox`, beside the existing `/conversations`, `/memory`, and
  `/sandboxes`. A `/p/:projectId` prefix would have been the only project-scoped route shape in the app.
- **One channel per bot, not four per project.** Keryx authorizes a channel only when a socket subscribes; it has no
  per-frame filter. A `project:<id>:conversations` channel would tell a member *when* an unreadable bot's
  conversations move — exactly what "gating is by bot" forbids, and the plan's own test plan ("no frames for that
  bot") could not pass. So the bot is in the name: `project:<id>:bot:<id>:dashboard`, authorized by `canReadBot`,
  and a page subscribes to one per readable bot (`bot:list` is the list). The four planned channels collapse into one
  frame shape, `{ event: "dashboard", stale }`, with `stale` one of `conversations`, `inbox`, `sandboxes`. The
  existing `project:<id>:conversation:<id>` keeps its `{ event: "conversation" }` frame.
- **Frames come from two choke points, not every writer.** `pingConversation` — already called after commit by
  every writer of a conversation, its entries, its outbox, and every relay — publishes `conversations` and `inbox`
  too, reading the conversation's bot by primary key. Approvals, help requests, and sandbox questions ride along as
  `inbox`, which holds only because every writer that settles one pings its conversation after commit. Three did
  not at first — `approval:decide` (a conversation still waiting on another approval does not wake, so nothing
  else pinged), `approvals:expire`, and `sandbox-job:answer` / the question-expiry sweep — and now do; the tests
  prove the frame for a decision and an answer. `sandboxes` is published by `publishJobStale` at the job's own transitions that ping nothing: claimed by
  dispatch, after `sandbox-job:start`, every `afterRelay` (whether or not a relay ran), a cancel, and a ledger row
  destroyed. The sandboxes page listens to `conversations` as well, since a job's start and end always relay. A
  client debounces a burst (a streaming step pings many times) into one trailing re-read.
- **Stop is `conversation:cancel`, gated by `canReadBot`.** Phase 08 decided anyone who may talk to a bot may stop
  it; the plan's `conversation:stop` would have been a second name for the same function. Retry is the plan's
  `canWriteBot`: it spends a turn on the bot's model, which a reader cannot otherwise make happen without writing a
  message (which a reader may also do — so retry adds no power a reader lacks, but it is a configuration-shaped
  intervention, and the plan asked for it).
- **"Every intervention by `canWriteBot`" is not true, and should not be.** Each answer keeps its own action's rule,
  because the dashboard's answer is that action: approvals `canDecide` (write access or the bot's approver tag),
  help requests `canAnswerHelp` (write access, admin, or the help tag), sandbox questions `canWriteBot`. The inbox
  says per item whether the reader may answer (`canAnswer`), drawn as a chip, never hidden.
- **Retry is a wake, not a replay.** `conversation:retry` refuses anything but `ended` / `failed`, then runs the same
  `wake` a message runs (reason `retry`: epoch + 1, pending inbox rows delivered) and appends a model-visible
  `status_change` telling the bot a person asked it to try again and to read why it failed. Nothing is replayed:
  the failed turn's open intents were settled as interrupted when it failed.
- **Transcript paging is `order=desc` plus `before`.** `conversation:entries` takes `order` and `before` and serves
  up to 200 a page. The page opens on the newest 200, pages back with **Show earlier entries**, and follows live with
  `since` as before.
- **Platform links are built only from platform ids.** Slack: `app.slack.com/client/<team>/<channel>/thread/<channel>-<ts>`
  from the installation's workspace id, refused unless every id looks like Slack's. Linear: the session URL Linear
  sent (else the issue's). Pylon: the issue's link. Each must parse as `https:`. A row's link sits beside the row,
  never inside it — a row is already an anchor.
- **Spend is today's priced cost records, UTC.** Sandbox job cost and budgets belong to
  [telemetry and cost](./phase-22-telemetry-and-cost.md). An unpriced record makes the figure end in `+`: unknown,
  not free.
- **Memory size is channel memory where the bot works.** Memory has no owner bot; a bot's number is the current,
  unforgotten channel documents in the channels it has conversations in. Two bots in one channel count the same
  documents.
- **The prompt hash per tick** was already on the transcript (phase 11's `context_update` rows); nothing new.
- **The landing page stays `/organization/projects`.** Home is a sidebar destination (`g h`), and the inbox `g n`.

### The open questions, decided

- **Cross-project home:** not built. An organization owner switches projects; one page across projects would need a
  second gating pass per project and is left for when someone asks.
- **Retention:** unchanged — raw entries are kept; it belongs to [scale and conformance](./phase-23-scale-and-conformance.md).

### Traps

- **Each spec that scripts a bot owns a scripted model.** The browser suite runs two workers, and the scripted model
  answers in queue order for any conversation: `dashboard.spec.ts` stole `conversations.spec.ts`'s answers until it
  got its own server (`DASHBOARD_MODEL_CONTROL_PORT`).
- **Two backend runs against one test database fail each other.** Running a single suite while `bun run test` runs
  truncates its tables mid-test; the failures look like real ones (an MCP approval, an RBAC setup). Run a lone file
  only when nothing else is.
- **The docs illustrations here were captured without the full capture script.** It seeds a Docker sandbox job, and
  this build had no Docker daemon. `dashboard-home` and `inbox` are rows in the script, so its next full run
  redraws them from its own seed.
