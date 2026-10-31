# Phase 10 — Shared MCP servers

> **Goal:** A project connects the MCP servers its bots may use (an Arcade gateway, GitHub, a company's own
> tools) once, with credentials that never leave the server. Each bot is given the servers and tools it may
> call. A bot finds tools by searching for them rather than carrying every schema in its prompt. Any call
> that is not allowlisted stops and waits for a person to approve it, and an approved call runs exactly once.

> **Status: built.** Builds on the [durable agent loop](./phase-08-durable-agent-loop.md) (the tool
> contract, `tool_call_intent`, `waiting` on `approval`) and [model providers and bots](./phase-07-model-providers-and-bots.md).
> Approvals are decided in the dashboard, the API, and the CLI here. The [channel framework](./phase-13-channel-framework.md)
> renders them in Slack, Linear, and Pylon. [Code mode](./phase-12-code-mode.md) calls the same gate from guest
> code.

The product direction says bots get their tools from *shared* MCP servers: Hypotenuse is a host, not a tool
author. That makes three problems this phase's to solve.

- **Credentials.** A gateway token or OAuth grant belongs to the project. It must be attached to each request
  server-side, so no prompt, transcript, or sandbox ever holds it.
- **Context.** A gateway can expose hundreds of tools. Botholomew's experience was that the model does better
  with four meta-tools (search, list, info, exec) than with a catalog in its prompt.
- **Side effects.** A team agent posting to the wrong channel, emailing a customer, or merging a pull request
  cannot be taken back. Botholomew's default, *every external call needs approval until allowlisted*, is the
  right default for a bot many people can talk to.

Keryx is an MCP **server**, with OAuth for clients, and has no MCP **client**. This phase builds the client on
`@modelcontextprotocol/sdk`.

## Scope

**In:**

1. `mcp_servers`: the project's server registry, using Streamable HTTP. Auth is none, static headers, bearer, or
   MCP OAuth (discovery, dynamic client registration, PKCE), with secrets encrypted by `CryptoOps`.
2. `bot_mcp_servers`: which servers a bot may use, its `allowedTools` patterns, and `autoAllowReadOnly`.
3. An MCP client pool in an initializer: per-process `Client` instances keyed by server and credential version,
   with SSRF-safe fetch, timeouts, and idle eviction.
4. A tool catalog cached per server and refreshed by a clock. Search over it combines `tsvector` keyword ranking
   with the [memory](./phase-09-memory.md) embedder.
5. Model tools: `mcp_search`, `mcp_list_tools`, `mcp_info`, `mcp_exec`, and `read_large_result`. A server's
   tool must have had `mcp_info` called on it in this conversation before its first `mcp_exec`.
6. The approval gate: `approvals` rows keyed by `callKey`; the conversation parks in `waiting` /
   `{kind: "approval"}`; a decision resumes the *same* `tool_call_intent`.
7. Deciding: `approval:list`, `approval:view`, `approval:decide` (approve, deny, or always allow), the
   `approvals:expire` clock, notifications to approvers, the dashboard inbox, and CLI commands.
8. `large_results`: tool output over `MAX_INLINE_CHARS` (10 000) is stored and replaced with a preview and an
   id; `mcp_exec` can also write a result straight to memory (`saveTo`).
9. A generated *capabilities* summary per bot: what its tools can do, grouped by theme, without tool names.
   Consumed by the prompt in [11](./phase-11-skills-prompts-and-goals.md).
10. A fake MCP server test fixture, built on the SDK's server half, with OAuth.

**Out:**

- stdio MCP servers. A hosted multi-tenant service does not spawn tenant commands. Settled non-goal; a sandbox
  ([17](./phase-17-sandboxes.md)) can run one for its own coding agent.
- Per-participant MCP authorization, where a tool acts as the Slack person who asked. Shared bots act as
  themselves. Open question.
- MCP resources and prompts from external servers. Tools only for now.
- Elicitation requests *from* an external server mid-call. Refused, with an error naming the server; open
  question.

## What already exists

| Thing | Where | Use here |
|---|---|---|
| botholomew's progressive disclosure | [`docs/mcpx.md`](https://github.com/evantahler/botholomew/blob/main/docs/mcpx.md), [`src/mcpx/client.ts`](https://github.com/evantahler/botholomew/blob/main/src/mcpx/client.ts) | The meta-tools; "call `mcp_info` before the first `mcp_exec`"; the capabilities section without tool names |
| botholomew's approval gate | [`docs/approvals.md`](https://github.com/evantahler/botholomew/blob/main/docs/approvals.md), [`src/approvals/`](https://github.com/evantahler/botholomew/tree/main/src/approvals) | Deny by default; pattern forms `server/tool`, `server/*`, `*/tool`, bare `tool`, `/regex/`; `auto_allow_read_only` off by default because annotations are untrusted hints; `call_key` = a hash of server, tool, and args; a denial tells the model not to retry |
| botholomew's large results | [`src/worker/large-results.ts`](https://github.com/evantahler/botholomew/blob/main/src/worker/large-results.ts) | Page results over 10k characters by id. Theirs is in memory and lost per loop; ours is a table |
| ToolExec's gateway proxy and OAuth client | [`backend/actions/proxy/proxy-gateway.ts`](https://github.com/arcadeai-labs/toolexec/blob/main/backend/actions/proxy/proxy-gateway.ts), [`backend/ops/OAuthClientOps.ts`](https://github.com/arcadeai-labs/toolexec/blob/main/backend/ops/OAuthClientOps.ts) | Server-side credential attachment and refresh. [17](./phase-17-sandboxes.md) reuses the proxy so a sandbox's coding agent reaches these servers with only its run token |
| v1's SSRF-safe egress | [`backend/ops/EndpointSafetyOps.ts`](https://github.com/arcadeai-labs/hypotenuse/blob/v1/backend/ops/EndpointSafetyOps.ts) | A DNS lookup that refuses non-public answers, defeating rebinding |
| The tool contract and the replay rules | [08](./phase-08-durable-agent-loop.md) | An approved intent runs on resume; a denied one gets an error result |

## What this must not weaken

1. **No MCP credential is returned by any action or serializer, written to a transcript, or passed to a model or
   sandbox.** `serializeMcpServer` has no field one fits in. `__tests__/security/no-secrets.test.ts` asserts it
   by scanning every serializer's output and every stored entry after a run.
2. **Default deny.** A bot with no `allowedTools` can search and read tool schemas, and every `mcp_exec` waits
   for a person.
3. **An approval authorizes one call:** the exact server, tool, and arguments of one `tool_call_intent`. It is
   consumed with the result, in one transaction. An approval can never run a different call.
4. **Annotations are hints.** `readOnlyHint` lets a call through only when the bot's `autoAllowReadOnly` is on,
   and that setting is an audited decision.
5. **Every outbound connection passes `assertPublicUrl` with the pinned lookup,** at configuration and at every
   connect.

## Design

### 1. The registry

An `mcp_servers` row holds:

- `name`: a slug, unique per project, used in `server/tool`.
- `url`, `transport: "streamable-http"`, `enabled`.
- `authMode`: `none`, `headers`, `bearer`, or `oauth`.
- `credentials`, encrypted. For `headers`, a map of header names to values. A value may contain `{{bot.slug}}`
  or `{{bot.identity}}`, so one gateway can scope tools per bot. Arcade's `Arcade-User-ID` header is the
  motivating case: each bot is its own identity, so each bot gets its own tool authorizations.
- `toolsCache`, `toolsRefreshedAt`, `status`, and `lastError`.

**Connecting**:

1. `mcp-server:create` validates the URL.
2. It connects once and runs `listTools`.
3. It stores the catalog.

For `oauth`, the registry follows the MCP authorization spec as a client, taking ToolExec's
`connection-github-install-*` three-hop shape:

1. Discover the protected-resource metadata, then the authorization-server metadata.
2. Register dynamically if no client id was given.
3. Redirect the admin through PKCE to `mcp-server:oauth-callback`.
4. Store the access and refresh tokens. Refresh happens under a row lock, as v1's Linear refresh did.

### 2. The client pool

`backend/initializers/mcpClients.ts` holds an LRU of `Client` instances, keyed by `(serverId,
credentialVersion)`.

- **Transport.** Each client uses a `StreamableHTTPClientTransport` whose `fetch` is the SSRF-safe one.
- **Timeouts and eviction.** Each call has a 60 s timeout; each tool may override it. A client idle for 5 minutes
  is closed. A credential change bumps `credentialVersion`, which retires the old client.
- **Retries.** A 401 triggers one token refresh and one retry. Nothing else retries automatically: a tool call
  is not known to be idempotent.
- **Process scope.** The pool is per process. Workers do not share sessions, and the protocol's session ids are
  an optimization, not state.

### 3. Discovery, and the meta-tools

| Tool | Replay | Does |
|---|---|---|
| `mcp_search` | safe | Searches the bot's allowed servers' catalogs by `query`. Returns `server/tool`, a one-line description, and whether the call would be gated |
| `mcp_list_tools` | safe | Lists one server's tools, paginated |
| `mcp_info` | safe | Returns one tool's input schema, description, and annotations, and records in the conversation that this tool's info was read |
| `mcp_exec` | unsafe | Calls `server/tool` with `args`, with optional `saveTo: {path, scope}`. Refused with a hint if `mcp_info` was not called for this tool in this conversation. Gated by §4 |
| `read_large_result` | safe | Pages a stored large result by `id`, `offset`, and `limit` |

Catalog search is keyword (`tsvector` over name and description) fused with semantic ranking from the memory
embedder, the same RRF as [09](./phase-09-memory.md). The catalog is small, so it is held per project in Redis
and rebuilt by `mcp-servers:refresh`.

The bot's prompt carries only a *capabilities* section, regenerated by the `fast` model whenever a bot's catalog
changes. It is a thematic summary ("can read and send email, read calendars, open GitHub pull requests") with no
tool names, so the model searches instead of guessing.

### 4. The approval gate

`ApprovalOps.check(bot, server, tool, args)` decides each `mcp_exec` before anything is sent:

| Allowlisted by pattern | `readOnlyHint` and `autoAllowReadOnly` | Prior approval for this `callKey` on this intent | Result |
|---|---|---|---|
| yes | — | — | run |
| no | yes | — | run |
| no | no | `approved`, not consumed | run, and consume it with the result |
| no | no | `denied` or `expired` | error result "denied by <who>; do not retry; try another approach or ask" |
| no | no | none | write an `approvals` row (`pending`); the tool returns *gated* |

- **The key.** `callKey = sha256(server + "/" + tool + "\n" + canonicalJson(args))`. Approval rows also reference
  the exact `entryId` of the `tool_call_intent` (or the code-mode interruption from
  [12](./phase-12-code-mode.md)), so a decision is bound to one call.
- **Parking.** When any call in a step is gated, the tick runs the step's ungated calls, writes their results,
  and moves the conversation to `waiting` with `{kind: "approval", approvalIds}`. All of that commits in one
  transaction. The approvers are notified after commit.
- **Resuming.** When every approval in the batch is decided, the decision path calls
  [08](./phase-08-durable-agent-loop.md)'s `wake`. The tick's recovery step finds intents without results and
  their decided approvals, then runs or refuses them. No earlier step is replayed; botholomew had to re-run its
  task from the start, and the durable transcript removes that.
- **Expiry.** A pending approval expires after `bots.approvalTtlSeconds` (24 h by default); expired counts as
  denied.
- **Always allow.** `approval:decide` with `alwaysAllow: true` also appends `server/tool` to the bot's
  `allowedTools`, audited as an edit to `bot_mcp_servers` under the same audit row.

**Who decides.** In the dashboard, API, and CLI, a decision needs `canWriteBot`, or the bot's `approverTag` when
set. In a platform channel, [13](./phase-13-channel-framework.md)'s binding `approvalPolicy` decides.

**What the requester sees.** The model gets a `tool_result` once the decision arrives. Meanwhile the
conversation's status says "Waiting for approval to run gmail/send_email". The platform phases render that.

### 5. Large results

- A tool result whose JSON text is longer than `MAX_INLINE_CHARS` is stored in `large_results`. The model gets
  `{preview: first 2 000 chars, id: "lr_<id>", totalChars, hint: "use read_large_result"}`.
- `saveTo` writes the whole result into memory as a document, and the model gets only an acknowledgement.
  Botholomew's field notes call piping large data into memory and reducing it with code "the normal case".
- `large_results` rows belong to a conversation and are deleted 30 days after it ends, by `large-results:sweep`.

### 6. Result scrubbing

Before a result is stored, `scrubToolResult` removes values under `SENSITIVE_KEYS` and any string equal to one of
the server's own credential values. That is a backstop; no credential should reach a result in the first place.

## Schema sketch

```ts
// backend/schema/mcp_servers.ts
mcp_servers: id serial pk, projectId, name text,             // unique (projectId, name)
  url text, transport text default 'streamable-http', authMode text,
  credentials jsonb null,                                     // CryptoOps {ciphertext, iv, authTag}
  oauthClient jsonb null, oauthTokens jsonb null,             // encrypted
  credentialVersion int default 1, enabled bool default true,
  status text ('ok' | 'error' | 'needs_auth'), lastError text null,
  toolsCache jsonb, toolsRefreshedAt tstz null, createdAt tstz, updatedAt tstz

// backend/schema/bot_mcp_servers.ts
bot_mcp_servers: id serial pk, botId, mcpServerId,           // unique (botId, mcpServerId)
  allowedTools jsonb default '[]',                            // patterns
  autoAllowReadOnly bool default false, createdAt tstz, updatedAt tstz

// backend/schema/approvals.ts
approvals: id serial pk, projectId, botId, conversationId,
  entryId int null, codeRunId int null, interruptionId text null,
  callKey text, server text, tool text, args jsonb,           // args scrubbed
  reason text ('not-allowlisted'), status text ('pending'|'approved'|'denied'|'expired'|'consumed'),
  decidedByUserId int null, decidedByParticipantId int null,
  decidedVia text null ('dashboard'|'api'|'cli'|'mcp'|'slack'|'linear'|'pylon'),
  note text null, expiresAt tstz, decidedAt tstz null, consumedAt tstz null, createdAt tstz

// backend/schema/large_results.ts
large_results: id serial pk, projectId, conversationId, entryId, mimeType text,
  content text, totalChars int, createdAt tstz
```

## Actions and policy sketch

| Action | Route | RBAC | MCP | Audited |
|---|---|---|---|---|
| `mcp-server:create` | `PUT /mcp-server` | admin | yes | yes (credentials in `SENSITIVE_KEYS`) |
| `mcp-server:edit` | `POST /mcp-server/:id` | admin | yes | yes |
| `mcp-server:delete` | `DELETE /mcp-server/:id` | admin | yes | yes |
| `mcp-server:list` / `view` | `GET /mcp-servers`, `GET /mcp-server/:id` | member | yes | no |
| `mcp-server:test` | `POST /mcp-server/:id/test` | admin | yes | no (reads only) |
| `mcp-server:refresh-tools` | `POST /mcp-server/:id/refresh` | admin | yes | no (cache) |
| `mcp-server:oauth-start` | `GET /mcp-server/:id/oauth` | admin | **never** (browser hop) | yes |
| `mcp-server:oauth-callback` | `GET /mcp-server/oauth/callback` | state-bound | **never** | yes |
| `bot-mcp-server:set` | `PUT /bot/:id/mcp-server` | `canWriteBot` | yes | yes |
| `bot-mcp-server:remove` | `DELETE /bot/:id/mcp-server/:serverId` | `canWriteBot` | yes | yes |
| `bot-mcp-server:list` | `GET /bot/:id/mcp-servers` | `canReadBot` | yes | no |
| `approval:list` / `view` | `GET /approvals`, `GET /approval/:id` | member, filtered by `canReadBot` | yes | no |
| `approval:decide` | `POST /approval/:id` | `canWriteBot` or `approverTag` | yes | yes |
| `large-result:view` | `GET /large-result/:id` | `canReadBot` | yes | no |
| `mcp-servers:refresh` | — (clock, 1 h) | — | no | no |
| `approvals:expire` | — (clock, 1 min) | — | no | no |
| `large-results:sweep` | — (clock, daily) | — | no | no |

## Frontend and user docs

- **Project → MCP servers:** connect (with the OAuth flow), test, browse the catalog, and see status.
- **Bot → Tools:** which servers, allowlist patterns (tested live against the catalog to show what they match),
  `autoAllowReadOnly` with its warning, and the generated capabilities text.
- **Approvals inbox:** pending approvals with the bot, conversation link, server/tool, scrubbed arguments, who
  asked (the participant), and approve / deny / always allow. The notification bell shows a count.
- **User docs:** `frontend/src/content/docs/{mcp-servers,approvals}.md`.
- **CLI:** `hypotenuse mcp-server add|list|test|remove`, `hypotenuse approval list|view|approve|deny`.

## Steps

### 1. Dependency — `backend/package.json`

`@modelcontextprotocol/sdk`, pinned exactly; the client lives in one module.

### 2. Schema — `backend/schema/{mcp_servers,bot_mcp_servers,approvals,large_results}.ts`

### 3. Client — `backend/initializers/mcpClients.ts`, `backend/ops/McpClientOps.ts`, `backend/ops/EndpointSafetyOps.ts`

Port `EndpointSafetyOps` from v1.

### 4. OAuth client — `backend/ops/McpOAuthOps.ts`

### 5. Catalog and capabilities — `backend/ops/McpCatalogOps.ts`, `backend/ops/CapabilitiesOps.ts`

### 6. Gate — `backend/ops/ApprovalOps.ts`

`check`, `callKey`, `matchPattern`, `decide`, `serializeApproval`.

### 7. Tools — `backend/tools/{mcp-search,mcp-list-tools,mcp-info,mcp-exec,read-large-result}.ts`

### 8. Actions — `backend/actions/{mcp-server,bot-mcp-server,approval,large-result}/*.ts`

### 9. Fixture — `backend/__tests__/fixtures/mcp-server.ts`

A real MCP server on the SDK's server half, over Streamable HTTP. It has scripted tools (read-only, side-effect,
slow, huge output, failing), optional bearer or OAuth (with its own authorization server), and records every call.

### 10. Frontend, CLI, docs — as above

## Test plan

- `__tests__/mcp/registry.test.ts`:
  - Connect over none, headers, bearer, and OAuth (the full PKCE hop against the fixture's authorization
    server).
  - A private address is refused, at configuration and through DNS rebinding.
  - A credential rotation retires the pooled client.
- `__tests__/mcp/meta-tools.test.ts`:
  - Search ranks the right tool.
  - `mcp_exec` without `mcp_info` is refused with a hint.
  - A tool outside the bot's servers is invisible.
- `__tests__/mcp/approval.test.ts`:
  - Every row of the gate table.
  - A step with one gated and one ungated call: the ungated call runs, the conversation waits, then approval
    resumes. The fixture records **exactly one** call of the gated tool.
  - Deny gives an error result and the model's next request contains it.
  - Expiry.
  - Always-allow edits the allowlist, under one audit row.
  - An approval cannot be consumed by a different intent or arguments.
- `__tests__/mcp/crash.test.ts`: the lease is forced to expire after the approval is consumed and before the
  result is written. That is impossible by construction (one transaction), and the test asserts the transaction
  boundary by failing the result insert.
- `__tests__/mcp/large-results.test.ts`: a huge result → preview + id → paged reads; `saveTo` writes to memory.
- `__tests__/security/no-secrets.test.ts`: no serializer, entry, or log line contains a configured credential.
- `__tests__/actions/mcp-server.test.ts`, `__tests__/actions/approval.test.ts`: RBAC and audit for every action.
- `rbac.test.ts`: the OAuth hop actions are never MCP tools.

## Verification

```bash
cd backend && bun test __tests__/mcp __tests__/security __tests__/actions/{mcp-server,approval}.test.ts
bun run --cwd cli hypotenuse mcp-server add arcade --url https://api.arcade.dev/mcp/... --header "Arcade-User-ID={{bot.identity}}"
bun run --cwd cli hypotenuse approval list
```

On staging: connect an Arcade gateway. Ask a bot over the API to send an email. Approve it in the dashboard, and
see exactly one email sent.

## Definition of done

- [x] Servers connect over all four auth modes; credentials are encrypted and never serialized.
- [x] The client pool uses SSRF-safe fetch, timeouts, refresh-on-401, and eviction.
- [x] The meta-tools work, with info-before-exec enforced.
- [x] The approval gate is default deny, with patterns, `autoAllowReadOnly`, one approval per intent, resume
      without replay, expiry, and always-allow.
- [x] Large results are stored, paged, and `saveTo` writes to memory.
- [x] The capabilities section is generated per bot.
- [x] The dashboard inbox, server and bot pages, CLI, and docs ship; both themes are checked.

## Open questions

- Per-participant authorization: a tool that acts as the person who asked (Arcade supports per-user auth
  flows). That needs a participant's consent link and changes "a bot acts as itself". Revisit after
  [14](./phase-14-slack.md).
- Server-initiated elicitation mid-call: it could become an `ask_question` to the channel, but the call is
  synchronous to the server. Refused for now.
- Whether `autoAllowReadOnly` should be allowed for project-wide defaults, or only per bot.

## Learnings from the build

### What is built

| Piece | Where |
|---|---|
| `mcp_servers`, `bot_mcp_servers`, `approvals`, `large_results`; `bots.approver_tag`, `approval_ttl_seconds`, `capabilities`, `capabilities_hash` (migration `0008`) | `backend/schema/`, `backend/drizzle/0008_*.sql` |
| The registry: inputs, the serializer, sealing credentials, per-bot header templates | `backend/ops/McpServerOps.ts` |
| The MCP authorization spec as a client | `backend/ops/McpOAuthOps.ts` |
| The client pool and its lifecycle | `backend/ops/McpClientOps.ts`, `backend/initializers/mcpClients.ts` |
| The catalog, its hybrid search, capabilities | `backend/ops/{McpCatalogOps,CapabilitiesOps}.ts` |
| The gate: patterns and the call key (pure); approvals, decisions, expiry | `backend/ops/{ApprovalPatternOps,ApprovalOps}.ts` |
| The tick's gate: decide, settle, park, resume | `backend/ops/TickOps.ts` (`decideGate`, `settleGated`, `parkForApprovals`) |
| Large results | `backend/ops/LargeResultOps.ts` |
| The five tools | `backend/tools/{mcp-search,mcp-list-tools,mcp-info,mcp-exec,read-large-result,mcp-shared}.ts` |
| Actions, tasks, and clocks | `backend/actions/{mcp-server,bot-mcp-server,approval,large-result}/`, `backend/actions/bot/bot-capabilities.ts` |
| Settings | `backend/config/mcp.ts` |
| The approval notification | `backend/ops/templates/approval-requested.ts` |
| The fixture MCP server, with its own OAuth authorization server | `backend/__tests__/fixtures/mcp-server.ts` |
| Proof | `backend/__tests__/mcp/{registry,meta-tools,approval,crash,large-results}.test.ts`, `__tests__/security/no-secrets.test.ts`, `__tests__/actions/mcp-server.test.ts` |

### Decisions the plan left open

- **Routes live under the project**, like every other action: `PUT /project/:projectId/mcp-server`,
  `GET /project/:projectId/approvals`, `PUT /project/:projectId/bot/:botId/mcp-server`, and so on. The one route
  outside it is the OAuth return, `GET /mcp-server/oauth/callback`, whose single-use `state` names the project.
- **`EndpointSafetyOps` was not ported.** Phase 07's `NetworkGuardOps` already is v1's guard: `urlRefusal` at
  configuration, and `guardedFetch` — the pinned lookup that defeats rebinding — as the MCP transport's `fetch`, so
  every request of every connection is checked, not only the first. It gained a `timeoutMs` option, since the 30 s
  socket idle default is shorter than a 60 s tool call.
- **Two actions the plan did not list.** `mcp-server:match-tools` (`GET …/match?patterns=`) tests allowlist
  patterns against a server's catalog, so the dashboard's live preview and the gate share one matcher instead of a
  copy in the browser. `bot:capabilities` and `mcp-server:refresh-catalog` are the per-item tasks the clock and the
  write paths enqueue; a clock is never reused as a per-item task.
- **`mcp-server:test` and `mcp-server:refresh-tools` are audited**, as `model-connection:test` is: they write the
  status a person reads. The plan had them unaudited. The OAuth hops are audited too, and are the only audited
  actions answering `GET` — a browser is sent through them (`audited-actions.test.ts` names them).
- **`approval:decide` takes `decision: approve | deny`, `alwaysAllow`, `note`, and `via`** (`dashboard`, `api`, `cli`;
  an MCP caller is recorded as `mcp` from the connection, whatever it sends). A denial's note reaches the model.
- **Who decides**: `canWriteBot`, or the bot's `approverTag`. Who is notified: the approver tag's holders, or the
  project's admins (`resolveRecipients`). Listing approvals is filtered by `canReadBot`, so an approver who cannot
  read the bot cannot see its approvals either — give the approver tag read access too.
- **"`mcp_info` was called" is read from the transcript**, not stored: a non-error `mcp_info` result whose
  `output.name` is the tool. Compaction keeps the rows, so a read before a compaction still counts.
- **The gate is a tool hook, `ToolDefinition.gate`**, returning `run`, `run-approved`, `refuse`, `interrupted`, or
  `park`; the tick applies it (`settleGated`). A gated tool always runs serially. A tool's own refusal in the gate
  (no such server, info not read) becomes its error result.
- **A step with a gated call does not end its turn**: its terminal call, if any, gets a `not_run` result ("a call in
  this step is waiting for approval"), the step's other calls run and are written, then one transaction writes the
  approvals, queues their notifications, and parks on `{kind: "approval", approvalIds}`. The model sees every
  result, approved or refused, before it decides how to end the turn.
- **Intent before effect, for approvals too.** The plan consumed an approval with its result, which is right, but
  left a worker dying *during* the approved call to re-run it on recovery. `approvals.executing_at` is committed
  before the call is sent; recovery finds an approved, executing, unconsumed approval and reports the call
  interrupted (consuming it) rather than sending it twice. `crash.test.ts` fails the result's insert with a trigger
  and proves the fixture sees exactly one call.
- **Recovery of a gated intent** asks the gate again. An approval on record decides it (table in `ApprovalOps`); with
  none, a `park` parks (nothing could have been sent) and a `run` is reported interrupted (an allowlisted call may
  have been mid-flight).
- **Cancelling a conversation expires its pending approvals** (`finalizeCancel`); a decision after that is refused.
- **Expiry is the clock's**, and also caught at decision time: deciding an expired approval expires it, wakes the
  conversation if nothing else is pending, and refuses.
- **The catalog lives on the row** (`mcp_servers.tools_cache`), not in Redis: Postgres is the source of truth, and
  the catalog is small. Search runs `ts_rank_cd` over the visible tools' text in one query (any of the query's words,
  as memory search does) and fuses it with cosine ranks from the memory embedder by the same weighted RRF. Tool
  vectors are cached in Redis by embedding revision and text digest (`hyp:mcp-embed:*`, a week), so a refresh
  re-embeds only what changed. Without an embedding model, search is keyword-only and says so (`searchedBy`).
- **Capabilities are stored on the bot**, regenerated by `bot:capabilities` when a server is given, taken away,
  renamed, enabled or disabled, or its catalog changes. The digest of the catalog it came from
  (`capabilities_hash`) makes a repeat a no-op. The fast model is told never to name a tool, and any tool name with
  `_` or `-` it writes anyway is replaced. A model failure stores the plain list (each server and its tool count)
  and a hash that makes the next run try again. `MCP_GENERATE_CAPABILITIES=false` (the browser suite) always stores
  the plain list. The prompt carries a "Your tools" section and the summary only for a bot with servers, and the MCP
  tools are offered only then (`ToolDefinition.available` may now be async).
- **A tool result reaches the model as text.** `mcp_exec` answers `{name, text}` — the result's text parts joined —
  plus `structuredContent` only when there is no text, and a description of non-text parts. A result whose
  `isError` is set becomes a `tool_error` envelope. Keeping the result a string matters because
  `scrubToolOutput` drops keys named in `SENSITIVE_KEYS` (`state`, `code`, `token`, `headers`…) at any depth, which
  would silently remove an issue's `state` from structured content.
- **Large results** store the text (or the JSON, with no text) when the serialized result passes
  `MCP_MAX_INLINE_CHARS`. `saveTo` accepts channel memory only (a bot cannot write project memory), refuses a result
  larger than a memory document (and stores it as a large result instead, saying so), and is deduped like any bot
  memory write.
- **The pool's key is `(server, credential version, digest of the headers)`**, so one bot's filled-in headers never
  reuse another's client. A credential change bumps the version; the editing action reconnects inside its
  transaction and retires only the older versions after commit — retiring every client of the server closed the one
  the edit had just opened (`registry.test.ts` caught it).
- **OAuth**: discovery reads RFC 9728 protected-resource metadata (path-inserted, then root), falls back to the
  server's origin as the issuer, then RFC 8414 or OpenID metadata. A client id an admin enters is stored with an
  empty issuer and reused at the first sign-in; otherwise Hypotenuse registers a public client (PKCE, no secret)
  and reuses it while the issuer is unchanged. The pending sign-in is a Redis key per `state`, ten minutes, taken
  once. `oauth-start` answers a 302 (or `{authorizationUrl}` with `format=json`, for the CLI); the callback lands on
  `/settings/mcp-servers?server=<id>&signedIn=1` or `&oauthError=`. Refresh happens before a token's stated expiry
  and once on a 401, under the row lock; a second worker that finds a newer credential version uses it instead of
  refreshing again. A failed refresh marks the server `needs_auth`.
- **Header templates**: `{{bot.identity}}` is `hypotenuse-<projectId>-<botId>`, stable across a slug rename;
  `{{bot.slug}}` is the slug. A person's connection test, with no bot, sends `hypotenuse-test` / `test`.
- **Never MCP**: `mcp-server:oauth-start` and `mcp-server:oauth-callback` joined `NEVER_MCP_ACTION_NAMES`.
- **`bearerToken` joined `SENSITIVE_KEYS`**; `headers`, `clientSecret`, `code`, and `state` were already there.
- **Queues**: the refresh fan-out, capabilities, and catalog refreshes run on `default`; the three clocks on
  `orchestrator`.

### Traps found while building

- **Parallel-safe calls finish in any order**, so their results' `seq` order is not the model's call order. Tests
  that read several `mcp_search` results by position put each call in its own step.
- **Redis outlives the test database, and ids restart**, so an embedding revision (a digest of connection id and
  model) repeats across runs and cached tool vectors survive. The hybrid search test deletes `hyp:mcp-embed:*` first.
- **Keryx instantiates every export under `actions/`**: the shared inputs of create and edit live in `McpServerOps`.
- **An action may answer a `Response`** (Keryx passes it through), which is how the OAuth hops redirect.
- **The SDK's Streamable HTTP client surfaces a 401 as an error with `code: 401`** when no auth provider is given;
  Hypotenuse does its own OAuth rather than the SDK's `authProvider`, so every request of the flow goes through the
  SSRF guard and the tokens stay sealed in Postgres.

### The frontend

- **Routes:** `/settings/mcp-servers` (Project, after Models; `?server=<id>` opens a server's tools, and the OAuth
  return's `signedIn=1` / `oauthError=` shows a banner once), `/approvals` (Pending by default, chips for the other
  statuses), and `/approvals/:approvalId`. **Approvals** is a sidebar destination (`g a`) with the pending count,
  re-read on navigation and on every notification frame.
- **The bot page** gained **Tools** (servers, a per-server pattern editor previewed live through
  `mcp-server:match-tools`, the read-only switch with its warning, the capabilities text) and **Approvals** (approver
  tag, expiry). The unavailable placeholder that read "Tools" became "Code", and since code mode "Sandboxes".
- **A conversation waiting on approval** says "Waiting for approval to run `server/tool`" and links each approval.
- **Colour is spent only where a person is needed**: "Waits for approval" chips and pending approvals use the
  waiting colour; a destructive annotation is heavier type, not a colour.
- **The browser suite** runs `backend/__tests__/fixtures/mcp-server-process.ts` (an open fixture, one behind
  OAuth, and a control port) and sets `MCP_GENERATE_CAPABILITIES=false`. `mcp.spec.ts` drives its own scripted
  model on a second control port: the shared one answers in queue order for any conversation, and
  `conversations.spec.ts` runs beside it.
- **Illustrations** (`mcp-servers`, `bot-tools`, `approvals`, and a retaken `bot`) need the dev backend with
  `NETWORK_ALLOW_PRIVATE_HOSTS=true MCP_GENERATE_CAPABILITIES=false`; the capture script starts the fixture process
  itself (`MCP_FIXTURE_TOOLSET=illustration` lists a believable mailbox) and repoints the seeded servers at its
  fresh ports on a rerun. Its seed now parks two conversations on approvals, so a retake of `conversations` will show
  them.

### The CLI

`hypotenuse` 2.5.0. Rule 13 decisions:

| Routed action | Command |
|---|---|
| `mcp-server:create` / `edit` / `delete` | `mcp-server add <name> --endpoint <url>` / `edit <server>` / `remove <server> --yes` |
| `mcp-server:list` / `view` / `test` / `refresh-tools` / `match-tools` | `mcp-server list` / `view` / `test` / `refresh` / `match --pattern` |
| `mcp-server:oauth-start` | `mcp-server sign-in <server>` (prints the URL), and `add --oauth` |
| `bot-mcp-server:set` / `remove` / `list` | `bot tools add <bot> <server> [--allow]…` / `bot tools remove` / `bot tools list` |
| `approval:list` / `view` / `decide` | `approval list` / `view <id>` / `approve <id> [--always]` and `deny <id> [--note]` (sent `via: cli`) |
| `large-result:view` | `large-result view <lr_id\|id>` |
| `bot:create` / `bot:edit` new fields | `--approver-tag`, `--no-approver-tag`, `--approval-ttl <secs\|30m\|24h\|7d>` |
| `mcp-servers:refresh`, `mcp-server:refresh-catalog`, `bot:capabilities`, `approvals:expire`, `large-results:sweep` | out of scope: tasks with no route |
| `mcp-server:oauth-callback` | out of scope: a browser hop |

- **`--endpoint`, not `--url`**: `--url` is the program's global option naming the Hypotenuse server, and commander
  reads it anywhere in argv.
- **Secrets never ride argv**: a bearer token is `--bearer-stdin`, `--bearer-env <NAME>`, or a hidden prompt;
  secret headers `--headers-stdin`; a client secret `--client-secret-stdin` / `--client-secret-env`.

### Not verified here

- No real MCP server was called: every connection is the fixture, on the SDK's own server half, over loopback with
  the SSRF guard lifted. The staging verification (an Arcade gateway, an email approved in the dashboard, exactly one
  sent) has not been run.
- `no-secrets.test.ts` scans answers and stored rows, not log lines.
- Per-tool timeouts are per server (`mcp_servers.timeout_ms`), not per tool as the plan said.
