# Phase 1 — Foundation

> **Goal:** A Bun workspace holding a Keryx backend, a Vite/React frontend, the `hypotenuse` CLI, and the
> shared `protocol` package, all four with passing tests, all four running in CI behind a single required
> status check. `AGENTS.md` encodes the non-negotiable rules, and a fake Linear (finear) boots in-process
> inside the backend test harness before any Linear code is written.

> **Status: planned, not built.** The repository is empty. This phase is the scaffold every later phase
> builds on, and it halts for review before [phase 2](./phase-02-deployment.md).

Hypotenuse is built on the same stack and the same conventions as
[ToolExec](https://github.com/arcadeai-labs/toolexec), which is the template for everything that is not
Linear, runners, or ACP. **Copy ToolExec's shape rather than inventing one.** The files worth reading first are
`toolexec/package.json`, `toolexec/biome.json`, `toolexec/backend/bunfig.toml`,
`toolexec/backend/__tests__/setup.ts`, `toolexec/backend/scripts/{workspace,setup-workspace}.ts`,
`toolexec/frontend/vite.config.ts`, `toolexec/cli/package.json`, and `toolexec/.github/workflows/ci.yml`, and
ToolExec's own [phase 1 learnings](https://github.com/arcadeai-labs/toolexec/blob/main/docs/plans/phase-01-foundation.md#learnings-from-the-build),
which are the reason several of the steps below are not what a fresh scaffold would give you.

Two things are new relative to ToolExec and both belong in the foundation rather than later:

- **A fourth workspace, `protocol/`.** The server ⇄ daemon contract ([`RUNNER_PROTOCOL.md`](../RUNNER_PROTOCOL.md))
  is written once, as Zod schemas, and imported by both `backend/` and `cli/`. If it lived in either, the other
  would grow a hand-written copy, and the first field rename would make the two disagree on the wire without a
  type error anywhere. Creating the empty package now is what makes "where does this schema go?" have one
  answer from the first PR that needs it.
- **finear in the test harness.** Every Linear-facing test in this repository runs against
  [finear](https://github.com/pmdroid/finear), a fake Linear that serves Linear's own GraphQL schema, a real
  OAuth consent flow, and signed webhooks. Proving it boots inside `bun test` now — before
  [phase 6](./phase-06-linear-connection.md) depends on it — means the first Linear plan starts with a working
  fake instead of discovering its integration gaps under deadline.

## Scope

**In:** repo layout and the four workspaces; the backend scaffold (`keryx new`) and the gaps it leaves; the
frontend scaffold with the `@backend/*` type alias; an empty `cli/` that prints `--version` and `--help`; an
empty `protocol/` exporting `PROTOCOL_VERSION`; the test harness for every workspace; the finear dev
dependency and its in-process smoke test; `workspace:setup` for several checkouts; Dockerfiles; CI with a
`complete` gate; branch protection; `AGENTS.md` (Claude Code reads it directly; no `CLAUDE.md`); the docs-links test;
`.env.example` files; local development instructions in `README.md`.

**Out:** the Render blueprint ([phase 2](./phase-02-deployment.md)). Theming, users, projects, RBAC, audit,
notifications ([phase 4](./phase-04-users-tenancy-and-audit.md)). Any real CLI command, the release pipeline,
binaries, and self-upgrade ([phase 5](./phase-05-cli-and-distribution.md)). Anything that talks to Linear
([phase 6](./phase-06-linear-connection.md) onward). The only backend actions in this phase are the
framework's own `status` and `swagger`.

## Design

```
hypotenuse/
├── package.json            workspaces: backend, frontend, cli, protocol
├── biome.json              formatter only (2 spaces, width 80, double quotes) — copied from ToolExec
├── AGENTS.md               the rules (read by Claude Code and other agents)
├── README.md
├── docs/                   ARCHITECTURE, RUNNER_PROTOCOL, CONFIG, LINEAR_COVERAGE, DEPLOY, plans/
├── backend/                Keryx app (index.ts, keryx.ts, migrations.ts, config/, actions/, schema/, …)
├── frontend/               Vite + React 19 + React Router 7 + Tailwind v4 + local UI kit
├── cli/                    @arcadeai/hypotenuse — bin `hypotenuse` (src/cli.ts, Bun shebang)
└── protocol/               @hypotenuse/protocol — Zod schemas, no runtime dependencies but zod
```

Dependency direction is one-way and asserted by a test (step 11):

| Workspace | May import | Must never import |
|---|---|---|
| `protocol/` | `zod` | anything in this repo |
| `backend/` | `protocol/` | `cli/`, `frontend/` |
| `cli/` | `protocol/` (bundled into the binary) | `backend/` at runtime (type-only `@backend/*` is allowed, as in ToolExec), `keryx`, `drizzle-orm` |
| `frontend/` | `@backend/*` **type-only**, `protocol/` types | `cli/` |

The CLI is a separate product that runs on somebody's laptop. If it imported Keryx at runtime, a compiled
binary would carry a web framework, a Postgres driver, and Redis clients it never uses — and the first
`import "bun"` deep in a server module would break `bun build --compile` for one platform only.

## Steps

### 1. Repo root — `package.json`, `biome.json`, `.gitignore`, `.dockerignore`

```json
{
  "name": "hypotenuse-workspace",
  "private": true,
  "type": "module",
  "workspaces": ["backend", "frontend", "cli", "protocol"],
  "trustedDependencies": ["esbuild"],
  "scripts": {
    "dev": "bun run --parallel dev:backend dev:frontend",
    "dev:backend": "bun run --cwd backend dev",
    "dev:frontend": "bun run --cwd frontend dev",
    "ngrok": "bun run --cwd backend scripts/start-ngrok.ts",
    "lint": "bun run --cwd protocol lint && bun run --cwd backend lint && bun run --cwd frontend lint && bun run --cwd cli lint",
    "test": "bun run --cwd protocol test && bun run --cwd backend test && bun run --cwd frontend test && bun run --cwd cli test",
    "test:e2e": "bun run --cwd frontend test:e2e",
    "workspace:setup": "bun run --cwd backend workspace:setup"
  }
}
```

- `biome.json` — copy `toolexec/biome.json` verbatim (formatter only, linter disabled, organize imports).
- `trustedDependencies: ["esbuild"]` **replaces** Bun's default trust list, so no native addon's install
  script runs. Keep it exactly; ToolExec's `deps/native-addons.test.ts` is ported in step 11 to assert it.
- `.gitignore` adds `dist/`, `*.sqlite`, `.env`, `test-results/`, `playwright-report/`, `.cache/`.
- **`bun run test`, never `bun test`, at the root** — Bun's own runner shadows the script and skips
  `backend/bunfig.toml`. Say so in `AGENTS.md`.

### 2. Backend scaffold — `backend/`

```bash
bunx keryx@latest new backend -y      # with database and Redis; no example actions
```

Pin `keryx` to the version the scaffold installs, which must be **≥ 0.48** (the version the research for
these plans read; ToolExec's floor of 0.42.4 is the loopback OAuth redirect fix the CLI login in
[phase 5](./phase-05-cli-and-distribution.md) depends on). Then close the gaps, copying from ToolExec:

| File | Source | Why |
|---|---|---|
| `backend/bunfig.toml` | `toolexec/backend/bunfig.toml` | `timeout = 15000`, `preload = ["./__tests__/setup.ts"]` |
| `backend/__tests__/setup.ts` | `toolexec/backend/__tests__/setup.ts`, **trimmed** | keep `import "../index"` first, `setMaxListeners(999)`, `HOOK_TIMEOUT`, `serverUrl()` (the *bound* port), `retryClearDatabase()`, `runAction()`, `drainTasks()`, and the narrow ioredis-teardown `unhandledRejection` filter. Drop GitHub-App, Docker, and sandbox helpers. `buildTestUniverse()` arrives in [phase 4](./phase-04-users-tenancy-and-audit.md) |
| `backend/tsconfig.json` | `toolexec/backend/tsconfig.json` | strict, `bundler`, `verbatimModuleSyntax`, `noUnused*`; exclude `drizzle` |
| `backend/biome.json` | `toolexec/backend/biome.json` | — |
| `backend/config/index.ts` + framework namespaces | `toolexec/backend/config/` minus `runs.ts`, `sandbox.ts`, `proxy.ts`, `secrets.ts`, `audit.ts`, `notifications.ts`, `sentry.ts` | app namespaces arrive with the phases that read them |
| `backend/actions/status.ts` | `toolexec/backend/actions/status.ts` | replaces Keryx's built-in; sets `tracing = false`. Its schema probe column moves with every migration (ToolExec phase 1 learnings: the server binds before migrations finish) |
| `backend/scripts/{workspace,setup-workspace}.ts` | ToolExec, renamed | see step 7 |
| `backend/scripts/start-ngrok.ts`, `/ngrok.yml` | ToolExec, renamed | see [phase 2](./phase-02-deployment.md) — Linear will not deliver to `localhost` |

If the scaffold is broken in a way ToolExec already filed upstream and the fix has shipped, take the fixed
version; if a new scaffold bug appears, **rule 4 applies on day one**: file it at
[`actionhero/keryx`](https://github.com/actionhero/keryx/issues) and stop.

Scripts (`backend/package.json`):

```json
"start":           "bun keryx.ts start",
"dev":             "bun --watch keryx.ts start",
"migrations":      "bun run migrations.ts",
"workspace:setup": "bun run scripts/setup-workspace.ts",
"test":            "bun test",
"lint":            "tsc && biome check .",
"format":          "tsc && biome check --write ."
```

### 3. Backend env — `backend/.env.example`

Start from `toolexec/backend/.env.example` and delete every sandbox, run, proxy, GitHub-App, and model block.
What remains, plus the Linear keys that later phases read (declared now, empty, so the shape of a working
`.env` is visible from the first clone):

```bash
NODE_ENV=development
PROCESS_NAME=hypotenuse
WEB_SERVER_PORT=8080
WEB_SERVER_PORT_TEST=0                 # random free port per test file
APPLICATION_URL=http://localhost:8080
FRONTEND_URL=http://localhost:3000
WEB_SERVER_ALLOWED_ORIGINS=http://localhost:3000
DATABASE_URL=postgres://localhost:5432/hypotenuse
DATABASE_URL_TEST=postgres://localhost:5432/hypotenuse_test
DATABASE_AUTO_MIGRATE=true
REDIS_URL=redis://localhost:6379/0
REDIS_URL_TEST=redis://localhost:6379/1
MCP_SERVER_ENABLED=true
RATE_LIMIT_UNAUTH_LIMIT=100            # e2e signs up several users; see ToolExec phase 1 learnings
LOG_LEVEL=info
LOG_LEVEL_TEST=fatal

# Linear — read from the Linear connection onward; empty until then
LINEAR_CLIENT_ID=
LINEAR_CLIENT_SECRET=
LINEAR_WEBHOOK_SECRET=
LINEAR_API_URL=https://api.linear.app
LINEAR_OAUTH_URL=https://linear.app
```

`loadFromEnvIfSet` checks `${VAR}_${NODE_ENV}` before `${VAR}`, so `_TEST` variants select themselves when
`bun test` sets `NODE_ENV=test`. Create both databases: `createdb hypotenuse && createdb hypotenuse_test`.
**System Postgres and Redis, never Docker Compose** — the same rule as ToolExec, for the same reasons.

### 4. Backend smoke test — `backend/__tests__/actions/status.test.ts`

Copy ToolExec's: boot the real server, `GET /api/status`, assert 200 with healthy database and Redis checks.
This proves the harness end to end, and running it twice in a row proves per-file random ports and test
database isolation.

### 5. finear in the harness — `backend/__tests__/linear/finear.ts`

finear is not published to npm (`"private": true`) and has no Docker image. Add it as a **git dev
dependency pinned to a commit**, so an upstream change can never alter a test's meaning without a PR here:

```json
// backend/package.json
"devDependencies": {
  "finear": "github:pmdroid/finear#c0a3036"
}
```

finear pins Bun via `.bun-version`; if it needs a newer Bun than CI's, that is finear's problem to file, not
ours to work around (`AGENTS.md`: **finear gaps go upstream**, the same discipline as Keryx bugs).

The helper wraps finear's in-process API so every later Linear test reads the same way:

```ts
import { createApplication } from "finear/src/application";

/** Boots finear in-process on a random port with an in-memory database, and tears it down after the file. */
export function useFinear(options: { clients?: FinearClientConfig[] } = {}) {
  let app: Awaited<ReturnType<typeof createApplication>>;
  const controlToken = crypto.randomUUID();
  beforeAll(async () => {
    app = await createApplication({ databasePath: ":memory:", port: 0, controlToken, clients: options.clients ?? [] });
  }, HOOK_TIMEOUT);
  afterAll(async () => { await app.close(); }, HOOK_TIMEOUT);
  return {
    url: () => app.url,
    controlToken,
    drain: () => app.drain(),          // flush the webhook outbox now
    advance: (ms: number) => app.advance(ms),
    reset: () => app.reset(),
  };
}
```

This phase only needs the smoke test, `backend/__tests__/linear/finear-smoke.test.ts`: boot finear, query
`viewer { id name }` with the fixture key `finear-fixture-primary-key` over real HTTP, and assert the fixture
user "Human 1" answers. Registering an OAuth client with a webhook, scripting consent, and the clock-skew
tolerance arrive with [phase 6](./phase-06-linear-connection.md) and
[phase 7](./phase-07-webhook-ingress-and-session-mirror.md); record in this phase's learnings anything finear
did that surprised you.

### 6. Frontend scaffold — `frontend/`

Do **not** `bun create vite` from nothing: ToolExec's frontend has already paid for every lesson in its
phase 1 and phase 3 learnings. Copy the configuration and the bare app, then delete everything domain-shaped:

- Configs, verbatim and renamed: `frontend/{package.json,vite.config.ts,tsconfig.json,tsconfig.app.json,
  tsconfig.node.json,biome.json,index.html,devTunnel.ts,.env.example,playwright.config.ts}`.
- `vite.config.ts` keeps `resolve.alias["@backend"]` and `tsconfig.app.json` keeps
  `"paths": { "@backend/*": ["../backend/*"] }` — **configured twice and they must agree**. Keep
  `erasableSyntaxOnly` off; Keryx's source uses enums.
- `frontend/src/utils/client.ts` — ToolExec's `apiFetch<T>`: prefixes `${VITE_API_URL}/api`, sends
  `credentials: "include"`, throws on Keryx's `{ error: { message } }` envelope even on HTTP 200.
- `frontend/src/main.tsx` and `frontend/src/App.tsx` with a single `/status` route rendering the backend's
  status through `ActionResponse<Status>` — the proof that backend types reach the frontend without codegen.
- The UI kit (`frontend/src/ui/*`), styles, and theme are ported in
  [phase 4](./phase-04-users-tenancy-and-audit.md), not here.

Scripts: `dev`, `build` (`tsc -b && vite build`), `test` (`bun test src/__tests__`), `lint`
(`tsc -b && biome check .`), `test:e2e` (`playwright test`).

Smoke test, `frontend/src/__tests__/client.test.ts` (copied): `apiFetch` prefixes `/api`, sends
`credentials: "include"`, and throws on an error envelope returned with a 200.

### 7. Several checkouts at once — `backend/scripts/{workspace,setup-workspace}.ts`

Copy ToolExec's verbatim, renaming `TOOLEXEC_WORKSPACE_ID` → `HYPOTENUSE_WORKSPACE_ID` and the database stem
`toolexec_test` → `hypotenuse_test`. It derives a workspace id (explicit env, Conductor, Orca, or a linked git
worktree), then writes `DATABASE_URL_TEST`, `REDIS_URL_TEST`, and the two e2e ports into `.env` once. It is a
setup step, not a runtime rule: skipping it is the right answer for a single clone. This matters more here
than in ToolExec, because Hypotenuse's own users will run coding agents in many worktrees of *this* repo.

### 8. The empty `protocol/` workspace — `protocol/`

```
protocol/
├── package.json     {"name": "@hypotenuse/protocol", "private": true, "type": "module",
│                     "exports": {".": "./src/index.ts"}, "dependencies": {"zod": "^4"}}
├── tsconfig.json    same strict settings as cli/
├── biome.json
├── src/index.ts     export const PROTOCOL_VERSION = 1;
└── __tests__/version.test.ts
```

Source-only: both consumers compile it themselves (Keryx runs TypeScript directly, and `bun build --compile`
bundles it into the CLI). There is nothing to publish. Every schema the daemon and the server exchange lands
here, starting in [phase 8](./phase-08-runners.md).

### 9. The empty `cli/` workspace — `cli/`

Enough to prove the package shape that [phase 5](./phase-05-cli-and-distribution.md) fills in:

- `cli/package.json`: `"name": "@arcadeai/hypotenuse"`, `"version": "0.0.1"`, `"type": "module"`,
  `"bin": { "hypotenuse": "./src/cli.ts" }` (the published package points it at a bundled
  `dist/hypotenuse.js` instead — [phase 5](./phase-05-cli-and-distribution.md) explains why), `"repository": { "type": "git", "url":
  "https://github.com/arcadeai-labs/hypotenuse.git" }` (exact — `upgradr` derives the GitHub repo from it),
  dependencies `commander`, `@hypotenuse/protocol` (`workspace:*`).
- `cli/src/cli.ts`: `#!/usr/bin/env bun`, a commander program with `--version` read from `package.json`.
- `cli/__tests__/version.test.ts`: spawns `bun run src/cli.ts --version` and asserts the package version.
- `cli/__tests__/imports.test.ts`: walks `cli/src/**` and fails on any import of `keryx`, `drizzle-orm`,
  `pg`, `ioredis`, or a value import from `@backend/*` (the dependency-direction table above).
- `bun run --cwd cli build` = `bun build --compile --minify --sourcemap ./src/cli.ts --outfile dist/hypotenuse`
  — built in CI from this phase on, so a `--compile` regression is caught before it is a release problem.

### 10. Dockerfiles — `backend/Dockerfile`, `frontend/Dockerfile`, `frontend/nginx.conf`

Copy ToolExec's, renamed:

- Backend: `oven/bun:1` → `oven/bun:1-slim`, copy the root `bun.lock` **plus every workspace's
  `package.json`** (four now) before `bun install --frozen-lockfile`, copy `protocol/` and `backend/`,
  `RUN bun keryx.ts build` (pre-generates the OpenAPI cache; without it boot peaks around 1.4 GB),
  `WORKDIR /app/backend`, `EXPOSE 10000`, `CMD ["bun", "keryx.ts", "start"]`.
- Frontend: same install prelude, then copy `protocol/`, `backend/`, and `frontend/` — the Vite build needs
  backend *sources* for the `@backend` type alias — `RUN bun run --cwd frontend build`, runtime
  `nginx:1.27-alpine` with SPA fallback on port 10000. `VITE_API_URL` is a build `ARG`.

### 11. Invariant tests ported on day one

Each of these is a few dozen lines in ToolExec and catches a class of mistake that is expensive to find late:

| Test | Source | Asserts |
|---|---|---|
| `backend/__tests__/docs/links.test.ts` | ToolExec, extended | every relative link and anchor in `AGENTS.md`, `README.md`, and `docs/**` resolves; **every `docs/plans/phase-*.md` contains `## Learnings from the build`** |
| `backend/__tests__/deps/native-addons.test.ts` | ToolExec | the root `trustedDependencies` is exactly `["esbuild"]` |
| `backend/__tests__/docs/no-phase-names.test.ts` | new | no source file under `backend/`, `frontend/src/`, `cli/`, or `protocol/` (user docs in `frontend/src/content/docs/` included) matches `/\b[Pp]hase \d+\b/` (rule 11) |
| `cli/__tests__/imports.test.ts` | new | step 9 |

### 12. CI — `.github/workflows/ci.yml`

Copy ToolExec's, minus the sandbox-image and Kubernetes jobs, plus a protocol job and a CLI build:

| Job | Name | Services |
|---|---|---|
| `protocol` | Protocol Lint & Test | — |
| `backend-lint` | Backend Lint | — |
| `backend-test` | Backend Test | `postgres:18`, `redis` |
| `backend-docker` | Backend Docker | — |
| `cli` | CLI Lint, Test & Build | — (`bun build --compile` for `bun-linux-x64` only; the full matrix is the release's job) |
| `frontend-lint` | Frontend Lint | — |
| `frontend-test` | Frontend Test | — (unit tests, then `bun run build` as a step) |
| `frontend-docker` | Frontend Docker | — |
| `complete` | **CI Complete** | — |

The gate is ToolExec's final form, not its first: `if: always()`, `needs:` every other job, `needs` passed
through `env` (never interpolated into the script), and the check asserts **every result *is* `success`**.
A denylist of `failure|cancelled` fails open the day GitHub invents an outcome — it did, `abandoned`, and
ToolExec's gate printed "All CI jobs passed" with no CI having run.

```yaml
  complete:
    name: CI Complete
    runs-on: ubuntu-latest
    if: always()
    needs: [protocol, backend-lint, backend-test, backend-docker, cli, frontend-lint, frontend-test, frontend-docker]
    steps:
      - name: Every job succeeded
        env:
          NEEDS: ${{ toJSON(needs) }}
        run: |
          echo "$NEEDS" | jq -e 'to_entries | all(.value.result == "success")' > /dev/null \
            || { echo "$NEEDS" | jq -r 'to_entries[] | "\(.key): \(.value.result)"'; exit 1; }
          echo "All CI jobs succeeded"
```

E2E arrives with the first browser-visible feature in [phase 4](./phase-04-users-tenancy-and-audit.md) and
joins `needs` then — no branch-protection change, which is the point of the gate.

### 13. Branch protection — one-time call, recorded here

"CI Complete" is the single required check, so adding a job never requires touching branch protection:

```bash
gh api -X PUT repos/arcadeai-labs/hypotenuse/branches/main/protection \
  -F required_status_checks[strict]=true \
  -F 'required_status_checks[contexts][]=CI Complete' \
  -F enforce_admins=false \
  -F required_pull_request_reviews[required_approving_review_count]=0 \
  -F restrictions=
```

### 14. `AGENTS.md` and `README.md`

`AGENTS.md` already exists from the planning PR; this phase makes its
commands block true. `README.md` documents prerequisites (Bun, Postgres 18, Redis — no Docker Compose), first
run, and a pointer to [`docs/plans/`](./README.md).

## Verification

```bash
bun install
createdb hypotenuse && createdb hypotenuse_test
cd backend && cp .env.example .env && bun run migrations && bun run lint && bun test
bun test __tests__/linear/finear-smoke.test.ts      # finear boots in-process and answers `viewer`
cd ../protocol && bun run lint && bun test
cd ../cli && bun run lint && bun test && bun run build && ./dist/hypotenuse --version
cd ../frontend && cp .env.example .env && bun run lint && bun run build && bun test
cd .. && bun dev                                     # backend :8080, frontend :3000
curl -s localhost:8080/api/status | jq
docker build -f backend/Dockerfile .
docker build -f frontend/Dockerfile --build-arg VITE_API_URL=http://localhost:8080 .
```

- `bun test` in `backend/` boots a real server on a random port and `/api/status` answers 200 with healthy
  database and Redis, **twice in a row**.
- The finear smoke test passes without network access beyond loopback.
- `dist/hypotenuse --version` prints the `cli/package.json` version from a compiled binary.
- The frontend's `/status` page renders the backend's answer typed through `ActionResponse<Status>`.
- A PR shows every job plus "CI Complete"; breaking one assertion turns the gate red; `main` refuses a direct
  push.
- `bun run workspace:setup --dry-run` in a linked worktree prints a distinct database and Redis index.

## Definition of done

- [ ] Root workspace with `backend/`, `frontend/`, `cli/`, `protocol/`; `bun dev` runs backend and frontend
- [ ] `backend/bunfig.toml` and a trimmed `backend/__tests__/setup.ts` exist; status test passes twice
- [ ] `backend/.env.example` covers dev and `_TEST` variants and declares the empty `LINEAR_*` keys
- [ ] finear is a pinned git dev dependency; `useFinear()` exists; the smoke test passes in CI
- [ ] `protocol/` exports `PROTOCOL_VERSION`; `cli/` prints its version from source and from a compiled binary
- [ ] The dependency-direction, native-addon, docs-links, and no-phase-names tests pass
- [ ] Both Dockerfiles build from the repo root
- [ ] CI runs eight jobs plus "CI Complete", which asserts every result is `success`
- [ ] Branch protection on `main` requires exactly "CI Complete"
- [ ] `AGENTS.md` and `README.md` commands are true

**Stop here for review before [phase 2](./phase-02-deployment.md).**

## Learnings from the build

_Nothing yet — this phase has not been built._
