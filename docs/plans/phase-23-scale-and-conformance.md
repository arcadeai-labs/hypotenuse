# Phase 23 — Scale and conformance

> **Goal:** Hypotenuse holds up when many teams use it at once. Thousands of conversations across hundreds of bots tick concurrently on a pool of workers. No tenant can starve another or exceed its quotas, and no platform rate limit takes a bot down. A single end-to-end suite proves the whole product works across every boundary at once: a Slack thread asks for a fix; a sandbox opens a PR; the PR lands on the Linear session; a review wakes the bot; Pylon is told. A security checklist is enforced by tests rather than remembered.

> **Status: planned, not built.** Builds on every earlier phase. Nothing here adds a user-facing feature. It measures, bounds, and proves what is already there, and it fixes whatever the measuring finds.

Each earlier phase is tested against its own boundary: a real server, real Postgres and Redis, finear or a platform fake, and a scripted model. That proves each piece is correct alone. It does not prove that 2,000 hibernating conversations wake without a thundering herd, that one noisy Slack workspace cannot fill the `agents` queue ahead of everyone else, or that the pieces compose. v1's conformance phase ([`v1 phase-17`](https://github.com/arcadeai-labs/hypotenuse/blob/v1/docs/plans/phase-17-conformance-and-e2e.md)) drove every interaction across three processes and judged it where the person would. This phase is that, for 2.0, plus load.

## Scope

**In:**

- **Load harness.** `backend/__tests__/load/`, run on demand and nightly (outside the CI gate). It boots N workers (separate processes, real Resque) against one Postgres and Redis, then drives:
  - thousands of conversations through the API channel and the platform fakes;
  - the scripted model with realistic latencies (p50 2 s, p99 30 s) and token counts.

  Recorded:
  - tick latency from inbox to first outbound, p50/p95/p99;
  - queue depth and age per queue;
  - lease contention and Postgres lock waits;
  - Redis memory;
  - outbox lag per platform.

  Results land in `docs/SCALE.md` with the machine sizes used.
- **Per-tenant fairness.** Ticks are claimed fairly across projects, not FIFO across the deployment:
  - a per-project in-flight cap (`project_settings.maxConcurrentTicks`);
  - a claim order that round-robins projects (a Lua script over per-project ready sets, `backend/lua/fair-claim.lua`);
  - the `agents` queue as a work signal only, with the database row as the claim (the lease).

  One project with 10,000 ready conversations delays another project's single conversation by at most one claim cycle.
- **Quotas** per project and per bot, enforced at the point of cost:
  - conversations started per hour;
  - ticks per conversation per hour (a loop breaker);
  - sandbox jobs concurrent and per day;
  - memory documents and bytes;
  - MCP calls per tick.

  Each refusal is a sentence a model or person can act on, and each is surfaced on the dashboard.
- **Platform rate limits under load.** Per-installation buckets for Slack, Linear, and Pylon (from their phases), verified at volume: no 429 left unhandled; acknowledgements (Linear's 10 s thought, Slack's status) keep their reserved share.
- **Ingress under load.** `webhooks:*` stays under each platform's deadline (Slack 3 s, Linear 5 s) at 50× normal volume, measured with a real worker.
- **Wake storms.** Waking 5,000 hibernating conversations at once (a schedule slot, or a Slack outage recovering) is spread by the fair claim, never by sleeping.
- **Retention.** A per-project retention setting for ended conversations' entries, outbox rows, `trigger_events`, and sandbox job events, run by a `retention:sweep` clock in bounded batches. Memory is excluded; it has its own decay.
- **Cross-platform end-to-end conformance.** `backend/__tests__/e2e/` boots the server, finear, the Slack fake, the Pylon fake, the GitHub fake, and real Docker sandboxes, with a pump in place of the worker queues (v1's `useE2E()` shape). Scenarios are judged by what each platform holds:
  1. **Slack → sandbox → PR → Linear.** A Slack thread asks bot B to fix a bug tracked in Linear issue L. B starts a sandbox job, which opens a PR in the GitHub fake. The PR link appears in the thread, and on L's Linear session as "Pull Request". A `changes_requested` review wakes the Slack conversation. B starts a follow-up job, which pushes. The thread is told.
  2. **Pylon → memory → Linear.** A Pylon issue from customer A is triaged into an internal note. B files a Linear issue through its Linear tools (approval-gated), and remembers the link in A's account memory. A later Pylon issue from A retrieves it; one from customer C does not.
  3. **Approval across platforms.** A `pylon_reply_to_customer` approval decided by a button in Slack (through `escalate_to_human` to a linked admin) sends exactly the drafted text.
  4. **Disengagement everywhere.** Stop in Slack, un-delegate in Linear, and close in Pylon each silence their conversation and cancel the sandbox.
  5. **Code mode with a gated call.** The program interrupts before the side effect, the approval is decided, and the program resumes deterministically.
  6. **Budget stop.** Mid-conversation, a bot hits its daily cap, stops with one notice, and resumes when raised.
  7. **Crash recovery.** Kill a worker mid-tick, after the tool-call intent and before the result. The non-`replay: safe` tool is reported as interrupted to the model and is not run twice.
- **Security checklist test.** `backend/__tests__/security/checklist.test.ts` enforces each item in `docs/SECURITY.md`:
  - no action response or serializer contains a credential field (whole-registry sweep with a fixture of every secret shape: `xoxb-`, `lin_`, `ghs_`, Pylon tokens, model keys);
  - every `webhooks:*` action is never MCP, has `rawBody`, and returns byte-identical refusals;
  - `SANDBOX_ONLY_ACTION_NAMES` and `NEVER_MCP_ACTION_NAMES` are closed sets asserted by name;
  - every write action extends `AuditedAction` unless it is on the closed unaudited list;
  - every outbound HTTP to a tenant-supplied URL goes through `EndpointSafetyOps`;
  - the sandbox environment holds only the job token;
  - memory retrieval never crosses a channel boundary it should not;
  - Slack Connect is refused.
- A real-agent nightly: the e2e scenario 1 against a real model and real Claude Code in Docker, skipped unless secrets are present, opening an issue on failure.

**Out:**

- Multi-region deployment and data residency (a separate decision).
- Autoscaling policy for Render. We document the measured capacity per worker; scaling is an operator setting.
- Chaos testing of Postgres or Redis failover.

## What already exists

| Piece | Where | Use |
|---|---|---|
| E2E harness with a pump, daemons, finear | v1 [`docs/plans/phase-17-conformance-and-e2e.md`](https://github.com/arcadeai-labs/hypotenuse/blob/v1/docs/plans/phase-17-conformance-and-e2e.md), `backend/__tests__/e2e/harness.ts` | Port the pump and teardown discipline; replace daemons with sandboxes and platform fakes |
| Security checklist test | v1 `backend/__tests__/security/checklist.test.ts` | Port the shape; new items |
| Per-project claim with `SKIP LOCKED` | ToolExec `runs:dispatch` | Basis for fair claim |
| Nightly outside the gate | v1 `.github/workflows/nightly-real-agent.yml` | Same pattern |
| Keryx fan-out | `api.actions.fanOut` | Waking batches |

## What this must not weaken

1. **Postgres is the source of truth.** Fairness and quotas may use Redis for speed, but a claim is a row change. A lost Redis key degrades fairness, never correctness.
2. **Tests control time by writing columns,** never by waiting. The load harness is the one place that measures wall-clock time, and it is outside the gate.
3. **No test launches a real coding agent or model in CI.** The real-agent test is nightly only.
4. **A quota refusal never loses work.** A refused tick stays ready and is retried after the window. A refused conversation start is answered on its platform.
5. **Assert the property, not the symptom:** whole-set comparisons, byte-identical refusals, exact platform-side sequences.

## Design

### Fair claim

Each project has a Redis sorted set `ready:<projectId>` (conversation ids scored by ready time), plus a set of projects with ready work. `agents:claim` (a clock, and also nudged after commit by every wake) runs `fair-claim.lua`. The script pops one id from each ready project in turn, up to the free worker capacity and each project's in-flight cap. It enqueues `agent:tick` with those ids. The tick still takes the Postgres lease (`FOR UPDATE SKIP LOCKED`), so a stale Redis entry is harmless. `agents:reap` rebuilds the ready sets from Postgres on a miss.

### Quotas

`QuotaOps.take(scope, key, n)` is a Redis token bucket (Lua) per quota, with limits from project and bot settings. A refusal maps to a `TypedError` with a recovery sentence for tools, and to a `waiting { kind: "timer" }` with a reason for ticks.

## Schema sketch

```ts
project_settings: + maxConcurrentTicks, + quotas jsonb { conversationsPerHour, ticksPerConversationPerHour,
  sandboxJobsConcurrent, sandboxJobsPerDay, memoryDocuments, memoryBytes, mcpCallsPerTick },
  + retention jsonb { entriesDays, outboxDays, triggerEventsDays, sandboxEventsDays }
bots: + quotas jsonb (overrides)
```

## Actions and policy sketch

| Action | Route | RBAC | MCP | Audited |
|---|---|---|---|---|
| `project:quotas-edit` | `POST /project/:projectId/quotas` | admin | yes | yes |
| `project:retention-edit` | `POST /project/:projectId/retention` | admin | yes | yes |
| `project:usage` | `GET /project/:projectId/usage` (quota consumption) | member | yes | no |
| `agents:claim` | task-only clock | — | never | no |
| `retention:sweep` | task-only clock | — | never | no |

## Frontend and user docs

- **Settings → Limits** (quotas and retention, with current consumption).
- **Dashboard:** quota refusals are visible on the conversation and project home.
- `frontend/src/content/docs/limits.md`.
- Operator-facing `docs/SCALE.md` (measured capacity) and `docs/SECURITY.md` (the checklist each test enforces).

## Steps

### 1. Fair claim — `backend/lua/fair-claim.lua`, `backend/ops/ClaimOps.ts`, `backend/actions/agents/agents-claim.ts`

### 2. Quotas — `backend/lua/quota-bucket.lua`, `backend/ops/QuotaOps.ts`

### 3. Retention — `backend/actions/retention/retention-sweep.ts`

### 4. Load harness — `backend/__tests__/load/*`, `.github/workflows/nightly-load.yml`

### 5. E2E — `backend/__tests__/e2e/{harness.ts,*.test.ts}`

### 6. Security — `docs/SECURITY.md`, `backend/__tests__/security/checklist.test.ts`

### 7. Frontend and docs — `frontend/src/pages/settings/Limits.tsx`, `frontend/src/content/docs/limits.md`, `docs/SCALE.md`

## Test plan

- **Fairness:** project A with 10,000 ready conversations and project B with 1. B's conversation is claimed within one cycle, with the clock moved by writing columns.
- **Caps:** a per-project in-flight cap holds under 8 workers.
- **Quotas:** each quota refuses at its limit with a recovery sentence, and the work resumes after the window.
- **Retention:** batches stay bounded (no long locks), and memory is untouched.
- **E2E:** scenarios 1–7 pass in CI's E2E job, and teardown fails a file that leaves a sandbox or process alive.
- **Security:** the checklist test passes, and each item has a deliberately broken fixture proving the test can fail.
- **Load (nightly):** thresholds recorded in `docs/SCALE.md`. A regression beyond 20% opens an issue.

## Verification

```bash
cd backend && bun test __tests__/e2e __tests__/security
cd backend && bun run load -- --conversations 5000 --workers 8   # outside the gate
```

## Definition of done

- [ ] Ticks are claimed fairly across projects with per-project in-flight caps
- [ ] Quotas and retention are enforced, configurable, and visible
- [ ] Ingress meets Slack's 3 s and Linear's 5 s deadlines at 50× load
- [ ] The seven cross-platform e2e scenarios pass in CI
- [ ] `docs/SECURITY.md` exists and every item is enforced by `checklist.test.ts`
- [ ] Measured capacity is recorded in `docs/SCALE.md`; nightly load and real-agent runs report regressions

## Open questions

- **Target scale.** What concurrent conversation count and worker count should the first deployment be sized for? This sets the load harness's pass thresholds.
- **Fair claim in Redis vs Postgres.** A pure-Postgres round-robin (`DISTINCT ON (projectId) … SKIP LOCKED`) is refused by Postgres (v1's finding). Confirm the Redis ready-set design holds at the measured scale before adding more machinery.

## Learnings from the build

Not built yet.
