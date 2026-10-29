# Hypotenuse — Build Plans

Hypotenuse 2.0 is **a persistent multiplayer, multichannel agent for your team**. Bots live in a project; each has its own prompts, identity,
goals, and model, and its own Slack and Linear app. People reach a bot in **Slack**, **Linear**, and **Pylon**, and
the platform's own permissions decide who may. Every bot remembers each channel it works in — memory that decays —
and shares the project's memory, MCP servers, and skills. Every bot has **code mode**: TypeScript in a WebAssembly
sandbox that calls those tools. The agent loop is a set of durable [Keryx](https://www.keryxjs.com/) tasks over
Postgres, so the load fans out across workers and a restart loses nothing. Code work runs in ephemeral **sandboxes**
that report back, ask questions, and open pull requests.

The map of the finished system is [`../ARCHITECTURE.md`](../ARCHITECTURE.md); the rules for building it are in
[`../../AGENTS.md`](../../AGENTS.md). This index is the order it gets built in.

Hypotenuse **v1** — ACP coding agents on teammates' machines answering Linear agent sessions — was built in 21 phases
and is archived, plans and all, on the [`v1` branch](https://github.com/arcadeai-labs/hypotenuse/tree/v1/docs/plans).
These plans start over at Phase 01.

## Where the plumbing comes from

Much of this is a port, and each port says so in its phase:

| From | What | Phases |
|---|---|---|
| [ToolExec](https://github.com/arcadeai-labs/toolexec) | Workspace layout, Keryx conventions, test harness, CI gate, Render blueprint; users, projects, memberships, invites, **tags-as-roles RBAC**, **`AuditedAction` and the audit log**, notifications, MCP tool policy; the frontend shell and docs site; the operator CLI; the sandbox provider interface, ledger, supervisor and its protocol, run tokens, credential containment, direct git, human help; the design for Slack as a remote interface | 01, 02, 04, 05, 06, 10, 13, 14, 17, 18, 19 |
| [Hypotenuse v1](https://github.com/arcadeai-labs/hypotenuse/tree/v1) | The design system, UI kit, and look; Linear OAuth, webhook verification, rate-limit bucket, activity outbox, and the finear harness; CLI tokens and distribution; OpenTelemetry export; cost records; SSRF-safe egress | 03, 06, 10, 15, 22 |
| [botholomew](https://github.com/evantahler/botholomew) | The tick and its terminal tools; approvals that park a task and resume it; progressive MCP disclosure (`mcp_search` / `mcp_info` / `mcp_exec`); code mode with signed, replayable continuations; prompt files, skills, and self-editing | 08, 10, 11, 12 |
| [membot](https://github.com/evantahler/membot) | Versioned memory documents, markdown-aware chunking, hybrid semantic + keyword search with reciprocal-rank fusion, the memory tool surface | 09 |
| [Pi Durable](https://earendil.com/posts/pi-durable/) | Intent stored before every effect; replay only what declares itself safe; idempotency keys from durable ids; typed waits; background compaction | 08, 12 |
| [finear](https://github.com/pmdroid/finear) | Linear, for every test | 15 |

## Build order

| Phase | Title | Deliverable |
|---|---|---|
| [01](./phase-01-foundation.md) | Foundation | Bun workspaces (backend, frontend, CLI) seeded from ToolExec; Keryx; Postgres with pgvector; tests green against a booted server; the docs tests; CI behind `CI Complete` |
| [02](./phase-02-deployment.md) | Deployment | One Render blueprint — api, worker, frontend, Redis, Postgres with pgvector — staging first |
| [03](./phase-03-design-system.md) | Design system | v1's tokens, UI kit, app shell, public site, `/docs`, and `/style-guide`, in light and dark |
| [04](./phase-04-organizations-users-and-rbac.md) | Organizations, users, and RBAC | Organizations above ToolExec's users, projects, memberships, invites, and tags-as-roles RBAC; per-object read/write tag lists |
| [05](./phase-05-audit-logging.md) | Audit logging | ToolExec's `AuditedAction`: every decision a person makes logged in the same transaction; the closed list of unaudited writers |
| [06](./phase-06-operator-cli.md) | Operator CLI | `hypotenuse` over HTTP: sign-in, projects, bots, conversations; npm and compiled binaries; self-upgrade |
| [07](./phase-07-model-providers-and-bots.md) | Model providers and bots | Encrypted model connections and a named model registry; bots with identity, prompts, goals, model, and access tags. No execution |
| [08](./phase-08-durable-agent-loop.md) | Durable agent loop | Conversations, the inbox, the entry log, and `agent:tick`: lease, hydrate, step, intent-before-effect, park; recovery; compaction; cost per tick; the HTTP API channel |
| [09](./phase-09-memory.md) | Memory | Channel and project memory: versioned documents, pgvector + full-text hybrid search, decay, promotion with provenance, memory tools and explorer |
| [10](./phase-10-shared-mcp-servers.md) | Shared MCP servers | Per-project MCP servers with server-side credentials; progressive disclosure; per-bot allowlists; the approval gate; large results |
| [11](./phase-11-skills-prompts-and-goals.md) | Skills, prompts, and goals | Shared skills, prompt sections, goals, guarded self-editing, a generated capabilities section |
| [12](./phase-12-code-mode.md) | Code mode | `run_code`: TypeScript in QuickJS-WASM against `memory.*` and `mcp.*`, with limits and resumable continuations |
| [13](./phase-13-channel-framework.md) | Channel framework | Platform adapters, bot installations, channels and bindings, participants, ingress, the outbox, the interactive surface, escalation to people |
| [14](./phase-14-slack.md) | Slack | One Slack app per bot; mentions, DMs, threads; streamed replies, status, plan steps; buttons for questions and approvals |
| [15](./phase-15-linear.md) | Linear | One Linear app per bot; agent sessions as conversations; v1's OAuth, webhook, outbox, and finear stack ported |
| [16](./phase-16-pylon.md) | Pylon | Pylon issues as conversations, customer accounts as channels; internal notes by default |
| [17](./phase-17-sandboxes.md) | Sandboxes | ToolExec's provider interface with Docker; sandbox jobs owned by a conversation; the supervisor protocol; the model and MCP gateway proxies; status, questions, and help relayed back |
| [18](./phase-18-git-and-pull-requests.md) | Git and pull requests | GitHub App, repository grants, per-command scoped tokens, pull requests reported to the conversation |
| [19](./phase-19-vercel-sandboxes.md) | Vercel sandboxes | The production provider, with a provider-conformance suite shared with Docker |
| [20](./phase-20-schedules.md) | Schedules | Per-bot cron schedules that wake a bot to work toward its goals |
| [21](./phase-21-dashboard.md) | Dashboard | Mission control: bots, live conversations and transcripts, the memory explorer, approvals and help, sandboxes |
| [22](./phase-22-telemetry-and-cost.md) | Telemetry and cost | OpenTelemetry export, one trace per tick; priced cost records; per-bot and per-project budgets |
| [23](./phase-23-scale-and-conformance.md) | Scale and conformance | Load and fairness across tenants, quotas, cross-platform end-to-end conformance, a security checklist |

Each phase doc is `phase-NN-<kebab-title>.md`, so a search for "slack" or "memory" finds the file without opening this
index.

Each phase ends in a reviewable, deployable state. **Phase 01 halts for review before Phase 02.**

## How the phases depend on each other

```
01 ─► 02 ─► 03 ─► 04 ─► 05 ─► 06
                         └──► 07 ─► 08 ─┬─► 09 ─┐
                                        ├─► 10 ─┼─► 12
                                        ├─► 11 ─┘
                                        └─► 13 ─┬─► 14 (Slack)
                                                ├─► 15 (Linear)
                                                ├─► 16 (Pylon)
                                                └─► 17 ─► 18 ─► 19
                                    20 (needs 08, 11, 13)   21 (needs 09–17)
                                    22 (needs 08)            23 (last)
```

- **08 is the spine.** Everything a bot does is a tool called inside a tick; every later phase adds tools, wake
  reasons, or a place to render what a tick did.
- **The HTTP API channel ships with 08,** so the loop, memory, MCP, skills, and code mode are tested headlessly
  before any platform exists.
- **The approval gate is born in 10** and answered in the dashboard and API there; 13 gives it an in-channel
  surface, and 14–16 render it natively.
- **Platforms (14–16) and sandboxes (17) are independent of each other** once 13 lands, and can be built in any
  order or in parallel.

## Status

**[Phase 01](./phase-01-foundation.md) is built**: the `backend/`, `frontend/`, and `cli/` workspaces, Postgres with
pgvector from migration 0000, the docs tests in the backend suite, and CI behind **CI Complete**.
**[Phase 02](./phase-02-deployment.md) is built and deployed to staging**: the Render blueprint, its invariant test, and
[`DEPLOY.md`](../DEPLOY.md); `api.hypotenuse.cloud` is healthy with `vector`.
**[Phase 03](./phase-03-design-system.md) is built**: the generated tokens with `--status-idle`, the shared state table
in `design/states.ts`, the UI kit, conversation-state glyphs and the bot badge in web and CLI, the app shell with
organization and project switchers, the public site, `/docs` with the style guide at `/docs/style-guide`, and the browser suite as **E2E Test**.
**[Phase 04](./phase-04-organizations-users-and-rbac.md) is built**: sign-up into an owned organization and a Default
project; organizations, projects, memberships, invites, tags, and notifications; five RBAC levels with owners' admin
standing in every project; `AccessOps`; `AuditedAction` on every write; the settings and organization pages; and a
browser suite that boots the backend too.
**[Phase 05](./phase-05-audit-logging.md) is built**: `audit_logs` with organization scope and an actor type (`user`,
`participant`, `system`); `audit:list`, `organization:audit-list`, and the daily `audit:sweep`; the Audit log page for
a project and an organization; and a registry walk that holds every writer to `AuditedAction` or the closed list.
**[Phase 06](./phase-06-operator-cli.md) is built**: `hypotenuse` 2.0 over HTTP — browser sign-in by loopback + PKCE
or device code onto `hyp_cli_` tokens (`cli_tokens`, `cli-auth:*`, `cli-token:*`, the principal hook), the
`org`, `project`, `member`, `invite`, `tag`, and `audit` commands, `upgrade` with a major-version guard, Account → CLI
sign-ins, the install scripts, `auto-release.yml`, and **CLI Upgrade** in the gate.
**[Phase 07](./phase-07-model-providers-and-bots.md) is built**: `model_connections` (keys sealed, probed, never
returned) for Anthropic, OpenAI, Vercel AI Gateway, and OpenAI-compatible endpoints through the AI SDK; the SSRF guard
and its pinned-DNS `guardedFetch`; `model_aliases` with `default` and `fast` required; `bots` with `canReadBot` /
`canWriteBot`, the lockout guard, and stored avatars; the scripted model server; Settings → Models, the Bots list, and
the bot page; and the `model` and `bot` commands.
No other phase is built; every later plan's **Learnings from the
build** section reads "Not built yet." until its phase lands.

### Decisions so far

| Topic | Decision |
|---|---|
| v1 | Archived on the `v1` branch. Its runner daemon and ACP agent host are dropped: all code work happens in sandboxes, and the CLI is an operator client |
| Template | ToolExec, including its RBAC (tags as roles, the reserved `admin` tag, `none` / `member` / `admin` levels, per-object `accessRead` / `accessWrite`) and its audit history (`AuditedAction`, `audit_logs`, `audit:list`, the Audit page) |
| Tenancy | An organization holds members and projects; everything else — platform installs, model keys, MCP servers, skills, memory, bots — belongs to a project |
| Models | The Vercel AI SDK; provider and model chosen per bot; embeddings through the same SDK |
| Bot identity | One platform app per bot: each bot is its own Slack app and its own Linear OAuth app, created from manifests Hypotenuse generates |
| Memory boundaries | Slack: a channel. Linear: a Linear project (the team when an issue has none). Pylon: a customer account. Plus one project-wide scope |
| Memory store | Postgres with pgvector and full text, hybrid rank fusion as in membot; decay and promotion are new |
| Who may talk to a bot | The platform's own permissions; no identity linking. Project RBAC governs configuration, transcripts, and memory |
| Sandboxes | ToolExec's provider interface; Docker first (development, CI), Vercel next (production) |
| Code mode | QuickJS compiled to WebAssembly inside the worker; no network, filesystem, or timers; host API of memory and MCP |
| Agent loop | Durable Keryx tasks; every message, intent, and result in Postgres; one tick at a time per conversation |
| Organization owners | Admin standing in every project of the organization without joining it, flagged `viaOrganizationOwner` and in audit metadata; only owners create projects |
| Audit actors | `user`, `participant` (a person on a platform, from the channel framework on), or `system` (sign-up's bootstrap rows); sign-up's own row is the new account's |
| Audit retention | A year (`AUDIT_RETENTION_DAYS`), swept daily; rows are never edited |
| CLI | `@arcadeai/hypotenuse` 2.0.0, an HTTP client only; sign-in through the dashboard onto `hyp_cli_` tokens (90-day sliding expiry); `upgrade` refuses to cross a major version without `--major` |
| Last-admin guard | Counts the project's explicit `admin` tag holders, not owners: a project always keeps someone who administers it by being in it |
| Models | A bot names aliases, never keys or model ids; `default` and `fast` are required; `ModelOps.languageModel` is the only way to a model, and every provider fetches through the SSRF guard |
| Bot access | Member-level CRUD gated per bot by `accessRead` / `accessWrite`; an unreadable bot is the same 404 as a missing one; a non-admin cannot save a list that locks them out |
