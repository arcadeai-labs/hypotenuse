# Phase 01 — Foundation

> **Goal:** A Bun workspace holding a Keryx backend, a Vite/React frontend, and the `hypotenuse` operator CLI.
> All three have passing tests and run in CI behind the one required status check, **CI Complete**. Postgres has
> the `vector` extension from the first migration. The docs tests that guarded the planning-only repository move
> into the backend and keep guarding it.

> **Status: planned, not built.** It builds on the planning-only repository: `AGENTS.md`, `docs/`, the kept
> `design/` inputs, `tests/docs.test.ts`, and a CI workflow with one docs job. Everything here is scaffold.
> The phase **halts for review** before [phase 02](./phase-02-deployment.md).

Hypotenuse 2.0 starts from an almost-empty repository on purpose. v1's runner daemon, ACP host, worktrees, and
runner protocol are gone; they live on the [`v1` branch](https://github.com/arcadeai-labs/hypotenuse/tree/v1).
What 2.0 needs from day one is what v1 also needed: a Keryx server that tests boot over real HTTP, a frontend that
reads backend types without codegen, a CLI that never imports the server, and a CI gate that never needs branch
protection touched again.

Both ancestors already paid for this scaffold:

- [ToolExec](https://github.com/arcadeai-labs/toolexec) is the template for all plumbing: users, projects, RBAC,
  audit, sandboxes, and the operator CLI.
- v1 is ToolExec's scaffold, already trimmed, plus a handful of fixes found in review.

So the rule for this phase: **take a file from v1 where v1 already trimmed ToolExec, and from ToolExec where v1
never had one.** Invent nothing.

Read both foundation phases before starting:

- [ToolExec phase 1](https://github.com/arcadeai-labs/toolexec/blob/main/docs/plans/phase-01-foundation.md)
- [v1 phase 1](https://github.com/arcadeai-labs/hypotenuse/blob/v1/docs/plans/phase-01-foundation.md)

Each learnings section explains why a step below differs from what `keryx new` would produce.

Two things are new relative to v1, and both belong in the foundation:

- **pgvector from the first migration.** [Memory](./phase-09-memory.md) stores embeddings in a `vector` column,
  and the cheapest time to require a Postgres extension is before anything depends on it. Requiring it now makes
  every developer's Postgres and every CI service container right before the first embedding is written. Finding
  out in phase 09 would mean finding out from a red CI run.
- **No `protocol/` workspace.** v1 needed one because a daemon on someone's laptop and the server shared a wire
  contract. 2.0's only out-of-process peer is the in-sandbox supervisor. As in ToolExec, it is source under
  `backend/sandbox/runner/` that imports nothing from the backend and is copied into the sandbox
  ([phase 17](./phase-17-sandboxes.md)). A fourth workspace would be a package with one consumer.

## Scope

**In:**
- Repository layout and the three workspaces.
- The backend scaffold (`keryx new`) and the gaps it leaves.
- The frontend scaffold with the `@backend/*` type alias.
- An empty `cli/` that prints `--version` and `--help`.
- The test harness for every workspace.
- `workspace:setup` for running several checkouts at once.
- The `vector` extension in migration 0000 and in `/api/status`.
- Both Dockerfiles.
- The full CI workflow behind **CI Complete**.
- Moving `tests/docs.test.ts` into `backend/__tests__/docs/`, with the no-phase-names scan extended to the new
  source trees.
- `.env.example` files.
- Making `AGENTS.md`'s Local development and Commands sections true.

**Out:**
- The Render blueprint ([phase 02](./phase-02-deployment.md)).
- Tokens, UI kit, shell, and docs site frame ([phase 03](./phase-03-design-system.md)).
- Organizations, users, projects, RBAC ([phase 04](./phase-04-organizations-users-and-rbac.md)).
- Audit ([phase 05](./phase-05-audit-logging.md)).
- Any real CLI command, the release pipeline, binaries, and self-upgrade ([phase 06](./phase-06-operator-cli.md)).
- Model providers and bots ([phase 07](./phase-07-model-providers-and-bots.md)).
- finear, which arrives with [Linear](./phase-15-linear.md) because nothing before it speaks to Linear.
- The scripted model server, which arrives with the first model call ([phase 07](./phase-07-model-providers-and-bots.md)).

The only backend actions in this phase are `status` and `swagger`.

## What already exists

| Piece | Where | Take it from |
|---|---|---|
| Root `package.json` shape, `trustedDependencies: ["esbuild"]` | [ToolExec `package.json`](https://github.com/arcadeai-labs/toolexec/blob/main/package.json) | ToolExec (three workspaces, like ours) |
| `biome.json` | already in this repository | kept as is |
| `backend/bunfig.toml`, trimmed `backend/__tests__/setup.ts` | [v1 `backend/__tests__/setup.ts`](https://github.com/arcadeai-labs/hypotenuse/blob/v1/backend/__tests__/setup.ts) | v1, without finear, runner, daemon, and Linear helpers |
| `backend/actions/status.ts` (schema probe column, `tracing = false`) | [v1 `backend/actions/status.ts`](https://github.com/arcadeai-labs/hypotenuse/blob/v1/backend/actions/status.ts) | v1, without the Linear URL block |
| `backend/scripts/{workspace,setup-workspace}.ts` | v1 | v1, including the two review fixes and `__tests__/scripts/workspace.test.ts` |
| `backend/scripts/start-ngrok.ts`, `ngrok.yml` | v1 | v1; [phase 02](./phase-02-deployment.md) explains why a public URL is needed from the first platform onward |
| Frontend configs, `utils/client.ts` (`apiFetch`) | [v1 `frontend/`](https://github.com/arcadeai-labs/hypotenuse/tree/v1/frontend) | v1's configs, without the design system (that is [phase 03](./phase-03-design-system.md)) |
| `cli/` skeleton, `imports.test.ts` | v1 | v1, without `protocol` and daemon dependencies |
| Dockerfiles, `frontend/nginx.conf` | v1 | v1, with `protocol/` removed from the copy steps; nginx keeps `absolute_redirect off` |
| Docs tests | `tests/docs.test.ts` in this repository | moved, not rewritten |
| CI gate | `.github/workflows/ci.yml` in this repository | extended |

## What this must not weaken

1. **CI Complete stays the only required check**, and it keeps asserting that every result *is* `success`. A
   denylist fails open the day GitHub invents a new outcome; it already did once, with `abandoned`.
2. **The docs tests keep running**:
   - every relative link and anchor in `AGENTS.md`, `README.md`, and `docs/**` resolves;
   - every phase doc carries `## Learnings from the build`;
   - no phase number appears outside `docs/plans/`.

   Moving them must never leave a commit where none of these run.
3. **System Postgres and Redis, never Docker Compose.** Docker builds deployment images and, from
   [phase 17](./phase-17-sandboxes.md), is the development sandbox provider. It never runs our databases.
4. **The CLI never imports the server at runtime.** A compiled binary carrying Keryx, a Postgres driver, and Redis
   clients would be heavier. Worse, the first `import "bun"` deep in a server module would break
   `bun build --compile` for one platform only.

## Design

```
hypotenuse/
├── package.json            workspaces: backend, frontend, cli; trustedDependencies ["esbuild"]
├── biome.json              formatter only — unchanged
├── AGENTS.md  README.md  LICENSE
├── design/                 token inputs (kept); generator runs in phase 03
├── docs/                   ARCHITECTURE, DESIGN, plans/
├── backend/                Keryx app: index.ts, keryx.ts, migrations.ts, config/, actions/, schema/, ops/, …
├── frontend/               Vite + React 19 + React Router 7
└── cli/                    @arcadeai/hypotenuse — bin `hypotenuse`
```

Dependencies run one way only, and a test asserts it:

| Workspace | May import | Must never import |
|---|---|---|
| `backend/` | its own modules | `cli/`, `frontend/` |
| `cli/` | its own modules | `keryx`, `drizzle-orm`, `pg`, `ioredis`, a value import from `@backend/*` (type-only is allowed) |
| `frontend/` | `@backend/*` **type-only** | `cli/` |

**pgvector.**
- The first migration is hand-written: `CREATE EXTENSION IF NOT EXISTS vector;`. Drizzle generates every
  migration after it.
- `/api/status` reports `database.extensions.vector: true|false` and counts it in `healthy`. A server whose
  database lacks the extension is unhealthy before anything tries to write an embedding.
- Locally: `brew install pgvector` beside `postgresql@17`. In CI: the `pgvector/pgvector:pg18` service image. On
  Render, the extension is available on managed Postgres; [phase 02](./phase-02-deployment.md) asserts it.

**Keryx version.** Pin to what `keryx new` installs, which must be **≥ 0.48.2**.
- 0.48.1 fixed the WebSocket frame-ordering defect v1 filed as
  [actionhero/keryx#550](https://github.com/actionhero/keryx/issues/550).
- 0.48.2 answers an unparseable request body with a 400 instead of escaping as Bun's own 500 (#553, the fix for
  v1's [#552](https://github.com/actionhero/keryx/issues/552)).
- Record both in `AGENTS.md`'s upstream list as fixed.

## Schema sketch

No application tables. Migration `0000_vector.sql` creates the extension, and nothing else. `status.ts`'s schema
probe reads `pg_extension` until the first table lands in [phase 04](./phase-04-organizations-users-and-rbac.md).
From then on it probes the newest migration's column, because Keryx binds before `DATABASE_AUTO_MIGRATE` finishes.

## Actions and policy sketch

| Action | Route | RBAC | MCP | Audited |
|---|---|---|---|---|
| `status` | `GET /api/status` | none | never (unauthenticated introspection) | no (read) |
| `swagger` | `GET /api/swagger` | none | never | no (read) |

## Frontend and user docs

- One `/status` route renders the backend's answer typed through `ActionResponse<Status>`. It proves backend
  types reach the frontend without codegen.
- There are no user docs yet; the docs site frame is [phase 03](./phase-03-design-system.md).
- `README.md` documents the prerequisites (Bun, Postgres 18 with pgvector, Redis) and the first run.

## Steps

### 1. Repository root — `package.json`, `.gitignore`, `bun.lock`

- Replace the planning `package.json` with ToolExec's three-workspace shape, renamed `hypotenuse-workspace`.
  Scripts: `dev`, `dev:backend`, `dev:frontend`, `ngrok`, `lint`, `test`, `test:e2e`, `workspace:setup`.
- Keep `trustedDependencies: ["esbuild"]` exactly. It **replaces** Bun's default trust list, so no native addon's
  install script runs. `backend/__tests__/deps/native-addons.test.ts` asserts it.
- `bun run test` at the root, never `bun test`: Bun's own runner shadows the script and skips
  `backend/bunfig.toml`. `AGENTS.md` already says so.

### 2. Backend scaffold — `backend/`

`bunx keryx@latest new backend -y`, with database and Redis and without example actions. Then close the gaps
from v1:

- `bunfig.toml`: `timeout = 15000`, `preload = ["./__tests__/setup.ts"]`.
- `__tests__/setup.ts` keeps:
  - `import "../index"` first;
  - `HOOK_TIMEOUT`;
  - `serverUrl()` (the *bound* port);
  - `retryClearDatabase()`, `runAction()`, `drainTasks()`;
  - the narrow ioredis-teardown `unhandledRejection` filter.

  `buildTestUniverse()` arrives in [phase 04](./phase-04-organizations-users-and-rbac.md).
- `tsconfig.json`: strict, `bundler`, `verbatimModuleSyntax`, `noUnused*`, with `drizzle` excluded.
- `config/`: keep the scaffold's (newer than ToolExec's). Application namespaces arrive with the phases that read
  them.
- `actions/status.ts`: from v1, with the `vector` check added.
- Delete the scaffold's `users`, `sessions`, and `me`. ToolExec's versions arrive in phase 04.
- `lua/.gitkeep`: an empty `lua/` directory fails boot, and git keeps no empty directories.

If the scaffold is broken in a way that is new, **rule 4 applies on day one**: file it at
[`actionhero/keryx`](https://github.com/actionhero/keryx/issues) with a minimal repro, and stop.

### 3. Backend environment — `backend/.env.example`

Start from v1's. Delete every `LINEAR_*`, runner, and daemon key. Keep the `_TEST` variants, including:

- `TASK_PROCESSORS_TEST=0`. A bare `TASK_PROCESSORS=1` started a Resque worker under `bun test` in v1's CI.
- `RATE_LIMIT_ENABLED_TEST=false`.
- `WEB_SERVER_PORT_TEST=0`.

Add `SECRETS_ENCRYPTION_KEY` (declared now, read from [phase 04](./phase-04-organizations-users-and-rbac.md)).
Remember that `loadFromEnvIfSet` checks `X_<NODE_ENV>` first.

### 4. pgvector — `backend/drizzle/0000_vector.sql`, `backend/actions/status.ts`

Write the hand-written extension migration and the status check above. Then
`backend/__tests__/actions/status.test.ts` boots the real server and asserts `healthy` with database, Redis, and
`vector` all true, run **twice in a row**. That proves per-file random ports and test-database isolation.

### 5. Frontend scaffold — `frontend/`

Copy v1's configs: `package.json`, `vite.config.ts`, `tsconfig*.json`, `biome.json`, `index.html`, `devTunnel.ts`,
`.env.example`, `nginx.conf`.

- `resolve.alias["@backend"]` in `vite.config.ts` and `paths["@backend/*"]` in `tsconfig.app.json` are
  **configured twice and must agree**.
- `erasableSyntaxOnly` stays off: Keryx's source uses enums.
- Copy `src/utils/client.ts` (`apiFetch<T>`) and its test.

### 6. Several checkouts at once — `backend/scripts/{workspace,setup-workspace}.ts`

Copy v1's, with `HYPOTENUSE_WORKSPACE_ID` and the `hypotenuse_test` database stem. It is a setup step, not a
runtime rule: a single clone skips it. Parallel agent forks on this repository depend on it, which `AGENTS.md`
already says.

### 7. The empty CLI — `cli/`

- `package.json`:
  - name `@arcadeai/hypotenuse`;
  - version `2.0.0-alpha.0` (the major bump is argued in [phase 06](./phase-06-operator-cli.md));
  - `repository.url` exactly `https://github.com/arcadeai-labs/hypotenuse.git`, because upgradr derives the
    GitHub repository from it.
- `src/cli.ts`: a commander program with `--version`.
- Tests:
  - `__tests__/version.test.ts`: from source.
  - `__tests__/imports.test.ts`: enforces the dependency table.
- `bun run build` compiles one binary. CI builds it from this phase on, so a `--compile` regression is caught
  before it becomes a release problem.

### 8. Docs tests move — `backend/__tests__/docs/{links,no-phase-names}.test.ts`

- Move `tests/docs.test.ts` into two files: `links.test.ts` and `no-phase-names.test.ts`. Delete `tests/`.
- The no-phase-names scan covers:
  - `backend/**/*.{ts,tsx,sql,json,md}`;
  - `frontend/src/**/*.{ts,tsx,css,scss,md}`;
  - `cli/**/*.{ts,tsx,md,json}`.

  It ignores `node_modules`, `dist`, `.cache`, `drizzle/meta`, and `backend/.finear`, and asserts that more than
  ten files were scanned. Without that floor, a glob that matched nothing would pass.
- The plan-count guard in `links.test.ts` is `> 20`, because this repository plans 23 phases.
- Do this move in the **same commit** as the CI change in step 9, so no commit leaves the docs unchecked.

### 9. CI — `.github/workflows/ci.yml`

Replace the planning `docs` job with ToolExec's jobs, minus the sandbox-image and Kubernetes jobs:

| Job | Name | Services |
|---|---|---|
| `backend-lint` | Backend Lint | — |
| `backend-test` | Backend Test | `pgvector/pgvector:pg18`, `redis` |
| `backend-docker` | Backend Docker | — |
| `cli` | CLI Lint, Test & Build | — |
| `frontend-lint` | Frontend Lint | — |
| `frontend-test` | Frontend Test | — (unit tests, then `bun run build`) |
| `frontend-docker` | Frontend Docker | — |
| `complete` | **CI Complete** | — |

The `complete` job keeps its exact shape:
- `if: always()`;
- `needs:` lists every other job;
- `needs` is passed through `env`, never interpolated into the script;
- `jq -e 'to_entries | all(.value.result == "success")'`.

A job added later goes into `needs`, never into branch protection.

### 10. Dockerfiles — `backend/Dockerfile`, `frontend/Dockerfile`

Copy v1's and drop `protocol/` from the copy lists.
- The backend image runs `bun keryx.ts build`, which pre-generates the swagger cache. Without it, boot peaks
  around 1.4 GB.
- The frontend build copies `backend/` sources because of the `@backend` type alias.

### 11. Invariant tests ported on day one

| Test | Asserts |
|---|---|
| `backend/__tests__/deps/native-addons.test.ts` | root `trustedDependencies` is exactly `["esbuild"]` |
| `backend/__tests__/config/tasks.test.ts` | `TASK_PROCESSORS_TEST=0` wins under test |
| `backend/__tests__/scripts/workspace.test.ts` | the workspace script's two review fixes |
| `cli/__tests__/imports.test.ts` | the dependency table |

## Test plan

- `backend`: status twice; the `vector` check (a test database without the extension reports `healthy: false`,
  driven by `DROP EXTENSION` in a throwaway database); docs, native-addon, task-config, and workspace tests.
- `frontend`: `apiFetch` prefixes `/api`, sends `credentials: "include"`, and throws on an error envelope
  returned with a 200.
- `cli`: version from source and from a compiled binary; imports.

## Verification

```bash
bun install
brew install pgvector && createdb hypotenuse && createdb hypotenuse_test
cd backend && cp .env.example .env && bun run migrations && bun run lint && bun test
cd ../cli && bun run lint && bun test && bun run build && ./dist/hypotenuse --version
cd ../frontend && cp .env.example .env && bun run lint && bun run build && bun test
cd .. && bun dev && curl -s localhost:8080/api/status | jq '.database'
```

- `bun test` in `backend/` answers `/api/status` with `healthy: true` and `vector: true`, twice.
- A PR shows every job plus CI Complete. Breaking one assertion turns the gate red.
- `bun run workspace:setup --dry-run` in a linked worktree prints a distinct database and Redis index.

## Definition of done

- [ ] Root workspace with `backend/`, `frontend/`, `cli/`; `bun dev` runs the backend and the frontend
- [ ] `backend/bunfig.toml` and a trimmed `__tests__/setup.ts`; the status test passes twice in a row
- [ ] Migration 0000 creates `vector`; `/api/status` reports it and counts it in `healthy`
- [ ] Local docs, CI services, and `.env.example` all require pgvector
- [ ] The docs tests live in `backend/__tests__/docs/` and scan the new source trees; `tests/` is gone
- [ ] The native-addon, task-config, workspace, and CLI imports tests pass
- [ ] Both Dockerfiles build in CI
- [ ] CI runs seven jobs plus CI Complete, which asserts every result is `success`
- [ ] `AGENTS.md` Local development and Commands are true
- [ ] **Stop for review** before [phase 02](./phase-02-deployment.md)

## Open questions

- Whether CI should also run against plain `postgres:18` with the extension installed by a step, so a Render
  version skew is caught. The default is the pgvector image alone.

## Learnings from the build

Not built yet.
