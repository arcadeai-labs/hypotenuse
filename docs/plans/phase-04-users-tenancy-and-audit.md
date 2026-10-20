# Phase 4 — Users, tenancy, and audit

> **Goal:** People sign up and sign in; every new user lands in their own project as its admin; admins invite
> teammates and assign tags; every project-scoped action is gated by RBAC the frontend reads without being
> able to drift from it; every data-changing action writes an audit row in the same transaction; members get
> in-app and e-mail notifications. The sign-in pages the design system drew now work.

> **Status: planned, not built.** This phase is a **port**. ToolExec built all of it across five phases and
> recorded what went wrong in each; Hypotenuse copies the result, not the journey.

Hypotenuse's tenancy question is the same as ToolExec's: *who may do what to which project?* A Hypotenuse
project is the tenant that will own a Linear workspace connection ([phase 6](./phase-06-linear-connection.md)),
runners ([phase 8](./phase-08-runners.md)), routing rules ([phase 9](./phase-09-work-routing.md)), and a
history of agent sessions. The people in it need exactly what ToolExec's people need — membership, an admin
gate, finer-grained tags, invites, an audit trail of decisions, and somewhere to be told that something needs
them. ToolExec's answer took five phases to settle (3, 4, 5, 12, 25) and every one of its learnings sections
records a bug its plan would have shipped. **Copy the code nearly verbatim**; rename `toolexec` →
`hypotenuse`; delete what refers to agents, runs, workflows, sandboxes, and connections; and read these
before changing anything load-bearing:

- [ToolExec phase 4 — users and tenancy](https://github.com/arcadeai-labs/toolexec/blob/main/docs/plans/phase-04-users-and-tenancy.md)
  (`timestamptz`, `CONNECTION_ACTION_PARAM_VALIDATION`, standing decided by the server, `buildTestUniverse`)
- [ToolExec phase 5 — audit logging](https://github.com/arcadeai-labs/toolexec/blob/main/docs/plans/phase-05-audit-logging.md)
  (the closed list of unaudited writers, and why each is unaudited)
- [ToolExec phase 12 — human help](https://github.com/arcadeai-labs/toolexec/blob/main/docs/plans/phase-12-human-help.md)
  (the notification table, the broadcast channel, mail)
- [ToolExec phase 18 — dashboard WebSockets](https://github.com/arcadeai-labs/toolexec/blob/main/docs/plans/phase-18-dashboard-websockets.md)
  (content-free frames; the open Keryx frame-ordering defect)
- [ToolExec phase 25 — alternative themes](https://github.com/arcadeai-labs/toolexec/blob/main/docs/plans/phase-25-alternative-themes.md)
  (the pre-paint boot script and per-browser choice the [design system](./phase-03-design-system.md) reuses; its
  midnight look is **not** ported)

## Scope

**In:** ToolExec's pages and component logic on top of the [design system](./phase-03-design-system.md); sign-up, sign-in, account; projects as tenants with
the signup bootstrap; memberships, tags, user-tags, invites; the two RBAC gates and `actions:permissions`;
`AuditedAction`, `audit:list`, `audit:sweep`; notifications (browser + e-mail) and the
`project:<projectId>:notifications` channel; the live-socket context; the MCP publish policy with
Hypotenuse's never-lists; `buildTestUniverse()` and `getMcpAccessToken()`; the e2e suite and its CI job;
user-facing docs pages for accounts, projects, members, and audit.

**Out:** anything Linear-, runner-, or session-shaped. The project settings **page** is ported with its
General, Members, Tags, MCP, and Danger Zone sections; the Linear section arrives in
[phase 6](./phase-06-linear-connection.md), Runners in [phase 8](./phase-08-runners.md), Routing in
[phase 9](./phase-09-work-routing.md). The CLI commands that wrap these actions arrive with the CLI in
[phase 5](./phase-05-cli-and-distribution.md). No new notification *kinds* — those come with the features
that raise them.

## Permission model

Unchanged from ToolExec: **two gates, no role ladder**, plus tags.

| Level | Means | Middleware |
|---|---|---|
| `none` | no project-scoped gate (session-scoped or public) | — |
| `member` | holds a membership in `params.projectId` | `ProjectMemberMiddleware()` |
| `admin` | additionally holds the reserved `admin` tag | `AdminMiddleware()` |

What the levels mean in Hypotenuse, so later phases do not re-argue it:

| A member may | Only an admin may |
|---|---|
| view the project, its sessions, runners, routing rules, and Linear connection status | connect or disconnect Linear |
| register, edit, and revoke **their own** runners | revoke **anyone's** runner |
| cancel a session their own runner holds, or that they started in Linear | edit routing rules and project settings |
| link their own Linear identity | link or unlink another member's identity |
| read notifications addressed to them | read the audit log; manage members, tags, invites |

Ownership checks ("their own runner") are data-dependent, so they live in the actions, as ToolExec's
`canReadAgent` / `canWriteAgent` do — not in middleware. Tags stay available for anything finer; a later plan
may introduce, for example, a `runners` tag that permits registering runners at all, without touching the
middleware.

A role ladder (owner/admin/member/viewer) was considered and rejected for the same reason ToolExec rejected
Synchzor's: every level beyond `admin` turned out to be a tag with a reserved name. If one is ever needed,
`RBAC_LEVELS` in `backend/middleware/rbac.ts` is the single place to add it, and the descriptor →
`actions:permissions` → `can()` chain carries it to the UI unchanged.

## Steps

### 1. Pages and shell wiring on the design system — `frontend/src/{components,hooks,pages,content}`

The look is **not** ported. The [design system](./phase-03-design-system.md) has already landed ToolExec's `#ui/*` kit
with the same API, restyled, along with the tokens, both themes, the shell, the public frame, and the Keryx OAuth
page. This step copies everything that *uses* the kit, and it should drop in unchanged because props and test ids
were kept:

- `frontend/src/components/{LoadingLabel,SkeletonRows,SkeletonBlocks,MarkdownBlock,JsonBlock,NotificationBell,
  NotificationToasts}.tsx` and `components/sections/*` (the section-editor framework: `SectionCard`, `SectionNav`,
  `useSeededDraft`, `useSectionSave`, `useDirtyGuard`, `DiscardChangesModal`). ToolExec's `Layout` is **not** copied;
  signed-in pages render inside the design system's `AppShell`.
- `frontend/src/hooks/{useFirstLoad,useDisplayClock}.ts`.
- `frontend/src/pages/{AccountPage,NewProjectPage,InvitesPage,AuditLogPage,StatusPage}.tsx`, the settings sections
  `General`, `Members`, `Tags`, `Mcp`, and `DangerZone`, and the docs content
  `src/content/docs/{getting-started,accounts,projects,members,audit}.md`, registered in `sections.ts`.
- Wire the design system's sign-in and sign-up shells to `session:create` / `user:create`, and the account menu's
  sign-out to `session:destroy`.
- Add command-palette entries for the pages above ("Invite member", "Open audit log"), each gated by `can()`.

Drop: Workflow Studio, mission control, agent editor, DAG and transcript components, `@xyflow/react`.

### 2. Schema — `backend/schema/{users,projects,project_memberships,tags,user_tags,project_invites,audit_logs,notifications,project_settings}.ts`

Copy ToolExec's files. Every timestamp `{ withTimezone: true }`; `serial` primary keys; `users.email` unique,
`users.name` **not** unique; `audit_logs` with **no foreign key on `projectId`**, no `updatedAt`, indexes on
`createdAt` and `(projectId, createdAt)`; `notifications` one row per recipient per channel (`browser`,
`email`) with `status`, `attempts`, `nextAttemptAt`, `readAt`, `linkPath`.

`project_settings` is ported as an empty-ish row (one per project, created by the signup bootstrap) with only
the columns General needs. Later phases add their own columns by migration — `routing` in
[phase 9](./phase-09-work-routing.md) — rather than this phase guessing them.

Generate migrations **from scratch** (`bun run migrations`); do not copy ToolExec's `drizzle/` history.

### 3. Ops — `backend/ops/{UserOps,ProjectOps,MembershipOps,TagOps,InviteOps,AuditOps,CryptoOps,NotificationOps,RawRequestOps,NetworkGuardOps,RedisScriptOps,McpToolPolicyOps,ProjectSettingsOps}.ts`

Copy verbatim except:

- `ProjectOps.createProjectForOwner` also inserts the `project_settings` row.
- `AuditOps.SENSITIVE_KEYS` extends ToolExec's list with every secret Hypotenuse will handle, **now**, so no
  later phase can add a secret-bearing param without the key already being scrubbed:
  ```ts
  export const SENSITIVE_KEYS = [
    "password", "passwordHash", "password_hash",
    "secret", "secretValue", "token", "apiKey", "connectionString",
    "accessToken", "refreshToken", "accessTokenEnc", "refreshTokenEnc",   // Linear OAuth tokens
    "clientSecret", "webhookSecret", "code", "codeVerifier", "state",     // OAuth hops
    "runnerToken", "tokenHash",                                           // runner credentials
  ] as const;
  ```
  The scrub is recursive (ToolExec phase 17), so a token nested inside a payload is caught too.
- `CryptoOps` (AES-256-GCM `encryptSecret` / `decryptSecret`, `lastFourOf`, constant-time `secretsMatch`) and
  `initializers/secrets.ts` (refuses to boot without a 32-byte `SECRETS_ENCRYPTION_KEY`) are ported now even
  though the first ciphertext is a Linear token in [phase 6](./phase-06-linear-connection.md) — a boot-time
  refusal is cheapest to adopt before anything depends on it.
- `NotificationOps` keeps `enqueueNotification`, the nodemailer transport that logs instead of sending when
  `SMTP_HOST` is empty, `claimDueNotifications` (`FOR UPDATE SKIP LOCKED`), `deliverNotification`
  (broadcasts a content-free frame on `project:<projectId>:notifications`), and `templates/{layout,
  escapeHtml}`. Delete the help-question templates.
- `McpToolPolicyOps` keeps `shouldPublishAsMcpTool` and `applyMcpToolPolicy` and **rewrites the lists** (step 8).

### 4. Middleware and the audited base class — `backend/middleware/{session,rbac}.ts`, `backend/classes/AuditedAction.ts`

Copy verbatim, changing only the descriptor symbol to `Symbol.for("hypotenuse.rbac")`. `rbac.ts` keeps the
factories (`ProjectMemberMiddleware()`, `AdminMiddleware()`) that each return a fresh object carrying its own
`RBAC_DESCRIPTOR`, and `loadProjectAccess`'s identical 403 for "no such project" and "not a member".
`AuditedAction` keeps its three easy-to-miss details: clear the audit snapshots at the top of `run()` (MCP
connections are reused), type `run()` as `Awaited<ReturnType<this["runWithAudit"]>>`, and log a non-`TypedError`
cause before rewrapping it. `afterCommit` errors are logged and swallowed; `refuseAfterCommit` is ported.

### 5. Actions — `backend/actions/**`

| Domain | Actions (ToolExec file → same path here) |
|---|---|
| auth | `user.ts` (`user:create`, signup bootstrap + synthetic `project:create` audit row), `session.ts` (`session:create` / `session:destroy`, `regenerateSession` after login), `me.ts` (`me:view`), `user-edit.ts` (`user:edit`) |
| introspection | `actions-permissions.ts` (`actions:permissions`, unauthenticated), `status.ts`, `swagger.ts` |
| project | `project/project-{create,view,list,edit,delete,settings-view,settings-edit}.ts` — `project:view` returns `standing: { isMember, isAdmin }` |
| membership | `membership/membership-{create,delete,list}.ts` — last-admin guard inside the transaction |
| tag | `tag/tag-{create,edit,delete,list}.ts`, `tag/user-tag-{assign,remove}.ts` — `RESERVED_TAGS`, last-admin guard |
| invite | `invite/invite-{create,accept,reject,list,list-pending}.ts`, `invite/invites-sweep.ts` — 5-day TTL, accepted by e-mail match, idempotent |
| audit | `audit/audit-list.ts` (admin, time range, paginated), `audit/audit-sweep.ts` (daily, `AUDIT_RETENTION_DAYS=90`) |
| notification | `notification/notification-{list,mark-read,unread-count}.ts`, `notifications-dispatch.ts` (clock), `notifications-sweep.ts` |

Every mutating action extends `AuditedAction` except the closed list ToolExec argues: `session:create` /
`session:destroy`, the notification family, and sweeps. Hypotenuse adds its own members to that list later
(`webhooks:linear`, `linear:process-event`, the `daemon:*` family), each argued in the phase that adds it.
Every CRUD set has a paginated `list` (`paginationInputs({ defaultLimit: 25 })`). Validation errors use
`CONNECTION_ACTION_PARAM_VALIDATION` (406), never `ACTION_VALIDATION` (500).

Drop `project:dump` / `project:apply` / `project:overview` — Hypotenuse has no infrastructure-as-code
document yet, and a project's Linear connection cannot round-trip through a file anyway.

### 6. Channels — `backend/channels/projectNotifications.ts`

Copy verbatim: name `/^project:(\d+):notifications$/`, `ChannelMiddleware.runBefore` requires a session
`userId` and a membership row, else `CONNECTION_CHANNEL_AUTHORIZATION`. Frames are content-free
(`{ event: "notifications" }`); the client re-reads over HTTP. The channel-name patterns are exported from
`ops/` so the frontend and tests share them. This is the pattern `project:<projectId>:sessions`,
`project:<projectId>:runners` ([phase 15](./phase-15-dashboard.md)) and `runner:<runnerId>`
([phase 8](./phase-08-runners.md)) follow.

**Keryx's open frame-ordering defect** (ToolExec phase 18: one connection's frames are handled concurrently,
so a subscribe and an unsubscribe can be applied out of order) is inherited, not worked around (rule 4). The
dashboard's ref-counted channel registry is what keeps it from mattering in practice; record the upstream
issue number in `AGENTS.md`.

### 7. Frontend auth and live state — `frontend/src/context/{AuthContext,LiveSocketContext,NotificationContext}.tsx`, `components/ProtectedRoute.tsx`, `utils/permissions.ts`

Copy verbatim. `AuthContext` is the one place session state lives (`activeProjectId` in `localStorage` as
`hypotenuse.activeProjectId`); `ProtectedRoute` sends signed-out visitors to `/sign-in` and project-less ones to
`/projects/new`; `can(permissions, action, standing)` is the only gating function, with a non-nullable
`standing` parameter so an unresolved standing can hide an affordance but never render a denial.
`LiveSocketContext` is one reconnecting socket with ref-counted channels and 1 s → 30 s backoff.

Settings: `pages/SettingsPage.tsx` with `components/settings/sections/{General,Members,Tags,Mcp,DangerZone}`.
Drop `Sandbox`, `Model`, `GitProviders`, `SandboxLedger`.

### 8. MCP publish policy — `backend/ops/McpToolPolicyOps.ts`, `backend/initializers/mcpToolPolicy.ts`

Human MCP ≈ HTTP: almost every action with a `web.route` is a tool for a signed-in person's MCP client. The
never-list is rewritten for Hypotenuse and **declared now, before the actions exist**, so the first PR that
adds one cannot forget it:

```ts
const NEVER_MCP_ACTION_NAMES = new Set([
  "user:create", "session:create", "session:destroy",     // login / signup
  "status", "swagger", "actions:permissions",              // unauthenticated introspection
  "linear:callback",                                       // a browser OAuth hop
  "runner:register",                                       // mints a credential; a model must not hold one
]);
const NEVER_MCP_PREFIXES = ["webhooks:", "daemon:"];       // machine ingress; runner-token-only actions
```

plus ToolExec's structural rules: no `web.route` → never; `task.frequency > 0` (a clock) → never; login or
signup flag → never. `applyMcpToolPolicy` overwrites each action's `mcp.tool` at initialize, and `rbac.test.ts`
asserts every action's live flag equals `shouldPublishAsMcpTool(action)`. The `daemon:` prefix is safe to
assert by prefix because no human action shares it — the human runner ledger is `runner:*`
([phase 8](./phase-08-runners.md) explains why the two families are named apart).

### 9. Test fixtures — `backend/__tests__/setup.ts`

Add ToolExec's `authHeaders`, `cookieHeader`, `createUserAndLogin`, `createTag`, `inviteAndAccept`,
`getMcpAccessToken` (the full OAuth authorization-code + PKCE flow — the same flow the CLI's login uses in
[phase 5](./phase-05-cli-and-distribution.md)), and **`buildTestUniverse()`**, unchanged in cast so a test
reads as a sentence: **Peach** administers the shared project, **Mario** holds `operators`, **Luigi** holds
`viewers`, **Toad** is a member with no tags, and **Bowser** is an outsider with no membership. Members join
through the real invite → accept HTTP flow. Later phases extend the universe (Peach connects finear's
workspace in [phase 6](./phase-06-linear-connection.md); Mario and Luigi register runners in
[phase 8](./phase-08-runners.md)) rather than building their own.

### 10. Tests — `backend/__tests__/**`, `frontend/e2e/**`

Port with the actions they cover:

| Test | Asserts |
|---|---|
| `actions/user.test.ts` | signup bootstraps user + project + admin tag + settings row + audit row; duplicate e-mail is 406 with `key` |
| `actions/session.test.ts` | identical error for unknown e-mail and bad password; session id changes on login |
| `actions/rbac.test.ts` | Bowser 403 on member actions, Toad 403 on admin actions, Peach succeeds; **every action taking `projectId` declares a requirement**; every clock has no `web.route`; **every action's live `mcp.tool` equals `shouldPublishAsMcpTool`**; no `daemon:*` or `webhooks:*` action is a tool |
| `actions/{project,membership,tag,invite}.test.ts` | CRUD, pagination envelopes, last-admin guards, reserved tags, invite lifecycle and expiry |
| `actions/audit.test.ts` | the row and the mutation commit together (force a failure after the write and assert neither exists); `metadata` contains no `SENSITIVE_KEYS` key at any depth |
| `actions/notification.test.ts` | enqueue → dispatch → browser row + e-mail logged; mark-read; unread count |
| `channels/project-notifications.test.ts` | Bowser's subscribe is refused; a member receives a frame whose key set is exactly `{event}` |
| `oauth/{authorize-theme,redirect-loopback}.test.ts` | the themed authorize page; a portless loopback redirect URI is accepted with any port (RFC 8252 §7.3 — the CLI login depends on it) |
| `frontend/src/__tests__/{permissions,client}.test.ts` | `can()`; the `apiFetch` envelope handling (theme and UI-kit tests belong to the design system) |
| `frontend/e2e/{auth,settings,audit,notifications,smoke,docs}.spec.ts` | the browser path end to end |

CI gains the **E2E Test** job (Playwright, `workers: 2`, `e2e/global-setup.ts` waiting for the newest
migration's column through `/api/status`), added to `complete.needs`.

## Verification

```bash
cd backend && bun run migrations && bun run lint && bun test
cd ../frontend && bun run lint && bun run build && bun test && bun run test:e2e
cd .. && bun dev
curl -s localhost:8080/api/actions/permissions | jq '.permissions | to_entries | map(select(.value.type=="admin")) | length'
open http://localhost:3000/sign-up
```

Manually: sign up → land in your own project as admin → create a tag → invite a second address → sign up as
that address → accept → appear in Members with the tag → as the first user, read the audit log and see every
step → the second user cannot open `/audit`.

- `GET /api/actions/permissions` needs no auth and reports `none` / `member` / `admin` for every action.
- Removing the last admin fails with a typed validation error, by either route.
- An MCP client authorized through `/oauth/authorize` lists project tools and none of login, signup,
  `linear:callback`, `webhooks:*`, or `daemon:*`.
- `bun test` passes twice consecutively.

## Definition of done

- [x] ToolExec's pages, section framework, and hooks run unchanged on the design system's kit and shell; auth pages wired
- [x] Nine ported tables, generated as fresh migrations; every timestamp `timestamptz`
- [x] Session and RBAC middleware; `actions:permissions`; `can()`; standing decided by the server
- [x] Signup bootstraps project, membership, admin tag, settings row, and audit row in one transaction
- [x] CRUD + paginated `list` for projects, memberships, tags, invites; last-admin and reserved-tag guards
- [x] `AuditedAction` on every mutation outside the closed list; `SENSITIVE_KEYS` covers Linear and runner secrets
- [x] Notifications (browser + e-mail) and the `project:<projectId>:notifications` channel
- [x] MCP publish policy with Hypotenuse's never-lists, asserted by `rbac.test.ts`
- [x] `buildTestUniverse()` and `getMcpAccessToken()`; the e2e job joins the CI gate
- [x] User docs for accounts, projects, members, and audit under `frontend/src/content/docs/`

## Learnings from the build

### What is built

All ten Definition of done items. The backend is ToolExec's, trimmed: nine tables in one fresh migration, the session
and RBAC middleware, `AuditedAction`, every action in the step 5 table except the two noted below, the notifications
channel, and `applyMcpToolPolicy` stamped by `initializers/mcpToolPolicy.ts`. The frontend is ToolExec's pages,
contexts, and section framework inside the design system's shell; the e2e suite drives the real backend in the
existing **E2E Test** job, which now has Postgres and Redis. The operator CLI commands that wrap these actions are
out of scope here and arrive with the CLI itself (rule 13's decision, recorded).

### Where the port departs from ToolExec

- **The notification frame is `{ "event": "notifications" }` and nothing else.** ToolExec's carried the row's id
  and recipient so a tab could ignore frames that were not its own. Here every member's tab re-reads
  `notification:list` / `notification:unread-count` on any frame and toasts only rows it has not seen before; the
  first read after page load toasts nothing. The cost is one cheap re-read per open tab per notification in the
  project, which is the price of a channel that carries nothing to leak.
- **`project_settings` has no setting columns**, so `project:settings-edit` is not ported: an edit action with
  nothing to edit would be an MCP tool that does nothing. `project:settings-view` returns the row; the first
  feature that adds a column (routing) adds the edit action with it. `createProjectForOwner` inserts the row, and
  `getOrCreateSettings` keeps its lazy insert only as a backstop.
- **`NetworkGuardOps` is not ported.** Hypotenuse has no URL a person types and the server fetches — Linear's
  endpoints are configuration — so the SSRF guard would be dead code. Port it with the first feature that fetches a
  user-supplied URL. `RawRequestOps` is ported now, for the Linear webhook, which must verify its signature over the raw bytes.
- **There are no notification templates yet.** The registry is empty and every row renders through the generic
  fallback; each kind arrives with the feature that raises it. The mail chrome is painted from
  `backend/theme/email-palette.ts`, a new output of `design/tokens.ts` — mail clients cannot read custom
  properties, and literals typed into a template would drift from the app.
- **The settings page has General, MCP endpoint, Members, Tags, and Danger zone**, and General renames through
  `project:edit`. ToolExec's terminal `tx-*` classes are gone (`tx-` means *transcript* here); the ported pages'
  layout utilities (`d-flex`, `mb-3`, …) are defined token-only in `styles/_pages.scss`.
- **Shell wiring:** the project switcher works, and its menu holds Invites, Audit log, and New project so the
  sidebar's destinations stay as `DESIGN.md` lists them. The bell sits in the sidebar foot beside the account menu.
  "Invite member" and "Open audit log" in `⌘K` are gated through `can()` against the active project's standing
  (`hooks/useProjectStanding.ts`).

### Traps found while building

- **An empty `backend/lua/` fails boot.** `loadRedisScripts` reads the directory and git keeps no empty ones, so
  `lua/.gitkeep` is load-bearing until the first script lands. The flush-fallback test writes a fixture script,
  loads it, and removes it, so the `EVAL` path is proven before the application ships a script of its own.
- **`/api/status` must touch the newest migration's column**, not `SELECT NOW()`: Keryx binds before
  `DATABASE_AUTO_MIGRATE` finishes, and `e2e/global-setup.ts` waits on `healthy`. It reads
  `notifications.link_path`; move it whenever a newer migration lands.
- **Backend suites sign up dozens of users from one address**, so `RATE_LIMIT_ENABLED_TEST=false` in
  `.env.example`. The e2e backend turns the limiter back on, because the browser path is the only place it runs.
- **The e2e backend works its own queues** (`TASK_PROCESSORS_TEST=1`, a one-second dispatch tick) — the opposite of
  `bun test`, which drives jobs in-process. The notifications spec inserts a pending row, since no feature raises one
  yet, and waits for the real clock and socket to deliver it.
- **Headless Chromium's starting notification permission differs by build** — `"denied"` on CI's, `"default"` on
  a preinstalled one — so the permission spec installs a stand-in `Notification` and counts `requestPermission`
  calls instead of reading the browser's answer.
- **A stopped backend leaves node-resque's scheduler leader lock in Redis** until it expires (about a minute), and a
  backend booted before then never becomes leader, so no clock ticks. Locally that shows up as the live
  notification spec timing out when Playwright follows a backend suite or another e2e run too closely; CI's Redis
  is fresh. Wait for `resque:resque_scheduler_leader_lock` to expire, or give the e2e stack its own Redis index.
- **`bun test` and Playwright share the test database**, and every backend file opens with `clearDatabase()`. Run
  one at a time per checkout, or give one of them its own database.
- **Two bugs came over with the port, and review caught both.** `invite:reject` never checked that the invite
  was still pending, so an accepted invite could be rewritten to `rejected` with the membership left in place. And
  the last-admin guard read the admin set in the transaction without locking it, so under `READ COMMITTED` two
  admins removing each other at once both passed it. `lockProjectAdmins` now takes `FOR UPDATE` on the project row
  before every last-admin read; the concurrency tests in `membership.test.ts` fail every time without it.
- **Whole-set assertions catch what spot checks miss.** `rbac.test.ts` compares every action's level and the full
  published-tool set against literal maps, so a new action changes those maps in the same commit and its level and
  MCP exposure are a decision a reviewer sees.

### The Keryx frame-ordering defect

Filed as [actionhero/keryx#550](https://github.com/actionhero/keryx/issues/550). Still present in Keryx 0.48.0:
`handleWebSocketConnectionMessage` awaits per message, but nothing serializes one connection's messages, and
`handleWebsocketSubscribe` only records the subscription after awaiting the session, the channel middleware, and
presence. So against `project:<id>:notifications` (whose middleware runs a membership query) a `subscribe` then
`unsubscribe` sent in one tick was acknowledged `unsubscribed, subscribed` and kept receiving broadcasts in 40 of 40
trials. The dashboard's ref-counted channel registry defers the last unsubscribe past the current turn, which keeps
it from mattering in practice.
