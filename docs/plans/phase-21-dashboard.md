# Phase 21 — Dashboard

> **Goal:** A project member opens Hypotenuse and sees, at a glance, what every bot they may read is doing right now: which conversations are working, waiting, or hibernating, where, and why. One click opens a live transcript of any conversation — messages, thinking, tool calls, sandbox jobs, approvals — as it happens. They can also browse and correct what a bot remembers, and answer every approval and help request waiting on a person, all in one place.

> **Status: planned, not built.** Builds on everything that produces state: the [durable agent loop](./phase-08-durable-agent-loop.md), [memory](./phase-09-memory.md), [shared MCP servers](./phase-10-shared-mcp-servers.md) (approvals), [the channel framework](./phase-13-channel-framework.md) (help requests, channels), and [sandboxes](./phase-17-sandboxes.md). The visual language is [the design system](./phase-03-design-system.md); RBAC is [organizations, users and RBAC](./phase-04-organizations-users-and-rbac.md).

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

- A chat client. The dashboard watches and intervenes; people talk to bots on their platforms (and through the API channel). There is no compose box beyond answering a pending question.
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

- [ ] Project home, conversations, live transcript, memory explorer, inbox, and sandboxes pages exist and update live
- [ ] Every read is gated by `canReadBot`, every intervention by `canWriteBot`, and both are proven whole-set
- [ ] Interventions here are the same operations as on the platforms, and audited
- [ ] Both themes are checked; `dashboard.md` ships with illustrations

## Open questions

- **Cross-project home.** Should an organization owner see every project's bots on one page?
- **Retention.** How long are `conversation_entries` kept for ended conversations? Compaction keeps raw entries forever today. A per-project retention setting likely belongs in [scale and conformance](./phase-23-scale-and-conformance.md).

## Learnings from the build

Not built yet.
