# Phase 17 — Sandboxes

> **Goal:** A bot can hand real work to a coding agent in an ephemeral sandbox, and the people who asked can follow it from where they asked. Real work here means anything that needs a filesystem, a shell, or hours: reading a repository, running tests, changing code. The bot starts a sandbox job from a conversation. The job's coding agent sees Hypotenuse's own tools and the project's shared MCP servers. It reports status, asks questions, and asks for help, and each of those arrives in the originating Slack thread, Linear session, or Pylon issue. The bot sleeps while the job runs and wakes when it finishes.

> **Status: planned, not built.** Builds on the [durable agent loop](./phase-08-durable-agent-loop.md) (`waitingOn`, wake), [shared MCP servers](./phase-10-shared-mcp-servers.md) (registry, credentials, approval gate), and [the channel framework](./phase-13-channel-framework.md) (interactive surface, escalation). Git credentials and pull requests are [the next phase](./phase-18-git-and-pull-requests.md). Docker is the only provider here; [Vercel](./phase-19-vercel-sandboxes.md) follows.

Hypotenuse's main loop runs on hosts shared by every tenant. It runs model calls, memory, MCP, and [code mode](./phase-12-code-mode.md) in a WASM isolate, and never a shell. Anything that needs a real machine runs somewhere disposable. ToolExec already built that machinery: a provider interface, a ledger, a supervisor that speaks to the server over plain HTTPS, an injected MCP server, credential containment, human help, and reapers. Most of it ports with its learnings intact. What is new is the **caller**: a conversation waiting on a job, instead of a person watching a run page.

## Scope

**In:**

- **Providers.**
  - ToolExec's `SandboxProvider` interface (`backend/sandbox/types.ts`): `create`, `connect`, `list`, and the `Sandbox` operations `writeFiles`/`readFile`/`mkdir`/`exec`/`spawn`/`attach`/`setEgress`/`extendTimeout`/`stop`/`destroy`, plus `ProviderCapabilities`.
  - The provider registry, the `docker` provider (development and CI only), the `sandboxes` ledger, and `sandbox:orphan-sweep`.
- **Images.** The sandbox image: `backend/sandbox/images/Dockerfile.dev`, non-root user `agent`, Claude Code installed, `VERSION` bumped with every change.
- **Jobs.** `sandbox_jobs`: one per job, tied to `(conversationId, botId)`, with a task, an optional repository reference (used by the [git phase](./phase-18-git-and-pull-requests.md)), status, and liveness clocks. `sandbox_job_events` is the job's transcript.
- **Bot tools:**
  - `sandbox_start` (create a job and park the conversation on it, or keep working);
  - `sandbox_message` (follow-up or steer an interactive job);
  - `sandbox_status`;
  - `sandbox_cancel`.
- **Dispatch and provisioning.** `sandbox-jobs:dispatch` (clock, `FOR UPDATE SKIP LOCKED`, per-project concurrency) → `sandbox-job:start` (task, `timeout = 0`). Provisioning:
  1. Mint a **job token** (ToolExec's run token).
  2. Write the prompt, the MCP config, and the supervisor.
  3. Narrow egress where the provider can.
  4. Launch the coding CLI under the supervisor.
- **The supervisor protocol** (sandbox → server only, HTTPS, token in the body):
  - `sandbox:events` (batched transcript);
  - `sandbox:heartbeat` (the only server → sandbox control: cancel, follow-up, steer);
  - `sandbox:complete` (exit, closing text, usage).
- **Hypotenuse MCP inside the sandbox** at `${apiUrl}/mcp`, authenticated by the job token, publishing only the sandbox-only tools:
  - `sandbox:report-status`
  - `sandbox:ask` (a question relayed to the originating conversation)
  - `sandbox:request-help` (escalation to project people)
  - `sandbox:submit-artifact`
  - `sandbox:memory-search` (the bot's memory, read-only, the conversation's scopes)
- **The project's shared MCP servers** for the job, through a server-side **gateway proxy** that attaches credentials, with the bot's allowlist and approval gate applied.
- **A model proxy** so the CLI's model traffic carries the job token, never a provider key. It is required now, not in the git phase, because the rule "credentials never leave the server" binds from the first sandbox.
- **Waking the parent.** The parent conversation waits on `waitingOn: { kind: "sandbox", jobId }`. Completion, failure, a question, or a help request wakes it.
- **Reaper sweeps** (ToolExec's): dead supervisor, stalled agent, stuck provisioning, over duration, cancel not acknowledged, and an idle interactive job.
- RBAC, audit, MCP policy, CLI, UI, and user docs.

**Out:**

- Git credentials, cloning private repositories, pushing, and pull requests: [git and pull requests](./phase-18-git-and-pull-requests.md).
- Vercel and any hosted provider: [Vercel sandboxes](./phase-19-vercel-sandboxes.md). Kubernetes, exe.dev, and SSH are possible later providers through the same registry.
- Sleep and wake of a sandbox from an encrypted checkpoint (ToolExec's [sleep and wake](https://github.com/arcadeai-labs/toolexec/blob/main/docs/plans/phase-31-sleep-and-wake.md)). An idle interactive job here ends `expired`, and a later follow-up starts a new job that the bot briefs from its own transcript.
- Codex, Cursor, and other CLIs. The supervisor's CLI abstraction keeps them possible; Claude Code is the first and only one tested.
- Agent-to-agent calls from inside a sandbox (ToolExec's stacking). A sandbox talks to its own conversation only.

## What already exists

| Piece | ToolExec path | Carry |
|---|---|---|
| Provider interface | [`backend/sandbox/types.ts`](https://github.com/arcadeai-labs/toolexec/blob/main/backend/sandbox/types.ts) | Port verbatim |
| Registry (`kind`, `productionAllowed`, `capabilities`, `credentialSchema`, `build(credentials)`) | [`backend/sandbox/registry.ts`](https://github.com/arcadeai-labs/toolexec/blob/main/backend/sandbox/registry.ts) | Port, with `docker` only |
| Docker provider (`toolexec.managed` label, polling exec, deadline file, `chown` after `docker cp`) | [`backend/sandbox/providers/docker.ts`](https://github.com/arcadeai-labs/toolexec/blob/main/backend/sandbox/providers/docker.ts) | Port; label `hypotenuse.managed` |
| Ledger (`creating` before the provider call, compare-and-swap destroy) | [`backend/ops/SandboxOps.ts`](https://github.com/arcadeai-labs/toolexec/blob/main/backend/ops/SandboxOps.ts), `schema/sandboxes.ts` | Port verbatim |
| Provisioning (`collectMcpServers`, `buildMcpConfigFile`, `buildSandboxEnv`, `buildClaudeSettings`, `buildEgressAllowlist`, `runnerFiles`) | [`backend/ops/RunProvisionOps.ts`](https://github.com/arcadeai-labs/toolexec/blob/main/backend/ops/RunProvisionOps.ts) | Port; rename env from `TOOLEXEC_*` to `HYPOTENUSE_*` |
| Supervisor (`runner.ts`, `parser.ts`, `batcher.ts`, `usage.ts`; imports nothing from the backend) | [`backend/sandbox/runner/`](https://github.com/arcadeai-labs/toolexec/tree/main/backend/sandbox/runner) | Port; drop session checkpointing |
| Job token middleware (param → MCP session → Bearer; active statuses) and per-job rate limit | [`backend/middleware/runToken.ts`](https://github.com/arcadeai-labs/toolexec/blob/main/backend/middleware/runToken.ts), `runTokenRateLimit.ts` | Port as `jobToken.ts` |
| Model proxy (verbatim headers, untouched body, streamed, 429/529 retried, budget 402) | [`backend/actions/proxy/proxy-model.ts`](https://github.com/arcadeai-labs/toolexec/blob/main/backend/actions/proxy/proxy-model.ts), [`ops/ModelProxyOps.ts`](https://github.com/arcadeai-labs/toolexec/blob/main/backend/ops/ModelProxyOps.ts) | Port; the key comes from the bot's [model connection](./phase-07-model-providers-and-bots.md) |
| Gateway proxy | [`backend/actions/proxy/proxy-gateway.ts`](https://github.com/arcadeai-labs/toolexec/blob/main/backend/actions/proxy/proxy-gateway.ts) | Port over `mcp_servers` |
| Human help (ask now, collect later; a wait that runs out is not an error) | [`docs/plans/phase-12-human-help.md`](https://github.com/arcadeai-labs/toolexec/blob/main/docs/plans/phase-12-human-help.md) | `sandbox:ask` / `sandbox:request-help` follow its two-tool shape |
| Learnings | [`phase-06`](https://github.com/arcadeai-labs/toolexec/blob/main/docs/plans/phase-06-sandboxes.md), [`phase-08`](https://github.com/arcadeai-labs/toolexec/blob/main/docs/plans/phase-08-manual-runs.md), [`phase-13`](https://github.com/arcadeai-labs/toolexec/blob/main/docs/plans/phase-13-credential-containment.md), [`phase-20`](https://github.com/arcadeai-labs/toolexec/blob/main/docs/plans/phase-20-interactive-agent-sessions.md) | Read before changing anything here |

## What this must not weaken

1. **The job token is the only credential in the sandbox.** No model key, no MCP credential, no platform token, and no GitHub token sits in the environment or in a file. A test enumerates the sandbox's environment and files and asserts it.
2. **The job carries the bot's authority, never more.** The token resolves to the bot, project, conversation, and job. Every in-sandbox tool re-derives its scope from the job row. A sandbox cannot reach another conversation, another bot's memory, or a tool its bot is not allowed.
3. **All job state is in Postgres.** A worker restart, a deploy, or an OOM loses nothing. The supervisor pushes; the server never holds a stream in memory.
4. **One funnel ends a job.** `finalizeSandboxJob` stamps a terminal status idempotently (first reason wins) and releases what the job held (token, sandbox, open questions). Every ending goes through it.
5. **Never docker in production.** Refused at run time and at settings-write time, as in ToolExec.
6. **A provider that cannot honour an egress policy refuses it.** Docker throws on `deny-all`, and a job whose bot requires an allowlist does not start on Docker.
7. **Delivery after a claim is at-most-once.** A follow-up claimed by a heartbeat is never replayed.
8. **The parent conversation is never left waiting on a dead job.** Every terminal transition wakes it.

## Design

### 1. From a tool call to a sandbox

The bot calls `sandbox_start({ task, title, repository?, interactive?, wait? })`:

1. The tool inserts a `sandbox_jobs` row (`pending`, `parentConversationId`, `botId`, `triggeredByParticipantId`). Its `afterCommit` nudges `sandbox-jobs:dispatch`.
2. With `wait: true` (the default), the tick ends with `waitingOn: { kind: "sandbox", jobId }`, and the conversation's interactive surface shows a step "Working in a sandbox: <title>".
3. With `wait: false`, the bot keeps going and can check later with `sandbox_status`.

Approval: `sandbox_start` is an approval-gated tool by default (policy `approve`), because a sandbox costs money and, from the git phase on, can push. The bot's settings can relax that.

`sandbox-jobs:dispatch` (clock, 10 s) claims pending jobs per project with `FOR UPDATE SKIP LOCKED` up to the project's concurrency limit, moves them to `provisioning`, and enqueues `sandbox-job:start` on the `sandboxes` queue.

`sandbox-job:start` is task-only with `timeout = 0`. It runs ToolExec's order (create wide → install → narrow → prologue → launch), re-reading `cancelRequested` between steps:

1. `generateJobToken` — 32 random bytes. Redis `oauth:token:<token>` maps to `{ userId: bot.serviceUserId, clientId: "hypotenuse-job:<id>", scopes: ["mcp"] }`, and `sandbox_jobs.tokenHash` holds the hash.
2. `provisionSandbox` — the ledger row first, then `provider.create` with labels `{ hypotenuse.managed: "true", job: <id>, project: <id> }`.
3. `writeFiles`:
   - `/work/.hypotenuse/prompt.md` — the task plus a briefing (see §2).
   - `/work/.hypotenuse/mcp.json`:
     - server `hypotenuse` at `${apiUrl}/mcp`;
     - each allowed shared MCP server at `${apiUrl}/proxy/mcp/<serverId>`;
     - all with `Authorization: Bearer ${HYPOTENUSE_JOB_TOKEN}`.
   - Claude settings: `permissionMode: bypassPermissions`, which is why the image runs as non-root.
   - The supervisor files.
4. Environment:
   - `HYPOTENUSE_JOB_TOKEN`
   - `HYPOTENUSE_API_URL`
   - `ANTHROPIC_BASE_URL=${apiUrl}/proxy/model/anthropic`
   - `ANTHROPIC_AUTH_TOKEN=${HYPOTENUSE_JOB_TOKEN}`
   - `HYPOTENUSE_COMMAND`, `HYPOTENUSE_RESUME_COMMAND`, `HYPOTENUSE_INTERACTIVE`
5. Spawn `bun /work/.hypotenuse/runner.ts` and move the job to `running`.

Any failure goes through `finalizeSandboxJob` with the reason.

### 2. The briefing

The sandbox agent is a different model run with none of the conversation's context, so the bot writes the task. Before the task, the server prepends a fixed briefing:

- who asked;
- where (platform, channel name);
- what the bot already knows (the bot's own `task` text);
- which tools exist and when to use them;
- "Ask with `sandbox-ask` rather than guessing when a decision is the requester's";
- "Report progress with `sandbox-report-status` at each milestone";
- "Put your result in `sandbox-submit-artifact` named `result`".

The briefing is rendered from a template in `backend/sandbox/briefing.md` and recorded on the job, so what the agent saw is inspectable.

### 3. The supervisor protocol

Ported from ToolExec, renamed:

| Endpoint | Action | Purpose |
|---|---|---|
| `PUT /api/sandbox/events` | `sandbox:events` | Batched parsed CLI JSONL (about 200 events, 2 s, or 256 KB), appended to `sandbox_job_events`. Bumps `lastActivityAt` |
| `POST /api/sandbox/heartbeat` | `sandbox:heartbeat` | Every 30 s (10 s during an interactive turn). The answer is the **only** server → sandbox control: `{ cancelRequested, followUp?, steer? }` |
| `POST /api/sandbox/complete` | `sandbox:complete` | Exit code, closing text, usage. An interactive job parks in `awaiting_input`; otherwise the job ends. Idempotent (`alreadyFinal`) |

Token in the body (`secret(z.string())`), because Keryx actions cannot read headers. Rate limited per job (300/min), not per IP: many sandboxes share a NAT.

### 4. What reaches the conversation

`backend/ops/SandboxRelayOps.ts` maps job activity onto the parent conversation's interactive surface ([the channel framework](./phase-13-channel-framework.md)). Each relay is also a `conversation_entries` row, so the bot sees it when it wakes:

| In the sandbox | Conversation entry | Interactive surface | Wakes the parent? |
|---|---|---|---|
| `sandbox-report-status { state, message }` | `status_change` | Step update ("Running tests…") | no |
| `sandbox-ask { question, options?, blocking }` | `message` (from the job) | `question` in the thread/session/issue, attributed "from the sandbox working on <title>" | yes if `blocking`: the bot can answer from what it knows or pass it on |
| `sandbox-request-help { question, urgency }` | `message` | `escalation` → `help_requests` + notifications | no (the answer goes back to the job) |
| `sandbox-submit-artifact { name, content }` | `tool_result` | none until completion | no |
| `sandbox:complete` (ended) | `tool_result` with the closing text and artifacts | Step complete | **yes** |
| any failure or reap | `tool_result` with the reason | Step failed | **yes** |

**Answers flow back by polling, as in ToolExec.** `sandbox-ask` returns a `questionId` at once. `sandbox-check-answer { questionId, waitMs }` collects the answer, which may come from a person in the channel or from the bot answering on their behalf through `sandbox_message`. A wait that runs out answers `pending` with `timedOut: true`, never an error. Every ask and check bumps `lastActivityAt`, so the stall sweep never reaps a job for waiting on a person. Each job has a cap of 5 questions, re-checked under `FOR UPDATE` on the job row.

### 5. The bot's side while a job runs

- **Hibernation.** The parent conversation is `waiting`, which costs nothing. A new inbound message in the thread wakes it as usual, and the bot may call `sandbox_status` or `sandbox_message` (a follow-up or steer) without waiting for the job.
- **Completion.** The bot's next tick hydrates the job result as a `tool_result` for the original `sandbox_start` call. It then writes the answer in its own voice: what changed, and where.
- **Stop.** A person's Stop in the channel cancels the conversation's live jobs (`cancelRequested`). The supervisor SIGTERMs the CLI on the next heartbeat, and exit 143 is `cancelled`, not `failed`.

### 6. Interactive jobs

With `interactive: true`, the job parks in `awaiting_input` after each turn instead of ending, and `sandbox_message` delivers the next instruction through the heartbeat. Claude Code is resumed by its own session id (`HYPOTENUSE_RESUME_COMMAND` with `__HYPOTENUSE_SESSION_ID__` and `__HYPOTENUSE_FOLLOW_UP__`), as in ToolExec. An idle interactive job (`idleTimeoutMs`, 30 minutes) ends `expired`. Expired means "nobody came back", not a failure.

### 7. Liveness and the reaper

`sandbox-jobs:reap` (clock) has six sweeps, each recording which fired:

- **dead supervisor:** `lastHeartbeatAt` stale;
- **stalled agent:** `lastActivityAt` stale;
- **stuck provisioning;**
- **over duration:** `maxDurationMs`;
- **cancel not acknowledged;**
- **idle interactive.**

`sandbox:orphan-sweep` destroys provider sandboxes with no live ledger row, and ledger rows with no live job.

### 8. Cost

The model proxy tees usage (ToolExec's `UsageAccumulator`: maximum, never sum) onto the job. Job spend is charged to the parent conversation's bot. The bot's per-job budget is checked before each forwarded request: over the cap is 402 plus a cancel. [Telemetry and cost](./phase-22-telemetry-and-cost.md) turns this into `cost_records`.

## Schema sketch

```ts
sandbox_jobs: {
  id serial, projectId, botId, parentConversationId, triggeredByParticipantId?,
  title text, task text, briefing text, repository jsonb?,        // repository used by the git phase
  interactive boolean, status: pending|provisioning|running|awaiting_input|
    succeeded|failed|cancelled|timed_out|expired,
  reportedStatus text?, statusMessage text?, closingText text?, artifacts jsonb,
  cancelRequested boolean, tokenHash text?, cliSessionId text?,
  lastHeartbeatAt, lastActivityAt, startedAt, endedAt (timestamptz),
  error text?, costUsd numeric, usage jsonb, maxDurationMs, budgetUsd?
}
sandbox_job_events: { id serial, jobId, seq int, kind, payload jsonb, createdAt } // unique (jobId, seq)
sandbox_job_messages: { id serial, jobId, source: bot|participant|system, delivery: queue|steer,
  body text, deliveryKey text unique, deliveredAt? }
sandbox_job_questions: { id serial, jobId, question, options jsonb?, blocking, status: pending|answered|expired|cancelled,
  answer text?, answeredBy jsonb?, expiresAt }
sandboxes: (ToolExec's ledger) id, projectId, jobId?, provider, externalId?, status, labels, createdAt, destroyedAt
```

Indexes:

- `sandbox_jobs (status, projectId, createdAt)`
- `sandbox_jobs (parentConversationId)`
- `sandboxes (status, createdAt)`
- `sandboxes (externalId)`
- `sandboxes (jobId) WHERE jobId IS NOT NULL`

## Actions and policy sketch

| Action | Route | RBAC | MCP | Audited |
|---|---|---|---|---|
| `sandbox-job:list` | `GET /project/:projectId/sandbox-jobs` (paginated) | member, filtered by `canReadBot` | yes | no |
| `sandbox-job:view` | `GET /sandbox-job/:id` | member + `canReadBot` | yes | no |
| `sandbox-job:events` | `GET /sandbox-job/:id/events` | member + `canReadBot` | yes | no |
| `sandbox-job:cancel` | `POST /sandbox-job/:id/cancel` | member + `canWriteBot` | yes | yes |
| `sandbox-job:answer` | `POST /sandbox-job/:id/question/:qid` | member + `canWriteBot` | yes | yes |
| `sandbox-job:start` | task-only | — | never | no (machine) |
| `sandbox-jobs:dispatch`, `sandbox-jobs:reap`, `sandbox:orphan-sweep` | task-only clocks | — | never | no (clocks) |
| `sandbox:events`, `sandbox:heartbeat`, `sandbox:complete` | `PUT/POST /sandbox/*` | job token | **never** | no (the daemon half) |
| `sandbox:report-status`, `sandbox:ask`, `sandbox:check-answer`, `sandbox:request-help`, `sandbox:submit-artifact`, `sandbox:memory-search` | `/sandbox/job/*` + MCP | job token | **sandbox-only** MCP | no |
| `proxy:model`, `proxy:mcp` | `/proxy/model/:provider/*`, `/proxy/mcp/:serverId/*` | job token | never | no (recorded per job) |
| `project:settings-edit` (sandbox provider, concurrency) | existing | admin | yes | yes |

`SANDBOX_ONLY_ACTION_NAMES` is a closed list in `ops/McpToolPolicyOps.ts`. A `beforeAct` hook refuses them to every other principal, and refuses everything else to a job token. `rbac.test.ts` asserts both directions by name.

## Frontend and user docs

- **Project settings → Sandboxes:** provider (`docker` shown as development-only), concurrency, default limits.
- **Conversation transcript:** a sandbox job renders as a collapsible block with status, questions, and artifacts. The full job transcript has its own page.
- **Jobs list** (project): status filters, cost.
- `frontend/src/content/docs/sandboxes.md`: what runs where, what a sandbox can and cannot reach, how questions arrive, how to stop one.

## Steps

### 1. Interface, registry, Docker — `backend/sandbox/{types,registry}.ts`, `backend/sandbox/providers/docker.ts`

### 2. Image — `backend/sandbox/images/{Dockerfile.dev,VERSION,verify-image.sh,stub-claude.sh}`

`stub-claude.sh` is the scripted CLI for tests: it plays a JSONL scenario and calls our MCP tools.

### 3. Ledger and jobs — `backend/schema/{sandboxes,sandbox_jobs,sandbox_job_events,sandbox_job_messages,sandbox_job_questions}.ts`, `backend/ops/{SandboxOps,SandboxJobOps,SandboxRelayOps}.ts`

### 4. Provisioning — `backend/ops/SandboxProvisionOps.ts`, `backend/sandbox/briefing.md`

### 5. Supervisor — `backend/sandbox/runner/*`

### 6. Token, proxies, MCP policy — `backend/middleware/{jobToken,jobTokenRateLimit}.ts`, `backend/actions/proxy/{proxy-model,proxy-mcp}.ts`, `backend/ops/McpToolPolicyOps.ts`

### 7. Actions — `backend/actions/sandbox/*.ts`, `backend/actions/sandbox-job/*.ts`

### 8. Bot tools — `backend/tools/sandbox/{sandbox-start,sandbox-message,sandbox-status,sandbox-cancel}.ts`

### 9. Frontend, CLI, docs — `frontend/src/pages/sandbox/*`, `cli/src/commands/sandbox.ts`, `frontend/src/content/docs/sandboxes.md`

## Test plan

- **Lifecycle** (`sandbox-lifecycle.test.ts`, real Docker, CI's E2E job): a conversation → `sandbox_start` → provisioning → the stub CLI reports status, asks a question, submits a `result` → `sandbox:complete` → the parent wakes with the result → the channel fake shows step, question, and answer. The ledger is empty and `docker ps` shows nothing afterwards.
- **No secrets:** enumerate the container's environment and `/work` and assert only the job token is credential-shaped. The model proxy and gateway proxy see the real keys; the sandbox never does.
- **Scope:**
  - a job token calling another conversation's tools gets 403;
  - a human session calling `sandbox:*` gets 403;
  - a job token calling a non-sandbox action gets 403.
- **Questions:** blocking ask → the parent wakes and answers via `sandbox_message`; a person answers in the channel; a timed-out check is `pending` + `timedOut`; the 5-question cap holds under 20 concurrent asks.
- **Reaper:** each sweep independently. A fresh heartbeat with stale activity is still reaped. A job waiting on a question is not.
- **Cancel:** Stop in the channel → SIGTERM → `cancelled` (exit 143), and the parent wakes.
- **Restart:** kill the worker mid-job. The job continues (the supervisor pushes to whichever web node answers), and the parent still wakes.
- **Production guard:** `docker` is refused under `NODE_ENV=production` at both guards.
- **Budget:** a job over its cap gets 402 from the proxy, then is cancelled.

## Verification

```bash
cd backend && bun test __tests__/sandbox
cd backend && bun test __tests__/e2e/sandbox-from-slack.test.ts
bun run lint
```

By hand: ask a bot in a Slack test channel to "run the tests in a scratch sandbox"; watch the step, the question, and the answer.

## Definition of done

- [ ] ToolExec's provider interface, registry, Docker provider, and ledger are ported with their tests
- [ ] A bot starts a sandbox job by tool, parks its conversation, and wakes on completion or failure
- [ ] The supervisor protocol (`sandbox:events`/`heartbeat`/`complete`) and the job token work end to end
- [ ] Inside the sandbox: Hypotenuse's sandbox-only tools plus the bot's allowed shared MCP servers via the gateway proxy; models via the model proxy
- [ ] Status, questions, and help from the sandbox reach the originating conversation's interactive surface
- [ ] The only credential in a sandbox is its job token, proven by test
- [ ] Every reaper sweep and the orphan sweep are tested
- [ ] Settings, job views, CLI, and `sandboxes.md` ship in the same PR

## Open questions

- **A service identity per bot.** Job tokens need a `userId` for Keryx's OAuth record. ToolExec used the triggering user. Here, the trigger is often an external participant. Proposed: each bot has a service user (no login) whose tags are the bot's grants. Confirm with the [bots phase](./phase-07-model-providers-and-bots.md).
- **Default approval for `sandbox_start`.** `approve` is safe but slows every coding request. Should read-only jobs (no repository write) default to `allow`?
- **Concurrency defaults** per project and per bot: 3 and 1?

## Learnings from the build

Not built yet.
