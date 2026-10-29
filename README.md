# Hypotenuse

**A persistent multiplayer, multichannel agent for your team.**

Mention a bot in a Slack thread, delegate a Linear issue to it, or let it pick up a Pylon ticket. It answers where you
asked, with its own identity, its own tools, and its own memory of that place. When the work needs code, it starts an
ephemeral sandbox that clones the repository, makes the change, and opens a pull request — and reports back, asks
questions, or asks for help in the same conversation.

- **Bots with identities.** Each bot has its own prompts, goals, model, and its own Slack and Linear app.
- **Memory with boundaries.** Each Slack channel, Linear project, or Pylon customer has its own memory, which fades
  with disuse; the project has a shared memory every bot can read.
- **Shared tools.** A project's MCP servers and skills are shared by its bots. Every bot has **code mode**: it
  writes TypeScript that runs in an isolated WebAssembly sandbox against those tools and its memory.
- **Durable and multi-tenant.** Every message and tool call is stored; agent loops are background tasks that any
  worker can pick up, so many bots run many conversations at once and a restart loses nothing.
- **The platform's permissions, the project's RBAC.** Whoever can post where a bot is bound may talk to it. Who
  may configure it, read its transcripts, or edit its memory is decided by project roles, and every such decision is
  in the audit log.

> **Status: the foundation, the deployment, and the design system are built; nothing a person would call a feature
> is.** The design is
> [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) and the phased plans in [`docs/plans/`](./docs/plans/README.md). Hypotenuse **v1** — local coding agents answering
> Linear agent sessions — is archived on the [`v1` branch](https://github.com/arcadeai-labs/hypotenuse/tree/v1).

## How it fits together

```mermaid
flowchart LR
  P["Slack · Linear · Pylon"] -- webhooks --> H["Hypotenuse (Keryx)"]
  H -- "replies, status, questions" --> P
  H --> L["agent:tick tasks<br/>(durable, fanned out)"]
  L --> T["memory · MCP servers · code mode"]
  L --> S["ephemeral sandbox<br/>(Docker / Vercel)"]
  S -- "status, questions, PR" --> H
```

[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) has the whole picture; [`AGENTS.md`](./AGENTS.md) has the rules
for building it.

## Running it locally

You need [Bun](https://bun.sh), Postgres 18 with the [pgvector](https://github.com/pgvector/pgvector) extension
available, and Redis — installed on your machine, not in Docker.

```bash
brew install postgresql@18 pgvector redis && brew services start postgresql@18 redis
createdb hypotenuse && createdb hypotenuse_test
bun install
cp backend/.env.example backend/.env && cp frontend/.env.example frontend/.env
bun run test        # every workspace's tests
bun run test:e2e    # the browser suite; boots its own backend on hypotenuse_e2e
bun dev             # the API on http://localhost:8080, the app on http://localhost:3000
curl -s localhost:8080/api/status | jq '.healthy, .database'
```

The first boot migrates the database, which creates the `vector` extension; `/api/status` reports
`healthy: false` on a database without it.

## Built on

[Keryx](https://www.keryxjs.com/), with plumbing from [ToolExec](https://github.com/arcadeai-labs/toolexec) and ideas
from [botholomew](https://github.com/evantahler/botholomew), [membot](https://github.com/evantahler/membot), and
[Pi Durable](https://earendil.com/posts/pi-durable/).

## License

Apache-2.0 — see [`LICENSE`](./LICENSE).
