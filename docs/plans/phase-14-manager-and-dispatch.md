# Phase 14 — Manager role and dispatch

> **Goal:** A person can hand `@hypotenuse` a whole piece of product work instead of one ticket. A **manager**
> agent writes the PRD into the Linear project, breaks it into issues with acceptance criteria, **dispatches**
> those issues to **worker** agents on whichever runners are eligible, reviews what each worker produced, and
> either accepts it, asks for changes, or files follow-ups. A human stays accountable at every step: nothing is
> merged or closed as Done by an agent unless the project explicitly allows it.

> **Status: planned, not built.** Builds on [work routing](./phase-09-work-routing.md) (role selection and the
> `work_items` table), the [ACP agent host](./phase-11-acp-agent-host.md) (role prompts and permission
> policies), [worktrees](./phase-12-worktrees-and-session-lifecycle.md), and the
> [Hypotenuse MCP server](./phase-13-hypotenuse-mcp.md) (the manager tool set). This phase adds the dispatch
> mutation, the review loop, and the manager's default entry prompt.

Before this phase every Linear session is answered by a worker: one issue, one worktree, one pull request. That
is the right unit for implementation, and the wrong one for the work that comes *before* implementation —
turning "we need saved carts in checkout" into a PRD, a breakdown, and a set of tickets small enough for a
worker to finish. Linear has the surfaces for that (projects with descriptions, Documents, issues and sub-issues,
relations), and the agent APIs let an app create issues and start sessions on them. What is missing is an agent
whose job is to use them, and a server that can carry the result of one agent's work back to another.

There is one Linear app user. The decision recorded in [`ARCHITECTURE.md`](../ARCHITECTURE.md#the-roles-manager-and-worker)
is that **role is a routing decision, not an identity**: a manager session and a worker session look the same
in Linear — both are `@hypotenuse` — and differ in which entry prompt, which permission policy, and which MCP
tools the daemon gives the coding agent. That keeps install simple (one OAuth app, one webhook) and puts the
whole manager/worker distinction in places Hypotenuse controls.

## Scope

**In:**

- The default **manager entry prompt** and the manager's runtime shape: a **read-only checkout** worktree for
  repository context and `permission_policy = "deny"` for writes.
- Routing-rule defaults that select `manager`: the label `hypotenuse:manager`, the `/manage` prompt prefix, and
  sessions on project-level planning issues.
- **`daemon:dispatch`** — delegate an issue to `@hypotenuse`, start a Linear session on it, record it as a child
  of the manager's session, and route a `dispatch` work item with `role = worker` forced.
- **Deduplication** of the `AgentSessionEvent` / `created` webhook Linear may send for a session the server
  started itself.
- The **review loop**: when a dispatched worker turn finishes, a `review` work item on the parent manager
  session, sticky to the manager's runner, carrying the worker's result.
- **Requesting changes** from a worker without impersonating a human prompt.
- **Loop guards**: dispatch depth 1, no self-dispatch, a per-session concurrent-dispatch cap, and
  `routing.maxReviewRounds`.
- The **accountability rule** (AIG #6): `manager.can_complete_issues` (default `false`) gates the manager
  moving issues to a `completed` state; no agent merges pull requests.
- Dashboard: the session page shows parent/child links; the CLI shows them in `hypotenuse session view`.
- User docs: `roles.md` gains the manager workflow.

**Out:**

- Multi-level hierarchies (a manager dispatching to a manager). Depth stays 1 until a real use case argues
  otherwise. See [Settled non-goals](#settled-non-goals-do-not-reopen-without-a-new-plan).
- Cross-workspace dispatch. One project is one Linear workspace.
- Automatic PR merging by any agent, in any configuration.
- Estimation models, cycle planning, or initiative management. The manager can set `estimate` and labels; it
  does not plan cycles.
- A separate Linear app for the manager. Rejected at the start of planning; see
  [`ARCHITECTURE.md`](../ARCHITECTURE.md#the-roles-manager-and-worker).

## Design

### How a session becomes a manager session

Role selection lives in [`phase-09-work-routing.md`](./phase-09-work-routing.md): `routing_rules` are evaluated
in order on `AgentSessionEvent` / `created`, and the first match decides `agent_sessions.role`. This phase only
seeds the defaults that a new project's rules start with and documents them:

| Position | Match | Role | Why |
|---|---|---|---|
| 1 | prompt's first line starts with `/manage` | `manager` | explicit, wins over labels |
| 2 | prompt's first line starts with `/work` | `worker` | explicit escape hatch from rule 3 |
| 3 | issue has label `hypotenuse:manager` | `manager` | a planning issue a person marked as such |
| 4 | issue has **no team-workflow parent** and is in a project whose description is empty | `manager` | "plan this project" issues |
| 5 | (default) | `worker` | |

Rule 4 is seeded **disabled**. It is a heuristic, and the review of this plan judged that a heuristic which
silently changes what kind of agent answers is worse than a missing default. Admins can turn it on.

A follow-up prompt never changes a session's role. A session that started as a worker stays a worker even if
someone later types `/manage` into it — the prefix is only read at `created`. The reply, as a `thought`, says so.

### The manager's runtime

A manager session needs to *read* the code (to write a PRD that fits the codebase, and to size tickets), and must
not *change* it. Two choices were weighed:

1. **No worktree.** The manager reasons from the issue text and Linear alone. Cheap, but the breakdown is blind
   to the repository and tends to produce tickets that do not match its structure.
2. **A read-only checkout.** The daemon creates a worktree as usual
   ([`phase-11`](./phase-12-worktrees-and-session-lifecycle.md)) but at the repository's `base_branch` head,
   detached, and the role's `permission_policy` is `deny`: every ACP `session/request_permission` for an
   `edit`, `delete`, `move`, or `execute` tool kind is answered `reject_once` by the daemon without asking the
   person, and `fs/write_text_file` returns an error.

**Decision: 2.** The checkout is detached so no branch is created, and it is cleaned up with the session under the
`on-complete` policy regardless of the runner's configured cleanup, because there is never anything in it to keep.
If no repository applies (the routing step found none), the manager runs with `cwd` set to an empty temporary
directory and is told so in its prompt.

`execute` is denied because "read-only" that permits arbitrary shell is not read-only. A manager that needs to run
something to answer a question — "how many tests are there?" — asks a worker by dispatching a spike issue.

The role's tool set comes from [`phase-13-hypotenuse-mcp.md`](./phase-13-hypotenuse-mcp.md): the worker tools
plus `linear_create_issue`, `linear_update_issue`, `linear_create_sub_issue`, `linear_create_relation`,
`linear_get_project`, `linear_update_project`, `linear_create_document`, `linear_update_document`,
`linear_list_labels`, and `hypotenuse_dispatch`. The server re-derives the role from the session row on every
call; a worker session that somehow named `daemon:dispatch` gets a 403 regardless of what the daemon sent.

### The default manager prompt

Shipped as `cli/src/acp/prompts/manager.md` and used when `[roles.manager]` sets neither `prompt` nor
`prompt_file` ([`CONFIG.md`](../CONFIG.md)). The prompt is assembled by `cli/src/acp/prompt.ts`
([`phase-10`](./phase-11-acp-agent-host.md)) with Linear's `promptContext`, guidance, and the rebuilt
conversation; this file is only the role's standing instructions. Its content, in outline:

1. **Who you are.** "You are the planning agent for this Linear workspace, acting as the app user
   `@hypotenuse`. You are an AI agent; say so if asked." (AIG #1.)
2. **What you produce.**
   - A PRD in the project's description (`linear_update_project`) when the issue concerns a whole project, or
     a Linear Document attached to the project (`linear_create_document`) when the description is already
     owned by a person. Sections: Problem, Goals, Non-goals, User stories, Requirements, Open questions,
     Rollout.
   - A breakdown into issues (`linear_create_issue`) or sub-issues of the triggering issue
     (`linear_create_sub_issue`), each with a title, a description containing **Acceptance criteria** as a
     checklist, labels from `linear_list_labels` (never invented), an estimate where the team uses them, and
     `blocks` / `related` relations (`linear_create_relation`) where ordering matters.
3. **How you ask.** Clarifying questions go through `linear_ask_user`, with `options` whenever the answer is a
   choice, which renders as a `select` elicitation. Ask everything you need at once, not one question per turn.
4. **What you never do.** Write or change code; run commands; merge pull requests; move an issue to a
   `completed` state unless the tool tells you that is permitted; dispatch an issue you did not create or that a
   human has not delegated to you; dispatch more than `max_parallel_dispatch` issues at once.
5. **How you dispatch.** Only issues whose acceptance criteria are written, one `hypotenuse_dispatch` per issue,
   with optional `instructions` (extra context for the worker that does not belong in the issue).
6. **How you review.** On a review turn you receive the worker's final response, plan, and pull request link.
   Check the result against the issue's acceptance criteria, then **accept**, **request changes** (one
   `hypotenuse_dispatch` with `mode: "changes"` and specific instructions), or **file follow-ups** (new issues
   linked `related` to the original). End every review turn with a `response` that says which you chose and why.

The prompt is a file, not a string in code, so it can be read, reviewed, and overridden as a whole. A test asserts
that the default prompt names every manager tool and no worker-only tool name is missing from it either.

### `daemon:dispatch`

```
hypotenuse_dispatch(issueId, instructions?, agentPreference?, mode? = "new" | "changes")
  → daemon:dispatch  (runner token; session id from the MCP server's --session)
```

The action, in one transaction on the server:

1. **Load and lock** the calling session (`agent_sessions … FOR UPDATE`). Refuse unless `role = manager`, the
   session is not terminal, and the calling runner holds its live work item.
2. **Guards** (each a typed 406 with a reason the tool returns to the model verbatim):
   - the target issue is in the session's integration and on a team the integration can access;
   - the target issue is not the manager session's own issue (**no self-dispatch**);
   - for `mode = "new"`: no non-terminal child session of this manager already exists for the issue;
   - for `mode = "changes"`: a child session for the issue exists, belongs to this manager, and is terminal;
   - the number of non-terminal child sessions is below `manager.max_parallel_dispatch` (project setting,
     default 3);
   - for `mode = "changes"`, the child's `reviewRound` is below `routing.maxReviewRounds` (default 3).
3. **Record the intent** — insert a `dispatch_intents`-shaped row. Rather than a new table, this is a Redis key
   `dispatch:intent:<integrationId>:<externalIssueId>` → `{ managerSessionId, workItemSeed }` with a 10-minute
   TTL, written **after commit**, and the authoritative copy is the `work_items` row inserted in step 6. The
   key exists only so that the webhook handler can recognise a `created` it did not expect (below).
4. **After commit**, call Linear (through `ops/LinearOps.ts`, with the integration's token):
   - `issueUpdate(id, { delegateId: <externalAppUserId> })` if the issue's delegate is not already the app user;
   - `agentSessionCreateOnIssue({ issueId })` for `mode = "new"`. For `mode = "changes"` the worker's existing
     Linear session is reused: no new session is created.
5. **Upsert `agent_sessions`** by `externalSessionId` with `role = worker` (forced, bypassing `routing_rules`),
   `parentAgentSessionId = <manager session>`, `dispatchMode`, `reviewRound` (0 for new, previous + 1 for
   changes).
6. **Insert a `work_items` row**: `kind = dispatch` (or `prompt` for `mode = "changes"`), `role = worker`,
   `status = queued`, payload `{ instructions, agentPreference, dispatchedBy: managerSessionId }`, and the
   preferred user is the **manager session's creator**, so a dispatched ticket prefers the same person's runners
   as the plan it came from.
7. Enqueue `work:route`, and emit on the manager session an `action` activity
   `{ action: "Dispatched", parameter: "ENG-123", result: "<Linear session URL>" }`.

Steps 4–5 are outside the step-1 transaction because they are network calls. If step 4 fails, the work item from
step 6 is never inserted and the tool returns the Linear error; if the Linear calls succeed and the second
transaction fails, the next `created` webhook (or the reconciliation in `work:route`) finds the Linear session and
the Redis intent and completes the insert. The plan's order is chosen so that **every failure leaves either
nothing, or a Linear session Hypotenuse can recognise** — never a work item pointing at a session that does not
exist.

### Deduplicating the `created` webhook

Linear's docs say a session is created when the app is delegated an issue or mentioned. Whether
`agentSessionCreateOnIssue` *also* sends `AgentSessionEvent` / `created` to the app that called it is not stated.
The handler must be correct either way:

- `triggers:process-event` upserts `agent_sessions` **by `externalSessionId`** — so a `created` for a session the
  dispatch already inserted finds the row, and does not insert a second.
- If the row exists and already has a non-terminal work item, the event is recorded with
  `outcome = duplicate_of_dispatch` and nothing else happens. In particular, **no** second acknowledgement
  `thought` and **no** role selection.
- If the row does not exist yet but `dispatch:intent:<integrationId>:<externalIssueId>` does, the handler inserts
  the session **with the intent's role and parent** — the webhook won the race against step 5 above.
- Only when neither exists is this an ordinary `created` from a human delegation.

The `issueUpdate(delegateId)` in step 4 can likewise produce a delegation-triggered `created`. The same upsert
covers it: Linear ties a session to an issue and app user, and the identifier the dispatch and the webhook agree on
is `externalSessionId`.

A test drives both orders against finear (which does send `created` on delegation) and asserts exactly one
`agent_sessions` row, one work item, and one acknowledgement.

### What the worker sees

A dispatched worker session is an ordinary worker session plus:

- an opening `thought`, emitted by the server as the acknowledgement:
  "Dispatched by the planning session on <parent issue URL>." A bare Linear issue URL in Markdown renders as a
  mention, so the parent issue is linked in Linear's UI.
- the dispatch `instructions` appended to its prompt under a heading `## Instructions from the planning agent`,
  after Linear's `promptContext`.
- `agentPreference` (an agent id from the runner's `[agents]`) is a preference, not a constraint: a runner that
  lacks it may still claim; the daemon uses the role's configured agent instead and says so in a `thought`.

Workers cannot dispatch. The tool is not in their MCP set, and `daemon:dispatch` refuses any session whose
`role` is not `manager`. That is the **depth-1** rule, enforced in two places on purpose: the tool list is what
keeps a model from trying, and the server is what makes trying useless.

### The review loop

When `daemon:complete` finishes a work item whose session has a `parentAgentSessionId`, the server — inside the
same transaction that marks the item terminal — inserts a `work_items` row on the **parent** session:

```
kind      = review
role      = manager
sticky    = parent session's runnerId (falls back per routing.stickyTimeout)
payload   = {
  childSessionId, childIssueIdentifier, reviewRound,
  outcome: "completed" | "failed" | "cancelled",
  finalResponse:  <body of the child's last response or error activity>,
  plan:           <child agent_sessions.plan>,
  pullRequests:   <child externalUrls labelled "Pull Request">,
}
```

The daemon renders the payload into the review turn's prompt (`cli/src/acp/prompt.ts`), as a fenced block under
`## Worker result for ENG-123 (round N)`. The manager's Linear session gets a `thought`
"Reviewing ENG-123 (round N)…" as the turn's acknowledgement, so a person watching the planning issue sees why it
became active again.

Linear does not let an agent create `prompt` activities, so the review turn is **not** a Linear prompt. It is a
Hypotenuse work item whose prompt exists only in the payload. The conversation history that later turns rebuild
from activities therefore includes the manager's *reaction* to each review (its activities) and not the synthesized
input. The daemon also keeps the rendered review prompt in its local ACP session, which `session/load` restores,
so a resumed manager session still has the text. This asymmetry is recorded as a known gap; if it causes a model to
lose the thread, the fix is to have the server emit the result summary as a persisted `thought` on the manager
session before the turn — not to fake a prompt.

**One review per child completion.** If several workers finish while the manager is mid-turn, their review items
queue behind it; exactly one manager work item is non-terminal at a time
([`ARCHITECTURE.md`](../ARCHITECTURE.md#work_itemsstatus)). A review item for a child that has since been
re-dispatched (round advanced) is cancelled with `reason = superseded` when it would have been offered.

### Accept, request changes, file follow-ups

| Decision | What the manager calls | What the server does |
|---|---|---|
| **Accept** | `linear_comment` on the child issue ("Reviewed against acceptance criteria: …"), optionally `linear_set_issue_state` | The comment is an ordinary comment authored by the app. A state change to a `completed`-type state is **refused** unless `manager.can_complete_issues = true`; moving to a `started`-type "In Review" state is always allowed. |
| **Request changes** | `hypotenuse_dispatch(issueId, instructions, mode: "changes")` | `reviewRound + 1`; a `kind = prompt` work item on the **worker's existing session**, sticky to its runner (so it reuses the worktree and branch). The server emits on the worker session a persisted `thought`: "The planning agent requested changes: <instructions>". The worker's prompt carries the instructions under `## Changes requested by the planning agent`. |
| **File follow-ups** | `linear_create_issue` + `linear_create_relation(type: related)` | Ordinary creates. Follow-ups are not dispatched automatically; the manager may dispatch them in the same turn, within the parallel cap. |

Request-changes uses a work item on the worker's session rather than a comment because a comment is not a prompt:
Linear does not send `prompted` for a comment authored by the app, and an agent reading comments is exactly what
the best practices advise against. The `thought` is what makes the request visible in the worker's session in
Linear; the work item is what makes it happen.

When `reviewRound` reaches `routing.maxReviewRounds`, `mode = "changes"` is refused with "review round limit
reached — hand this to a person", and the manager is instructed by its prompt to end with an `elicitation`
addressed to the session's creator explaining what is still wrong.

### Accountability

AIG principle 6 — *an agent cannot be held accountable* — is the reason three things are not configurable to
"yes" by an agent:

- **Merging.** No tool merges a pull request. Workers open pull requests (with the person's own git credentials,
  on their own machine); people merge them.
- **Completing issues.** `linear_set_issue_state` to a state whose `type` is `completed` or `canceled` is refused
  for manager sessions unless the project setting `manager.can_complete_issues` is `true` (default `false`), and
  refused for worker sessions always. The refusal is a tool error the model can read.
- **Assignment.** Dispatch sets `delegateId`, never `assigneeId`. The person who owns the issue stays its owner;
  the agent is the delegate, which is Linear's model for exactly this.

### Concurrency and loop guards, together

| Guard | Where | Default |
|---|---|---|
| Workers cannot dispatch | MCP tool set + `daemon:dispatch` role check | always |
| No self-dispatch | `daemon:dispatch` | always |
| No double dispatch of one issue by one manager | non-terminal child check under the manager row lock | always |
| Parallel children per manager session | `manager.max_parallel_dispatch` | 3 |
| Review rounds per child | `routing.maxReviewRounds` | 3 |
| One non-terminal work item per session | `work_items` partial unique index from [phase 9](./phase-09-work-routing.md) | always |
| Dispatch only into the integration's accessible teams | `daemon:dispatch` | always |

The parallel cap is checked under the manager session's row lock, so two dispatch calls racing from one turn
cannot both pass at `cap - 1`. The test fires `cap * 4` concurrent dispatches (ToolExec's convention) and asserts
exactly `cap` succeed.

## Steps

### 1. Schema — `backend/schema/agent_sessions.ts`, `backend/schema/project_settings.ts`

- `agent_sessions` gains `parentAgentSessionId` (nullable, `references agent_sessions.id`, `on delete set null`),
  `dispatchMode` (`text`, nullable: `new` | `changes`), and `reviewRound` (`integer`, default 0). Index on
  `parentAgentSessionId`.
- `project_settings` gains a `manager` jsonb section: `{ canCompleteIssues: false, maxParallelDispatch: 3 }`, and
  `routing.maxReviewRounds` (default 3) lands in the `routing` section from [phase 9](./phase-09-work-routing.md).
- One migration, `bun run migrations`.

### 2. Default routing rules — `backend/ops/RoutingOps.ts`

`seedDefaultRoutingRules(tx, projectId)` inserts the five rules above (rule 4 disabled) when a Linear integration
is first connected. It is called from `linear:callback`'s transaction, and is idempotent: it does nothing if the
project already has rules. `ops/RoutingOps.ts` `selectRole` (from phase 9) needs no change.

### 3. Ops — `backend/ops/DispatchOps.ts`

- `assertCanDispatch(tx, managerSession, target, mode)` — every guard in the table, each a
  `TypedError(CONNECTION_ACTION_PARAM_VALIDATION)` with a sentence the model can act on.
- `dispatchIntentKey(integrationId, externalIssueId)` and `writeDispatchIntent` / `readDispatchIntent`.
- `buildReviewPayload(tx, childSession)` — the review payload, from the child's last `response`/`error` activity,
  `plan`, and `externalUrls`.
- `enqueueReviewIfChild(tx, workItem)` — called by `daemon:complete`; inserts the review item when the session has a
  parent; cancels superseded review items.

### 4. `daemon:dispatch` — `backend/actions/daemon/daemon-dispatch.ts`

As designed above. Daemon-only (added to `DAEMON_ONLY_ACTION_NAMES`), runner-token authenticated, never MCP as a
server tool (it is reached through the stdio MCP server's `hypotenuse_dispatch`). Not an `AuditedAction` — it is
the machine half of a session, like `daemon:events` — but it writes an `audit_logs` row through `writeAuditLog`
with `action = "agent:dispatch"`, the manager session, and the target issue, because it is the one daemon action
that **delegates work to the app on a person's issue**. The [audit plan](./phase-04-users-tenancy-and-audit.md)'s
closed list of unaudited writers gains `daemon:*` with this exception named.

Inputs: `{ issueId: string (uuid or identifier), instructions?: string (≤ 8 KB), agentPreference?: string,
mode: "new" | "changes" = "new" }`. Response: `{ dispatch: { agentSessionId, externalSessionId, externalSessionUrl,
issueIdentifier, mode, reviewRound } }`.

### 5. Webhook dedupe — `backend/actions/linear/linear-process-event.ts`

The `created` branch from [phase 7](./phase-07-webhook-ingress-and-session-mirror.md) becomes: upsert by
`externalSessionId` → if a non-terminal work item exists, `outcome = duplicate_of_dispatch` → else consult the
dispatch intent → else ordinary routing. The acknowledgement `thought` is enqueued only on the branch that inserted
the work item.

### 6. Review enqueue — `backend/actions/daemon/daemon-complete.ts`

Call `enqueueReviewIfChild(tx, workItem)` inside the existing completion transaction. Emit the "Reviewing …"
acknowledgement through the outbox when the review item is offered, not when it is inserted, so a manager that is
mid-turn does not show "Reviewing" while it is still doing something else.

### 7. Issue-state guard — `backend/actions/daemon/daemon-linear-set-issue-state.ts`

Look up the target state's `type` (cached per team from `integration:catalog` data). Refuse `completed` / `canceled`
types for workers always and for managers unless `manager.canCompleteIssues`. Refuse any issue other than the
session's own for workers; managers may set state on issues they created or dispatched.

### 8. Daemon: the manager runtime — `cli/src/acp/prompts/manager.md`, `cli/src/acp/prompt.ts`, `cli/src/acp/permissions.ts`, `cli/src/worktree/manager.ts`

- `manager.md` as outlined. `prompt.ts` renders `dispatch` instructions, `changes` instructions, and review payloads
  into their headed sections.
- `permissions.ts`: policy `deny` rejects `edit` / `delete` / `move` / `execute` tool kinds without an elicitation;
  `fs/write_text_file` returns a JSON-RPC error with a message the model reads ("this session is read-only").
- `worktree/manager.ts`: `createReadOnlyCheckout(repo)` — `git worktree add --detach <path> <base_branch>`; always
  cleaned on completion.
- `mcp/tools.ts`: `hypotenuse_dispatch` input schema and description, which states the depth-1 rule and the review
  loop so the model knows a review turn will follow.

### 9. Config — `cli/src/config/schema.ts`

`[roles.manager]` defaults: `permission_policy = "deny"`, prompt from the shipped file. `config validate` warns when a
runner lists `manager` in `[runner].roles` but `[roles.manager].permission_policy` is not `deny` ("a manager with
write permission can change code; this is allowed but unusual").

### 10. Dashboard and CLI — `frontend/src/pages/SessionPage.tsx`, `cli/src/commands/session.ts`

The session page shows "Dispatched by" (parent link) and a "Dispatched" table of children with their status,
review round, and pull requests. `hypotenuse session view <id>` prints the same tree. `agent-session:view` returns
`parent` and `children` summaries — the server decides the tree, the client draws it.

### 11. User docs — `frontend/src/content/docs/roles.md`

The manager workflow: how to start one (label, `/manage`), what it writes where, how dispatch and review look in
Linear, the review-round limit, and `can_complete_issues`.

### 12. Tests

`backend/__tests__/actions/daemon-dispatch.test.ts`:

- a manager session dispatches → finear shows the issue delegated to the app user and a new agent session; exactly
  one `agent_sessions` row with `parentAgentSessionId`, `role = worker`; one `dispatch` work item.
- finear's delegation `created` webhook arriving **before** and **after** the dispatch's own insert → one row, one
  work item, one acknowledgement thought (two orders, driven by holding the finear drain).
- worker session calling `daemon:dispatch` → 403; self-dispatch → 406; double dispatch → 406; Bowser's runner
  token (another project) → 403.
- `cap * 4` concurrent dispatches → exactly `cap` succeed.
- `mode: "changes"` on a terminal child → `prompt` work item on the child session, sticky, `reviewRound + 1`,
  the "requested changes" thought in the outbox; at `maxReviewRounds` → refused.

`backend/__tests__/actions/review-loop.test.ts`:

- child `daemon:complete` → one `review` item on the parent with the payload's four fields; two children finishing
  back-to-back → two review items, serialized; a superseded review item → cancelled.
- issue state to `completed` from a manager with the default setting → refused; with
  `canCompleteIssues = true` → allowed; from a worker → always refused.

`cli/__tests__/acp/manager-runtime.test.ts`: the fake ACP agent requests `edit` and `execute` permissions under
policy `deny` → both rejected without an outbound elicitation; `fs/write_text_file` errors; the default manager
prompt contains every manager tool name.

## Verification

```bash
cd backend && bun run migrations && bun run lint && bun test __tests__/actions/daemon-dispatch.test.ts __tests__/actions/review-loop.test.ts
cd ../cli && bun run lint && bun test __tests__/acp/manager-runtime.test.ts
```

Manually, against a local finear instance (the harness from [phase 6](./phase-06-linear-connection.md)) and a
local daemon with the fake agent scripted to plan-and-dispatch:

1. Label an issue `hypotenuse:manager` and delegate it to `@hypotenuse`.
2. The session acknowledges as the manager, writes a PRD Document, creates three sub-issues, dispatches two.
3. Two worker sessions appear on the sub-issues, each opening with "Dispatched by …" linking the parent.
4. Each worker finishes; the manager session goes active again with "Reviewing ENG-… (round 1)".
5. The scripted manager requests changes on one; the worker session shows the "requested changes" thought and a new
   turn on the same branch.
6. `hypotenuse session view <manager-session>` shows the tree with rounds.

## Definition of done

- [x] `parentAgentSessionId`, `dispatchMode`, `reviewRound` on `agent_sessions`; `manager` and
      `routing.maxReviewRounds` settings
- [x] Default routing rules seeded on first connect, rule 4 disabled
- [x] `daemon:dispatch` with every guard, row-locked, Linear calls after commit, audit row via `writeAuditLog`
- [x] Exactly one session row and one work item regardless of `created` webhook ordering
- [x] Review work items enqueued on child completion, serialized, superseded ones cancelled
- [x] Request-changes as a sticky `prompt` work item plus a visible thought — never a fake prompt activity
- [x] `completed`/`canceled` state changes gated by `manager.can_complete_issues`; never for workers
- [x] Manager runtime: detached read-only checkout, `deny` policy, default `manager.md`
- [x] Session page and `session view` show parent/children (the CLI draws it; the session page is the dashboard's)
- [x] `roles.md` user doc updated (it is `manager-and-worker.md`)
- [x] Tests above green twice in a row

## Settled non-goals (do not reopen without a new plan)

- **A second Linear app for the manager.** The role is a routing decision. Two apps would double the install, the
  webhook, and the token custody, to buy a different avatar.
- **Managers dispatching managers.** Depth 1. A deeper tree needs a budget model (rounds × depth × parallelism)
  that nobody has asked for.
- **Comments as change requests.** An app-authored comment produces no `prompted` event and is not how an agent
  should read instructions.
- **Agents merging.** Not configurable.

## Learnings from the build

**Built.** Everything in the Definition of done, at CLI 0.10.0, with the departures below. A scripted daemon
dispatches against finear in `backend/__tests__/actions/daemon-dispatch.test.ts` and `review-loop.test.ts`; the
fake ACP agent exercises the read-only runtime in `cli/__tests__/acp/manager-runtime.test.ts`. No real coding agent
has planned and dispatched yet, and the manual walk-through under Verification has not been run against a real
Linear workspace.

### Where the pieces live

- **Server:** `ops/DispatchOps.ts` (guards, the Redis intent and in-flight reservation, `completeDispatch`,
  `adoptDispatchedSession`, the review payload, `enqueueReviewIfChild`, `reviewSuperseded`); `dispatch` in
  `ops/DaemonToolOps.ts` and the issue-state gate beside it; the `created` branch of
  `ops/LinearWebhookOps.ts`; `finishWorkItem` (reviews) and `buildAssignment` (`dispatch`, `review`) in
  `ops/WorkItemOps.ts`; supersede-at-offer and the "Reviewing" thought in `ops/WorkRouteOps.ts`;
  `MANAGER_DEFAULTS` and the `manager` section in `ops/ProjectSettingsOps.ts`; `SEEDED_RULES` and the
  `projectHasContent` match in `ops/RoutingOps.ts`; `agent-session:view`'s `parent` and `children`. Migration `0010`
  (the three session columns, `work_items.payload`, `project_settings.manager`).
- **Protocol:** `AssignmentDispatch`, `AssignmentReview` on `WorkAssignment` (additive); the
  `hypotenuse_dispatch` input in `protocol/src/tools.ts`.
- **Daemon:** `cli/src/acp/templates/manager.md`, the request sections in `cli/src/acp/prompt.ts`,
  `isReadOnly` in `cli/src/acp/permissions.ts` and the host's write refusal, `cli/src/acp/agent-choice.ts`, the
  `readonly` workspace in `cli/src/worktree/manager.ts`, `MANAGER_DEFAULT_POLICY` in `cli/src/config/schema.ts`,
  the validate warning, and `session view`'s tree; `routing settings` and `routing add|edit` gained the manager
  settings and the project-content match.

### Where the build departs from the plan

| Plan | Built | Why |
|---|---|---|
| The manager's `permission_policy = "deny"` | **a table: `{ default = "allow", edit = "deny", delete = "deny", move = "deny", execute = "deny" }`** | ACP agents ask permission for MCP tool calls (kind `other` or `fetch`); a blanket deny refused the manager its own Hypotenuse tools |
| `fs/write_text_file` errors under policy `deny` | **under any policy that denies `edit`**, whatever the role | read-only is a property of the policy, not of the role's name |
| The read-only checkout is cleaned "with the session" under `on-complete` | **made fresh for every turn and removed at its end**; a dirty one is kept for cleanup's safety rules | a review turn may come hours later on another runner; there is nothing to keep |
| `agentPreference` chosen by routing | **applied by the daemon**, for a new dispatch only, when the agent is an `[agents]` id on that runner | the server records the role's agent at offer; a `changes` turn resumes the agent holding the session. The server's per-agent count can be off by one for such a turn |
| Step 4: `issueUpdate(delegateId)`, then `agentSessionCreateOnIssue` | **create the session first, then delegate** | finear (and, we expect, Linear) starts a session on delegation unless one is live on the issue for the app; creating first makes the delegation join it instead of starting a second |
| The intent is "`dispatch_intents`-shaped" in Redis, the authoritative copy the work item | the same, plus **an in-flight hash per manager** (`dispatch:inflight:<id>`) written under the manager's row lock | the cap must count dispatches whose child row does not exist yet, or two racing calls both pass at `cap - 1` |
| A failed Linear call leaves nothing | **a refused call (a GraphQL error, `RATELIMITED`, an empty bucket) releases the slot; a lost response or timeout keeps it until the intent lapses (10 min)** | a lost response may hide a session Linear did create, which the `created` webhook then adopts; a retry meanwhile is refused rather than starting a second worker |
| Reconciliation in `work:route` | **none**: the `created` webhook (and its retries) is the reconciliation | Linear retries a delivery for six hours; the intent covers the first ten minutes |
| A review on every child completion, outcome `completed` / `failed` / `cancelled` | **none for a cancelled turn, a turn that ended on a question, or a manager a person stopped or un-delegated**; an expired turn is `failed` | re-dispatching what a person stopped re-engages without a prompt; a worker waiting on a person has nothing to review yet |
| The "Reviewing" thought when the item is offered | the same, **on its first offer only** | a lapsed offer re-offered must not say it twice |
| `buildReviewPayload` reads `plan` and `externalUrls` from the session | **folds in the turn's still-pending session updates** | the row holds what Linear has accepted; the turn that just ended usually has its plan and pull request link still in the outbox |
| `payload` on work items | **`work_items.payload` (jsonb)**: `{ dispatch }` or `{ review }` | work items had no payload column |
| Rule 4: "no team-workflow parent, project description empty" | **`{ hasParent: false, projectHasContent: false }`**, read with `GetProjectContent` only when an enabled rule needs it | Linear's `description` is the one-line summary; the PRD is `content` (as the tools plan found) |
| `roles.md`; the session page | **`manager-and-worker.md`**; the CLI draws the tree from `agent-session:view` | that is the doc's name; no session page exists yet |
| `outcome = duplicate_of_dispatch` | the same, also for **another session on an issue mid-dispatch** | Linear may start one for the delegation; it gets no worker |

### Decisions the plan left open

| Question | Answer |
|---|---|
| A dispatch onto an issue a person's own session is working | refused (406): delegating would join their session |
| Who the audit row names | the runner's owner, with the manager session, issue, mode, round, and runner in `metadata` |
| How a person reads "round N" | `reviewRound + 1`; the wire carries the count of change requests (0 for the first dispatch) |
| Manager settings in the CLI | `hypotenuse routing settings --max-parallel-dispatch`, `--manager-can-complete`, `--reset canCompleteIssues` |
| A worker moving its issue to `completed` | refused, like `canceled`, whatever the project allows |

### Traps found while building

- **A foreign key is a lock.** `completeDispatch` writing the child's `parent_agent_session_id` takes a key-share
  lock on the manager's row; two dispatches holding one each then deadlocked upgrading it to `FOR UPDATE` for the
  manager's outbox. The manager is now locked first, inside the same transaction.
- **Redis survived the tables between runs**: a reservation keyed by manager session 1 from an earlier file made the
  next file's session 1 look busy. `clearLinearRedisState` now clears `dispatch:*`.
- **finear starts a session on an app's own delegation** and delivers `created` for sessions the app creates, so
  both of the plan's webhook orders are reachable; the "webhook first" order is driven by losing the delegation's
  response at the proxy.
