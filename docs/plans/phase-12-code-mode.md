# Phase 12 — Code mode

> **Goal:** Every bot can write a short TypeScript program and run it in an isolated WebAssembly sandbox
> inside the worker. The program can call the bot's MCP tools and its memory, filter and combine what comes
> back, and return a small answer, so large intermediate data never passes through the model's context. A
> program that reaches a call needing approval pauses before the call and resumes exactly where it stopped.

> **Status: planned, not built.** Builds on the [durable agent loop](./phase-08-durable-agent-loop.md) (tools,
> intents, waiting on approval), [memory](./phase-09-memory.md) (the operations behind `memory.*`), and
> [shared MCP servers](./phase-10-shared-mcp-servers.md) (the client, the catalog, and the approval gate behind
> `mcp.*`). Code that needs a filesystem, a shell, git, or packages runs in a sandbox: [17](./phase-17-sandboxes.md).

A team agent asked "which customers opened more than three tickets this month and are on the enterprise plan"
has two bad options without code. It can pull every ticket into its context, which is slow, expensive, and
truncated. Or it can make dozens of tool calls, each a model round trip. With code mode it writes one program:
call the support tool, call the CRM tool, join, count, return twelve names.

The product direction calls this *code mode*: isolated TypeScript in WASM that can reach the shared MCP servers
and memory. Botholomew built it as `membot_run`
([milestone 18](https://github.com/evantahler/botholomew/blob/main/docs/plans/milestone-18-sandboxed-code.md)),
on Vercel's Run SDK. Run executes JavaScript or type-stripped TypeScript in a fresh, hardened QuickJS context
in a worker thread. The guest has no Node or Bun globals, filesystem, modules, environment, timers, or network.
It reaches the host only through serializing host functions. Run also produces a *continuation*: a host function
can interrupt, and the same program can later be replayed deterministically with settled calls answered from
the record. That is the property that makes approvals work inside code, and why this phase adopts Run rather
than wiring QuickJS by hand.

## Scope

**In:**

1. The `run_code` tool:
   - input is `source`, plus optional `saveTo: {path, scope}` and `changeNote`;
   - output is inline (`result`, `resultType`, `resultCount`) or a memory acknowledgement;
   - a `source` of `"?"` returns the primer.
2. The runtime: the `run` package (Vercel's Run SDK, QuickJS in WASM in a worker thread), pinned exactly, behind
   one module. Limits are set by application policy.
3. The host API, all routed through the same ops as the top-level tools:
   - `memory.search`, `memory.list`, `memory.read`, `memory.write`;
   - `mcp.listTools`, `mcp.search`, `mcp.info`, `mcp.exec`, `mcp.capture`;
   - `largeResult.read`;
   - `console.log` (captured and bounded).
4. Approvals inside code. A gated `mcp.exec` or `mcp.capture` interrupts *before* its effect. The continuation is
   stored, signed and encrypted, in `code_runs`. The conversation waits for the whole interruption batch, then
   replays the same program, with the model never asked to rewrite it.
5. A three-tier primer (see §5), so routine turns do not carry an API manual.
6. `code_runs` for the record and the continuation; the transcript shows each run's source, host calls, and
   result.
7. The compiled-binary and container check: the worker image must start Run's worker thread and resolve its
   QuickJS assets.

**Out:**

- Packages, `fetch`, timers, filesystem, and shell. Settled non-goal: that is what a sandbox is for
  ([17](./phase-17-sandboxes.md)).
- Calling Hypotenuse's own top-level tools from code: no `reply_and_wait`, `ask_question`, or `sandbox_start`.
  Code computes; it does not talk to the channel or start long work. This is also botholomew's rule ("reject
  attempts to route top-level tools through MCP").
- Memory edits, forgets, and promotion from code. These are destructive or audience-changing, and keep their
  top-level tools.
- Running code on a schedule without a model turn. A schedule wakes a turn ([20](./phase-20-schedules.md)), and
  the turn may run code.

## What already exists

| Thing | Where | Use here |
|---|---|---|
| botholomew's `membot_run` | [`src/tools/membot/run/`](https://github.com/evantahler/botholomew/tree/main/src/tools/membot/run) (`execute.ts`, `host.ts`, `mcp.ts`, `files.ts`, `continuation.ts`, `primer.ts`, `limits.ts`, `errors.ts`) | The tool shape, host API, limits, error types, primer tiers, and the continuation flow, ported into a multi-tenant service |
| botholomew's milestone doc | [`docs/plans/milestone-18-sandboxed-code.md`](https://github.com/evantahler/botholomew/blob/main/docs/plans/milestone-18-sandboxed-code.md) | The arguments: interrupt before a non-idempotent effect; resolve a concurrent batch together; "dropping a continuation and letting the model retry is not acceptable"; signed continuations give integrity, not secrecy |
| botholomew's approvals | [`docs/approvals.md`](https://github.com/evantahler/botholomew/blob/main/docs/approvals.md) | "Each approval records the sandbox interruption it came from, so the resumed program consumes its own grant and never another task's" |
| The approval gate | [10](./phase-10-shared-mcp-servers.md) | `ApprovalOps.check` and `approvals` with `codeRunId` and `interruptionId` |
| `CryptoOps` | [ToolExec `backend/ops/CryptoOps.ts`](https://github.com/arcadeai-labs/toolexec/blob/main/backend/ops/CryptoOps.ts) | AES-256-GCM at rest for continuations, which contain tool results |

## What this must not weaken

1. **Guest code has no ambient capability.** Everything it can do is a host function listed in §3, and each host
   function enforces the conversation's scope, the bot's allowlist, and the approval gate exactly as the
   top-level tool does. There is one policy, not two.
2. **A gated call interrupts before its effect.** No `mcp.exec` that needs approval sends a byte to the MCP
   server until its approval is `approved` and is consumed by that interruption.
3. **A resumed program is the same program.** The source hash, host-function names, and continuation context
   are verified before replay. A mismatch fails the run; it never re-executes with fresh calls.
4. **Continuations are confidential and bound.** They are stored encrypted, signed with a per-project key, and
   bound by audience to project, conversation, intent, and code run. They are never shown to a model, written
   to a transcript, or logged.
5. **Limits are policy, not input.** Guest source cannot raise its timeout, memory, or call budget.

## Design

### 1. The tool

`run_code` is a [08](./phase-08-durable-agent-loop.md) tool with `replay: "unsafe"` and `parallelSafe: false`.
Its description starts `[[ bash equivalent command: bun -e '<source>' ]]`, the analogy botholomew found the
model understands.

| Field | Meaning |
|---|---|
| `source` | A JavaScript or type-stripped TypeScript function body. Top-level `await` and `return` work. `"?"` returns the primer without starting the sandbox |
| `saveTo` | `{path, scope}`: store the returned value as a memory document (JSON) instead of returning it |
| `changeNote` | Used with `saveTo` |

Success returns `{result, resultType, resultCount}` inline (≤ 1 MiB), or `{path, versionId, bytesWritten,
preview}`. Failure returns the error envelope with a stable `error_type`:

- `invalid_source`
- `sandbox_timeout`, `sandbox_memory`, `sandbox_limit`
- `host_error`, `mcp_error`
- `approval_denied`
- `continuation_invalid`
- `internal_error`

These map from Run's error codes, never from parsing message text. Every failure's `next_action_hint` includes
the short primer (§5).

### 2. Limits

These are botholomew's `RUN_LIMITS`, which have run in practice, set per deployment and overridable per bot
only downward:

| Limit | Value |
|---|---|
| Timeout | 30 s |
| QuickJS memory | 96 MiB |
| Stack | 2 MiB |
| Source | 256 KiB |
| Result | 1 MiB |
| Console output | 64 KiB |
| Host-function argument / output | 22 MiB each |
| Bridge requests per run | 256 |
| Concurrent bridge requests | 32 |
| Continuation | 32 MiB |

The worker runs at most `CODE_RUNS_PER_WORKER` (4) programs at once; more wait on a per-process semaphore.
Each program is a worker thread, so one cannot starve the event loop of the tick that started it.

### 3. Host API

Host functions are trusted code. Each receives the tick's `ToolContext` (project, bot, conversation, scope) and
validates and bounds its arguments. No client, connection, function, or class instance crosses the boundary.

| Guest function | Host behavior | Gated |
|---|---|---|
| `memory.search(query, {scope?, pathPrefix?, limit?})` | [09](./phase-09-memory.md)'s hybrid search, at most 20 hits | no |
| `memory.list({scope?, pathPrefix?, limit, offset?})` | Bounded listing | no |
| `memory.read(path, {scope})` | Returns text, or parsed JSON for a `.json` path | no |
| `memory.write(path, value, {scope, changeNote?})` | Writes a new version; channel scope only unless the binding allows project writes | no |
| `mcp.listTools(server?)` | Same as `mcp_list_tools` | no |
| `mcp.search(query)` | Same as `mcp_search` | no |
| `mcp.info(server, tool)` | Same as `mcp_info`; satisfies info-before-exec for this conversation | no |
| `mcp.exec(server, tool, args?)` | Same client and gate as `mcp_exec`; returns parsed JSON or text | yes, per [10](./phase-10-shared-mcp-servers.md) |
| `mcp.capture(server, tool, args, path)` | Executes with the same gate and writes the whole result to memory; returns only an acknowledgement | yes |
| `largeResult.read(id, {offset, limit})` | Pages a stored large result | no |
| `console.log(...)` | Captured, bounded, returned beside the result | no |

The primer tells the agent to capture once and compute locally, not to call a tool once per record. The bridge
caps enforce it.

### 4. Interruptions, continuations, and resume

1. A host function for a gated call checks the gate. If approval is needed, it calls Run's
   `getHostFunctionContext().interrupt({server, tool, args, interruptionId})` **before** any effect.
2. Run returns a continuation and the full batch of interruptions; calls in flight concurrently can interrupt
   together.
3. In one transaction, the host:
   - updates the `code_runs` row to `interrupted`, storing the continuation encrypted with `CryptoOps` and
     signed with the project's continuation key;
   - writes one `approvals` row per interruption, with `codeRunId` and `interruptionId`;
   - moves the conversation to `waiting` / `{kind: "approval", approvalIds}`.
   
   The `run_code` intent has no result yet.
4. When every approval in the batch is decided, [10](./phase-10-shared-mcp-servers.md) wakes the conversation.
5. The tick's recovery step finds the `run_code` intent with an interrupted `code_runs` row and calls
   `CodeRunOps.resume`. That:
   - verifies the signature, audience, and source hash;
   - replays the program with the continuation and the batch's resolutions;
   - lets settled host calls return their recorded values without running again;
   - re-invokes each interrupted function: approved means it runs the call now and consumes its own approval
     (matched by `interruptionId`), denied means it throws `approval_denied`, which the program may catch.
6. The run may interrupt again; a new batch, the same loop. When it finishes, the `tool_result` is written once.

- **The signing key** is per project: 32 random bytes, stored encrypted in `projects.codeContinuationKey`, and
  created once with `INSERT … ON CONFLICT DO NOTHING`, so two workers cannot install different keys.
- **The audience** is `hypotenuse-run-v1:<projectId>:<conversationId>:<intentEntryId>:<codeRunId>`.

**Crash mid-run.** A worker that dies while a program runs, outside an interruption, leaves a `code_runs` row
`running` under a dead lease. Settled host calls are journaled to `code_runs.hostCalls` as they settle (server,
tool, ok or error, sizes, no payloads). Recovery writes the `run_code` intent's result as `interrupted`, with
that journal, and the model decides whether to run again ([08](./phase-08-durable-agent-loop.md)'s rule for
unsafe tools). Reconstructing a continuation from a journal is not attempted. Run produces continuations only at
interrupts, and a partial replay that guesses would be worse than an honest "interrupted".

### 5. Teaching the model

The three disclosure tiers are botholomew's:

1. **Tool description, every turn:** what `run_code` is, when to prefer it (fetch, reduce, or join large tool
   output), and that `source: "?"` returns the API.
2. **`source: "?"`:** the full primer. It is a TypeScript declaration of the host API, the limits, and three
   worked examples: count by day, join two tools, and capture-then-reduce.
3. **On failure:** the short primer, appended to `next_action_hint`.

[11](./phase-11-skills-prompts-and-goals.md)'s tool primers section carries one line pointing at `run_code`.

### 6. The transcript

A `run_code` intent shows its source, syntax-highlighted. Its result entry shows the result or the error, the
captured console, and the journal of host calls with their gate decisions. An interrupted run shows its pending
approvals inline, each linking to the approval.

## Schema sketch

```ts
// backend/schema/code_runs.ts
code_runs: id serial pk, projectId, botId, conversationId, entryId,   // the run_code intent
  sourceSha256 text, source text,
  status text ('running'|'interrupted'|'completed'|'failed'|'interrupted_by_crash'),
  continuation jsonb null,                  // CryptoOps {ciphertext, iv, authTag}; signed inside
  interruptionIds jsonb default '[]', hostCalls jsonb default '[]',    // journal, no payloads
  bridgeRequests int default 0, durationMs int null,
  resultBytes int null, errorType text null, leaseOwner text null,
  createdAt tstz, updatedAt tstz

// backend/schema/projects.ts gains codeContinuationKey jsonb (encrypted)
// approvals (from the MCP phase) already carries codeRunId, interruptionId
```

## Actions and policy sketch

| Action | Route | RBAC | MCP | Audited |
|---|---|---|---|---|
| `code-run:list` | `GET /conversation/:id/code-runs` | `canReadBot` | yes | no |
| `code-run:view` | `GET /code-run/:id` | `canReadBot` | yes | no; never returns the continuation |
| `bot:edit` (existing) | — | `canWriteBot` | yes | yes. Gains `codeModeEnabled` and downward-only limit overrides |

`run_code` itself is a model tool, not an action. Approvals are decided with [10](./phase-10-shared-mcp-servers.md)'s
`approval:decide`.

## Frontend and user docs

- The transcript renders code runs as in §6.
- **Bot → Tools** gains a code mode toggle and limits.
- **User docs:** `frontend/src/content/docs/code-mode.md` covers what the bot can and cannot do in code, how
  approvals pause a program, and limits.
- **CLI:** `hypotenuse code-run list|view`.

## Steps

### 1. Spike in the container — `backend/Dockerfile`, `backend/__tests__/code/runtime.test.ts`

Add `run`, pinned exactly. Prove a minimal program runs under `bun test`, in the production image, and in the
worker process. That covers the worker thread, the QuickJS WASM assets, and memory limits. Botholomew needed the
same proof for its compiled binary.

### 2. Runtime module — `backend/ops/code/runtime.ts`

The only importer of `run`. It exports `createRunner(limits)`, `execute`, and `resume`, and maps errors to
stable types.

### 3. Host API — `backend/ops/code/host.ts`, `backend/ops/code/{memory,mcp,large-result}.ts`

Each is a thin adapter over [09](./phase-09-memory.md) and [10](./phase-10-shared-mcp-servers.md)'s ops.

### 4. Continuations — `backend/ops/code/continuation.ts`, `backend/ops/CodeRunOps.ts`

Key creation, sign and encrypt, verify, `resume`, and the journal.

### 5. Primer — `backend/ops/code/primer.ts`

Generated `.d.ts` text for the host API, plus examples.

### 6. Tool — `backend/tools/run-code.ts`

### 7. Recovery hook — `backend/ops/ReplayOps.ts`

`run_code` intents with interrupted or crashed `code_runs`.

### 8. Schema, actions, frontend, docs — `backend/schema/code_runs.ts`, `backend/actions/code-run/*.ts`, `frontend/src/components/transcript/CodeRun.tsx`, `frontend/src/content/docs/code-mode.md`

## Test plan

- `__tests__/code/runtime.test.ts`:
  - Hello world; type-stripped TypeScript.
  - Each limit trips with its error type: an infinite loop gives a timeout, a huge array gives memory, 300 calls
    give the bridge limit.
  - `fetch`, `require`, `Bun`, and `process` are undefined.
- `__tests__/code/host.test.ts`:
  - Memory calls respect the conversation's scope: another channel's path is not found, by construction.
  - `mcp.exec` respects the allowlist and info-before-exec.
  - `mcp.capture` writes to memory and returns no payload.
- `__tests__/code/approval.test.ts`:
  - A program makes one ungated call and two concurrent gated calls. The fixture MCP server records the ungated
    call once and the gated calls zero times.
  - The batch is two approvals; deciding one leaves the conversation waiting.
  - Approve both, and the fixture records each gated call exactly once and the ungated call **still once**
    (replayed from the continuation).
  - The program's result is written once.
- `__tests__/code/deny.test.ts`: a denied interruption throws `approval_denied` inside the program; a program
  that catches it returns a fallback.
- `__tests__/code/continuation.test.ts`: a tampered continuation, a changed source, a different conversation's
  audience, and a different project's key all fail with `continuation_invalid`, and the call never runs.
- `__tests__/code/crash.test.ts`: the lease expires during a run, recovery writes `interrupted` with the
  journal, and the model's next request contains it.
- `__tests__/security/no-secrets.test.ts` (extended): no continuation bytes appear in any entry, serializer, or
  log.

## Verification

```bash
cd backend && bun test __tests__/code
docker build -f backend/Dockerfile . && docker run … bun keryx.ts code:self-test   # CI's backend-docker job runs the spike
```

On staging, ask a bot to count tickets by customer from a gateway tool. The transcript shows one `run_code` with
a small result, and the model's input tokens stay flat.

## Definition of done

- [ ] `run_code` runs TypeScript in Run's QuickJS sandbox with the policy limits, in tests and in the production
      image.
- [ ] The host API covers memory and MCP through the same ops and gate as the top-level tools.
- [ ] Gated calls interrupt before effect; continuations are encrypted, signed, and audience-bound; resume
      replays the same program and runs each approved call exactly once.
- [ ] Crash recovery reports an interrupted run with its journal.
- [ ] The primer tiers, transcript rendering, docs, and CLI ship.

## Open questions

- Whether continuations should move to Run's stored continuation codec if they grow large. Measure sizes on
  staging first.
- Whether `memory.write` from code should count toward a per-run write cap, separate from the bridge cap.
- Whether a project should be able to turn code mode off for every bot at once, or only per bot.

## Learnings from the build

Not built yet.
