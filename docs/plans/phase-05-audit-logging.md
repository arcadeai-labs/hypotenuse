# Phase 05 — Audit logging

> **Goal:** Every decision a person makes in Hypotenuse is recorded **in the same transaction as the change**, by
> ToolExec's `AuditedAction`, kept verbatim. Project admins read the history on the Audit log page and through
> `audit:list`; organization owners read their organization's. The log never holds a secret.
>
> The writers that are deliberately *not* audited form a closed list, argued here once:
> - machine ingress;
> - agent ticks;
> - the outbox;
> - sandbox supervisors;
> - clocks.

> **Status: built.** It builds on [phase 04](./phase-04-organizations-users-and-rbac.md), which
> already routes every mutation through `AuditedAction` and therefore already writes `audit_logs` rows. This phase
> makes that history visible, retained, and argued, and adds the two columns 2.0 needs: organization scope and a
> non-user actor.

The user asked for this explicitly: **keep ToolExec's audit history.**

ToolExec's audit design is short and strict:
- An action that writes extends `AuditedAction` and implements `runWithAudit(tx, params, connection)`.
- It routes **every** write through `tx` and sets `connection.metadata.auditBefore` / `auditAfter` from
  `serializeX()` output.
- `AuditedAction.run` inserts the audit row on that same `tx`. There is no queue and no best-effort hook, so the
  log cannot disagree with what was persisted, in either direction.

v1 ported it unchanged, and its rule 6 ("the audited thing is always the decision a person made") carries over
word for word.

2.0 raises a question neither predecessor had. **Some decisions a person makes never touch our dashboard.** A
project admin who clicks *Approve* on a bot's tool call inside Slack, or *Reject* on a customer-facing reply in
Pylon, has made exactly the kind of decision the audit log exists for. That person may not be a Hypotenuse user at
all, because 2.0 trusts the platform's own permissions to decide who may talk to a bot. So the audit row gains an
**actor type**: a Hypotenuse `user`, a platform `participant`, or the `system` (a bootstrap write made by a shared
ops helper). The participant columns are declared now. The first rows that use them come from the
[channel framework](./phase-13-channel-framework.md), so no later phase reshapes this table.

## Scope

**In:**
- `AuditedAction` and its four easy-to-miss details.
- `audit_logs` with `organizationId`, `actorType`, and `participantId`.
- `SENSITIVE_KEYS` covering **every** secret 2.0 will handle, declared now.
- Recursive `scrubParams`; `writeAuditLog` / `insertAuditLog` for shared ops helpers.
- `audit:list` (project admin) and `organization:audit-list` (organization owner).
- `audit:sweep` with `AUDIT_RETENTION_DAYS`.
- The Audit log page for project and organization.
- The closed list of unaudited writers, argued below and copied into `AGENTS.md`'s rule.
- User docs.

**Out:**
- Exporting audit rows to a SIEM (OpenTelemetry log export, [phase 22](./phase-22-telemetry-and-cost.md), may
  carry them).
- A personal audit view (CLI sign-ins have no project; see v1's learnings).
- Tamper evidence (hash chains). Settled non-goal: the database is the trust boundary.

## What already exists

| Piece | Where |
|---|---|
| `AuditedAction` (`runWithAudit(tx)`, `afterCommit`, `refuseAfterCommit`) | [ToolExec `backend/classes/AuditedAction.ts`](https://github.com/arcadeai-labs/toolexec/blob/main/backend/classes/AuditedAction.ts) |
| `SENSITIVE_KEYS`, `scrubParams`, `writeAuditLog`, `insertAuditLog` | [ToolExec `backend/ops/AuditOps.ts`](https://github.com/arcadeai-labs/toolexec/blob/main/backend/ops/AuditOps.ts) |
| `audit_logs` (no FK on `projectId`, nullable non-cascading `userId`, no `updatedAt`) | [ToolExec `backend/schema/audit_logs.ts`](https://github.com/arcadeai-labs/toolexec/blob/main/backend/schema/audit_logs.ts) |
| `audit:list`, `audit:sweep`, `AuditLogPage` | ToolExec `backend/actions/audit/`, `frontend/src/pages/AuditLogPage.tsx` |
| Why each unaudited writer is unaudited | [ToolExec phase 5 learnings](https://github.com/arcadeai-labs/toolexec/blob/main/docs/plans/phase-05-audit-logging.md) |
| v1's closed list (`daemon:*`, `webhooks:linear`, CLI sign-in ingress) | [v1 `AGENTS.md`, rule 6](https://github.com/arcadeai-labs/hypotenuse/blob/v1/AGENTS.md) |

## What this must not weaken

1. **The audit row and the mutation are one commit.** `audit.test.ts` keeps ToolExec's proof: a throwaway subclass
   writes a row and then throws, and neither the row nor its audit entry survives.
2. **`audit_logs` breaks the referential rules on purpose.**
   - There is no foreign key on `projectId` or `organizationId`.
   - `userId` is nullable and does not cascade.

   So deleting a project, organization, or user cannot erase the record of itself. Rows are immutable.
3. **A secret never reaches a row.** Params are scrubbed recursively by key. Serializers have no field a secret
   fits in, so `auditBefore` / `auditAfter` cannot carry one either.
4. **An unauthenticated writer never appends audit rows.** If an unauthenticated writer could, anyone on the
   internet could flood the one table whose value depends on nobody being able to. A webhook's own record is
   `trigger_events` ([phase 13](./phase-13-channel-framework.md)).

## Design

### `AuditedAction`, unchanged

Four details from ToolExec's learnings, each of which looks optional and is not:

- **`run()` clears the audit snapshots first.** MCP sessions reuse a connection across `act()` calls, so a
  previous action's `auditBefore` would otherwise be attributed to this one.
- **The return type is `Awaited<ReturnType<this["runWithAudit"]>>`.** Without it, `ActionResponse<T>` collapses to
  `unknown` on the frontend.
- **Log the original error before rewrapping it.** The real Drizzle error is in `error.cause`.
- **`afterCommit` errors are logged and swallowed.** The write already committed, and enqueueing work is what
  `afterCommit` is for.

Other metadata an action can set:
- `connection.metadata.auditProjectId` and `auditOrganizationId` scope a row whose params do not name its tenant
  (`project:create`, `invite:accept`).
- `auditTargetType` / `auditTargetPath` fill the page's Target column.
- `auditMetadata` overrides the scrubbed params when they understate what happened. For example, `tag:delete`
  records the members it revoked from.

### Actors

| `actorType` | `userId` | `participantId` | Written by |
|---|---|---|---|
| `user` | set | null | every `AuditedAction` run by a browser session or CLI token |
| `participant` | null, or set when a linked identity exists | set | decisions a person makes on a platform: an approval or a rejection clicked in Slack, Linear, or Pylon ([phase 13](./phase-13-channel-framework.md) onward), through `writeAuditLog` inside the processing transaction |
| `system` | null | null | synthetic rows from shared ops helpers (the sign-up bootstrap's `organization:create` and `project:create`) |

A `participant` row is written by the *processing* of a verified inbound event, never by the ingress action that
received it. That keeps rule 4 above intact: ingress verifies, records a `trigger_events` row, answers, and
enqueues. Processing turns a verified click into a decision and audits it.

### `SENSITIVE_KEYS`, complete from day one

Declared in full now, so no later phase can add a secret-bearing param without its key already being scrubbed.
The scrub matches **param keys**, not value prefixes. That was v1's category error with `hyp_cli_`.

```ts
export const SENSITIVE_KEYS = [
  "password", "passwordHash", "password_hash",
  "secret", "secretValue", "token", "apiKey", "connectionString",
  "accessToken", "refreshToken", "clientSecret", "signingSecret",       // platform OAuth and Slack signing
  "webhookSecret", "botToken", "appToken", "privateKey",                // platform apps, GitHub App
  "code", "codeVerifier", "state", "deviceCode",                        // OAuth hops, CLI sign-in
  "runToken", "tokenHash", "continuationSecret",                        // sandboxes, code-mode continuations
  "headers", "authorization",                                           // MCP server and telemetry exporter headers
] as const;
```

`headers` is broad on purpose. An MCP server's or an OTLP exporter's header map is where credentials hide, and a
scrubbed header map costs a reviewer nothing.

### Scope of each list

| Action | RBAC | Reads |
|---|---|---|
| `audit:list` | project `admin` (an organization owner, through admin standing) | rows with `projectId = :projectId` |
| `organization:audit-list` | `org-owner` | rows with `organizationId = :organizationId`, **including** every project in it; filterable by project |

Both are time-ranged (`since` / `until` accept ISO strings or epoch milliseconds, through `z.preprocess`) and
filterable by `action`, `actorType`, and `targetType`. Both are paginated.

### The closed list of unaudited writers

Moved into this doc from `AGENTS.md`, which keeps the list and points here for the reasons. Every later phase
that adds an unaudited writer adds a row here **and** to `AGENTS.md`, in the same commit.

| Writer | Why it is not audited | Its record instead | Audited decision it traces to |
|---|---|---|---|
| Reads (`*:view`, `*:list`), `actions:permissions` | change nothing | — | — |
| `session:create` / `session:destroy` | login churn belongs in logs and metrics | Keryx logs | — |
| `notification:mark-read` | a per-person reading habit, not a project change | `notifications.readAt` | — |
| Clocks and sweeps (`*:sweep`, `*-due`, `*:reap`, `notifications:dispatch`) | the clock acting | the rows they change | the setting that armed them |
| `cli-auth:device` / `cli-auth:exchange`, and a CLI token's sliding expiry | the CLI's sign-in ingress; returns a token ([phase 06](./phase-06-operator-cli.md)) | `cli_tokens` | `cli-auth:approve` / `cli-auth:activate` |
| `webhooks:*` ([phase 13](./phase-13-channel-framework.md)) | unauthenticated: auditing it would let anyone append rows | `trigger_events` | connecting the platform, binding a bot to a channel |
| `triggers:process-event` (and its `triggers:process-pending` clock) and the inbox it writes | machine processing of a verified event | `trigger_events`, `conversation_inbox` | as above; a decision inside it (an approval click) **is** audited as `participant` |
| `agent:tick` and every tool a bot runs ([phase 08](./phase-08-durable-agent-loop.md)) | hundreds per conversation; the transcript is the better record | `conversation_entries`, plus provenance on what they wrote (`memory_documents`) | creating the bot, binding it, editing its tools |
| Outbox delivery (`outbox:deliver`, `outbox:deliver-due`) | the machine half of a reply | `outbox_messages` | as above |
| The sandbox machine half (`sandbox:events`, `sandbox:heartbeat`, `sandbox:complete`, the in-sandbox tools) ([phase 17](./phase-17-sandboxes.md)) | volume, with a better substitute | `sandbox_jobs`, `sandbox_job_events` | the bot's `sandbox_start`, traced to its conversation, traced to its binding |
| Cost records written as a tick ends ([phase 22](./phase-22-telemetry-and-cost.md)) | an accounting ledger, not a decision | `cost_records` | — |

The pattern every row follows: **the audited thing is the decision a person made.** That means connecting a
platform, creating or editing a bot, binding it to a channel, granting it a tool, approving its call, or cancelling
its conversation. The machine traffic that follows has its own, better record.

## Schema sketch

```ts
audit_logs {
  id serial,
  organizationId integer null,       // no FK, on purpose
  projectId integer null,            // no FK, on purpose
  actorType text not null,           // "user" | "participant" | "system"
  userId integer null → users (no cascade),
  participantId integer null,        // no FK; participants arrive with the channel framework
  action text not null,              // the Keryx action name, e.g. "bot:edit"
  targetType text null, targetPath text null,
  metadata jsonb not null default {}, before jsonb null, after jsonb null,
  createdAt timestamptz not null default now()
}
indexes: (createdAt), (projectId, createdAt), (organizationId, createdAt)
```

## Actions and policy sketch

| Action | Route | RBAC | MCP | Audited |
|---|---|---|---|---|
| `audit:list` | `GET /project/:projectId/audit` | admin | yes | no (read) |
| `organization:audit-list` | `GET /organization/:organizationId/audit` | org-owner | yes | no (read) |
| `audit:sweep` | — (daily clock) | — | never | no (clock); deletes rows older than `AUDIT_RETENTION_DAYS` (default 365, raised from ToolExec's 90 because a shared bot's history outlives a sprint) |

## Frontend and user docs

- **`AuditLogPage`** (ToolExec's), reached from the project switcher's menu and from Organization → Audit log.
  - It shows actor (a Hypotenuse user, or a platform participant with their platform chip), action, target, and
    time.
  - Its expandable before/after diff renders through `JsonBlock`.
  - Changing a filter resets pagination **during render**, ToolExec's learning, so a request never combines new
    filters with an old page.
- **`frontend/src/content/docs/audit.md`** covers: what is recorded, what is not and why (the closed list in
  plain words), who can read it, retention, and how a decision made in Slack appears.

## Steps

### 1. Schema and migration — `backend/schema/audit_logs.ts`

### 2. Ops — `backend/ops/AuditOps.ts`

Complete `SENSITIVE_KEYS`. Add `writeAuditLog(tx, { actorType, … })`; it is used by shared ops helpers and, from
the channel framework onward, by event processing.

### 3. Base class — `backend/classes/AuditedAction.ts`

Infer `organizationId` from `connection.metadata.project.organizationId` when not set explicitly, so every project
row is also an organization row.

### 4. Actions — `backend/actions/audit/{audit-list,organization-audit-list,audit-sweep}.ts`

### 5. Frontend — `frontend/src/pages/AuditLogPage.tsx`, organization route, `⌘K` "Open audit log" gated by `can()`

### 6. `AGENTS.md` rule — the closed list, with a link to this doc

## Test plan

- `audit.test.ts`:
  - the atomicity proof;
  - the four `AuditedAction` details (snapshot clearing across a reused MCP connection is driven over a real MCP
    session from `getMcpAccessToken()`);
  - synthetic sign-up rows with `actorType: "system"`.
- `audit-scrub.test.ts`: every entry of `SENSITIVE_KEYS` is removed at depth 0 and depth 3, including from a
  `headers` map. A whole-set comparison against a literal list makes adding a key a reviewed decision.
- `audit-list.test.ts`:
  - project vs organization scope;
  - an organization owner reads every project's rows;
  - a project admin of one project cannot read another's;
  - time-range parsing of epoch milliseconds;
  - pagination.
- `audited-actions.test.ts`: walks the registry and asserts every action whose name is not on the closed list and
  that is not a read **extends `AuditedAction`**. The closed list is a literal in the test, so adding an
  unaudited writer is a visible decision.
- e2e `audit.spec.ts`: dates, action filter, and Reset from page 2 all request page 1.

## Verification

```bash
cd backend && bun test __tests__/actions/audit* __tests__/classes
cd ../frontend && bun run test:e2e -- audit.spec.ts
```

Edit a project name in the browser, then open Audit log: one row, actor you, before and after names shown.

## Definition of done

- [x] Every non-read action outside the closed list extends `AuditedAction`, asserted by walking the registry
- [x] `audit_logs` carries `organizationId`, `actorType`, and `participantId`, with no FKs on tenant columns
- [x] `SENSITIVE_KEYS` covers every secret 2.0 plans to handle; the scrub is recursive and tested at depth
- [x] `audit:list` and `organization:audit-list` are paginated, time-ranged, and correctly scoped
- [x] The Audit log page works for a project and for an organization
- [x] The closed list lives here and in `AGENTS.md`, and the two agree
- [x] User docs explain what is and is not recorded

## Open questions

- Whether participant-made decisions should also notify the project's admins. The default is no: the audit row is
  the record, and approvals have their own notification path.

## Learnings from the build

### What is built

| Piece | Where |
|---|---|
| `organization_id`, `actor_type`, `participant_id`, the `(organization_id, created_at)` index, and a backfill of earlier rows | `backend/schema/audit_logs.ts`, `backend/drizzle/0002_*.sql` |
| `writeAuditLog` with a required `actorType`; organization inference; the shared list query and time inputs | `backend/ops/AuditOps.ts` |
| `audit:list`, `organization:audit-list`, `audit:sweep` (`AUDIT_RETENTION_DAYS`, default 365) | `backend/actions/audit/`, `backend/config/audit.ts` |
| The Audit log page, for a project (`/audit`) and an organization (`/organization/audit`) | `frontend/src/components/audit/AuditLogView.tsx`, `pages/AuditLogPage.tsx`, `pages/organization/OrganizationAuditPage.tsx`, `components/JsonBlock.tsx` |
| Ways in: the project switcher, the organization switcher and section nav, two palette commands | `components/shell/{ProjectSwitcher,OrganizationSwitcher,MenuLinkItem}.tsx`, `commands/registry.ts` |
| User docs | `frontend/src/content/docs/audit.md`, with the `audit` illustration |
| Proof | `backend/__tests__/classes/audit.test.ts`, `__tests__/ops/audit-scrub.test.ts`, `__tests__/actions/{audit-list,audited-actions}.test.ts`, `frontend/e2e/audit.spec.ts` |

### Decisions the plan left open

- **The organization a row is filed under** is, in order: `auditOrganizationId`, the `organizationId` param, the
  organization of the project the RBAC middleware loaded, the organization it loaded. `writeAuditLog` reads a
  project's organization itself when a caller gives only a `projectId`, so a participant row written by event
  processing cannot forget it. `organization:create` and the invite answers set `auditOrganizationId`.
- **Sign-up's own row is the new account's**, `actorType: "user"`, through `auditUserId` (the caller has no session
  until the account exists). It is the one row an unauthenticated request writes: the decision is that person's, the
  action is rate-limited, and each row costs a new account. The bootstrap's `organization:create` and
  `project:create` are `system` rows with a null `userId` and `metadata.ownerUserId`.
- **A write with no session and no `auditUserId` is the system's.** No such `AuditedAction` exists yet; the class
  suite proves the default.
- **Migration 0002 backfills** rows written before these columns: bootstrap rows (`metadata.bootstrappedBy`) become
  `system` with their user moved to `metadata.ownerUserId`, the sign-up row gains the account whose email is its
  target, and `organization_id` comes from `metadata.organizationId`, the project's organization, or — for a project
  already deleted — the `organizationId` in its own `project:*` rows' snapshots. A row of a deleted project with no
  such snapshot stays without an organization and is only readable in the database. `actor_type`
  is added with a default for the backfill and the default is dropped, so every new row names its actor.
- **The serializer names the actor** (`actor: { type, userId, participantId, name, email }`) and the project
  (`projectName`, `null` once deleted) by left joins, so the page never makes a request per row. A participant is
  shown as "Platform participant #id" until `participants` exists to give them a name and a platform chip.
- **`organization:audit-list`'s `projectId` is a filter** over rows already scoped to the organization; a project of
  another organization matches nothing.
- **The action filter's vocabulary is `actions:permissions`' keys**, which includes reads that never match a row.
  A list of audited actions would need a new endpoint for a cosmetic gain.
- **The project's audit log is its own page, `/audit`**, not a settings section: it is reached from the project
  switcher, and a member who opens it is told it is an admin's rather than shown a failed request.
- **The agent loop added three unaudited writers** that are not clocks: `agent:tick`, `conversation:compact` (the
  background summary a tick asks for, recorded as a `compaction` entry in `conversation_entries`), and
  `outbox:deliver`. `agents:reap`, `agents:wake-due`, and `outbox:deliver-due` are clocks. The decisions they trace to
  — `conversation:create`, `conversation:message`, `conversation:cancel`, `bot:rotate-callback-secret` — are audited,
  with a message's text recorded only as its length and sha256.
- **Rule 13: no CLI command wraps `audit:list` or `organization:audit-list` yet** — deferred, not out of scope, as
  with phase 04's actions: [phase 06](./phase-06-operator-cli.md) is the CLI's sign-in.

### Traps found while building

- **Postgres keeps microseconds; serializers emit milliseconds.** A row's own `createdAt` is at or before its stored
  instant, so `until=<that createdAt>` excluded the row itself. `until` now covers its whole millisecond (`<
  until + 1ms`); `since` is inclusive as written. `audit-list.test.ts` pivots on a real row to hold both.
- **The page is derived, not reset.** `AuditLogView` stores the page with the filters it was chosen under and reads
  page 1 whenever they differ, so the request that follows a filter change already asks for page 1. An effect that
  reset the page would send one request with the old page first. `audit.spec.ts` watches the requests.
- **Two elements shared a test id** (`audit-page` was the page and the pagination's current page); Playwright's
  strict mode caught it. The current page is `audit-current-page`.
- **`audited-actions.test.ts` reads `AGENTS.md` and this doc**, and fails if an unaudited writer that is not a clock
  is missing from either, so the closed list cannot drift between them.
