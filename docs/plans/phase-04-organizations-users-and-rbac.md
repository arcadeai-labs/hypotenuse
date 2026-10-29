# Phase 04 — Organizations, users, and RBAC

> **Goal:** People sign up and sign in. Every new user lands in their own **organization** as its owner, with a
> first project in which they are admin. Owners create projects and invite teammates; admins assign tags.
>
> Every project-scoped action is gated by **ToolExec's RBAC, kept verbatim**:
> - tags as roles;
> - the reserved `admin` tag;
> - the `none` / `member` / `admin` levels;
> - per-object `accessRead` / `accessWrite` tag lists.
>
> Above that sit two new organization levels. The frontend reads every level through `actions:permissions` and
> `can()`, so it cannot drift from the server. Members receive in-app and email notifications.

> **Status: built.** See [Learnings from the build](#learnings-from-the-build). It builds on [phase 01](./phase-01-foundation.md) (scaffold) and
> [phase 03](./phase-03-design-system.md) (the kit and shell the copied pages paint with). Audit lands
> immediately after in [phase 05](./phase-05-audit-logging.md). Every action this phase writes is an
> `AuditedAction` from its first commit; phase 05 delivers the log, the page, and the argued list of exceptions.

The user asked for this explicitly: **keep ToolExec's RBAC roles.** ToolExec reached its permission model over
five phases (3, 4, 5, 12, 25) and v1 ported it unchanged; each learnings section records a bug its plan would
have shipped. The model has three parts.

- **Two gates, no role ladder.** `member` means you hold a membership in `params.projectId`. `admin` means you
  additionally hold the reserved `admin` tag. Everything finer is a tag.
- **Tags are the roles.** An admin creates tags (`support`, `eng`, `finance`) and assigns them to members. A tag
  means nothing on its own.
- **Objects carry tag lists.** Each object has an `accessRead` list and an `accessWrite` list of tag names. In
  2.0, the first such object is a bot ([phase 07](./phase-07-model-providers-and-bots.md)): `canReadBot` and
  `canWriteBot` are ToolExec's `canReadAgent` and `canWriteAgent` under a new name. "Agents are multiplayer, with
  read and write handled by project permissions" is exactly this model.

One thing is new: **Organizations.** The 2.0 data model is Organization → Project → Bots. A company has many
teams, and each team has its own project, with its own bots, Slack workspace install, memory, and members. It
needs one place where someone can see all of them and create the next one.

An organization is deliberately thin. It owns **members and projects, nothing else.** Platform installs, MCP
servers, model keys, memory, bots, and skills all belong to a project, a decision settled with the user. So
organizations add two levels of standing and a containment rule, and they do not touch the project RBAC at all.

## Scope

**In:**
- Users, sign-up, sign-in, and account (ToolExec's).
- `organizations` and `organization_memberships` with `role` `owner | member`.
- The sign-up bootstrap: a personal organization plus a first project.
- Projects as tenants inside one organization.
- Project memberships, tags, user tags, and invites (ToolExec's), extended so that accepting an invite also
  creates the organization membership.
- The two project gates plus two organization gates, with `actions:permissions` and `can()`.
- `ops/AccessOps.ts`: the one `satisfiesAccess` behind every `accessRead` / `accessWrite` list.
- `CryptoOps` and `initializers/secrets.ts`.
- `NotificationOps`, the notification clocks, and the `project:<projectId>:notifications` channel.
- The MCP publication policy (`McpToolPolicyOps`) with 2.0's never-lists.
- `buildTestUniverse()` with the organization cast.
- The settings pages: General, Members, Tags, Danger zone.
- Organization pages: Members, Projects.
- e2e in the gate.
- User docs: accounts, organizations, projects, members, tags.

**Out:**
- The audit log page, `audit:list`, and the argued exceptions ([phase 05](./phase-05-audit-logging.md)).
  `AuditedAction` itself lands **here**, because every mutation here must already be audited.
- The CLI commands that wrap these actions ([phase 06](./phase-06-operator-cli.md)).
- Single sign-on and SCIM: a later plan.
- Billing.
- Organization-level settings beyond name and slug.
- Moving a project between organizations: settled non-goal, below.
- Personal access tokens: the same settled non-goal as ToolExec and v1.

## What already exists

| Piece | Where |
|---|---|
| Tables, ops, middleware, actions, pages | [ToolExec phase 4](https://github.com/arcadeai-labs/toolexec/blob/main/docs/plans/phase-04-users-and-tenancy.md), and v1's port: [v1 phase 04](https://github.com/arcadeai-labs/hypotenuse/blob/v1/docs/plans/phase-04-users-tenancy-and-audit.md) |
| `RBAC_DESCRIPTOR`, `RBAC_LEVELS`, `ProjectMemberMiddleware()`, `AdminMiddleware()`, `loadProjectAccess` | [ToolExec `backend/middleware/rbac.ts`](https://github.com/arcadeai-labs/toolexec/blob/main/backend/middleware/rbac.ts) |
| `RESERVED_TAGS`, `ADMIN_TAG`, `normalizeTagName` | [ToolExec `backend/ops/TagOps.ts`](https://github.com/arcadeai-labs/toolexec/blob/main/backend/ops/TagOps.ts) |
| `satisfiesAccess`, `canReadAgent`, `canWriteAgent`, `readableAgentIds`, `ACCESS_EVERYONE` | [ToolExec `backend/ops/AgentOps.ts`](https://github.com/arcadeai-labs/toolexec/blob/main/backend/ops/AgentOps.ts) (a second copy lives in `WorkflowOps.ts`) |
| `getCallerTags`, `isAdmin`, `getAdminUserIds` | [ToolExec `backend/ops/MembershipOps.ts`](https://github.com/arcadeai-labs/toolexec/blob/main/backend/ops/MembershipOps.ts) |
| `createProjectForOwner`, `standing` on `project:view` | ToolExec `backend/ops/ProjectOps.ts`, `actions/project/project-view.ts` |
| `lockProjectAdmins` (`FOR UPDATE` on the project row before every last-admin read), the `invite:reject` pending check | v1's two port bugs; [v1 learnings](https://github.com/arcadeai-labs/hypotenuse/blob/v1/docs/plans/phase-04-users-tenancy-and-audit.md) |
| Frontend `can()`, `useProjectStanding`, the section framework, `AccountPage`, `InvitesPage` | v1 `frontend/src/{utils/permissions.ts,hooks,components/sections,pages}` |

## What this must not weaken

1. **Two project gates, no role ladder.** `RBAC_LEVELS` in `backend/middleware/rbac.ts` is the single place a
   level is added. The descriptor → `actions:permissions` → `can()` chain carries any new level to the UI
   unchanged. The two organization levels go through exactly that path.
2. **One identical 403** for "no such project" and "not a member", and likewise for organizations. A refusal
   never reveals that a tenant exists.
3. **The server decides standing.** `project:view` and `organization:view` return
   `standing: { isMember, isAdmin, viaOrganizationOwner }`. The client never infers it.
4. **Access lists are checked inside actions, never in middleware**, because the rule lives on the row and
   middleware runs before the row is loaded. Middleware gates membership; `AccessOps` gates the object.
5. **The last-admin guard and the last-owner guard each lock their parent row** (`FOR UPDATE` on `projects` or
   `organizations`) before reading the admin or owner set. Otherwise two removals at once both pass under
   `READ COMMITTED`.
6. **Every timestamp is `withTimezone: true`.** Validation errors are `CONNECTION_ACTION_PARAM_VALIDATION`, never
   `ACTION_VALIDATION`.

## Design

### The levels

| Level | Means | Middleware | Param |
|---|---|---|---|
| `none` | session-scoped or public | — | — |
| `member` | holds a membership in the project, **or** owns its organization | `ProjectMemberMiddleware()` | `projectId` |
| `admin` | additionally holds the `admin` tag, **or** owns its organization | `AdminMiddleware()` | `projectId` |
| `org-member` | holds an organization membership | `OrganizationMemberMiddleware()` | `organizationId` |
| `org-owner` | holds it with `role = owner` | `OrganizationOwnerMiddleware()` | `organizationId` |

### What each level may do

| A project member may | Only a project admin may |
|---|---|
| view the project, its bots (subject to `accessRead`), conversations, and memory | connect platforms, model providers, MCP servers, and sandbox providers |
| create a bot, and edit a bot they can write (`accessWrite`) | manage members, tags, invites; edit project settings |
| answer and cancel in the dashboard what they can read | read the audit log |

| An organization member may | Only an organization owner may |
|---|---|
| see the organization and the projects they belong to | see and administer **every** project in it |
| leave the organization | create projects, rename or delete the organization, promote or remove members |

### Organization owners have admin standing in every project of their organization

This is the deliberate choice, and it is computed in one place: `loadProjectAccess`.

- If the caller has no project membership but owns the project's organization, the access check succeeds.
- `callerTags` then contains the project's reserved `admin` tag row, so every downstream `isAdmin` call and every
  `canReadBot` call behaves exactly as for a project admin. No action branches on organizations.
- `standing.viaOrganizationOwner = true`. Every audit row written under that standing records it
  (`auditMetadata.standing = "organization-owner"`).

The alternative was "owners can see, but must join to act". It adds a click and an audit row while protecting
nothing: an owner can always add themselves to the project, and that is an audited decision either way. The thing
worth guarding is that **visibility is never ambiguous**, and the `viaOrganizationOwner` flag guarantees that.

### Project membership requires organization membership

- `membership:create` refuses a user who is not a member of the project's organization: one 406 with the next
  move, "invite them to the organization first".
- **Accepting a project invite creates the organization membership if it is missing**, in the same transaction as
  the project membership. A teammate invited to one project therefore joins the organization as a `member`, and
  sees nothing else in it.
- `organization-membership:delete` (an owner removing someone, or someone leaving) does three things in **one
  transaction**:
  1. removes every project membership that user held in the organization;
  2. removes their `user_tags` there;
  3. runs the last-admin guard on each affected project.

  An owner always has admin standing, so removing a non-owner can never leave a project without admin standing.

### One invites table

`project_invites` is ToolExec's, plus a required `organizationId`, and its `projectId` becomes nullable.

- With a `projectId`, it is a project invite (admin).
- Without one, it is an organization invite (owner) that grants only the organization membership.

Both expire after five days, are accepted by email match, and are idempotent. Two tables with one lifecycle would
be two sweeps and two lists.

### The sign-up bootstrap

`user:create` calls `createOrganizationForOwner`, then `createProjectForOwner`, all on one transaction. The result
is an organization named after the person, its first project (named "Default"), the reserved `admin` tag, and the
person's admin `user_tags`. These shared ops helpers write synthetic audit rows (`organization:create`,
`project:create`) through `writeAuditLog`, as ToolExec's sign-up does. Otherwise the log would open with no record
of the tenant's creation.

### Creating projects

Only owners, via `project:create` with `organizationId`, at the `org-owner` level. The creator becomes the
project's first explicit admin. The rule is "owners create projects, members are invited to them", settled with
the user. A future `membersCanCreateProjects` organization setting is the obvious extension and is left out until
someone asks for it.

### Access lists: `backend/ops/AccessOps.ts`

ToolExec's semantics, unchanged, in **one** module. ToolExec carries two copies of `satisfiesAccess`, in
`AgentOps` and `WorkflowOps`, which is the drift this file prevents.

| List contents | Who satisfies it |
|---|---|
| any list, caller is admin (or an organization owner) | everyone with that standing |
| `[]` (empty) | every project member |
| contains `*` (`ACCESS_EVERYONE`) | every project member |
| tag names | members holding any named tag (case-insensitive, trimmed) |

Exports:
- `satisfiesAccess(list, callerTags)`;
- `canRead(row, callerTags)` and `canWrite(row, callerTags)`, for any row with `accessRead` / `accessWrite`;
- `readableIds(db, table, projectId, callerTags)`, ToolExec's `readableAgentIds` generalised so a list of
  something-readable can page in SQL;
- `accessListSchema`, the Zod input that validates every entry names an existing tag or `*`.

[Phase 07](./phase-07-model-providers-and-bots.md) defines `canReadBot` and `canWriteBot` as one-line wrappers,
so call sites read like ToolExec's.

**`tag:delete` refuses while any access list names the tag.** The 406 names the objects. Deleting the name from
the lists instead would turn `["finance"]` into `[]`, which means *everyone*. Leaving it dangling would silently
re-grant if a tag with that name were ever recreated. Refusing is the only option that changes no one's access.

### Notifications

ToolExec's model, as v1 ported it:
- one row per recipient per channel (`browser`, `email`);
- a content-free frame `{ "event": "notifications" }` on `project:<projectId>:notifications`, after which the
  client re-reads over HTTP;
- `notifications:dispatch` sends email over SMTP (or logs it when `SMTP_HOST` is empty);
- `notifications:sweep` cleans up.

No new kinds here. The first kinds come with help requests and approvals.

### MCP publication

`McpToolPolicyOps.shouldPublishAsMcpTool` is ToolExec's function with 2.0's never-lists:
- login, sign-up, and the CLI sign-in hops;
- `webhooks:*`;
- clocks (`task.frequency > 0`);
- anything without a `web` route;
- unauthenticated introspection (`status`, `swagger`, `actions:permissions`).

Every other routed action here is published. `rbac.test.ts` asserts every action's live flag equals that
function, compared as a whole set.

## Schema sketch

```ts
organizations             { id serial, name text, slug varchar unique, createdAt, updatedAt }
organization_memberships  { id, organizationId → organizations, userId → users, role "owner"|"member",
                            createdAt, updatedAt; unique (organizationId, userId) }
users                     ToolExec's: email unique, name not unique, passwordHash
projects                  ToolExec's + organizationId → organizations (not null, indexed); slug unique per org
project_memberships       ToolExec's; unique (projectId, userId)
tags                      ToolExec's; unique (projectId, normalized name); reserved "admin"
user_tags                 ToolExec's
project_invites           ToolExec's + organizationId (not null); projectId nullable; tagIds jsonb
notifications             ToolExec's: channel, template, payload, linkPath, status, attempts, nextAttemptAt, readAt
project_settings          one row per project, created by createProjectForOwner; columns arrive with their features
```

Every timestamp is `withTimezone: true`, and every key is `serial`. Generate migrations from scratch; never copy
ToolExec's `drizzle/` history.

## Actions and policy sketch

| Action | Route | RBAC | MCP | Audited |
|---|---|---|---|---|
| `user:create` | `PUT /user` | none | never (sign-up) | yes, plus synthetic org and project rows |
| `session:create` / `session:destroy` | `PUT` / `DELETE /session` | none | never (login) | no (login churn) |
| `me:view`, `user:edit` | `GET /me`, `POST /user` | none | yes | read / yes |
| `organization:create` | `PUT /organization` | none (any signed-in user) | yes | yes |
| `organization:view` / `organization:list` | `GET /organization/:organizationId`, `GET /organizations` | org-member / none | yes | read |
| `organization:edit` / `organization:delete` | `POST` / `DELETE /organization/:organizationId` | org-owner | yes | yes; delete refused while it has projects |
| `organization-membership:list` | `GET /organization/:organizationId/members` | org-member | yes | read |
| `organization-membership:edit` | `POST /organization/:organizationId/member/:userId` (role) | org-owner | yes | yes; last-owner guard |
| `organization-membership:delete` | `DELETE /organization/:organizationId/member/:userId` | org-owner, or self | yes | yes; cascades project memberships |
| `project:create` | `PUT /project` | org-owner | yes | yes |
| `project:view` / `project:list` | `GET /project/:projectId`, `GET /projects` | member / none | yes | read |
| `project:edit` / `project:delete` | `POST` / `DELETE /project/:projectId` | admin | yes | yes |
| `project:settings-view` | `GET /project/:projectId/settings` | member | yes | read |
| `membership:create` / `membership:delete` / `membership:list` | `/project/:projectId/member…` | admin / admin / member | yes | yes / yes / read |
| `tag:create` / `tag:edit` / `tag:delete` / `tag:list` | `/project/:projectId/tag…` | admin / admin / admin / member | yes | yes / yes / yes / read |
| `user-tag:assign` / `user-tag:remove` | `/project/:projectId/member/:userId/tag/:tagId` | admin | yes | yes; last-admin guard |
| `invite:create` | `PUT /organization/:organizationId/invite` | admin (project invite) or org-owner (org invite) | yes | yes |
| `invite:accept` / `invite:reject` | `POST /invite/:inviteId/…` | none (email match) | yes | yes (`auditProjectId` from the row) |
| `invite:list` / `invite:list-pending` | `GET …/invites`, `GET /invites/pending` | admin / none | yes | read |
| `invites:sweep` | — (clock) | — | never | no (sweep) |
| `actions:permissions` | `GET /actions/permissions` | none | never | read |
| `notification:list` / `notification:unread-count` / `notification:mark-read` | `/notifications…` | none (own rows) | yes | read / read / no (a per-person reading habit) |
| `notifications:dispatch` / `notifications:sweep` | — (clocks) | — | never | no |

Every list takes `paginationInputs({ defaultLimit: 25 })` and answers a `pagination` envelope beside its named
collection.

## Frontend and user docs

- **Wired and copied pages:**
  - sign-in and sign-up shells wired to `session:create` and `user:create`, with `?next=` honored for
    same-origin paths only;
  - `AccountPage`, `InvitesPage`;
  - project settings sections General, Members, Tags, and Danger zone;
  - **new**: Organization → Members and Organization → Projects.
- **Shell:** the organization switcher from [phase 03](./phase-03-design-system.md) becomes live. `⌘K` gains
  "Invite member" and "New project", each gated by `can()`.
- **`can()`:** reads `actions:permissions` plus the active project's and organization's standing, through
  `hooks/useProjectStanding.ts` and `useOrganizationStanding.ts`. While standing is unresolved, it never renders
  a denial.
- **User docs:** `frontend/src/content/docs/{accounts,organizations,projects,members,tags}.md`. The tags page
  explains `accessRead` / `accessWrite` with the table above, because bots use it from the next domain phase on.

## Steps

### 1. Schema — `backend/schema/{organizations,organization_memberships,users,projects,project_memberships,tags,user_tags,project_invites,notifications,project_settings}.ts`

### 2. Ops — `backend/ops/{OrganizationOps,UserOps,ProjectOps,MembershipOps,TagOps,InviteOps,AccessOps,CryptoOps,NotificationOps,RawRequestOps,RedisScriptOps,McpToolPolicyOps,ProjectSettingsOps}.ts`

Copy ToolExec's or v1's, then add:
- `OrganizationOps`: `createOrganizationForOwner`, `lockOrganizationOwners`, `removeOrganizationMember`.
- `AccessOps`, as designed above.
- A change to `ProjectOps.createProjectForOwner`, which now takes `organizationId`.

### 3. Middleware and base class — `backend/middleware/{session,rbac}.ts`, `backend/classes/AuditedAction.ts`

- `RBAC_DESCRIPTOR = Symbol.for("hypotenuse.rbac")`.
- `RBAC_LEVELS = ["none", "member", "admin", "org-member", "org-owner"]`.
- `loadProjectAccess` learns the owner path; `loadOrganizationAccess` is new.
- `AuditedAction` is ported now (see [phase 05](./phase-05-audit-logging.md)).

### 4. Actions — `backend/actions/{user.ts,session.ts,me.ts,user-edit.ts,actions-permissions.ts,organization/*,organization-membership/*,project/*,membership/*,tag/*,invite/*,notification/*}`

### 5. Channel — `backend/channels/projectNotifications.ts`

### 6. Secrets — `backend/initializers/secrets.ts`

Refuses to boot without a 32-byte `SECRETS_ENCRYPTION_KEY`. The first ciphertext is a model key in
[phase 07](./phase-07-model-providers-and-bots.md), and a boot-time refusal is cheapest to adopt before anything
depends on it.

### 7. Test universe — `backend/__tests__/setup.ts`

`buildTestUniverse()` seeds the ToolExec cast over real HTTP:

- **Mushroom Kingdom**: Peach (owner), Mario, Luigi, and Toad (members). Its "Castle" project has Peach as admin,
  and Mario and Luigi as members.
- **Koopa Troop**: Bowser (owner). He is the outsider to everything in the Mushroom Kingdom.
- **Daisy**: a member of Mushroom Kingdom with **no** project, who proves that organization membership grants no
  project visibility.

### 8. Frontend — `frontend/src/{pages,components,hooks,utils/permissions.ts}`

### 9. Docs — `frontend/src/content/docs/*.md`, `sections.ts`

## Test plan

- **`rbac.test.ts`**: whole-set maps of every action's level and MCP publication, compared against literal
  objects, so a new action is a visible decision in review.
- **`organizations.test.ts`**:
  - owner standing in a project without a membership, with the `viaOrganizationOwner` flag;
  - members see only their projects;
  - Daisy sees none;
  - the last-owner guard under concurrency (two owners demoting each other at once, `Promise.all`; it fails
    without the lock);
  - the removal cascade.
- **`access.test.ts`**: every row of the access-list table; `tag:delete` refused while a list names the tag. The
  first real access-list holder is a bot, so this file uses a test-only table created in the test database.
- **Ported from v1/ToolExec**: `membership.test.ts` (last-admin concurrency), `invite.test.ts` (including
  accepting an invite to a project in an organization the user is not yet in), `tag.test.ts`,
  `notifications.test.ts`, `project-notifications.test.ts` (the #550 regression), and the byte-identical 403
  for "no such project" vs "not a member".
- **e2e**: `auth.spec.ts`, `organization.spec.ts` (switcher, create project as owner, member cannot),
  `members.spec.ts`, `notifications.spec.ts`.

## Verification

```bash
cd backend && bun test __tests__/actions __tests__/ops __tests__/channels
cd ../frontend && bun run lint && bun test && bun run test:e2e
curl -s localhost:8080/api/actions/permissions | jq '.permissions | map(.level) | unique'
# ["admin","member","none","org-member","org-owner"]
```

## Definition of done

- [x] Sign-up creates an organization, its owner, a project, and the admin tag in one transaction, with synthetic audit rows
- [x] Owners have admin standing in every project of their organization, flagged in `standing` and in audit metadata
- [x] Project membership requires organization membership; an invite accept creates both
- [x] The last-admin and last-owner guards lock their parent rows; the concurrency tests fail without the lock
- [x] `AccessOps` is the only implementation of `satisfiesAccess`; `tag:delete` refuses a referenced tag
- [x] `actions:permissions` reports five levels; `can()` gates every UI affordance; disabled, never absent
- [x] Notifications deliver over the content-free channel and over SMTP
- [x] `rbac.test.ts` holds the whole-set maps; e2e runs in the gate
- [x] User docs for accounts, organizations, projects, members, and tags

## Open questions

- Whether an organization member should be able to *discover* (but not read) the organization's other projects,
  so they can ask to join one. The default is no; every project is invisible until you are invited.

### Settled non-goals

- **Moving a project between organizations.** Its bots' platform apps, memory, and audit history are all scoped
  by project, and nothing about them would be wrong in the new organization. But the audit trail of *who could
  see it* would become retroactively misleading. Export and recreate instead.
- **A role ladder** (owner, admin, member, viewer per project). Every rung beyond `admin` was a tag with a
  reserved name in ToolExec's analysis.

## Learnings from the build

### What is built

| Piece | Where |
|---|---|
| Ten tables in one generated migration (`0001`) | `backend/schema/*.ts`, `backend/drizzle/0001_*.sql` |
| Five RBAC levels, four gates, owners' admin standing | `backend/middleware/rbac.ts`, `resolveProjectAccess` in `backend/ops/MembershipOps.ts` |
| Organizations, the last-owner guard, the removal cascade | `backend/ops/OrganizationOps.ts`, `backend/actions/organization*/` |
| Access lists | `backend/ops/AccessOps.ts` |
| `AuditedAction` on every write, `SENSITIVE_KEYS` | `backend/classes/AuditedAction.ts`, `backend/ops/AuditOps.ts` |
| Notifications: table, dispatch over SMTP, the content-free channel | `backend/ops/NotificationOps.ts`, `backend/actions/notification/`, `backend/channels/projectNotifications.ts` |
| Boot refusal without a 32-byte key; the MCP publication policy | `backend/initializers/{secrets,mcpToolPolicy}.ts` |
| The cast | `buildTestUniverse()` in `backend/__tests__/setup.ts` |
| The SMTP server the suites send to | `backend/__tests__/fixtures/smtp.ts` |

`RawRequestOps` and `RedisScriptOps` (with the `redisScripts` initializer) are ported with their tests and have no
caller yet; `lua/` holds no script.

### Decisions the plan left open

- **Routes carry their tenant in the path**: `/project/:projectId/…`, `/organization/:organizationId/…`, and
  `/invite/:inviteId/accept`. Keryx merges path params first and lets a JSON body key of the same name overwrite one.
  That is not a bypass, because the RBAC middleware and the action read the same merged value, but a client should
  never send a tenant id in both places.
- **`organization:view` answers `standing: { isMember, isOwner, role }`**, not the project's shape: an organization
  has no admin tag, and `viaOrganizationOwner` would always equal `isOwner`.
- **`organization:invite-list` is new.** Owners need to see the organization invites they sent, and `invite:list` is
  one project's. It lists every invite in the organization, both kinds.
- **Two actions decide part of their gate inside.** `organization-membership:delete` is `org-member` because leaving
  is open to everyone; removing someone else checks for an owner. `invite:create` is `org-member` because the rule
  depends on the kind: a project invite needs admin standing in that project (a project of another organization is
  the same 403), an organization invite needs an owner. `rbac.test.ts` records both levels.
- **The last-admin guard counts explicit `admin` tag holders, never owners.** Counting owners would make the guard
  unreachable (an organization always has one) and let a project drift to having no member who administers it. So
  removing someone from the organization is refused while they are the last admin of one of its projects, and the
  refusal names the project.
- **The removal cascade writes one `membership:delete` row per project it touched**, with
  `metadata.cascadedFrom`. An organization-level row is filed under no project; without these, a project's log
  would never show who left it. Since [phase 05](./phase-05-audit-logging.md) every row also carries the
  `organizationId` column, which its migration backfilled from the metadata these rows carried.
- **The sign-up row's actor is the account it creates**, and the synthetic `organization:create` and
  `project:create` rows are `system` rows naming that account in `metadata.ownerUserId` — settled by
  [phase 05](./phase-05-audit-logging.md)'s `actorType`, whose migration rewrote the rows written before it.
- **`SENSITIVE_KEYS` is phase 05's whole list already.** Declaring it complete costs nothing, and this phase is
  where every audit row starts.
- **`tag:edit` rewrites access lists.** The plan said only that `tag:delete` refuses. A rename that left
  `["finance"]` naming a tag that no longer exists would revoke access silently, so the rename carries every list
  with it, in the same transaction, and the audit row names the objects it relabeled.
- **Access-list tables register themselves** with `registerAccessListTable({ kind, table, id, projectId, label,
  accessRead, accessWrite })`, which is how `tag:delete` and `tag:edit` find every list without importing features.
  `readableIds` is ToolExec's: it filters a project's rows in memory and returns ids for an `IN (…)`.
  `accessListSchema` checks shape (trimmed, lowercased, unique, at most 50); `assertAccessListTags` checks each name
  is a tag of the project, inside the writing transaction.
- **Tag names are unique after normalization**, by an expression index on `(project_id, lower(btrim(name)))`. Every
  comparison in the app was already normalized; the table now agrees.
- **Slugs.** An organization's slug is unique across the deployment and never follows a rename (it is how the
  organization is named in a URL someone shared); `organization:edit` sets it explicitly. A project's slug is unique
  within its organization and follows its name. Both get `-2`, `-3`, … on collision, with the unique index as the
  real guard.
- **`organization:create` starts empty**, with its creator as owner. Only sign-up makes a Default project.
- **`organization:delete` is refused while the organization has projects**, under a lock on the organization row;
  `projects.organizationId` does not cascade.
- **Notifications with no named tag reach everyone with admin standing**: the explicit admins and the
  organization's owners. The template registry is empty until a feature raises the first kind; the suites queue an
  unregistered template and assert its generic rendering.
- **No CLI command wraps these actions yet.** Rule 13's decision for every routed action here is "deferred, not out
  of scope": [phase 06](./phase-06-operator-cli.md) is the CLI's sign-in, and a command without it cannot authenticate.
- **`/api/status` probes the newest migration's column** (`NEWEST_MIGRATION_PROBE` in `ops/HealthOps.ts`), alongside
  the `vector` extension. Every migration that adds a column moves it.

### The frontend

| Piece | Where |
|---|---|
| Session, organizations, active project | `frontend/src/context/AuthContext.tsx`; active ids in `localStorage`, healed onto the first available when stale |
| `can()` and the standings it reads | `frontend/src/utils/permissions.ts`, `context/StandingContext.tsx`, `hooks/{useProjectStanding,useOrganizationStanding,useMay}.ts` |
| `?next=` | `utils/returnTo.ts` `safeNext()`: same-origin relative paths only (refuses `//`, `/\`, schemes, control characters) |
| Pages | `pages/{SignInPage,SignUpPage,AccountPage,InvitesPage,NewProjectPage,SettingsPage}.tsx`, `pages/organization/*` |
| Notifications | `context/{LiveSocketContext,NotificationContext}.tsx`, `components/shell/NotificationBell.tsx` |
| The browser suite's backend | `frontend/scripts/e2e-backend.ts`, `e2e/{env,global-setup,session}.ts` |

- **`can()` answers three ways** — allowed, denied, unresolved — and a control is drawn disabled only on *denied*,
  so a standing still loading never flashes a refusal. A refused palette command is listed disabled with its reason
  (`requires` on a command), and its keys do nothing.
- **Two actions' reported levels are not the whole rule**, so the UI combines them: a project invite is offered on
  `invite:create` *and* `invite:list` (admin), an organization invite on `invite:create` *and*
  `organization:invite-list` (owner); Remove on an organization member reads `organization-membership:edit` (owner),
  Leave reads `organization-membership:delete`. One level per action cannot describe a rule that depends on the
  params; the server still decides.
- **Signed in, with no safe `?next=`, a person lands on Organization → Projects**, since Home is not built.
- **The browser suite boots the backend** as a second Playwright `webServer`, against `hypotenuse_e2e` (created on
  first run) and Redis database 2, so a suite run never touches `bun dev`'s or the backend suites' data. CI gives the
  **E2E Test** job its own pgvector and Redis services. Run the frontend's unit tests with `bun run test`: plain
  `bun test` in `frontend/` also collects the Playwright specs.
- **`project:list` carries each project's `standing`**, computed by `projectStandings` in two queries per page by the
  same rule as `resolveProjectAccess`; `project.test.ts` asserts it equals `project:view`'s for a member, an explicit
  admin, and an owner who never joined. Organization → Projects names it per row (`utils/projectRole.ts`).
- **New organization** is `/organizations/new`, offered in the organization switcher and the palette to anyone signed
  in; the new organization becomes active and lands on its empty Projects page.
- **Left for later:** an unsaved-changes guard, desktop notifications, lists past 100 rows, and a separate active
  project per organization.
- **Signed-in docs illustrations are seeded.** `docs:illustrations` marks a shot `signedIn` and signs in as a fixed
  person in a fixed tenant (Ada Lovelace, owner of Acme, with Support and Platform), creating them over the API the
  first time; `shell` is Organization → Projects as that person. It needs the backend running as well as the
  frontend.

### Fixed after the merge

A review of the merged change, run because the automated reviewer had not, found no cross-tenant read but these
holes. Each is closed with a test; the grant race and the deletion deadlock were also run against the old code,
where they failed on the first round:

| Finding | Fix |
|---|---|
| A tag grant racing a removal left `admin` on a non-member, which the last-admin guard then counted | `user-tag:assign` takes the project lock before reading the membership; `getAdminUserIds` counts only grants held by members |
| A removed person could accept a still-pending invite and walk back in | removing someone from a project, or from the organization, sets their pending invites there to `revoked` in the same transaction |
| `invite:accept` deadlocked with `organization:delete` (and could 500 against a removal) | accept takes `KEY SHARE` on the organization row, then the project row, before locking the invite: the one order is organization → project → invite |
| An owner demoted mid-request could finish removing or promoting someone | both actions re-read the caller's role after taking the organization lock (`assertStillOwner`) |
| An id past a `serial`'s range was a 500 carrying the SQL | `idInput` caps at `MAX_ID`, so it is a 406 like any other bad id |
| A tag could be named `*`, and renaming one to it would turn its lists into "everyone" | refused on create and rename |
| `safeNext("/.//evil.com")` returned `//evil.com` | the resolved path is checked too |
| Any failed session read (a 5xx, a dropped connection) signed the person out | only a 401 does (`ApiError.status`, `isSignedOut`) |

Still open:

- **Invite acceptance trusts an unverified email.** `user:edit` changes an email with no confirmation, and sign-up
  takes any address, so whoever first claims an address can accept invites sent to it. This is ToolExec's model, and
  closing it means verifying addresses (or binding acceptance to a mailed token) — a decision, not a patch.
- **A socket stays subscribed to `project:<id>:notifications` after its person is removed.** Frames are content-free,
  so this leaks only timing; Keryx re-checks a channel only at subscribe.

### Traps found while building

- **Keryx 0.48 resets `connection.metadata` at the start of every top-level `act()`**, and builds a fresh connection
  for every MCP tool call. ToolExec's learning that "MCP sessions reuse a connection, so a previous action's
  snapshot leaks" no longer holds, so a `beforeAct` hook written to clear the tenant fields was a no-op and was
  removed. `AuditedAction.run` still clears its snapshots, as ported: a **nested** `act()` keeps its parent's
  metadata, and that is the one path where a snapshot could still leak.
  `connection-scope.test.ts` holds Keryx to both behaviors, over MCP and over a WebSocket, with an owner's standing
  as the thing that must not leak into the next audit row.
- **Both concurrency guards were proven by removing the lock.** With `FOR UPDATE` on the organization row commented
  out, two owners demoting each other both got 200 and left no owner; with it, one gets 200 and the other 406 (or 403,
  when the winner had already demoted it).
- **A registered table is known by its columns, not by Drizzle's property names**, so `.set({ [column.name]: … })`
  writes nothing useful. The access-list rename is raw SQL with `sql.identifier` for the `SET` columns.
- **A synthetic admin row is standing, not a grant.** `project:view` filters it out of `callerTags`, so an owner who
  never joined is not shown as holding the `admin` tag.
- **The mail server is faked over SMTP.** v1 stubbed nodemailer's transport, which is a mock of the one call that
  can fail. `fixtures/smtp.ts` is a loopback SMTP server that speaks enough of RFC 5321 for nodemailer; the suites
  point `config.notifications` at it and call `resetNotificationTransport()`.
- **Locally, pgvector on Debian/Ubuntu is `postgresql-16-pgvector`.**
