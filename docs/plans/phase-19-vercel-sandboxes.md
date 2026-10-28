# Phase 19 — Vercel sandboxes

> **Goal:** A production project runs its sandbox jobs on Vercel Sandbox, with the same behaviour it had on Docker in development. A project admin connects a Vercel account, picks it as the sandbox provider, and optionally turns on a deny-by-default egress allowlist. Bots keep starting jobs exactly as before.

> **Status: planned, not built.** Builds on [sandboxes](./phase-17-sandboxes.md) (interface, registry, ledger, supervisor, job token) and [git and pull requests](./phase-18-git-and-pull-requests.md) (git hosts on the allowlist). It also delivers the provider-conformance suite that any later provider (Kubernetes, E2B, exe.dev, SSH) must pass.

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

No new tables:

- `project_connections` gains kind `vercel`, with credentials `{ token (sealed), teamId, projectId }`.
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

- [ ] Vercel is a registered provider with a probed project connection
- [ ] Open-world and allowlist egress both work; allowlists open during install and narrow before launch
- [ ] Docker is refused in production at both guards
- [ ] Every provider passes one conformance suite; Docker in CI, Vercel nightly
- [ ] Settings, ledger view, and the Vercel section of `sandboxes.md` ship in the same PR

## Open questions

- **Who pays.** Is the Vercel account always the project's own, or should the hosted service offer a platform account billed through Hypotenuse?
- **Image cost.** Vercel runs stock runtimes, so every job installs Claude Code and bun first (tens of seconds). Vercel snapshots, if available, could cut that. Measure before building.
- **Second hosted provider.** ToolExec's survey ranks E2B next. Decide when a customer needs a non-Vercel cloud.

## Learnings from the build

Not built yet.
