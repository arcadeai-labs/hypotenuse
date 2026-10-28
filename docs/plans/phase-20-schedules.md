# Phase 20 — Schedules

> **Goal:** A bot can act without being asked. It posts a Monday summary of open Linear issues in a project's channel, checks every morning whether any Pylon customer has waited more than a day, and reviews its own goals at the end of each week. An admin attaches a cron schedule to a bot and a channel or conversation. At each time slot, the bot wakes exactly once with the schedule's instruction and its goals in context, and decides whether there is anything worth saying.

> **Status: planned, not built.** Builds on the [durable agent loop](./phase-08-durable-agent-loop.md) (wake, ticks), [skills, prompts and goals](./phase-11-skills-prompts-and-goals.md) (goals as rows), and [the channel framework](./phase-13-channel-framework.md) (channels, the outbox).

Every conversation so far starts with a person. Goals ([skills, prompts and goals](./phase-11-skills-prompts-and-goals.md)) give a bot something to want, and a schedule gives it a time to act on them.

Botholomew evaluated natural-language schedules by asking a fast model "is this due?" on every tick. That is flexible, but it costs a model call per schedule per tick, which does not scale to a multi-tenant service with thousands of bots. Here **cron decides when**, and an optional **guard** decides *whether*: a short question to the bot's `fast` model at the slot, such as "only if there are new P0 issues". The guard runs once per slot, not once per tick.

## Scope

**In:**

- **`schedules`:** bot, target (a `channel`, which starts a new conversation each slot, or a `conversation`, which continues one), cron expression with an IANA time zone, instruction text, optional guard, enabled flag, and `nextRunAt`. Admin CRUD with a paginated `list`.
- **`schedules:due`:** a task-only clock every 30 s. It claims schedules with `nextRunAt <= now()` using `FOR UPDATE SKIP LOCKED`, inserts one **schedule run** per `(scheduleId, slot)` under a unique index (idempotent per slot), advances `nextRunAt`, and enqueues the wake after commit.
- **Wake:** an inbox row with `source: "schedule"` and `deliveryKey = schedule:<id>:<slotIso>`, carrying the instruction and the bot's active goals. On a `channel` target, this creates a new conversation whose external id is a synthetic `schedule:<id>:<slot>`; the first outbound message becomes the platform thread (Slack: a new top-level message whose `ts` becomes the thread; Linear: see Open questions; Pylon: not supported as a channel target).
- **Guard:** if set, the `fast` model answers `{ act: boolean, reason }` from the instruction, the guard text, and cheap context (the channel's memory summary and the goal list). `act: false` ends the run as `skipped` with the reason, and nothing is posted.
- **Missed slots:** after downtime, run only the **latest** missed slot (`catchUp: "latest"`, the default) or none (`catchUp: "none"`). Never a burst.
- **The `quiet` contract:** a scheduled tick may end with the terminal tool `complete({ silent: true })` when there is nothing worth saying. That is a legitimate outcome, recorded, with nothing posted.
- **Goal review:** a built-in schedule kind, `goal-review`. It wakes the bot with its goals and recent conversations, so the bot can update goal status (through [skills, prompts and goals](./phase-11-skills-prompts-and-goals.md)' tools) and optionally post a summary.
- **Bot tools:** `schedule_list`. Also `schedule_propose`, which creates a **disabled** schedule an admin enables. A bot never arms its own schedule.
- RBAC, audit, CLI, UI, user docs.

**Out:**

- Event-triggered automations ("when a Pylon issue is tagged X") beyond what channel ingress already does. Platform triggers are the event path.
- Natural-language frequencies evaluated by a model (botholomew's approach).
- Sub-minute schedules. The minimum interval is 5 minutes per schedule.

## What already exists

| Piece | Where | Use |
|---|---|---|
| Idempotent cron scheduling | [`toolexec: docs/plans/phase-09-cron-runs.md`](https://github.com/arcadeai-labs/toolexec/blob/main/docs/plans/phase-09-cron-runs.md), `actions/run/runs-schedule.ts` | Unique per slot; claim with `SKIP LOCKED`; advance `nextRunAt` in the same transaction |
| Schedules with a fast-model due check, tasks chained by `blocked_by` | botholomew `src/worker/schedules.ts` | The guard idea, run once per slot instead |
| Keryx clocks | Keryx `task.frequency` | A clock re-enqueues itself, so `schedules:due` is its own action, never reused as a per-item task |

## What this must not weaken

1. **One slot, one run.** A unique `(scheduleId, slot)` makes overlapping clock ticks, retries, and multiple workers safe.
2. **A schedule never re-engages what a person disengaged.** A `conversation` target that a person stopped, or a channel binding that was removed, skips with that reason.
3. **Cost is bounded.** A guard is one `fast` call per slot. A skipped slot posts nothing. Budgets from [telemetry and cost](./phase-22-telemetry-and-cost.md) apply to scheduled ticks like any other.
4. **Clocks never get a `web` route.**
5. **A bot cannot schedule itself into a loop.** Bots only propose schedules, disabled, for a person to enable.

## Design

### Slot computation

`ScheduleOps.nextSlot(cron, tz, after)` uses a cron parser (`croner`, pinned) in the schedule's time zone. DST gaps skip a slot, and overlaps run once. `nextRunAt` is stored in UTC (`timestamptz`). Tests move time by writing `nextRunAt`, never by waiting.

### Run lifecycle

`schedule_runs` lifecycle:

| Status | Meaning |
|---|---|
| `pending` | Inserted by `schedules:due` |
| `guarding` | Guard set, being evaluated |
| `skipped` (reason) | Guard said no, or the target is disengaged |
| `woken` | Inbox row written. Linked to the conversation and the tick that answered |
| `silent` | The bot completed with nothing to say |
| `posted` | The bot posted |
| `failed` | Something went wrong |

### Targets per platform

| Target | Slack | Linear | Pylon |
|---|---|---|---|
| `channel` | New top-level message; its thread is the conversation | Comment on a pinned issue, or a project update (see Open questions) | Not supported (no channel-level surface) |
| `conversation` | Reply in that thread | Activity on that session, only if the session is not terminal (finear refuses activity on a terminal session) | Internal note on that issue |
| `none` (internal) | Memory and goals only; nothing posted | same | same |

## Schema sketch

```ts
schedules: { id serial, projectId, botId, kind: instruction|goal-review, targetType: channel|conversation|none,
  channelId?, conversationId?, cron text, timeZone text, instruction text, guard text?,
  catchUp: latest|none, enabled boolean, proposedByBot boolean, nextRunAt timestamptz, lastRunAt?,
  createdByUserId?, createdAt, updatedAt }
schedule_runs: { id serial, scheduleId, slot timestamptz, status, reason text?, conversationId?, costUsd numeric?,
  createdAt, finishedAt? }  // unique (scheduleId, slot)
```

## Actions and policy sketch

| Action | Route | RBAC | MCP | Audited |
|---|---|---|---|---|
| `schedule:create` | `PUT /bot/:botId/schedule` | admin, or member + `canWriteBot` | yes | yes |
| `schedule:edit` | `POST /schedule/:id` | same | yes | yes |
| `schedule:delete` | `DELETE /schedule/:id` | same | yes | yes |
| `schedule:list` | `GET /bot/:botId/schedules` (paginated) | member + `canReadBot` | yes | no |
| `schedule:view` | `GET /schedule/:id` | member + `canReadBot` | yes | no |
| `schedule:runs` | `GET /schedule/:id/runs` (paginated) | member + `canReadBot` | yes | no |
| `schedule:run-now` | `POST /schedule/:id/run` | member + `canWriteBot` | yes | yes |
| `schedules:due` | task-only clock | — | never | no (clock) |

Bot tools `schedule_list` and `schedule_propose` insert `enabled: false, proposedByBot: true`. Proposal is not audited; the person's enable is.

## Frontend and user docs

- **Bot page → Schedules:** list, editor (cron with a human-readable preview and the next five slots in the viewer's zone), guard field, and run history with skip reasons. Proposed schedules show a badge and an "Enable" button.
- `frontend/src/content/docs/schedules.md`: cron syntax, time zones, guards, what "silent" means, goal review.

## Steps

### 1. Schema — `backend/schema/{schedules,schedule_runs}.ts`

### 2. Ops — `backend/ops/ScheduleOps.ts`

`nextSlot`, `claimDue`, `evaluateGuard`, `wake`.

### 3. Actions — `backend/actions/schedule/*.ts`, `backend/actions/schedules/schedules-due.ts`

### 4. Tools — `backend/tools/schedule/*.ts`

### 5. Frontend, CLI, docs — `frontend/src/pages/bots/BotSchedulesTab.tsx`, `cli/src/commands/schedule.ts`, `frontend/src/content/docs/schedules.md`

## Test plan

- **Idempotency:** two `schedules:due` runs racing over the same due row produce one run and one inbox row.
- **Missed slots:** `nextRunAt` six slots in the past runs once (`latest`), or zero times (`none`).
- **DST:** a 02:30 daily schedule in `America/New_York` across both transitions.
- **Guard:** the scripted fast model answers `act: false` → `skipped`, with no tick and no outbound row.
- **Silent completion:** a scheduled tick ending `complete({ silent: true })` posts nothing to the Slack fake and records `silent`.
- **Disengagement:** a stopped conversation target skips; a removed binding skips.
- **Proposal:** a bot's `schedule_propose` creates a disabled schedule that never fires until a person enables it (audited).
- **Slack channel target:** a new top-level message becomes the thread, and a reply in that thread continues the same conversation.

## Verification

```bash
cd backend && bun test __tests__/schedules
bun run lint
```

## Definition of done

- [ ] Admins attach cron schedules (with time zone, instruction, optional guard) to a bot and a target
- [ ] Each slot runs at most once; missed slots never burst
- [ ] Guards cost one fast-model call per slot and can skip silently
- [ ] Scheduled ticks may end silent; goal-review schedules update goals
- [ ] Bots can propose but never enable schedules
- [ ] Schedules tab, CLI, and `schedules.md` ship in the same PR

## Open questions

- **Linear channel target.** A Linear project has no agent-session surface outside issues. Options: post as a project update, comment on a designated issue, or open a new issue (needs `issues:create`). Pick one with users.
- **Default limits.** Maximum schedules per bot (10?) and minimum interval (5 minutes?).

## Learnings from the build

Not built yet.
