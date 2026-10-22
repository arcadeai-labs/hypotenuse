# Phase 18 — OpenTelemetry export

> **Goal:** A project admin points Hypotenuse at one or more OpenTelemetry collectors, and from then on
> everything Hypotenuse can observe about that project's work arrives there as OTLP traces, metrics, and logs:
> the server's handling of each Linear session, every byte of the ACP conversation between the daemon and the
> coding agent, the daemon's own work on the machine, and the coding agent's **native** telemetry (model
> requests, token counts, cost), which today never reaches us at all. Collector credentials stay on the
> server, and a runner's owner can cap what leaves their machine.

> **Status: planned, not built.** It needs [work routing](./phase-09-work-routing.md) (the trace is rooted on
> a work item), the [ACP host](./phase-11-acp-agent-host.md) (the ACP stream), the
> [worktree lifecycle](./phase-12-worktrees-and-session-lifecycle.md) (git and setup commands),
> [Hypotenuse MCP](./phase-13-hypotenuse-mcp.md) (tool calls through the control socket), and the
> [dashboard](./phase-15-dashboard.md) (the settings page). It can land any time after those.

The daemon is the agent's ACP client, so it sees everything the agent *reports*: thoughts, messages, tool calls
and their results, plans, permission requests, and `fs/*` calls. It does not see the agent's model traffic, the
commands it runs in its own shell, or tools it loads from its own config, except where the agent reports them as
tool calls. Most of the agents we launch can emit their own OpenTelemetry, which covers exactly that gap.
Capturing "everything we can possibly see" therefore means three sources, joined into one trace:

| Source | Where it is observed | What it adds |
|---|---|---|
| Server | `hypotenuse-api`, `hypotenuse-worker` | webhooks, routing, offers and leases, the outbox, Linear GraphQL calls, `daemon:linear-*` |
| Daemon | `hypotenuse daemon` | every ACP frame, permission waits, `fs/*`, the agent process, worktrees, setup commands, the MCP broker |
| Agent native | the coding agent's own OTel exporter, captured by the daemon | model requests, token usage, cost, the agent's own tool decisions |

## Scope

**In:**

- `telemetry_exporters`: per-project OTLP destinations with encrypted headers, a content level, signals, and
  sampling. CRUD with `list`, audited, admin-only; `telemetry:test` sends a probe.
- A server-side relay: the daemon posts OTLP to `daemon:telemetry`, the worker exports it to each of the
  project's exporters. The daemon never learns an endpoint or a header.
- Server instrumentation, emitted only for projects that have an exporter.
- Daemon instrumentation over the ACP host, the worktree manager, and the MCP broker.
- A per-turn loopback OTLP receiver in the daemon, and per-preset environment that points each agent's native
  exporter at it.
- The runner owner's cap: `[telemetry]` in the daemon config.
- Redaction, SSRF protection on endpoints, volume limits, and drop accounting.
- The settings page, `hypotenuse telemetry exporter …` commands, and user docs.

**Out:**

- Hypotenuse's own operational telemetry: the deployment's health, not a project's work. That is a
  deploy-level concern with deploy-level config, and it should not share a pipeline that tenants configure.
- Storing telemetry. Hypotenuse relays; the collector stores. Nothing is written to Postgres beyond the
  exporter rows and counters.
- A runner exporting straight to its owner's own collector. That is a natural follow-up, and
  `[telemetry]` leaves room for it, but this plan only builds the project's path.
- OTLP over gRPC to exporters. OTLP/HTTP (protobuf or JSON) only, which every major vendor accepts.
- Traces *into* the agent's model provider: we capture what the agent exports, and we do not proxy its API
  traffic.

## Design

### 1. Where the credentials live, and why the server relays

| Option | Problem |
|---|---|
| Hand the daemon the exporter endpoint and headers in the claim | Vendor API keys on every laptop that serves the project, readable by the agent's process tree. It is the same argument as Linear tokens ([`ARCHITECTURE.md`](../ARCHITECTURE.md#trust-boundaries-and-credentials)), and a runner may serve several projects with different collectors |
| Runner owners configure their own collector | The project admin, who wants the data, has no say; every machine is configured by hand |
| **The daemon posts OTLP to the server, which exports it** | Volume through the server. Bounded below (§9) |

The relay wins. Exporter headers are stored with `CryptoOps` (AES-256-GCM, like Linear tokens), marked
`secret()` on input, added to `SENSITIVE_KEYS`, and no serializer has a field they fit in: `serializeTelemetryExporter`
returns `headerNames`, never values.

### 2. Per-project configuration

`telemetry_exporters` (a project may have several — a vendor and a self-hosted collector are a common pair):

| Column | Type | Notes |
|---|---|---|
| `id` | serial | |
| `project_id` | int → projects | indexed |
| `name` | text | unique per project |
| `enabled` | bool | |
| `endpoint` | text | OTLP/HTTP base URL; `/v1/traces`, `/v1/metrics`, `/v1/logs` are appended |
| `protocol` | text | `http/protobuf` (default) or `http/json` |
| `headers_ciphertext`, `headers_iv`, `headers_tag` | text | an encrypted JSON object |
| `signals` | text[] | any of `traces`, `metrics`, `logs` |
| `content` | text | `metadata`, `content`, or `full` (§5) |
| `agent_native` | bool | capture the coding agent's own telemetry (§7) |
| `trace_sample_ratio` | real | 0–1, applied per turn and per exporter (§9) |
| `resource_attributes` | jsonb | extra resource attributes, string values only |
| `last_export_at`, `last_error`, `last_error_at` | timestamptz / text | shown on the settings page |
| `created_at`, `updated_at` | timestamptz | |

Actions, all `ProjectMemberMiddleware()` + `AdminMiddleware()`, all published as MCP tools under the default
policy:

| Action | Route | Audited |
|---|---|---|
| `telemetry-exporter:create` | `PUT /project/:projectId/telemetry-exporter` | yes |
| `telemetry-exporter:view` | `GET /project/:projectId/telemetry-exporter/:id` | — |
| `telemetry-exporter:list` | `GET /project/:projectId/telemetry-exporters` | — (paginated, `defaultLimit: 25`) |
| `telemetry-exporter:edit` | `POST /project/:projectId/telemetry-exporter/:id` | yes; omitting `headers` keeps them, `headers: {}` clears them |
| `telemetry-exporter:delete` | `DELETE /project/:projectId/telemetry-exporter/:id` | yes |
| `telemetry-exporter:test` | `POST /project/:projectId/telemetry-exporter/:id/test` | — (sends a probe span, log, and metric, and answers with the collector's status per signal) |

Members can see that exporters exist (`telemetry-exporter:list` shows a member names and content levels) so
that a runner owner can see what their machine's work is exported at. Whether that is member- or admin-level
is decided at build time against how the settings page reads; the default above is admin for everything.

**Endpoint safety.** The worker POSTs to a URL a tenant chose, from inside Render's network. `endpoint` must be
`https`, and the host is resolved at create, edit, and every export; loopback, private, link-local, and
metadata addresses are refused (`CONNECTION_ACTION_PARAM_VALIDATION` at write time, a recorded `last_error` at
export time). `TELEMETRY_ALLOW_PRIVATE_ENDPOINTS=true` lifts this for development and tests.

### 3. The trace model

One **trace per turn** (work item). A session's turns are linked, not nested, so a long-lived session never
produces a trace that is open for days.

```
turn  (root, server)                          hypotenuse.work_item.id, hypotenuse.session.id, …
├── linear.webhook  AgentSessionEvent/created     (or /prompted)
├── routing.select                                rule matched, candidate runners, chosen runner
├── routing.offer → routing.claim                 wait time is the gap; re-offers are siblings
├── outbox.deliver  ×N                            each Linear activity, attempts, rate-limit waits
└── daemon.turn  (daemon, continues the trace)
    ├── worktree.prepare   git worktree add / reuse, setup commands (one child each, exit code)
    ├── agent.spawn        command, pid, preset, version from initialize
    ├── acp.initialize / acp.authenticate / acp.session.new | load
    ├── acp.prompt         the whole turn; stopReason on end
    │   ├── tool_call  ×N  toolCallId start → completed/failed; kind, title, locations
    │   │   └── permission.wait   policy, options, chosen option, wait duration
    │   ├── mcp.call  ×N   hypotenuse tool name → daemon:linear-* (server child span joins here)
    │   ├── fs.read / fs.write ×N
    │   └── elicitation.wait
    ├── agent.native …     the agent's own spans, re-parented here (§7)
    └── worktree.cleanup
```

The work item row carries a W3C `traceparent` written when the item is created. The server hands it to the daemon
in the claim; the daemon sends it back in the `traceparent` header on every `daemon:*` call for that turn, so
`daemon:events`, `daemon:linear-*`, and `daemon:complete` appear as children of the right daemon span.

Thoughts, message chunks, plans, usage, and mode updates are **span events** on `acp.prompt` at `metadata`
level, and log records at `content` and `full` (§5). Each tool call is a span, not an event, because it has a
duration and a result.

**Attributes.** OpenTelemetry's GenAI semantic conventions where one fits (`gen_ai.operation.name =
invoke_agent | execute_tool`, `gen_ai.agent.name`, `gen_ai.tool.name`, `gen_ai.tool.call.id`,
`gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`); our own under `hypotenuse.*` otherwise. Every
resource and root span carries:

`hypotenuse.project.id`, `hypotenuse.session.id`, `hypotenuse.work_item.id`, `hypotenuse.turn` (ordinal),
`hypotenuse.role`, `hypotenuse.runner.id`, `hypotenuse.runner.name`, `hypotenuse.agent.id`,
`hypotenuse.agent.preset`, `hypotenuse.repository`, `linear.issue.identifier`, `linear.agent_session.id`,
`linear.team.key`.

### 4. What each source emits

**Server** (only for projects with an enabled exporter; checked once per request from a cached lookup):

| Observed | Signal |
|---|---|
| webhook received: type, action, delivery id, signature valid, duplicate, enqueue latency | span + log |
| session lifecycle transitions | span events |
| routing: rules evaluated, the matching rule, candidates and why each was excluded, issuer preference, sticky hit | span attributes |
| offers, claims, lease renewals and expiry, re-offers | spans |
| outbox: per activity, type, ephemeral, attempts, token-bucket wait, Linear's response time and errors | spans; `hypotenuse.outbox.lag` histogram |
| Linear GraphQL: operation name, duration, status, complexity and rate-limit headers | spans (client kind); `hypotenuse.linear.requests` counter |
| `daemon:linear-*`: tool, target, scope decision, Linear writes | spans |
| runner presence: online, draining, offline; heartbeat gaps | logs; `hypotenuse.runners.online` gauge |
| signals: `stop`, `auth`, `select`, `continue`; disengagement | span events |
| audited decisions on the project (who connected Linear, edited a rule, revoked a runner, cancelled a session) | logs, from `audit_logs` after commit, already redacted |

**Daemon:**

| Observed | Signal |
|---|---|
| every ACP JSON-RPC frame, both directions | logs at `full` (§5) |
| `initialize`: agent name, version, capabilities, auth methods | span attributes |
| prompt assembly: sizes of role prompt, `promptContext`, guidance, replayed history | span attributes; the assembled prompt at `content` |
| each `session/update` kind | span events / tool spans per §3 |
| permission requests: tool, options, policy answer or the person's choice, wait | spans |
| `fs/*`: path (worktree-relative), bytes, refused outside the worktree | spans |
| `stopReason`, refusals, crashes, timeouts | span status + attributes |
| the agent process: pid, exit code, signal, peak RSS, CPU time; stderr lines | span + metrics; stderr as logs at `content` |
| worktree: branch, base commit, setup commands with duration and exit code, cleanup | spans; setup output at `content` |
| `hypotenuse mcp` calls through the broker: tool, args, result size, latency | spans; args and results at `content` |
| slots: capacity, in use, queue | `hypotenuse.runner.slots` gauge |
| `usage_update` | `gen_ai.client.token.usage` histogram |
| what was dropped (§9) | `hypotenuse.telemetry.dropped` counter |

**Agent native:** whatever the agent exports (§7), with our resource attributes stamped on.

### 5. Content levels

`metadata` is the default. "Everything we can possibly see" is `full`, and it is a choice an admin makes per
exporter, not the default, because it ships source code and prompts to a third party.

| Level | Includes |
|---|---|
| `metadata` | names, kinds, ids, timings, sizes, counts, statuses, exit codes, token usage, worktree-relative paths. No free text from the agent, the person, or the repository |
| `content` | adds thoughts, messages, the assembled prompt, Linear prompts, tool titles, inputs and results, diffs, command output, stderr, MCP arguments and results — each capped at 64 KB per attribute or log body, with the cap recorded |
| `full` | adds every ACP frame verbatim as a log record, and asks agents to log prompts and tool detail in their native telemetry (§7) |

The effective level for a turn is the **lowest** of the exporter's `content` and the runner's
`telemetry.max_content` (§8). With several exporters, the daemon collects at the highest level any of them needs
(after the runner's cap) and the worker filters down per exporter before sending, so a `metadata` exporter never
receives content that a `full` one asked for.

### 6. Redaction

Applied in the daemon before anything leaves the machine, and again in the worker before export:

- the runner token, the CLI token, the per-turn MCP nonce, and the per-turn receiver nonce, by value;
- any environment value the daemon resolved from `$VAR` in the config (agent `env`, `extra_mcp_servers` env
  and headers), by value;
- keys in `SENSITIVE_KEYS`, and `Authorization` / `Cookie` / `*-token` / `*-key` headers, by name;
- common secret shapes (provider API key prefixes, JWTs, PEM blocks, `AKIA…`), by pattern — best effort, and
  the docs say so.

Linear credentials never reach the daemon, and the server's spans are built from serializers and operation
names, never from request headers or raw tokens. A test greps every byte the test collector receives for every
secret value in the run (§Tests).

### 7. Capturing the agent's native telemetry

For a turn whose effective exporters include `agent_native`, the daemon starts a **loopback OTLP/HTTP receiver**
for that turn:

- bound to `127.0.0.1` on an ephemeral port, with a random per-turn path prefix, so the base URL is
  `http://127.0.0.1:<port>/<nonce>` and an agent posts to `/<nonce>/v1/traces`. Agents that cannot send
  headers still work, and nothing else on the machine can guess the URL;
- accepting `application/x-protobuf` and `application/json`, gzip or not;
- decoding each batch, stamping our resource attributes, re-parenting root spans under `daemon.turn` when the
  agent did not propagate context, applying the content filter and redaction, and queueing it for the relay;
- closed when the turn ends, after a short drain so the agent's final flush lands.

Each preset declares how to turn its native telemetry on, as an environment block the daemon merges over the
role's `env` (and over any `OTEL_*` already in the daemon's environment, so the agent does not double-export to
somewhere else). The exact keys are verified against each agent's release at build time; the shape is:

| Preset | Native telemetry | How it is pointed at the receiver |
|---|---|---|
| `claude` | yes | `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_{METRICS,LOGS,TRACES}_EXPORTER=otlp` plus whatever flag the release requires to emit traces (beta at the time of writing), `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_EXPORTER_OTLP_ENDPOINT`; at `full`, `OTEL_LOG_USER_PROMPTS=1` and `OTEL_LOG_TOOL_DETAILS=1` |
| `codex` | yes | its `[otel]` config, passed by `-c` overrides on the command line |
| `gemini` | yes | its telemetry settings, by environment or `--telemetry-*` flags |
| `goose`, `opencode`, others | where they read standard `OTEL_*` variables | standard `OTEL_EXPORTER_OTLP_*`; otherwise none, and the settings page says which agents contribute native data |
| a custom `command` | unknown | standard `OTEL_*` variables, plus `HYPOTENUSE_OTLP_ENDPOINT`, documented for people wrapping their own agent |

Every agent also receives `TRACEPARENT` set to the `acp.prompt` span, which agents that honour it use as their
parent. The receiver's re-parenting covers the ones that do not.

### 8. The runner owner's cap

The person whose machine runs the work decides what leaves it. `[telemetry]` in the daemon config:

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | bool | `true` | `false` sends nothing; every turn reports `telemetry: off` |
| `max_content` | `metadata` / `content` / `full` | `full` | the most this runner will send |
| `agent_native` | bool | `true` | `false` never starts the receiver or sets agent telemetry variables |
| `buffer_mb` | int | `32` | the daemon's in-memory queue (§9) |

The runner reports these in its capabilities on `daemon:connect`. Every combination is defined:

| Exporter wants | Runner allows | Turn collects | Session shows |
|---|---|---|---|
| no enabled exporter | anything | nothing; no receiver; no server spans | — |
| level L, native on | enabled, cap ≥ L, native on | L + native | — |
| level L, native on | enabled, cap < L | the cap | "telemetry capped at `<cap>` by runner `<name>`" on the dashboard transcript |
| level L, native on | enabled, native off | L, no native | "native agent telemetry disabled on runner `<name>`" |
| level L, native off | anything enabled | L (capped), no native | — |
| anything | `enabled = false` | server spans only | "runner `<name>` sends no telemetry" |

Telemetry is never a routing constraint: a runner that sends less still gets the work. Whether a project should
be able to *require* a level is left for when someone asks for it.

### 9. Volume, sampling, and loss

- **Sampling** is per turn and per exporter, and every decision uses the same number: a hash of the trace id
  mapped to [0, 1). An exporter keeps a turn when that number is below its `trace_sample_ratio`, so exporters
  with different ratios each get the share they asked for, and an exporter at 0.1 keeps a subset of what one at
  0.5 keeps. The `traceparent` sampled flag, set when the work item is created, records whether **any** exporter
  keeps the turn (the number is below the project's highest ratio). It decides whether the daemon collects spans
  and logs at all; the worker then drops the turn for each exporter whose own ratio it misses. A turn is kept or
  dropped whole for each exporter. Metrics are never sampled. Logs follow their trace.
- **Daemon:** a bounded in-memory queue (`buffer_mb`), flushed to `daemon:telemetry` every 2 s or 1 MB,
  gzip'd. When full it drops the oldest log records first, then spans, never metrics, and counts what it
  dropped. A failed post retries with backoff inside the buffer's limit. Telemetry never blocks the turn.
- **Server ingress:** `daemon:telemetry` checks that the batch's `X-Hypotenuse-Work-Item` names a work item
  this runner claimed, that its `traceparent` matches the item's, that the project has an exporter, and that
  the item is either non-terminal or has a `finishedAt` less than `TELEMETRY_LATE_WINDOW` (default 5 minutes) ago. The
  window exists because the receiver drains and the queue flushes after `daemon:complete`, which must not wait
  for telemetry. A batch past the window is refused with `410`, and the daemon counts it as dropped. The server
  then enforces a per-project byte rate (Redis token bucket, `backend/lua/`), pushes the batch to a Redis
  stream with a TTL, and answers `202`. It never calls a collector inline.
- **Export:** `telemetry:export` drains the stream, filters per exporter (§5), and POSTs with retry on
  `429` / `5xx` honouring `Retry-After`. After repeated failures an exporter is marked with `last_error` and
  skipped until its next backoff window; it is never auto-disabled.
- **Server-emitted spans** use an in-process OTel SDK whose exporter writes to the same stream, so they share
  the per-exporter filtering and retry.

### 10. Wire changes

Additive to [`RUNNER_PROTOCOL.md`](../RUNNER_PROTOCOL.md), so no `PROTOCOL_VERSION` bump:

- the claim carries `telemetry: { traceparent, sampled, content, agentNative } | null`;
- `daemon:connect` capabilities carry `telemetry: { enabled, maxContent, agentNative }`;
- `daemon:telemetry` (new, in `DAEMON_ONLY_ACTION_NAMES`): `POST`, body is an OTLP/HTTP protobuf
  `ExportTraceServiceRequest` / `ExportMetricsServiceRequest` / `ExportLogsServiceRequest` with
  `X-Hypotenuse-Signal` and `X-Hypotenuse-Work-Item` headers and the turn's `traceparent`; accepted until
  `TELEMETRY_LATE_WINDOW` after the turn finishes;
- every `daemon:*` call for a turn may carry `traceparent`.

A daemon too old to know `telemetry` ignores it; the server then exports server spans only.

## Steps

### 1. Schema — `backend/schema/telemetry_exporters.ts`, `backend/schema/work_items.ts`

`telemetry_exporters` as §2; `work_items.traceparent` text. Migration by `drizzle-kit`.

### 2. Ops — `backend/ops/TelemetryExporterOps.ts`, `backend/ops/TelemetryOps.ts`, `backend/ops/EndpointSafetyOps.ts`

`serializeTelemetryExporter` (header names only), content filtering, redaction, attribute stamping,
OTLP decode/encode (`@opentelemetry/otlp-transformer`), and the private-address check.

### 3. Actions — `backend/actions/telemetry/*.ts`

The six exporter actions; `daemon:telemetry`; the `telemetry:export` task. `headers` added to
`SENSITIVE_KEYS`. `rbac.test.ts`' MCP policy assertion picks the new actions up.

### 4. Server instrumentation — `backend/initializers/telemetry.ts`, `backend/ops/LinearOps.ts`, routing, outbox

An OTel SDK with the stream exporter; spans at the points in §4, gated on the project having an exporter.

### 5. Daemon — `cli/src/telemetry/{collector.ts,receiver.ts,redact.ts,queue.ts}`, `cli/src/acp/host.ts`, `cli/src/acp/presets.ts`

The span tree around the ACP host, the worktree manager, and the MCP broker; the frame logger; the loopback
receiver; per-preset native-telemetry env; the queue and relay client.

### 6. Config — `cli/src/config/schema.ts`

`[telemetry]` with `.describe()` on every key. `hypotenuse doctor` prints the effective cap and which configured
agents can contribute native telemetry.

### 7. Dashboard — `frontend/src/pages/ProjectTelemetryPage.tsx`

The exporter list, create/edit form (headers as write-only fields), the test button with per-signal results,
last export and last error, and which agents on which runners contribute native telemetry. Light and dark.

### 8. CLI — `cli/src/commands/telemetry.ts`

`hypotenuse telemetry exporter list | view | add | edit | remove | test`. `--header KEY=VALUE` repeatable;
values never echoed. Bump `cli/package.json`.

### 9. Docs

`frontend/src/content/docs/telemetry.md` (what each level sends, the runner cap, which agents contribute native
data, the redaction caveat); `CONFIG.md` `[telemetry]`; `RUNNER_PROTOCOL.md` §10; `ARCHITECTURE.md` (a
telemetry section and the trust-boundary row for exporter headers); `DEPLOY.md` (`TELEMETRY_ALLOW_PRIVATE_ENDPOINTS`, `TELEMETRY_LATE_WINDOW`).

### 10. Tests

No mocks: the collector is a small OTLP/HTTP receiver in `backend/__tests__/fixtures/otlp-collector.ts` that
records every request, decodes protobuf and JSON, and can answer `429` or `503` on demand. It speaks the wire
protocol to us, like finear.

- **Exporter CRUD** over HTTP: admin-only, audited with headers redacted in `audit_logs`, `list` paginated,
  `view` never returns header values, `edit` without `headers` keeps them, private endpoints refused, `test`
  reports per-signal status from the fixture.
- **End to end** (`backend/__tests__/e2e/telemetry.test.ts`): a session runs through the real daemon and the fake
  ACP agent; the collector receives one trace whose root is the server's `turn` span and whose descendants
  include the daemon's `acp.prompt`, every tool span the scenario emitted, the `mcp.call` → `daemon:linear-*`
  pair, and the outbox spans — asserted as a whole tree shape, not by spot checks.
- **Native capture:** a new fake-agent scenario `otel` posts OTLP to `$OTEL_EXPORTER_OTLP_ENDPOINT`; the
  collector receives those spans with our resource attributes and parented under `daemon.turn`.
- **Content levels:** the same scenario at `metadata`, `content`, and `full`, plus two exporters at different
  levels in one project; each exporter's received bytes contain exactly its level's fields.
- **Runner cap:** every row of the §8 table.
- **Secrets:** after the run, every byte the collector received is searched for the runner token, the CLI
  token, the Linear access and refresh tokens, the nonces, a `$VAR`-resolved env value, and the exporter's own
  header values. None appear.
- **Loss:** a tiny `buffer_mb` with a collector answering `503` — the turn completes on time, and
  `hypotenuse.telemetry.dropped` counts what was lost.
- **Sampling:** ratio 0 exports metrics and no spans; ratio 1 exports every turn whole; two exporters at 0.2
  and 0.6 over many turns each receive their share, and every turn the 0.2 exporter keeps is one the 0.6
  exporter keeps too.
- **Late batches:** a batch posted after `daemon:complete` inside the window is exported; one past it (the
  work item's `finishedAt` moved back) gets `410`.

## Verification

```bash
cd backend && bun test __tests__/actions/telemetry-exporter.test.ts __tests__/e2e/telemetry.test.ts __tests__/actions/rbac.test.ts
bun run --cwd cli test

# by hand, against a local collector
otelcol-contrib --config otelcol-debug.yaml   # an OTLP receiver and the debug exporter, prints what arrives
bun run --cwd cli hypotenuse telemetry exporter add --project 1 --name local \
  --endpoint http://localhost:4318 --content full     # with TELEMETRY_ALLOW_PRIVATE_ENDPOINTS=true
```

## Definition of done

- [x] `telemetry_exporters` with encrypted headers; six audited/admin actions including a paginated `list`
- [x] Endpoint safety: https only, private addresses refused at write and at export
- [x] `daemon:telemetry` relay with per-project rate limit; `telemetry:export` with retry and `last_error`
- [x] One trace per turn joining server, daemon, and agent-native spans through `work_items.traceparent`
- [x] Every ACP frame logged at `full`; content levels filtered per exporter
- [x] Loopback receiver and native-telemetry env for every preset that supports it
- [x] `[telemetry]` runner cap, reported in capabilities, every combination in the table tested
- [x] Redaction in the daemon and the worker; the secret-grep test passes
- [x] Bounded daemon buffer with drop accounting; telemetry never delays a turn
- [x] Settings page in light and dark; `hypotenuse telemetry exporter …` commands; CLI version bumped
- [x] User docs, `CONFIG.md`, `RUNNER_PROTOCOL.md`, `ARCHITECTURE.md`, `DEPLOY.md` updated

## Commands

```bash
# a project's exporters and their health
bun run --cwd cli hypotenuse telemetry exporter list --project 1
# what is queued for export right now
redis-cli XLEN hypotenuse:telemetry:1
```

## Learnings from the build

**Built.** The Definition of done, at CLI 0.14.0, except where a bullet below says otherwise.

- **No OpenTelemetry SDK, on either side.** A turn's trace crosses three processes and its whole life, and every
  span is written when it ends from what Postgres (server) or the turn (daemon) already knows; an SDK's in-process
  context and batch processor would have been fought, not used. Telemetry is held as OTLP/JSON everywhere, built by
  small helpers in `protocol/src/otlp.ts` and `telemetry.ts`, and converted to protobuf only at an edge (an agent's
  protobuf export, an `http/protobuf` exporter) through a protobufjs JSON descriptor of the OTLP messages written
  out by hand — `@opentelemetry/otlp-transformer` serializes requests but no longer decodes them. The server's
  Linear calls find their parent through an `AsyncLocalStorage` trace scope (`withTraceScope`).
- **Content levels are attributes, not batches.** Free text lives under `hypotenuse.content.*`; a record that is
  content whole (an ACP frame, a stderr line) carries `hypotenuse.telemetry.level`. `filterForLevel` drops by those
  two rules, so the daemon collects once and the worker filters per exporter. The agent's own telemetry is tagged
  with the level the turn collected at — what an agent logs depends on what it was asked to — so it reaches only
  exporters at that level or above: with a `full` and a `metadata` exporter, the `metadata` one gets none of it.
- **The traceparent is a column default.** Four places insert work items; `$defaultFn` mints the trace and root span
  id in all of them, and the migration backfills existing rows. The sampled flag is decided and written **at claim**,
  not at insert, because an insert does not know the project's exporters — and at claim the exporters in force are
  the ones that matter. The claim's decision is kept on `work_items.telemetry`, so a repeated claim answers the same,
  and `serializeWorkItem` carries its note and trace id to the session page.
- **The cap rides the heartbeat, not `daemon:connect`**, which carries no capabilities; it is stored on
  `runners.telemetry`. `RunnerCapabilities` is strict, so the key is optional and an older daemon reports none —
  treated as "sends no telemetry".
- **Routes follow the repository's convention**, `/telemetry-exporter(s)` and `/telemetry-exporter/:id` with
  `projectId` as a param, not the plan's `/project/:projectId/…`. **Members read** (`list`, `view`): header names only
  are ever serialized, and a runner's owner should see what their work is exported at; admins write and `test`.
  Headers are one sealed `jsonb` column plus `headerNames`, as `integrations` seals its tokens, not three text
  columns. The dashboard is a Settings section (Settings → Telemetry), not its own page.
- **Each exporter reads the stream through its own consumer group** (`exporter:<id>` on
  `telemetry:stream:<projectId>`, not the plan's `hypotenuse:telemetry:<id>`). A failing collector's entries stay
  pending and are re-read first after its backoff — a Redis key with a TTL (`telemetry:backoff:<id>`), which is how
  tests move its clock — while other exporters keep draining. A group is created at `$` when its exporter is (it
  gets what is observed from then on); a group found missing at export means the stream expired with it, so it is
  recreated at `0`. Each entry holds one signal, so a POST that fails acks nothing of the signals that succeeded.
- **The daemon sends gzipped OTLP/JSON**; `daemon:telemetry` is a `rawBody` route and accepts protobuf too. A turn
  no exporter wants is 409 `TELEMETRY_NOT_WANTED`, and the daemon then drops that turn's telemetry for good, as it
  does on 410. Spans and logs naming another trace are dropped at ingress, so a runner can write only into turns it
  held, and the server stamps project, work item, and runner itself.
- **`daemon:*` spans come from `beforeAct` / `afterAct` hooks** (`initializers/telemetry.ts`), not from each action:
  every traced call is a span, in the runner's own project only. `DaemonToolAction` reads the hook's span to run its
  Linear calls under it.
- **Native env, as verified against each agent's docs here:** Claude Code takes `CLAUDE_CODE_ENABLE_TELEMETRY` and
  the standard `OTEL_*`; its traces need `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA` at the time of writing (sources
  disagreed; it is set, and harmless if not needed). Gemini CLI logs prompts by default once telemetry is on, so
  `GEMINI_TELEMETRY_LOG_PROMPTS=false` below `full`. Qwen Code is assumed to keep Gemini CLI's variables under a
  `QWEN_` prefix, and Codex's `-c otel.*` overrides are assumed to pass through `codex-acp`; neither could be run
  in the build sandbox. The nightly real-agent run is where a wrong key would show.
- **The receiver keeps the agent's `service.*`**: it stamps the turn's other resource attributes, so a collector
  still says which agent produced a span. Root spans of an agent's own trace go under `daemon.turn`; an agent that
  honoured `TRACEPARENT` is already under `acp.prompt`.
- **Not built, or built smaller.** Setup commands are log records under `worktree.prepare`, not a child span each
  (the worktree manager reports output lines, not command boundaries). `agent.spawn` records pid and exit code, not
  peak RSS or CPU time. `routing.offer` records how many runners were eligible and available, not why each other one
  was excluded. Session transitions and signals are the root span's `cancel_reason` and status, not span events, and
  runner presence is the `hypotenuse.runners.online` gauge, not logs.
- **Tests that moved.** The loss test is a unit test of the queue (`cli/__tests__/telemetry`): a collector answering
  `503` exercises the worker's retry, not the daemon's buffer, which only fills when the server is unreachable. The
  secret grep covers the runner token, an exporter's header, a `$VAR` value the agent echoed, the Linear access and
  refresh tokens, and both nonces end to end; the CLI token is covered in the unit test, because an e2e daemon home
  holds no sign-in.
- **The e2e pump runs `telemetry:export`** after `settle()`; a project with no exporter costs it one `SMEMBERS`.
- **`project-sessions.test.ts`'s fifty-activity burst fails in the build sandbox on `main` too**: its loop takes
  longer than the one-second frame window there. Not this phase's, and the outbox's added telemetry check is a cached
  lookup for a project with no exporter.
