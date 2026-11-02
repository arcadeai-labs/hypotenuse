# Phase 19 — Vercel sandboxes

> **Goal:** A production project runs its sandbox jobs on Vercel Sandbox, with the same behaviour it had on Docker in development. A project admin connects a Vercel account, picks it as the sandbox provider, and optionally turns on a deny-by-default egress allowlist. Bots keep starting jobs exactly as before.

> **Status: built.** Builds on [sandboxes](./phase-17-sandboxes.md) (interface, registry, ledger, supervisor, job token) and [git and pull requests](./phase-18-git-and-pull-requests.md) (git hosts on the allowlist). It also delivers the provider-conformance suite that any later provider (Kubernetes, E2B, exe.dev, SSH) must pass.

Docker is development-only by design. Its bridge network gives a container unrestricted egress, so it refuses a deny-all policy rather than pretend to enforce one. Production needs a hosted provider. ToolExec chose Vercel Sandbox as its first, for these properties:

- live egress updates (`sandbox.update({ networkPolicy })`), so a job can install with the network open and then narrow before the agent runs;
- reattach to a running command after a worker restart;
- a 24 h ceiling;
- a TypeScript SDK (`@vercel/sandbox`).

That provider ports nearly line for line. This phase also adds the piece ToolExec never had: one conformance suite that runs every provider through the same contract, so "works on Docker" means "works".

## Scope

**In:**

- **The provider.** `backend/sandbox/providers/vercel.ts`, ported from ToolExec:
  - `@vercel/sandbox` SDK;
  - `node24` default runtime;
  - the runtime installed during provisioning, because Vercel runs stock runtimes only (`bakesRuntimeIntoImage: false`): bun, Claude Code, `gh-real`, and the supervisor;
  - at most 5 tags per sandbox (`managed: hypotenuse`, `job`, `project`).
- **The connection.** A project-level `vercel` sandbox connection (token, team id, project id), stored encrypted. A probe calls the SDK's list with our tag before saving, so a bad token fails at save time.
- **Egress modes.**
  - `open-world` (default, as in ToolExec).
  - `allowlist`: deny-by-default with our API host, the model proxy host, git hosts from the job's grants (`github.com` + `api.github.com`), and package registries needed during install. These are opened during install and narrowed before the CLI launches.
  - A bot can *require* `allowlist`. A job for such a bot refuses to start on a provider without `domainEgressAllowlist`.
- **Production guards.** `productionAllowed: true` for Vercel. Docker stays refused under `NODE_ENV=production` at both guards.
- **Conformance suite.** `backend/__tests__/sandbox/conformance.ts` is a parameterised suite every provider runs:
  - create, list (only ours), connect;
  - writeFiles with mode, readFile, exec, spawn + events + wait + kill;
  - attach after a dropped handle;
  - setEgress (honoured, or throws per capabilities), extendTimeout;
  - destroy and orphan sweep.

  Docker runs it in CI. Vercel runs it nightly against a real account (outside the CI gate, as v1's real-agent test was).
- Cost/limits per provider in the job view (vCPU, memory, timeout).

**Out:**

- Snapshots/sleep-and-wake (ToolExec's checkpoint design): a later phase.
- Other providers. The conformance suite and registry are the door.
- Region pinning. `CreateSandboxOptions.region` exists and nothing reads it yet.

## What already exists

| Piece | Where | Carry |
|---|---|---|
| Vercel provider | [`toolexec: backend/sandbox/providers/vercel.ts`](https://github.com/arcadeai-labs/toolexec/blob/main/backend/sandbox/providers/vercel.ts) | Port; tags renamed |
| Credential plumbing | [`toolexec: backend/ops/SandboxCredentialOps.ts`](https://github.com/arcadeai-labs/toolexec/blob/main/backend/ops/SandboxCredentialOps.ts), `connections/registry.ts`, `connections/probes/` | Port |
| Provider survey | [`toolexec: docs/SANDBOX_PROVIDERS.md`](https://github.com/arcadeai-labs/toolexec/blob/main/docs/SANDBOX_PROVIDERS.md) | The record of why Vercel first and what comes next (E2B, Daytona, Modal) |
| Registry, interface, ledger, supervisor | [sandboxes](./phase-17-sandboxes.md) | Unchanged |

## What this must not weaken

1. **Callers branch on `capabilities`, never on a provider's name.** Nothing outside the provider file, the registry entry, and the connection definition names Vercel.
2. **A provider that cannot honour a policy throws.** It never silently runs unfirewalled.
3. **`list()` returns only sandboxes Hypotenuse created**, filtered by the managed tag, because the orphan sweeper destroys the difference.
4. **The project's Vercel token never reaches a sandbox, a response, or a log.** Provider errors are scrubbed of the token's plaintext before they are recorded.
5. **Ledger first.** The `creating` row exists before `provider.create` is called.

## Design

### 1. Provider shape

```ts
export const VERCEL_CAPABILITIES: ProviderCapabilities = {
  domainEgressAllowlist: true, liveEgressUpdate: true, reattach: true, maxTimeoutMs: 24 * 60 * 60 * 1000,
};
// sandboxConfig: { runtime?: "node24" | …, vcpus?: 1..8 (2 GiB per vCPU), egressMode?: "open-world" | "allowlist" }
```

`create` maps `CreateSandboxOptions` onto the SDK. `spawn` returns an `ExecHandle` whose `events()` wraps the SDK's async generator. `attach(handleId)` re-finds the command by id. `setEgress` calls `sandbox.update({ networkPolicy })`.

### 2. Provisioning order, unchanged

Create wide → install runtime and tools → `setEgress(allowlist)` if the mode says so → clone prologue (git hosts already open) → launch. Downloads happen before egress narrows. Repository contents arrive after, through the opened git hosts.

### 3. Choosing a provider

`project_settings.sandboxProvider` is `docker | vercel`. A save validates:

- the connection exists and probes;
- the environment allows the provider;
- every bot that requires an allowlist is compatible (warn otherwise).

A job reads the provider when it starts, not when it is created. A job created before an admin switched providers starts on the new one.

## Schema sketch

One table ported, no new ones of our own:

- `project_connections` — ToolExec's sealed connection table, ported here because Vercel is its first kind (Docker
  needs no credentials) — holds kind `vercel`, with credentials `{ token (sealed), teamId, projectId }`.
- `project_settings`: `sandboxProvider`, `sandboxConfig jsonb`.
- `bots.settings.requireEgressAllowlist boolean`.

## Actions and policy sketch

| Action | Route | RBAC | MCP | Audited |
|---|---|---|---|---|
| `connection:create` (kind `vercel`) | `PUT /project/:projectId/connection` | admin | yes | yes |
| `connection:test` | `POST /project/:projectId/connection/:id/test` | admin | yes | no |
| `project:settings-edit` (provider, config) | existing | admin | yes | yes |
| `sandbox:list` | `GET /project/:projectId/sandboxes` (paginated) | member | yes | no |
| `sandbox:destroy` | `DELETE /sandbox/:id` | admin | yes | yes |

`token` stays in `SENSITIVE_KEYS`.

## Frontend and user docs

- **Project settings → Sandboxes:** provider picker (Docker labelled "development only" and disabled in production), Vercel connection form with a test button, egress mode with an explanation of what is opened.
- **Sandboxes list** (ledger view): live sandboxes, their jobs, and a destroy button.
- `frontend/src/content/docs/sandboxes.md` gains a "Vercel" section: creating a token, team and project ids, allowlist mode and what it blocks.

## Steps

### 1. Provider — `backend/sandbox/providers/vercel.ts`, `backend/sandbox/registry.ts`

### 2. Connection — `backend/connections/{registry.ts,probes/vercel.ts}`, `backend/ops/SandboxCredentialOps.ts`

### 3. Allowlist — `backend/ops/SandboxProvisionOps.ts` (`buildEgressAllowlist` with install-time and run-time sets)

### 4. Conformance — `backend/__tests__/sandbox/conformance.ts`, `backend/__tests__/sandbox/docker.conformance.test.ts`, `backend/__tests__/sandbox/vercel.conformance.test.ts`

### 5. Nightly — `.github/workflows/nightly-vercel-sandbox.yml` (skips without `VERCEL_TOKEN`; opens an issue on failure; outside the CI gate)

### 6. Frontend and docs — `frontend/src/pages/settings/SandboxSettings.tsx`, `frontend/src/content/docs/sandboxes.md`

## Test plan

- **Conformance:** the Docker run is in CI, and every case is named after a `SandboxProvider` method. The Vercel run is nightly.
- **Production guard:** Docker refused at settings-save and at job start under production; Vercel accepted.
- **Allowlist:** a job's sandbox reaches our API and `github.com` but not `example.com` (nightly, real Vercel). The install step succeeds before narrowing.
- **Capability refusal:** a bot requiring an allowlist cannot start a job on Docker. The refusal is a sentence a model can act on.
- **Reattach:** kill the worker mid-job on Vercel; the job finishes and the parent wakes (nightly).
- **Token scrubbing:** a Vercel auth error recorded on a job contains no token plaintext.

## Verification

```bash
cd backend && bun test __tests__/sandbox
VERCEL_TOKEN=… VERCEL_TEAM_ID=… VERCEL_PROJECT_ID=… bun test __tests__/sandbox/vercel.conformance.test.ts
```

By hand on staging: switch a project to Vercel with allowlist mode, run the PR round trip from [git and pull requests](./phase-18-git-and-pull-requests.md).

## Definition of done

- [x] Vercel is a registered provider with a probed project connection
- [x] Open-world and allowlist egress both work; allowlists open during install and narrow before launch
- [x] Docker is refused in production at both guards
- [x] Every provider passes one conformance suite; Docker in CI, Vercel nightly
- [x] Settings, ledger view, and the Vercel section of `sandboxes.md` ship in the same PR

## Open questions

- **Who pays.** Is the Vercel account always the project's own, or should the hosted service offer a platform account billed through Hypotenuse?
- **Image cost.** Vercel runs stock runtimes, so every job installs Claude Code and bun first (tens of seconds). Vercel snapshots, if available, could cut that. Measure before building.
- **Second hosted provider.** ToolExec's survey ranks E2B next. Decide when a customer needs a non-Vercel cloud.

## Learnings from the build

### What is built

| Piece | Where |
|---|---|
| The provider on `@vercel/sandbox` 3.9.1: `node24` by default (or `node22`; Vercel's `python3.13` has no Node for the coding agent), 1–8 vCPUs at 2 GiB each, `persistent: false`, tags `managed` (the deployment's `SANDBOX_MANAGED_TAG`), `project`, `job`; `/work` made and handed to the sandbox's user at create; `connect` never resumes; `list` filters on the managed tag at Vercel and on every other label here; every error rewritten without the token | `backend/sandbox/providers/vercel.ts` |
| The registry entry (`bakesRuntimeIntoImage: false`, `connectionKind: "vercel"`, the options a project may set), `canNarrowEgress`, `describeSandboxProviders` | `backend/sandbox/registry.ts` |
| Connections: `project_connections` (migration `0018`, one per kind per project, the token sealed, `lastFour` only), the kind registry and its probe (a list, never a create), `SandboxCredentialOps` (the one way to a provider instance: `providerForProject`; `providersToSweep`), and `connection:create` / `list` / `view` / `edit` / `test` / `delete` | `backend/connections/*`, `backend/ops/SandboxCredentialOps.ts`, `backend/actions/connection/*` |
| Provisioning: the provider read when a job starts; `planEgress` (the table in its JSDoc); the runtime install for a provider on stock runtimes; create on the install list, narrow to the run list before the clone | `backend/ops/SandboxProvisionOps.ts` |
| Settings: `sandboxRuntime`, `sandboxVcpus`, `sandboxEgressMode` on `project:settings-edit` (a provider on the project's account needs that account, probed; `warnings` for bots that require an allowlist), `providers` and `connectionKinds` on `project:settings-view`; `bots.requireEgressAllowlist` and its admin-only lift; `sandbox_start` refusing early when the account is missing or the allowlist cannot be held | `backend/actions/project/*`, `backend/actions/bot/bot-edit.ts`, `backend/tools/sandbox-start.ts` |
| The ledger: `sandboxes.resources`, `sandbox-ledger:list` and `sandbox-ledger:destroy`; the orphan sweep one account at a time | `backend/actions/sandbox-ledger/*`, `backend/ops/{SandboxOps,SandboxReapOps}.ts` |
| Proof: the conformance suite (`conformance.ts`), run by `docker.conformance.test.ts`, `vercel-fake.conformance.test.ts`, and `vercel.conformance.test.ts` (real account, nightly); `vercel.test.ts` (connections, settings, the egress table, a bot that requires an allowlist, the production guard, scrubbing, the ledger, a whole job on Vercel); the Vercel fake | `backend/__tests__/sandbox/*`, `backend/__tests__/fakes/vercel/server.ts`, `.github/workflows/nightly-vercel-sandbox.yml` |
| Deployment: `SANDBOX_DEFAULT_PROVIDER=vercel` and `SANDBOX_MANAGED_TAG=hypotenuse-staging` in the shared group | `render.yaml`, `docs/DEPLOY.md` |
| Frontend, CLI 2.14.0, docs | Settings → Sandboxes: the provider picker built from `providers` (one not allowed here disabled), each provider's options, the egress mode, the connection card (Test, replace, delete; never the token), and the ledger card with Destroy where the server says `destroyable`; the bot's **Require an egress allowlist** switch; the job page's sandbox resources (`frontend/src/components/{settings,sandboxes,bots}/*`, `frontend/src/utils/sandboxProviders.ts`). `hypotenuse connection …`, `sandbox ledger` / `sandbox destroy`, `project settings --sandbox-runtime --sandbox-vcpus --sandbox-egress`, `bot edit --require-egress-allowlist`. `sandboxes.md` (Vercel, egress, the sandboxes themselves), `cli.md`, and `docs/platform-coverage/vercel.md` |

### Where the build differs from the plan

| The plan says | The build does, and why |
|---|---|
| `sandbox:list` and `sandbox:destroy` | **`sandbox-ledger:list` and `sandbox-ledger:destroy`**, under `/project/:projectId/…`. The `sandbox:` namespace is the job token's machine actions; a person's action there would read, to every policy list and every reader, like one a sandbox may call. The project is in the route because the membership middleware reads it |
| `connection:test` unaudited | Audited, like `model-connection:test`: it writes the row's status, and rule 5's unaudited writers are a closed list |
| `connection:create` takes the kind's fields flat | They arrive as `config: { teamId, projectId }`: a flat `projectId` would collide with the route's own. The kind's definition names the fields and their shapes, and the actions validate against it |
| "Callers branch on `capabilities`" | Two more registry fields carry what capabilities do not: `bakesRuntimeIntoImage` (whether provisioning installs our runtime) and `connectionKind` (whether the provider runs on the project's account). Nothing outside the provider, its registry entry, and its connection definition names Vercel |
| `sandbox.update({ networkPolicy })` | `sandbox.updateNetworkPolicy` — the session's own endpoint, which answers the policy now held; `setEgress` compares it with what was asked and throws on any difference, so a job believed narrowed is |
| `allowlist`: "opened during install and narrowed before the CLI launches" | Narrowed before the **clone**, not just the launch: repository content is the untrusted input, and it arrives after the narrowing. A job on a repository is narrowed wherever the provider can, in either mode — the behaviour the git build already had |
| A bot that requires an allowlist "refuses to start on a provider without `domainEgressAllowlist`" | It also needs `liveEgressUpdate` (`canNarrowEgress`): the install needs the registries the agent must not have. Refused at `sandbox_start`, and again at provisioning, since the provider may change in between |
| Vercel's conformance run is nightly only | Also in CI, against the in-process fake: the real SDK over Vercel's wire protocol, each sandbox a real container. The fake records network policies instead of enforcing them; enforcement is the nightly run's |

### Decisions the plan left open

- **Who pays: the project.** A connection is the project's own Vercel team; a platform account billed through
  Hypotenuse is not built.
- **A connection is probed at three points**: when it is saved, when it is chosen as the provider, and on **Test**. A
  probe lists the project's sandboxes carrying our managed tag; it never creates one, so it costs nothing.
- **A connection cannot be removed while its provider is the project's, or while a sandbox on it is live** — without
  the account, nothing could destroy that sandbox, and the ledger would hold it live forever.
- **The managed tag is per deployment** (`SANDBOX_MANAGED_TAG`), because the orphan sweep destroys whatever of "ours" the
  ledger does not know, and two deployments sharing a Vercel project would each see the other's sandboxes as orphans.
  Within one deployment the sweep also filters on the connection's project tag, since two projects may share a Vercel
  project.
- **The server decides what a client draws**: `project:settings-view` answers `defaultProvider`, so a blank provider is
  described even after the project chose its own, and each ledger row answers `destroyable`.
- **A ledgered sandbox whose job is still live cannot be destroyed from the ledger**: cancelling the job is how it ends,
  with the conversation told.
- **The GitHub CLI release is pinned in one place per path** — `GITHUB_CLI_VERSION` for the install script and `ARG
  GH_VERSION` in `Dockerfile.dev` — and a test holds them equal.

### Traps found while building

- **`@vercel/sandbox` 3.x names sandboxes, not ids.** `Sandbox.get({ name })`, and every method on a sandbox resumes a
  stopped session by default (`withResume`). `connect` passes `resume: false`, so finding a sandbox to destroy it never
  starts it again.
- **The SDK has no base-URL option, but takes a `fetch`.** Pointing it at the fake is a `fetch` that rewrites
  `https://vercel.com/api`; `SANDBOX_VERCEL_API_URL` turns it on. Nothing else in the provider knows.
- **The SDK retries a 5xx.** A test that wants one failure uses a 4xx, or the retry succeeds and the test reads `ok`.
- **Vercel filters a listing on one tag only** (`SingleTagFilter`); the rest is filtered here.
- **Vercel extends a timeout *by* a duration**; ours is the total lifetime, so `extendTimeout` asks for the difference.
- **A custom policy comes back in the older shape** (`mode: "custom"`, `allowedDomains`), whatever shape was sent.

### What review found, and what changed

- **`python3.13` was offered and could not run a job**: the runtime install puts bun and the coding CLI in with
  `npm`, and the supervisor runs on bun. The Vercel runtimes are the Node ones only, `node24` and `node22`.
- **One account that could not be opened stopped the whole sweep**: `providersToSweep` built every Vercel account in
  one `map`, so a bad seal or a missing field threw and every other project's orphans were left running. Each
  account is opened on its own; one that fails is logged and skipped.
- **Restoring a default that needs an account skipped the probe**: `sandboxProvider: null` on a deployment whose
  default is `vercel` saved without checking the connection. The probe runs whenever the provider is sent.
- **Docker Hub rate-limits the test image's base** (as the git build found): `buildTestImage` keeps an image already
  built here when the rebuild fails, rather than failing every container suite.

### Not run here

- **A real Vercel account.** `vercel.conformance.test.ts` is written and skipped without `VERCEL_TOKEN`; the allowlist's
  enforcement (a sandbox reaches `example.org` and not `example.com`) and the runtime install on Vercel's own image are
  proved only there. The by-hand staging check — a project switched to Vercel in allowlist mode running the pull
  request round trip — waits for a Vercel token on staging.
- **The reattach after a killed worker on Vercel** is proved by `attach` from a fresh provider instance, against the
  fake; the plan's nightly kill-the-worker case is the supervisor's — it pushes to whichever web node answers and needs
  no worker once launched (see [sandboxes](./phase-17-sandboxes.md#where-the-build-differs-from-the-plan)).
- **Snapshots to cut the install time** were not measured: every job installs bun and the coding CLI first.
