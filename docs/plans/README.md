# Hypotenuse — Build Plans

Hypotenuse connects **coding agents on people's own machines** to **Linear** as a Linear agent. A hosted
[Keryx](https://www.keryxjs.com/) service receives Linear's webhooks at a public URL, holds every Linear credential,
and routes each agent session to a registered **runner**. A runner is the `hypotenuse` daemon on somebody's laptop
or build box. The daemon runs an [ACP](https://agentclientprotocol.com) coding agent (Claude Code, Codex,
Gemini CLI, …) in a git worktree and streams what it does back into the Linear session. One Linear app,
`@hypotenuse`, plays two roles: a **manager** that writes PRDs and tickets and dispatches them, and **workers** that
implement them.

The map of the finished system is [`../ARCHITECTURE.md`](../ARCHITECTURE.md). This index is the order it gets built
in.

## Where the plumbing comes from

Much of this is a port, and each port says so in its phase:

| From | What | Phases |
|---|---|---|
| [ToolExec](https://github.com/arcadeai-labs/toolexec) | Workspace layout, Keryx backend conventions, test harness, CI gate, Render blueprint; users, projects, memberships, tags, invites, RBAC descriptors, `AuditedAction`, notifications; the frontend shell, UI kit, `AuthContext`, `LiveSocketContext`, public docs; the operator CLI's command shape; the run-token and webhook-ingress patterns; the plan-doc format itself | 1, 2, 4, 5, 7, 8, 15 |
| [mcpx](https://github.com/arcadeai-labs/mcpx) | npm + compiled-binary distribution, `auto-release.yml`, `install.sh` / `install.ps1`, upgradr self-upgrade, the CLI's logger / TTY / shutdown modules, `test-upgrade.sh` | 3, 5, 10 |
| [finear](https://github.com/pmdroid/finear) | Linear, for every test: GraphQL against Linear's own schema, OAuth `actor=app`, signed webhooks, agent sessions and activities, and `/__test/*` control routes | 1, 6, 7, 17 |

## Build order

| Phase | Title | Deliverable |
|---|---|---|
| [1](./phase-01-foundation.md) | Foundation | Bun workspaces `backend` / `frontend` / `cli` / `protocol`; ToolExec scaffolds ported; finear booting in process; CI with one `complete` gate; `AGENTS.md`; docs link test |
| [2](./phase-02-deployment.md) | Deployment | One Render blueprint: api + worker + frontend + Redis + Postgres; the public webhook URL; staging only |
| [3](./phase-03-design-system.md) | Design system | A Linear-native look in light and dark, generated from three LCH inputs; self-drawn status glyphs and the `◢` mark; ToolExec's UI-kit API restyled; app shell, command palette, public site and docs frame; the CLI palette |
| [4](./phase-04-users-tenancy-and-audit.md) | Users, tenancy, and audit | ToolExec's pages on the design system; signup, projects, memberships, tags, invites, RBAC, `actions:permissions`, `AuditedAction`, notifications, `buildTestUniverse()`, MCP tool policy |
| [5](./phase-05-cli-and-distribution.md) | CLI and distribution | `hypotenuse` CLI with operator commands and OAuth login; six compiled binaries + npm on every version bump; install scripts; `upgrade` / `check-update` |
| [6](./phase-06-linear-connection.md) | Linear connection | `actor=app` install per project; encrypted, refreshed, rotated tokens; `LinearOps` with rate-limit handling; the finear harness |
| [7](./phase-07-webhook-ingress-and-session-mirror.md) | Webhook ingress and session mirror | Signed, deduplicated `POST /api/webhooks/linear`; `agent_sessions` / `agent_activities`; the activity outbox and token bucket; 10-second acknowledgement; permission and revocation events |
| [8](./phase-08-runners.md) | Runners | Runner registration and tokens; `daemon:connect` / `daemon:heartbeat`; the `runner:<id>` ping channel; presence; the daemon/human action wall |
| [9](./phase-09-work-routing.md) | Work routing | `work_items` with offers, claims, and leases; role selection rules; repository selection via `issueRepositorySuggestions` and `select`; issuer preference; sticky sessions; `daemon:events` / `daemon:complete` |
| [10](./phase-10-daemon-and-config.md) | Daemon and config | `hypotenuse daemon`; the TOML config, its zod schema, `config validate`; local state; the control socket; service install; `doctor`; drain-and-re-exec on upgrade |
| [11](./phase-11-acp-agent-host.md) | ACP agent host | Agent presets; `initialize` / auth / `session/new` / `load`; prompt assembly; the ACP → Linear mapping; permission policies through `select` elicitations; stop |
| [12](./phase-12-worktrees-and-session-lifecycle.md) | Worktrees and session lifecycle | A worktree per session; setup commands; timeouts and keepalives; cleanup policies; PR links; issue state and delegate hygiene; `agents` / `worktrees` commands |
| [13](./phase-13-hypotenuse-mcp.md) | Hypotenuse MCP | `hypotenuse mcp` stdio server; role-scoped Linear tools; the closed `daemon:linear-*` proxy |
| [14](./phase-14-manager-and-dispatch.md) | Manager and dispatch | The manager role: PRDs, ticket breakdown, `hypotenuse_dispatch`, review turns, loop guards |
| [15](./phase-15-dashboard.md) | Dashboard | Linear connection, runners, sessions and transcripts, routing rules, identities; live channels; CLI parity; user docs |
| [16](./phase-16-signals-and-hardening.md) | Signals and hardening | Every signal (`stop`, `auth`, `select`, `continue`); `AppUserNotification`; rate-limit and replay hardening; the AIG checklist |
| [17](./phase-17-conformance-and-e2e.md) | Conformance and end to end | Every `LINEAR_COVERAGE.md` row closed; the full daemon + finear + fake-agent suite; an optional nightly real-agent run |

Each phase doc is named `phase-NN-<kebab-title>.md`, so searching for "routing" or "worktree" finds the file without
opening this index.

Each phase ends in a reviewable, deployable state. **Phase 1 halts for review before Phase 2.**

## How the phases depend on each other

```
1 ─► 2 ─► 3 ─► 4 ─► 5 ─────────────────────► 10 ─► 11 ─► 12 ─► 13 ─► 14
               │                             ▲
               └─► 6 ─► 7 ─► 8 ─► 9 ─────────┘
                                   └─► 15 (after 9; grows with 12–14)
                                                     16, 17 (last)
```

- **The look comes before any page.** The [design system](./phase-03-design-system.md) lands ToolExec's UI-kit API
  restyled. Phase 4's ported pages then drop in unchanged, and phase 15's pages are built from its primitives and its
  `/style-guide` fixtures.
- **The server half (6–9) and the daemon half (10–13) meet in the protocol.**
  [`../RUNNER_PROTOCOL.md`](../RUNNER_PROTOCOL.md) is written before either side ships. Phase 9's server endpoints are
  tested with a scripted HTTP client; phase 10's daemon is tested against the real server from phase 9.
- **Until phase 9 lands, a session ends honestly.** Phase 7 acknowledges every session and, with no routing yet,
  answers with an `error` saying no runner is connected. A Linear workspace connected to a half-built Hypotenuse never
  shows an unresponsive agent.
- **The manager (14) is built on the worker path (11–13)**, not beside it. A manager turn is a work item with a
  different role, prompt, and tool set. Dispatch makes worker work items, and review makes manager work items.
- **Coverage is tracked from the first Linear phase.** Phases 6 onward each add rows to
  [`../LINEAR_COVERAGE.md`](../LINEAR_COVERAGE.md) as they ship. Phase 17 closes the remainder and makes the matrix
  a test.

## Status

**Phases 1–4 are built** (phase 2 is not yet deployed); the rest are plans. Every document here is a plan with the open questions settled as **decisions so far**. Each
ends in an empty **Learnings from the build** section that fills in as the phase ships. From then on that section,
and not the plan above it, is the live account (rule 14 in [`AGENTS.md`](../../AGENTS.md)).

### Decisions so far

- **One Linear app, two roles.** The role (manager or worker) is chosen per session by a project's ordered routing
  rules, not by which app was mentioned.
- **One Linear workspace per Hypotenuse project.** The deployment owns one Linear OAuth app. A project connects one
  workspace with `actor=app`, and runners subscribe to subsets of it: teams, projects, labels, repositories, roles,
  and agent kinds.
- **Linear credentials are server-only.** Runners and coding agents reach Linear through `daemon:linear-*` actions,
  scoped per session. Handing a runner the Linear MCP server and a token was rejected: it would put workspace-wide
  write access on every laptop.
- **CLI and runner authentication.** `hypotenuse login` signs in **on the web**. The dashboard approves the CLI
  (loopback + PKCE, or a device code over SSH), and the server issues a `hyp_cli_` token it stores and checks itself.
  Keryx's OAuth server is kept for human MCP clients only. `runner register` then mints a runner token, shown once and stored as a sha256. HTTP requests carry it as a bearer
  token. The WebSocket uses a session cookie obtained from `daemon:connect`.
- **Postgres is truth; the socket is a ping.** The daemon's 15-second heartbeat also returns offers and cancels.
- **Routing preference.** A follow-up goes to the runner that holds the session, then to the issuer's runners, then
  to any eligible runner.
- **Config is TOML** at `~/.config/hypotenuse/config.toml`, validated by a zod schema that also emits JSON Schema.
- **ACP SDK v2.** `@agentclientprotocol/sdk` 2.0 (released 2026-10-19) removed `ClientSideConnection`; we build on
  `client()` / `connectWith()` and pin the version.
- **The npm package is a Bun bundle** (`dist/hypotenuse.js`, `--target bun`, with `protocol/` inlined), so it needs
  Bun as mcpx's does. The compiled binaries need nothing.
- **A Linear-native look, light and dark.** [`../DESIGN.md`](../DESIGN.md) echoes Linear's grammar without cloning
  its assets. The session transcript, the runner fleet, the public site and docs, and the CLI's output are the four
  surfaces that get real design attention.
- **`AGENTS.md` only.** Claude Code and other agents read it directly, so there is no `CLAUDE.md`.
