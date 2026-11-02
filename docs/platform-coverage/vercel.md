# Vercel platform coverage

Every call Hypotenuse makes to Vercel's Sandbox API, the module that makes it, and the test that proves it (AGENTS.md
rule 10). `backend/__tests__/docs/coverage.test.ts` asserts each row's test file exists and mentions the row's id.
Every call goes through `@vercel/sandbox`, on a project's own Vercel account. The tests run the real SDK against the
Vercel fake, `backend/__tests__/fakes/vercel/server.ts`: Vercel's Sandbox API over its wire protocol, in process —
bearer token and `teamId` on every request, sandboxes in one Vercel project, ndjson streams for a waited command and
its logs, gzipped tarballs for files — each sandbox a real container, every answer shaped to pass the SDK's own
validators. The fake records network policies rather than enforcing them; `vercel.conformance.test.ts` runs the same
cases nightly against a real account, where Vercel enforces them.

| Id | Interaction | Module | Test |
|---|---|---|---|
| `vercel.out.create` | `POST /v2/sandboxes`: a runtime, vCPUs, a timeout, `persistent: false`, the sandbox's environment, at most five tags, and the install allowlist when the job wants one | `backend/sandbox/providers/vercel.ts` | `backend/__tests__/sandbox/vercel-fake.conformance.test.ts` |
| `vercel.out.get` | `GET /v2/sandboxes/{name}` with `resume=false`: a sandbox found again without starting it; 404 is `SandboxNotFoundError` | `backend/sandbox/providers/vercel.ts` | `backend/__tests__/sandbox/vercel-fake.conformance.test.ts` |
| `vercel.out.list` | `GET /v2/sandboxes` filtered on the deployment's managed tag (Vercel filters on one), the rest filtered here; the connection probe and the orphan sweep | `backend/sandbox/providers/vercel.ts` | `backend/__tests__/sandbox/vercel-fake.conformance.test.ts` |
| `vercel.out.delete` | `DELETE /v2/sandboxes/{name}`; 404 and 410 count as destroyed | `backend/sandbox/providers/vercel.ts` | `backend/__tests__/sandbox/vercel-fake.conformance.test.ts` |
| `vercel.out.cmd` | `POST …/sessions/{id}/cmd` with `wait: true`, read as ndjson: `exec`, with `cwd`, `env`, and `sudo` | `backend/sandbox/providers/vercel.ts` | `backend/__tests__/sandbox/vercel-fake.conformance.test.ts` |
| `vercel.out.cmd-detached` | `POST …/cmd` detached: `spawn`, and the supervisor's launch | `backend/sandbox/providers/vercel.ts` | `backend/__tests__/sandbox/vercel-fake.conformance.test.ts` |
| `vercel.out.cmd-get` | `GET …/cmd/{cmdId}` (and `?wait=true`): `attach` from another process, and a command's exit | `backend/sandbox/providers/vercel.ts` | `backend/__tests__/sandbox/vercel-fake.conformance.test.ts` |
| `vercel.out.logs` | `GET …/cmd/{cmdId}/logs` as ndjson, replayed from the start | `backend/sandbox/providers/vercel.ts` | `backend/__tests__/sandbox/vercel-fake.conformance.test.ts` |
| `vercel.out.kill` | `POST …/cmd/{cmdId}/kill` with a signal | `backend/sandbox/providers/vercel.ts` | `backend/__tests__/sandbox/vercel-fake.conformance.test.ts` |
| `vercel.out.fs-write` | `POST …/fs/write`, one gzipped tarball with modes | `backend/sandbox/providers/vercel.ts` | `backend/__tests__/sandbox/vercel-fake.conformance.test.ts` |
| `vercel.out.fs-read` | `POST …/fs/read`, bytes as `application/octet-stream`; 404 is `null` | `backend/sandbox/providers/vercel.ts` | `backend/__tests__/sandbox/vercel-fake.conformance.test.ts` |
| `vercel.out.network-policy` | `POST …/network-policy`: narrowed to the run list, the answer compared with what was asked | `backend/sandbox/providers/vercel.ts` | `backend/__tests__/sandbox/vercel.test.ts` |
| `vercel.out.extend-timeout` | `POST …/extend-timeout` by the difference from the current timeout | `backend/sandbox/providers/vercel.ts` | `backend/__tests__/sandbox/vercel-fake.conformance.test.ts` |
| `vercel.probe` | a connection's probe — a listing, never a create — at save, when chosen as the provider, and on Test | `backend/connections/probes/vercel.ts` | `backend/__tests__/sandbox/vercel.test.ts` |
| `vercel.errors.scrubbed` | a refusal that echoes the token is recorded on the job, the ledger, and a connection's answer without it | `backend/sandbox/providers/vercel.ts` | `backend/__tests__/sandbox/vercel.test.ts` |
| `vercel.egress.enforced` | a narrowed sandbox reaches an allowed host and not another (real account only) | `backend/sandbox/providers/vercel.ts` | `backend/__tests__/sandbox/vercel.conformance.test.ts` |
