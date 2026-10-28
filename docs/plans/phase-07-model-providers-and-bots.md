# Phase 07 — Model providers and bots

> **Goal:** A project admin connects model providers and names the models the project uses. The keys are encrypted
> at rest and never returned. The providers are Anthropic, OpenAI, Vercel AI Gateway, and any OpenAI-compatible
> endpoint, all reached through the Vercel AI SDK. `default` and `fast` are the two required names.
>
> Members create **bots**. A bot has:
> - a name and a slug;
> - an identity: display name, avatar, persona;
> - the model names it uses;
> - who may read and edit it (`accessRead` / `accessWrite`);
> - who it escalates to (`helpNotifyTag`);
> - a budget.
>
> Bots are CRUD only. **Nothing runs yet.**

> **Status: planned, not built.** It builds on [phase 04](./phase-04-organizations-users-and-rbac.md):
> `AccessOps`, the `admin` gate, and `CryptoOps`. It also builds on [phase 05](./phase-05-audit-logging.md): every
> write is audited, and `apiKey` is already in `SENSITIVE_KEYS`. The durable loop that makes a bot answer is
> [phase 08](./phase-08-durable-agent-loop.md).

This phase separates two decisions that change at different speeds.

- **Which model a project pays for** is an admin's decision, rare and audited: a provider, a key, and the model
  ids behind names like `default` and `fast`.
- **What a bot is** is a member's decision, frequent and collaborative: its persona, its name, which of those named
  models it uses, and who may change it.

A bot never holds a key or a raw model id. It names a model alias. Swapping the project's `default` from one model
to another is one audited edit that every bot follows, and removing a key is one row.

The **named model registry** comes from botholomew, whose `default_model` / `fast_model` split held up: the fast
model does the cheap auxiliary calls (titles, capability summaries, schedule guards, memory descriptions), and the
default model does the thinking. See [botholomew](https://github.com/evantahler/botholomew/blob/main/docs/architecture.md).

**Bots are the first object with an access list**, so this is where ToolExec's `canReadAgent` / `canWriteAgent`
become `canReadBot` / `canWriteBot`. That is the user's "agents are multiplayer, with read/write handled by project
permissions", built on the tag model kept from ToolExec.

**One platform app per bot**, a decision settled with the user, shapes the identity columns. A bot's display name
and avatar are what its generated Slack and Linear app manifests carry
([phase 14](./phase-14-slack.md), [phase 15](./phase-15-linear.md)). The platform app ids themselves live in
`bot_installations` ([phase 13](./phase-13-channel-framework.md)), one row per bot per platform, not on the bot.

## Scope

**In:**
- **Model connections:** `model_connections` (per-project, encrypted keys, AI SDK provider kinds), a probe action
  that verifies a key, and the list of models an endpoint reports.
- **Model aliases:** `model_aliases`, the named registry with reserved `default` and `fast`.
- **Bots:**
  - the `bots` table and CRUD, with `canReadBot` / `canWriteBot`;
  - avatar upload and serving;
  - slug rules.
- **Pages:** Settings → Models; Bots list and the bot page (Identity, Model, Access sections).
- **The scripted model server fixture**, minimal here and extended in [phase 08](./phase-08-durable-agent-loop.md).
- **CLI and docs:** `model` and `bot` commands; user docs.

**Out:**
- Running a bot, conversations, and ticks ([phase 08](./phase-08-durable-agent-loop.md)).
- Prompt sections beyond the persona, skills, and goals ([phase 11](./phase-11-skills-prompts-and-goals.md)).
  The bot page shows those sections disabled, labelled "Not available yet".
- Platform installs and channel bindings ([phase 13](./phase-13-channel-framework.md) onward).
- Pricing, cost records, and **enforcing** the budget ([phase 22](./phase-22-telemetry-and-cost.md)). The budget
  is stored and shown here, labelled "Not enforced yet".
- Model subscriptions (ToolExec's pasted `setup-token`). A later plan if wanted.
- Embedding models for memory. [Phase 09](./phase-09-memory.md) adds an `embedding` alias kind on this same
  table.

## What already exists

| Piece | Where |
|---|---|
| Connection registry pattern (kinds, credential schema, probe) | [ToolExec `backend/connections/registry.ts`](https://github.com/arcadeai-labs/toolexec/blob/main/backend/connections/registry.ts), `backend/schema/project_connections.ts` |
| AES-256-GCM sealing, `lastFourOf` | ToolExec / v1 `backend/ops/CryptoOps.ts`, ported in [phase 04](./phase-04-organizations-users-and-rbac.md) |
| `satisfiesAccess`, `readableIds` | `backend/ops/AccessOps.ts`, from [phase 04](./phase-04-organizations-users-and-rbac.md) |
| Agent CRUD, `accessRead` / `accessWrite`, `helpNotifyTag`, budget fields | [ToolExec phase 7 — agent management](https://github.com/arcadeai-labs/toolexec/blob/main/docs/plans/phase-07-agent-management.md), `backend/schema/agents.ts`, `backend/ops/AgentOps.ts` |
| SSRF-safe egress (DNS answers checked, rebinding defeated) | [v1 `backend/ops/EndpointSafetyOps.ts`](https://github.com/arcadeai-labs/hypotenuse/blob/v1/backend/ops/EndpointSafetyOps.ts), ToolExec `NetworkGuardOps.assertPublicUrl` |
| Named models with a fast model | botholomew's model registry (`default_model`, `fast_model`) |

## What this must not weaken

1. **A key never leaves the server.**
   - No action returns it.
   - No serializer has a field it fits in. `serializeModelConnection` returns `lastFour`, kind, name, base URL,
     and status.
   - `apiKey` is `secret(z.string())` and is in `SENSITIVE_KEYS`.
   - [Sandboxes](./phase-17-sandboxes.md) reach models through a server-side proxy, never with the key.
2. **Access lists are checked in actions, through `AccessOps`.** There is no second implementation.
3. **Every write is audited.** Every list is paginated.
4. **A probe is a fetch the server makes to a URL a person typed.** It goes through the SSRF guard: a public
   `https` URL, and DNS answers that are all public. The only exception is under test, where
   `config.network.allowPrivateHosts` is true, so the fixture on loopback is reachable.

## Design

### Provider kinds

| `provider` | AI SDK package | Base URL | Probe |
|---|---|---|---|
| `anthropic` | `@ai-sdk/anthropic` | default; overridable | `GET {base}/v1/models` |
| `openai` | `@ai-sdk/openai` | default; overridable | `GET {base}/v1/models` |
| `gateway` | `@ai-sdk/gateway` (Vercel AI Gateway) | default | the gateway's available-models call |
| `openai-compatible` | `@ai-sdk/openai-compatible` | **required** | `GET {base}/models` |

- `backend/models/registry.ts` is the one table of kinds. Each entry has `kind`, `label`, `credentialSchema`,
  `defaultBaseUrl`, `build(connection) → ProviderV2`, and `probe(connection)`. ToolExec's rule holds: callers
  branch on what the registry says, never on the kind's name.
- `build` decrypts the key **at the call**, in the worker, and keeps it only for that call's lifetime.
- `ModelOps.languageModel(projectId, alias)` and `ModelOps.embeddingModel(projectId, alias)` are the only ways
  later phases obtain a model. Each resolves alias → connection → provider instance.

Why the AI SDK, settled with the user: one interface over every provider, `streamText` and `generateObject` with
tool calls, `embed()` for memory, and the provider chosen per project without code changes.

### Model aliases

| Column | Meaning |
|---|---|
| `name` | `default`, `fast`, or any `[a-z0-9-]+` name (`reasoning`, `cheap`) |
| `kind` | `language` here; `embedding` added by [phase 09](./phase-09-memory.md) |
| `connectionId`, `modelId` | which connection, and the provider's model id string |
| `options` | jsonb: `maxOutputTokens`, `temperature`, provider options (e.g. thinking budget) |

Rules:
- `default` and `fast` are **reserved and required** before any bot of the project can run. Phase 08's tick
  refuses with a sentence an admin can act on. This phase shows a banner on the Bots page when either is missing.
- `model-alias:delete` refuses an alias a bot names, and lists the bots.
- `model-connection:delete` refuses a connection an alias uses.

### Bots

| Column | Meaning | Rule |
|---|---|---|
| `name` | human name, e.g. "Ada" | required, ≤ 80 |
| `slug` | `[a-z0-9-]+`, unique per project | **immutable once any `bot_installations` row exists**, because generated manifests embed it; enforced from [phase 13](./phase-13-channel-framework.md), and the column comment says so |
| `description` | what it is for, shown in lists | ≤ 280 |
| `displayName` | the name platforms show | defaults to `name` |
| `avatar`, `avatarMimeType` | PNG or JPEG bytes, ≤ 512 KB, square | stored, not linked: platform app icons are uploaded by a person from the generated manifest's instructions, and the dashboard must not depend on a third-party URL staying up |
| `persona` | the identity section of its system prompt: who it is, how it speaks, what it will not do | required; markdown |
| `modelAlias` / `fastModelAlias` | alias names | default `default` / `fast`; must exist in the project |
| `accessRead` / `accessWrite` | tag-name lists (ToolExec semantics: `[]` or `*` is every member; admins always pass) | validated by `accessListSchema` |
| `helpNotifyTag` | whose help a bot asks for when nobody answers in-channel | null means the project's admins |
| `monthlyBudgetUsd` | spending ceiling | stored and shown; enforcement is [phase 22](./phase-22-telemetry-and-cost.md) |
| `enabled` | whether it accepts new conversations | a disabled bot ignores inbound messages from [phase 13](./phase-13-channel-framework.md) on |
| `createdByUserId` | who made it | — |

Access rules:
- **`canReadBot` / `canWriteBot`** are `AccessOps.canRead` / `canWrite` over a bot row. Every bot action loads
  the row and checks.
- `bot:list` pages in SQL through `readableIds`. An unreadable bot is **absent** from the list, and `bot:view` on
  it answers the same 404 as a missing one.
- **A writer cannot lock themselves out.** `bot:edit` refuses an `accessWrite` the caller would no longer satisfy,
  unless they are admin. The refusal names the next move: "add one of your tags, or ask an admin". ToolExec allowed
  the lockout; it is a support ticket waiting to happen.
- **`bot:create` is member-level.** A bot spends the project's model budget, but only through aliases an admin
  chose. The creator must satisfy the `accessWrite` they set.

## Schema sketch

```ts
model_connections { id serial, projectId → projects, name text, provider text, baseUrl text null,
                    secret jsonb /* {ciphertext, iv, authTag} */, lastFour text,
                    status "unverified"|"ok"|"error", lastCheckedAt timestamptz, lastError text null,
                    createdByUserId, createdAt, updatedAt; unique (projectId, name) }
model_aliases     { id serial, projectId, name text, kind "language", connectionId → model_connections,
                    modelId text, options jsonb default {}, createdAt, updatedAt; unique (projectId, name) }
bots              { id serial, projectId → projects, name, slug, description, displayName,
                    avatar bytea null, avatarMimeType text null, persona text,
                    modelAlias text, fastModelAlias text,
                    accessRead jsonb default [], accessWrite jsonb default [],
                    helpNotifyTag text null, monthlyBudgetUsd numeric(10,2) null, enabled boolean default true,
                    createdByUserId, createdAt, updatedAt; unique (projectId, slug) }
```

## Actions and policy sketch

| Action | Route | RBAC | MCP | Audited |
|---|---|---|---|---|
| `model-connection:create` | `PUT /project/:projectId/model-connection` | admin | yes | yes (`apiKey` scrubbed) |
| `model-connection:view` / `:list` | `GET …/model-connection/:id`, `GET …/model-connections` | member | yes | read |
| `model-connection:edit` | `POST …/model-connection/:id` (rename, rotate key, base URL) | admin | yes | yes |
| `model-connection:delete` | `DELETE …/model-connection/:id` | admin | yes | yes; refused while an alias uses it |
| `model-connection:test` | `POST …/model-connection/:id/test` | admin | yes | yes (it writes `status`) |
| `model-connection:models` | `GET …/model-connection/:id/models` | admin | yes | read (probes live; nothing stored) |
| `model-alias:create` / `:edit` / `:delete` | `PUT` / `POST` / `DELETE …/model-alias…` | admin | yes | yes |
| `model-alias:list` | `GET …/model-aliases` | member | yes | read |
| `bot:create` | `PUT /project/:projectId/bot` | member | yes | yes |
| `bot:view` / `bot:list` | `GET …/bot/:botId`, `GET …/bots` | member + `canReadBot` | yes | read |
| `bot:edit` | `POST …/bot/:botId` (including a base64 avatar ≤ 512 KB) | member + `canWriteBot` | yes | yes (the avatar's bytes are summarized in audit metadata, never stored there) |
| `bot:delete` | `DELETE …/bot/:botId` | member + `canWriteBot` | yes | yes; refused while installations exist (from [phase 13](./phase-13-channel-framework.md)) |
| `bot:avatar` | `GET …/bot/:botId/avatar` (raw image `Response`) | member + `canReadBot` | never (binary) | read |

## Frontend and user docs

- **Settings → Models** (admin):
  - Connections: add, rotate, test with a status glyph, delete.
  - Aliases: `default` and `fast` pinned first. A model picker is fed by `model-connection:models`, falling back
    to free text when a provider does not list.
- **Bots** (sidebar):
  - The list shows avatar with bot badge, name, description, alias names, and an enabled chip.
  - **The bot page** is the second signature surface in [`DESIGN.md`](../DESIGN.md). Its sections are Identity
    (name, display name, avatar, persona with a markdown preview), Model (aliases), Access (`accessRead`,
    `accessWrite`, `helpNotifyTag` as tag pickers), and Budget.
  - Prompts, Skills, Goals, Tools, and Channels appear as disabled sections reading "Not available yet".
  - Every affordance is gated by `can()` plus the row's `canWrite` answer, which the server returns as
    `standing.canWrite` on `bot:view`.
- **CLI:**
  - `hypotenuse model connection {list,add,test,rotate,remove}`;
  - `hypotenuse model alias {list,set,remove}`;
  - `hypotenuse bot {list,view,create,edit,delete}` with `--persona-file`.
- **User docs:**
  - `frontend/src/content/docs/models.md`: providers, keys, the two required names, and why bots name aliases.
  - `bots.md`: identity, persona writing tips, and access lists, linking the tags page.

## Steps

### 1. Schema — `backend/schema/{model_connections,model_aliases,bots}.ts`

### 2. Provider registry — `backend/models/registry.ts`, `backend/ops/ModelOps.ts`

Covers `languageModel`, `embeddingModel` (a stub returning a refusal until memory), `probe`, and `listModels`.
Dependencies: `ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/gateway`, `@ai-sdk/openai-compatible`, each
pinned exactly. A provider package's minor release has changed request shapes before.

### 3. Network guard — `backend/ops/NetworkGuardOps.ts`

Port v1's `EndpointSafetyOps` DNS check under ToolExec's name, with `config.network.allowPrivateHosts` (true only
under test).

### 4. Bot ops — `backend/ops/BotOps.ts`

`canReadBot`, `canWriteBot`, `serializeBot` (no avatar bytes; an `avatarUrl` path instead), and the lockout guard.

### 5. Actions — `backend/actions/{model-connection,model-alias,bot}/*`

### 6. Scripted model server — `backend/__tests__/fixtures/model-server.ts`

An in-process HTTP server speaking the Anthropic and OpenAI wire formats:
- `/v1/models` in both shapes;
- one scripted non-streaming completion;
- recording of every request with its headers. Tests assert that the key arrived as the provider expects, and that
  it appears nowhere else.

[Phase 08](./phase-08-durable-agent-loop.md) extends it to stream and script multi-step tool calls. Real provider
packages talk to it unchanged, so no code of ours is mocked.

### 7. Frontend — `frontend/src/pages/{bots,settings/models}/**`

### 8. CLI — `cli/src/commands/{model,bot}.ts`

### 9. Docs — `frontend/src/content/docs/{models,bots}.md`

## Test plan

- **`model-connections.test.ts`**:
  - create, then test against the fixture: `status: ok`, and the fixture saw the key in `x-api-key` (Anthropic) or
    `Authorization: Bearer` (OpenAI);
  - the key never appears in any response body, audit row, or log line captured during the test (a whole-response
    scan for the plaintext);
  - rotate;
  - delete refused while an alias uses it;
  - a private base URL is refused when `allowPrivateHosts` is false.
- **`model-aliases.test.ts`**: reserved names, uniqueness, delete refused while a bot names it.
- **`bots.test.ts`**, across the Mushroom Kingdom cast:
  - `accessRead: ["castle-staff"]` hides the bot from Toad in both list and view (the same 404 as a missing bot);
  - Peach (admin) sees and edits everything;
  - an organization owner without membership does too;
  - the lockout guard;
  - avatar size and type limits;
  - slug uniqueness.
- **`rbac.test.ts`**: the whole-set maps gain every new action.
- **CLI spawn tests** for each command.
- **e2e `bots.spec.ts`**: create a bot, upload an avatar, edit the persona, restrict access, and see it disappear
  for another member.

## Verification

```bash
cd backend && bun test __tests__/actions/model* __tests__/actions/bot*
cd ../frontend && bun run test:e2e -- bots.spec.ts
bun run --cwd cli hypotenuse model alias list --json | jq '.modelAliases[].name'   # "default", "fast"
```

## Definition of done

- [ ] Model connections for four AI SDK provider kinds, encrypted at rest, probed through the SSRF guard, never returned
- [ ] `default` and `fast` aliases are required and refuse deletion while used
- [ ] Bots CRUD with `canReadBot` / `canWriteBot` on `AccessOps`; unreadable bots are absent and 404
- [ ] The writer-lockout guard; member-level `bot:create`
- [ ] Avatar upload and serving; the bot badge on every avatar
- [ ] The scripted model server exists and real AI SDK providers talk to it
- [ ] Settings → Models, Bots list, and the bot page; future sections disabled without naming a phase
- [ ] CLI `model` and `bot` commands; user docs for models and bots
- [ ] `rbac.test.ts` and `audited-actions.test.ts` include every new action

## Open questions

- Whether a bot may override alias `options` (e.g. a higher temperature for a creative bot) without its own alias.
  The default is no: make an alias.
- Whether `gateway` should become the recommended default provider, since it lets one key reach every model. Revisit
  once [phase 22](./phase-22-telemetry-and-cost.md) prices calls.

## Learnings from the build

Not built yet.
