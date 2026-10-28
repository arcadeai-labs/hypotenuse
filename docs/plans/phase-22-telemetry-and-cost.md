# Phase 22 — Telemetry and cost

> **Goal:** Two outcomes. First, a project admin points Hypotenuse at one or more OpenTelemetry collectors, and every tick of every conversation then arrives there as one OTLP trace, covering ingress, the model call, each tool call, memory, MCP, code mode, sandbox jobs, and delivery, at the content level that exporter allows. Second, every dollar a bot spends is recorded against the bot, conversation, channel, platform, and person who caused it, and a bot or project over its budget stops before it spends more.

> **Status: planned, not built.** Builds on the [durable agent loop](./phase-08-durable-agent-loop.md) (ticks, which already record usage), [sandboxes](./phase-17-sandboxes.md) (the model proxy's per-job usage), and [model providers and bots](./phase-07-model-providers-and-bots.md) (models, budgets). v1 built both halves for a different topology; this phase ports them.

v1 learned to export telemetry without an OpenTelemetry SDK:

- spans are written when they end, from what Postgres already knows;
- they are held as OTLP/JSON;
- they are queued per project in a Redis stream;
- they are exported per collector through a consumer group, with sealed headers and content levels.

That machinery moves over almost unchanged. What changes is the trace root. In v1 it was a work item routed to a runner; here it is a **tick**.

Cost is simpler than in v1 in one way and harder in another. Simpler, because the server now makes the model calls itself: AI SDK reports exact `usage` per call, so there is no cumulative-cost reverse engineering. Harder, because the server now pays. It must price tokens, and it must stop spending at a limit. v1 never priced tokens; 2.0 must.

## Scope

**In:**

- **Telemetry export** (port from v1):
  - `telemetry_exporters` per project (endpoint, protocol `http/json|http/protobuf`, sealed headers, content level `metadata|content|full`, enabled).
  - Per-project Redis stream `telemetry:stream:<projectId>` with one consumer group per exporter.
  - `telemetry:export` clock, backoff per exporter (`telemetry:backoff:<id>`), and `postToEndpoint` (DNS-rebinding-safe egress, `EndpointSafetyOps`).
  - `telemetry-exporter:test`.
  - An OTLP collector test fixture.
- **One trace per tick.** `conversation_entries` gains the tick's `traceparent`. Spans:
  - `agent.tick` (root)
  - `model.call` (with `gen_ai.*` attributes: system, model, tokens, finish reason)
  - `tool.<name>`
  - `memory.search` / `memory.write`
  - `mcp.call` (server and tool)
  - `code_mode.run` with child `host.call`s
  - `sandbox.job` (linked, not parented: a job outlives the tick that started it)
  - `outbox.deliver`
  - `webhook.ingress`, linked from the tick it woke

  A conversation is a span link chain across ticks. Free text goes under `hypotenuse.content.*` attributes, filtered per exporter level.
- **Sandbox telemetry.** The job's coding CLI emits native OTLP (Claude Code's `CLAUDE_CODE_ENABLE_TELEMETRY` + `OTEL_*`) to a relay action `sandbox:telemetry` (job token, gzipped OTLP/JSON or protobuf). The relay re-stamps project, bot, and job and drops records naming another trace. Content is tagged with the level the job collected at.
- **Cost records.** One `cost_records` row per model call and per sandbox job, copied attribution and no foreign keys (v1's deadlock lesson):
  - who: project, bot, conversation, channel, platform, participant (external person), triggering user (if any);
  - what: model, provider, input/output/cache tokens, `costUsd`, `priced: boolean`.
- **Pricing.** A per-model price table:
  - seeded from a public catalog at boot (ToolExec reads OpenRouter's catalog);
  - overridable per project for negotiated rates;
  - an unpriced model costs zero, is flagged `priced: false`, and is reported on the bot page.

  Prices are **estimates**, and the UI says so.
- **Budgets** per bot and per project, daily and monthly:
  - checked **before every model call** at the tick, and by the model proxy before every sandbox request;
  - re-checked **after** each spend is recorded, because concurrent calls all read the same total;
  - reaching a cap stops new spend: the conversation goes to `waiting` with a budget reason, posts one notice in the channel ("I've reached my spending limit for today"), and notifies admins;
  - a person may raise the cap (audited) to resume.
- `cost:list`, `cost:summary` (by bot, channel, platform, participant, model, day), the CLI `cost summary --by …`, and a cost section on the bot page and project home.

**Out:**

- Billing customers or invoicing. Cost here is attribution and limits.
- Metrics dashboards inside Hypotenuse. Collectors are where analysis happens; we show sums.
- Per-tenant sampling policies beyond "an exporter exists and is enabled".

## What already exists

| Piece | Where | Carry |
|---|---|---|
| Exporters, relay, stream, content levels, collector fixture | v1 [`docs/plans/phase-18-opentelemetry-export.md`](https://github.com/arcadeai-labs/hypotenuse/blob/v1/docs/plans/phase-18-opentelemetry-export.md); `backend/ops/{TelemetryExporterOps,TelemetryOps,TelemetryRelayOps,EndpointSafetyOps}.ts`, `backend/lua/telemetry-byte-bucket.lua`, `protocol/src/otlp.ts`, `backend/__tests__/fixtures/otlp-collector.ts` | Port; re-key from work items to ticks and jobs |
| Cost ledger shape (one row per claim, copied attribution, ids not FKs, `unpricedTurns`) | v1 [`docs/plans/phase-21-cost-attribution.md`](https://github.com/arcadeai-labs/hypotenuse/blob/v1/docs/plans/phase-21-cost-attribution.md); `backend/ops/CostOps.ts`, `schema/cost_records.ts`, `actions/cost/*` | Port; rows per model call and per job |
| Price catalog, usage tee, budget check before and after | [`toolexec: backend/ops/ModelPriceOps.ts`](https://github.com/arcadeai-labs/toolexec/blob/main/backend/ops/ModelPriceOps.ts), [`ops/EgressOps.ts`](https://github.com/arcadeai-labs/toolexec/blob/main/backend/ops/EgressOps.ts) (`isOverBudget`, `projectedSpend`) | Port |
| Keryx hooks | `beforeAct` / `afterAct`, resque `beforeJob` / `afterJob` | Span per traced action and task |

## What this must not weaken

1. **Nothing a turn does waits on telemetry.** Emission is a Redis `XADD` after commit; export is a clock. A dead collector slows nothing.
2. **Collector credentials never leave the server.** Headers are sealed; only header names are serialized.
3. **Server telemetry is emitted only for a project with an enabled exporter** (cached per process, as v1's `projectTelemetry`).
4. **Content levels are enforced per exporter, at export.** A `metadata` exporter never receives `hypotenuse.content.*` attributes or content-level records.
5. **Every model call leaves a cost record**, including calls in ticks that fail, are cancelled, or are reaped. The record is written in the same transaction as the entry that used the result, or by the funnel that ends the tick.
6. **A budget stop is not a failure.** It is a `waiting` state with a reason a person can clear, and the conversation is intact.

## Design

### Trace shape

```
agent.tick (conversation 812, tick 14)  ── link → agent.tick 13
├─ model.call  claude-…  in=12k out=900 cache_read=10k  $0.021
├─ tool.memory_search  scope=channel  hits=5
├─ tool.mcp_exec  server=linear tool=search_issues
├─ tool.run_code  ├─ host.call mcp.exec  ├─ host.call memory.write
├─ tool.sandbox_start ── link → sandbox.job 55 ─ (native Claude Code spans, relayed)
└─ outbox.deliver slack chat.appendStream ×3
```

### Cost flow

| Source | Usage from | Recorded when |
|---|---|---|
| Tick model call | AI SDK `usage` on the step result | With the `conversation_entries` row for the step |
| Fast-model calls (guards, titles, risk checks, compaction) | AI SDK `usage` | Same, under the conversation that caused them, `kind: auxiliary` |
| Embeddings | AI SDK `embed` usage | With the memory write or search; `kind: embedding` |
| Sandbox job | The model proxy's tee (maximum, never sum) | At `finalizeSandboxJob`, plus running totals on the job |

### Budget check

`BudgetOps.check(botId)` reads today's and this month's sums from a Redis counter. The counter is kept in step with `cost_records` inserts and rebuilt from Postgres on miss. The check refuses when either cap is reached. The tick calls it before each model step. The model proxy calls it before forwarding. After each insert, the counter is re-read, and a crossing stops further steps immediately.

## Schema sketch

```ts
telemetry_exporters: { id serial, projectId, name, endpoint, protocol, level, headers jsonb /* sealed */,
  headerNames text[], enabled, lastExportAt?, lastError?, createdAt, updatedAt }
cost_records: { id serial, projectId, botId, conversationId?, channelId?, sandboxJobId?, platform?,
  participantId?, userId?, botName, channelName?, participantName?,     // copied for reading, ids not FKs
  kind: tick|auxiliary|embedding|sandbox, provider, model, inputTokens, outputTokens,
  cacheReadTokens, cacheWriteTokens, costUsd numeric, priced boolean, traceId?, createdAt }
model_prices: { id serial, projectId? /* null = catalog */, provider, model, inputPerMTok, outputPerMTok,
  cacheReadPerMTok?, cacheWritePerMTok?, source: catalog|override, updatedAt }
bots: + budget { dailyUsd?, monthlyUsd? };  projects (settings): + budget { dailyUsd?, monthlyUsd? }
conversation_entries: + traceparent
```

Indexes:

- `cost_records (projectId, createdAt)`
- `cost_records (botId, createdAt)`
- `cost_records (conversationId)`

## Actions and policy sketch

| Action | Route | RBAC | MCP | Audited |
|---|---|---|---|---|
| `telemetry-exporter:create` / `edit` / `delete` | `PUT/POST/DELETE /telemetry-exporter` | admin | yes | yes |
| `telemetry-exporter:list` / `view` | `GET /telemetry-exporters`, `/telemetry-exporter/:id` | member | yes | no |
| `telemetry-exporter:test` | `POST /telemetry-exporter/:id/test` | admin | yes | no |
| `telemetry:export` | task-only clock | — | never | no |
| `sandbox:telemetry` | `PUT /sandbox/telemetry` (rawBody) | job token | never | no |
| `cost:list` | `GET /project/:projectId/costs` (paginated) | member, filtered by `canReadBot` | yes | no |
| `cost:summary` | `GET /project/:projectId/costs/summary?by=` | member, filtered | yes | no |
| `model-price:list` | `GET /project/:projectId/model-prices` (paginated) | member | yes | no |
| `model-price:set` / `delete` | `PUT/DELETE /project/:projectId/model-price` | admin | yes | yes |
| `bot:budget-edit`, `project:budget-edit` | `POST /bot/:botId/budget`, `POST /project/:projectId/budget` | admin | yes | yes |

Exporter `headers` stay in `SENSITIVE_KEYS`.

## Frontend and user docs

- **Settings → Telemetry** (exporters, levels, a test button, last export or error).
- **Bot page → Cost** (today and this month against budget, top conversations, an unpriced-model warning).
- **Project home** spend tile.
- **Settings → Model prices.**
- `frontend/src/content/docs/telemetry.md`: the trace shape, levels, collector setup.
- `frontend/src/content/docs/cost.md`: how cost is computed, why it is an estimate, budgets and what happens at a cap.

## Steps

### 1. Port telemetry — `backend/ops/{TelemetryExporterOps,TelemetryOps,TelemetryRelayOps,EndpointSafetyOps}.ts`, `backend/initializers/telemetry.ts`, `backend/lua/telemetry-byte-bucket.lua`, `backend/ops/otlp.ts`

### 2. Tick spans — `backend/ops/AgentTickOps.ts` (span helpers), `backend/ops/TraceScopeOps.ts` (`withTraceScope`)

### 3. Sandbox relay — `backend/actions/sandbox/sandbox-telemetry.ts`, provisioning env for native OTLP

### 4. Cost — `backend/schema/{cost_records,model_prices}.ts`, `backend/ops/{CostOps,ModelPriceOps,BudgetOps}.ts`

### 5. Actions — `backend/actions/{telemetry,cost,model-price}/*.ts`

### 6. Frontend, CLI, docs — `frontend/src/pages/settings/{Telemetry,ModelPrices}.tsx`, `frontend/src/pages/bots/BotCostTab.tsx`, `cli/src/commands/{telemetry,cost}.ts`, `frontend/src/content/docs/{telemetry,cost}.md`

## Test plan

- **Trace:** a scripted tick with a model call, two tools, code mode, and a sandbox start produces exactly the span tree above at the collector fixture, with links across ticks.
- **Levels:**
  - a `metadata` exporter receives no `hypotenuse.content.*` attributes and no content-level records (whole-set assertion over the received payloads);
  - a `full` exporter receives everything;
  - the sandbox's native records reach only exporters at or above the job's level.
- **Collector failure:** a `503` backs off one exporter while another keeps draining. Delete `telemetry:backoff:<id>` to move its clock.
- **Rebinding:** an endpoint resolving to a private address is refused at send.
- **Cost:**
  - every model call in a tick that is cancelled midway still has its record;
  - sums by every `by=` dimension match a hand-computed fixture;
  - an unpriced model records `priced: false` and zero cost.
- **Budgets:**
  - a bot at its daily cap stops before the next model call, posts one notice, and waits; raising the cap resumes it;
  - five concurrent ticks against a nearly spent budget overshoot by at most one step each, then all stop;
  - the model proxy refuses a sandbox request over budget with 402 and cancels the job.

## Verification

```bash
cd backend && bun test __tests__/telemetry __tests__/cost
bun run lint
```

## Definition of done

- [ ] Exporters ported; one trace per tick with model, tool, memory, MCP, code-mode, sandbox, and delivery spans
- [ ] Sandbox jobs' native telemetry is relayed with the job token and filtered per exporter level
- [ ] Every model call, auxiliary call, embedding, and sandbox job leaves a cost record with copied attribution
- [ ] Prices come from a catalog with project overrides; unpriced models are flagged
- [ ] Bot and project budgets stop spend at the tick and at the model proxy, and resume when raised
- [ ] Telemetry and cost settings, bot cost tab, CLI, and both user docs ship in the same PR

## Open questions

- **Price catalog source.** OpenRouter's public catalog (as ToolExec does), or the providers' own published prices, vendored and reviewed?
- **What a budget stop says in the channel,** and whether customers (Pylon) ever see it. Proposed: Pylon gets an internal note only.
- **Cost for platform API calls** (Slack, Linear, Pylon) is zero to us. Is it worth recording request counts per bot for rate-limit diagnosis?

## Learnings from the build

Not built yet.
