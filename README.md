# Hypotenuse

**Linear's agent sessions, answered by coding agents on your own machines.**

Delegate a Linear issue to `@hypotenuse`, or mention it in a comment. A coding agent on your laptop, or on a teammate's
build box, picks the work up in a fresh git worktree. It streams its thinking, plan, and tool calls into the Linear
agent session, opens a pull request, and replies. A **manager** agent can own a whole project: it writes the PRD,
files the tickets, hands them out to **worker** agents, and reviews what comes back.

- **Any ACP agent.** Claude Code, Codex, Gemini CLI, GitHub Copilot, goose, OpenCode, Cursor, and anything else that
  speaks the [Agent Client Protocol](https://agentclientprotocol.com).
- **Your machines, your credentials.** Agents run where your code, model logins, and git keys already are. Linear
  credentials stay on the hosted service. Runners and agents reach Linear only through narrowly scoped tools.
- **Teams.** Many people and many runners per project. Work goes to the person who asked first, sticks to the machine
  that holds its worktree, and otherwise goes to whoever has free capacity.
- **Full Linear agent support.** Sessions, activities, plans, signals (`stop`, `select`, `auth`), delegation,
  guidance, and repository suggestions. See [`docs/LINEAR_COVERAGE.md`](./docs/LINEAR_COVERAGE.md).
- **OpenTelemetry.** Every turn is one trace in your own collector — the service, the runner, every step of the
  agent's conversation, and the agent's own model telemetry — at a content level the project chooses and each
  runner's owner can cap.

> **Status: planned, not built.** This repository holds the design: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)
> and the phased plans in [`docs/plans/`](./docs/plans/README.md). The install and usage below describe the
> intended product.

## How it fits together

```
Linear ──webhooks──► Hypotenuse service (hosted, Keryx) ──work──► hypotenuse daemon (your machine)
       ◄──activities──                                  ◄─events──      │
                                                                         └─ ACP agent in a git worktree
```

Read [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the whole picture.

## Install the CLI

```bash
# macOS / Linux: standalone binary
curl -fsSL https://raw.githubusercontent.com/arcadeai-labs/hypotenuse/main/install.sh | bash

# Windows (PowerShell)
irm https://raw.githubusercontent.com/arcadeai-labs/hypotenuse/main/install.ps1 | iex

# or from npm (requires Bun)
bun install -g @arcadeai/hypotenuse      # or: npm install -g @arcadeai/hypotenuse

hypotenuse upgrade                       # later: upgrades itself, whichever way it was installed
```

## Run a runner

```bash
hypotenuse login                         # opens a browser; signs you in to the hosted service
hypotenuse project use acme              # the project whose Linear workspace you work in
hypotenuse runner register --name my-laptop
hypotenuse config init                   # writes ~/.config/hypotenuse/config.toml
$EDITOR ~/.config/hypotenuse/config.toml # agents, roles, repositories, subscriptions
hypotenuse config validate
hypotenuse service install               # launchd / systemd user service; or: hypotenuse daemon start
```

Then delegate an issue to `@hypotenuse` in Linear.

A minimal config:

```toml
[server]
url = "https://api.hypotenuse.cloud"
project = "acme"

[runner]
name = "my-laptop"
max_parallel_jobs = 2        # jobs at once on this machine; roles and agents can set lower max_parallel
roles = ["worker", "manager"]

[subscriptions]
teams = ["ENG"]

[agents.claude]
preset = "claude"

[agents.codex]
preset = "codex"

[roles.manager]
agent = "claude"
prompt_file = "~/.config/hypotenuse/prompts/manager.md"

[roles.worker]
agent = "codex"
permission_policy = "allow"

[[repositories]]
name = "acme/web"
path = "~/code/web"
remote = "github.com/acme/web"
base_branch = "main"
setup = ["bun install"]

[sessions]
worktrees = "always"
cleanup = "on-merge"
```

Every key is documented in [`docs/CONFIG.md`](./docs/CONFIG.md).

## Day to day

```bash
hypotenuse daemon status                 # connection, capacity, live sessions
hypotenuse agents list                   # coding agents running on this machine
hypotenuse agents kill ENG-123           # stop one (the Linear session says so)
hypotenuse worktrees list
hypotenuse worktrees cleanup --dry-run
hypotenuse session list                  # sessions across the project
hypotenuse doctor                        # checks git, agents, logins, server, clock
```

## Develop

Prerequisites: [Bun](https://bun.sh) 1.4+, Postgres (16+; CI runs 18), and Redis, all running locally. No Docker
Compose: Docker only builds deployment images.

```bash
bun install
createdb hypotenuse && createdb hypotenuse_test
cp backend/.env.example backend/.env && cp frontend/.env.example frontend/.env

bun run lint                 # tsc + biome, every workspace
bun run test                 # every workspace; the backend fetches finear (the fake Linear) first
bun dev                      # backend on :8080, frontend on :3000 — open http://localhost:3000/status
```

If `$USER` is unset in your shell, node-postgres cannot pick a role from `postgres://localhost/…`; put the user in
the URL (`postgres://you@localhost:5432/hypotenuse`) in `backend/.env`.

See [`AGENTS.md`](./AGENTS.md) for the rules and conventions, and [`docs/plans/`](./docs/plans/README.md) for the
build order.

## License

[Apache License 2.0](./LICENSE).
