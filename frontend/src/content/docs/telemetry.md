# Telemetry

A project can send everything Hypotenuse observes about its work to one or more
[OpenTelemetry](https://opentelemetry.io) collectors — your vendor (Honeycomb, Datadog, Grafana, …) or your own — as
OTLP traces, metrics, and logs. Each turn of an agent session is **one trace**, joining three sources:

| Source | What it adds |
|---|---|
| The hosted service | the Linear webhook, routing (which rule, which runners, who got it), the offer and claim, each activity sent to Linear, every Linear API call, the agent tools' calls |
| The runner's daemon | the worktree and its setup, the agent process, every step of the ACP conversation — the prompt, each tool call with its result, permission and question waits, file reads and writes — and, at `full`, every ACP message verbatim |
| The coding agent itself | its own OpenTelemetry: model requests, token counts, cost, its own tool decisions — what the daemon cannot see |

The trace's root is the service's `turn` span; the daemon's `daemon.turn` is its child, and the agent's own spans
hang under the daemon's. Look a turn up by its trace id, which its session page shows.

## Adding an exporter

Settings → **Telemetry** → **Add exporter** (admins), or from the CLI:

```bash
hypotenuse telemetry exporter add --name honeycomb \
  --endpoint https://api.honeycomb.io --header x-honeycomb-team=$HONEYCOMB_KEY --content metadata
hypotenuse telemetry exporter test 1      # a probe span, log, and metric; prints what the collector answered
```

| Setting | Means |
|---|---|
| Endpoint | the collector's OTLP/HTTP base URL; `/v1/traces`, `/v1/metrics`, and `/v1/logs` are added. It must be a public `https` address |
| Protocol | `http/protobuf` (the default) or `http/json`. gRPC is not supported |
| Headers | sent with every export — usually the vendor's API key. Write-only: stored encrypted, never shown again, never sent to a runner. Editing an exporter without new headers keeps them |
| Content | `metadata`, `content`, or `full`, below |
| Signals | any of traces, metrics, and logs |
| Sample ratio | the share of turns whose traces and logs are kept, 0 to 1. Metrics are never sampled |
| Agent's own telemetry | capture the coding agent's native telemetry on runners that allow it |
| Resource attributes | extra attributes on everything sent, e.g. `deployment.environment=prod` |

Every member can see which exporters a project has and at what level — a runner's owner can see what their
machine's work is exported at. Only admins add, change, test, or remove one, and each change is in the audit log.

## Content levels

`metadata` is the default. Anything more is a choice an admin makes per exporter, because it sends source code
and prompts to a third party.

| Level | Sends |
|---|---|
| `metadata` | names, kinds, ids, timings, sizes, counts, statuses, exit codes, token usage, and paths relative to the worktree. No text from the agent, the person, or the repository |
| `content` | adds the prompt the agent was given, its thoughts and messages, the person's Linear prompts, tool titles, inputs, and results, diffs, command output, the agent's stderr, and its Hypotenuse tool calls — each cut at 64 KB, with the original size recorded |
| `full` | adds every ACP message between the daemon and the agent, verbatim, and asks agents to log prompts and tool detail in their own telemetry |

With several exporters, a turn is collected at the highest level any of them asks for, and each exporter receives
only its own level: a `metadata` exporter never sees what a `full` one asked for. The agent's own telemetry depends
on what the agent was asked to log, so it goes only to exporters at the level the turn was collected at or above.

Sampling is per turn and per exporter, decided from the trace id: an exporter at 0.1 keeps a subset of the turns
one at 0.5 keeps, and a turn is kept or dropped whole.

## The runner owner's cap

The person whose machine runs the work decides what leaves it, with `[telemetry]` in the daemon's
[config file](/docs/config):

```toml
[telemetry]
enabled = true          # false sends nothing
max_content = "content" # the most this machine sends, whatever an exporter asks
agent_native = true     # false never captures the agent's own telemetry
buffer_mb = 32
```

A turn collects at the lower of the exporters' level and the runner's cap. The session page says so when the cap
lowered it — "telemetry capped at `content` by runner `laptop`" — when the runner turned the agent's own telemetry
off, or when it sends none. Telemetry never decides where work goes: a runner that sends less still gets the work.
`hypotenuse doctor` prints this machine's cap and which of its agents contribute their own telemetry.

## Which agents contribute their own telemetry

The daemon starts a receiver for each turn on `127.0.0.1`, under a random path nobody else can guess, and points the
agent's own exporter at it. What arrives joins the turn's trace.

| Agent | Its own telemetry |
|---|---|
| Claude Code (`claude`) | yes: model requests, tokens, cost, tool decisions; prompts and tool detail at `full` |
| Codex (`codex`) | yes, through its `[otel]` settings |
| Gemini CLI (`gemini`), Qwen Code (`qwen`) | yes; prompts only at `full` |
| goose, OpenCode | if they read the standard `OTEL_*` variables |
| Others, and a custom `command` | the standard `OTEL_*` variables and `HYPOTENUSE_OTLP_ENDPOINT` are set; whatever the agent sends there is captured |

Every agent also gets `TRACEPARENT`, so one that honours it parents its spans under the turn's prompt. The daemon
removes any `OTEL_*` your environment set for the agent, so it does not also send to somewhere else.

## Credentials and redaction

The daemon never learns a collector's endpoint or headers: it sends its telemetry to the hosted service, which
exports it. Before anything leaves the runner, and again before export, Hypotenuse redacts:

- the runner token, your CLI token, and the per-turn secrets the daemon hands the agent;
- every value the daemon read from an environment variable through `$VAR` in its config;
- attributes and headers named like credentials (`authorization`, `cookie`, `*-token`, `*-key`, …);
- common secret shapes — provider API keys, JWTs, private keys, AWS key ids. This is best effort: a secret that
  looks like nothing in particular is caught only if Hypotenuse knows its value.

Linear tokens never reach a runner, and the service builds its spans from what it records, never from requests'
headers. At `content` and `full`, what the agent reads and writes is sent as it is: anything in your repository or
your prompts can be in it.

## Volume and loss

The daemon holds telemetry in memory (`buffer_mb`) and sends it every two seconds. When the buffer is full it drops
the oldest log records first, then spans, never metrics, and reports what it dropped as
`hypotenuse.telemetry.dropped`. Telemetry never delays a turn. A turn's telemetry is accepted until five minutes
after it finishes, so the agent's last flush still lands.

The service limits each project's telemetry rate, and exports to each collector independently: one that is down or
answers `429` is retried with backoff — honouring `Retry-After` — without holding up the others, and its last
error shows on the Telemetry page. An exporter is never turned off on its own. Hypotenuse stores nothing: what a
collector has not taken within the hour is gone.
