# Phase 15 — Dashboard and operator surface

> **Goal:** A project member can see, from the browser or the `hypotenuse` CLI, everything Hypotenuse is doing
> for their Linear workspace: whether Linear is connected and healthy, which runners are online and how busy they
> are, every agent session with its full transcript, plan, pull requests, and the turns it took — and can stop a
> session, revoke a runner, edit routing rules and test them, and link their Linear identity. All of it live,
> without polling.

> **Status: planned, not built.** The actions this phase draws already exist by now — `linear:*`
> ([phase 6](./phase-06-linear-connection.md)), `agent-session:*` ([phase 7](./phase-07-webhook-ingress-and-session-mirror.md)),
> `runner:*` ([phase 8](./phase-08-runners.md)), `routing-rule:*` and `linear-identity:*`
> ([phase 9](./phase-09-work-routing.md)). Some earlier phases ship a minimal page alongside their actions; this
> phase is where the dashboard becomes a product: one navigation, live channels, the session page, the routing
> editor with a preview, CLI parity, and the public user docs.

Linear is where people *use* Hypotenuse. They delegate, they read the agent's thoughts in the session panel, they
answer elicitations. What Linear cannot show is the other half: the runner a session is on, why a session has been
`pending` for four minutes (no eligible runner; the issuer's laptop is asleep), which routing rule made a session a
manager, the work-item timeline behind a session's turns, and what the fleet of runners looks like right now. That
half is operational, it belongs to the people who run Hypotenuse for a team, and it is the dashboard.

The frontend is ToolExec's, ported in [phase 4](./phase-04-users-tenancy-and-audit.md) and repainted by the [design system](./phase-03-design-system.md): Vite, React 19, React Router
7, the local UI kit under `frontend/src/ui/`, `AuthContext`, `can()`, `useFirstLoad`, the shared section framework,
`MarkdownBlock`, and `LiveSocketContext`. Every convention ToolExec's AGENTS.md records about those carries over —
three-state loading, never rendering a denial before standing is known, a loader gating writes on its subject,
content-free socket frames. This plan does not restate them; it says what Hypotenuse puts on top.

## Scope

**In:**

- Navigation: **Home**, **Sessions**, **Runners**, **Routing**, and under **Project**: Settings (with a **Linear**
  section), Members, Invites, Identities, Audit.
- **Project home**: connection health, runners online/busy, sessions by status over a window, the queue (work items
  waiting and why).
- **Linear settings section**: connect / reconnect / disconnect, org name, app user, scopes, team access, token
  expiry, last webhook received, recent delivery outcomes.
- **Runners page**: live list (status, owner, jobs used/total with per-role and per-agent limits when set, roles, agents, repositories, version, platform,
  last heartbeat); register (shows the token once and the exact `hypotenuse runner register` / config snippet),
  edit name, drain, revoke.
- **Sessions list**: filters (role, status, runner, owner, issue team), pagination; **session page**: the mirrored
  activity transcript, plan, external links / pull requests, work-item timeline, parent/children
  ([phase 14](./phase-14-manager-and-dispatch.md)), and **Cancel**.
- **Routing page**: ordered rules editor with reorder, enable/disable, and a **preview** that evaluates the rules
  against a real issue.
- **Identities page**: my linked Linear user; admins see and manage all links.
- Two content-free channels, `project:<projectId>:sessions` and `project:<projectId>:runners`.
- **CLI parity** (rule 13 of [`AGENTS.md`](../../AGENTS.md)): `session list/view/cancel`, `runner list/view/revoke`,
  `routing list/add/edit/remove/reorder`, `identity list/link/unlink`, `linear status/connect/disconnect`.
- **User docs** under `frontend/src/content/docs/`: getting started, connect Linear, install a runner, the config
  file, roles, routing, security.
- Playwright specs for each page.

**Out:**

- Answering a Linear elicitation or prompting a session from the dashboard. Linear is where people talk to the
  agent; a second place to talk would fork the conversation. The session page links to the Linear session.
- Editing a runner's config from the browser. The config file lives on the runner's machine
  ([`CONFIG.md`](../CONFIG.md)); the dashboard shows what the runner *reported*.
- Live streaming of ACP output that never reaches Linear (raw `agent_message_chunk` deltas). The transcript is the
  mirrored Linear activities; the dashboard is not a second chat surface.
- Theming beyond the ported midnight system.

## Design

### Two channels, and what they wake

| Channel | Who may subscribe | Frame | Wakes |
|---|---|---|---|
| `project:<projectId>:sessions` | session + membership | `{ event: "sessions" }` or `{ event: "session", id }` | the sessions list, the project home queue, an open session page whose id matches |
| `project:<projectId>:runners` | session + membership | `{ event: "runners" }` | the runners page, the project home, the session page's runner badge |

Both follow ToolExec's channel rules ([phase 18 there](https://github.com/arcadeai-labs/toolexec/blob/main/docs/plans/phase-18-dashboard-websockets.md)):
deny-by-default `ChannelMiddleware.runBefore` (session, then membership), frames name *what* changed and never carry
content, the client re-reads over HTTP, a reconnect hydrates, and a publish never throws.

**Why the session frame may carry an id here.** ToolExec's runs-list channel deliberately omitted run ids because
some runs were readable only by some members. Hypotenuse has no per-session read restriction inside a project — every
member can read every session, because every member can read the Linear issue it is attached to (the installation
is workspace-wide). If a future change introduces per-session visibility, the id comes out of the frame in the same
commit; a test asserts the frame's key set is exactly `{event}` or `{event, id}` so that change is noticed.

**Publishers.** `ops/SessionChannelOps.ts` `broadcastSessionUpdate(projectId, agentSessionId?)` is called after commit
by: `linear:process-event` (session created, prompt, stop), `activities:deliver` (an activity sent — throttled to one
frame per session per second, coalesced in Redis with `SET NX PX 1000`), `daemon:events`, `daemon:complete`,
`daemon:dispatch`, `agent-session:cancel`, `work:route` and `work:reap` (work item state changes).
`ops/RunnerChannelOps.ts` `broadcastRunnersUpdate(projectId)` is called by `daemon:heartbeat` **only when the
runner's status or capacity changed** (a heartbeat every 15 s per runner must not become a frame every 15 s per
runner), `runner:register` / `edit` / `revoke`, and `work:reap` when it marks runners offline.

### Built on the design system

Every page here is built from the [design system](./phase-03-design-system.md), with no page-local styling. Lists
use `ListLayout` and `ListGroup` / `ListRow`, and detail pages use `DetailLayout` with a `PropertiesPanel`. Status,
presence, role, and agent are always shown with `StatusGlyph`, `PresenceDot`, `RoleChip`, and `AgentBadge`. Two of
[`DESIGN.md`](../DESIGN.md)'s four signature surfaces land here, and are specified there in detail:

- **The session transcript** ([`DESIGN.md`](../DESIGN.md#1-the-session-transcript)). Turn separators carry the work
  item. While a turn is live, an ephemeral activity is the single live line at the bottom, replaced in place. Once
  Linear has replaced it, it stays in the log struck through and collapsed (see below). The plan card is pinned to
  the turn that last changed it. An elicitation is the only accented card, and its buttons deep-link to Linear.
- **The runner fleet** ([`DESIGN.md`](../DESIGN.md#2-the-runner-fleet)). Cards grouped by owner, with a
  `CapacityBar` whose filled segments link to the sessions they hold. A table view toggles on `v`. A runner that goes
  offline mid-turn is the one loud state.

Command-palette entries added here (each gated by `can()`): "Go to session…", "Cancel session", "Register runner",
"Revoke runner", "Edit routing rules". Every page's illustrations are captured in both themes by
`docs:illustrations`.

### The session page

The page is the one place all four of a session's histories meet:

1. **Transcript** — `agent-session:activities`, paginated by `afterId`, drained to the end, merged by id (ToolExec's
   transcript discipline). Inbound `prompt` activities render as the person's message with their Linear name;
   outbound activities render by type: `thought` dim, `action` as a call/result row (collapsed `result` over 8
   lines), `elicitation` highlighted with its `select` options or `auth` provider, `response` as Markdown, `error`
   red. Ephemeral activities that Linear has since replaced are shown struck through and collapsed by default — they
   are part of what the agent said, and hiding them would make the dashboard less transparent than Linear (AIG #4).
   All Markdown goes through `MarkdownBlock` (no `rehype-raw`), because every body is model-authored.
2. **Plan** — the latest `agent_sessions.plan` as a checklist with Linear's four statuses.
3. **Links** — `externalUrls`, with "Pull Request" entries first; a link to the Linear session (`agent_sessions.url`)
   and the Linear issue.
4. **Turns** — the session's `work_items`: kind, role, status, runner, offered/claimed/finished times, attempts, and
   for expired or failed items the reason. This is the column that answers "why is it pending".

Header: issue identifier and title, role badge, status badge, runner badge (live), owner (the runner's owner), the
issuer (Linear creator, and the linked Hypotenuse user if any), and — for manager sessions — "Dispatched" children;
for worker sessions with a parent — "Dispatched by".

**Cancel.** `agent-session:cancel` (member; audited — it is a person's decision) cancels the live work item exactly
the way a Linear `stop` signal does ([phase 16](./phase-16-signals-and-hardening.md)): the daemon receives a
`cancel` frame, sends ACP `session/cancel`, and the session's final `response` says it was stopped **from the
Hypotenuse dashboard by <name>**. It is disabled (not absent) when no work item is live. A session that is waiting on
an elicitation has no live work item; cancelling it emits a server-side `response` ("Stopped from the dashboard")
so Linear's status leaves `awaitingInput`.

### The routing editor and its preview

Rules are an ordered list (`routing_rules.position`); the editor is a table with drag handles, an enable toggle,
match summary, and role. Saving an order calls `routing-rule:reorder` with the full id list (the server rejects a
list that is not exactly the project's rule ids, so a stale tab cannot drop a rule).

The **preview** answers "what would happen if this issue were delegated now?". This phase adds one action to the
canon:

| Action | Route | Gate | Returns |
|---|---|---|---|
| `routing-rule:preview` | `GET /routing-rule/preview?projectId=&issue=ENG-123&prompt=` | member | `{ preview: { issue, matchedRuleId, role, candidates: [{ runnerId, name, owner, eligible, reasons[] }], repository: { candidates, suggestion?, wouldElicit } } }` |

It runs the real `selectRole` and `eligibleRunners` from `ops/RoutingOps.ts` against a live `issue(id)` fetch and the
current runner table, writes nothing, and calls `issueRepositorySuggestions` only when the request sets
`withRepository=true` (it costs Linear budget). `reasons[]` are machine codes with sentences
(`offline`, `draining`, `no_capacity`, `role_not_served`, `repository_missing`, `subscription_mismatch`) — the same
codes `work:route` records on a work item that cannot be offered, so the session page's "why is it pending" and the
preview speak the same language. `routing-rule:preview` is an MCP tool (it has a route and reads only) and a CLI
command (`hypotenuse routing preview ENG-123`).

### Identities

`linear_identities` links a Linear user to a Hypotenuse user per installation; it is how "prefer the issuer's
runner" finds the issuer ([phase 9](./phase-09-work-routing.md)). The page shows:

- for everyone: "Your Linear identity" — linked user, how (`email` match or `oauth`), and **Link** / **Unlink**;
  linking runs a Linear `actor=user` OAuth with scope `read` only to learn `viewer.id` and then discards the token
  (the explicit path), and is the fix when a person's Linear e-mail differs from their Hypotenuse e-mail;
- for admins: every link in the project, with **Unlink**.

### Project home

Four cards, windowed (24 h / 7 d, server-computed in one `project:overview` action — ToolExec's pattern of one
read for the whole home page):

| Card | Content |
|---|---|
| Linear | connected org, status, last webhook received, failed deliveries in window |
| Runners | online / draining / offline counts, capacity used / total, oldest heartbeat |
| Sessions | counts by status and role in the window; median time-to-acknowledge (must stay under 10 s) and time-to-claim |
| Queue | work items `queued` / `offered` now, each with its reason code and age; expired in window |

`project:overview` is the one read this phase adds alongside `routing-rule:preview`.

### CLI parity

The operator CLI is a session HTTP client over the same routes ([phase 5](./phase-05-cli-and-distribution.md)).
Commands added or completed here:

```
hypotenuse session list [--status S] [--role R] [--runner ID] [--mine] [--json]
hypotenuse session view <id|ENG-123> [--transcript] [--follow]
hypotenuse session cancel <id|ENG-123>
hypotenuse runner list [--json]            # status, owner, capacity, version
hypotenuse runner view <id> | revoke <id>
hypotenuse routing list | add | edit | remove | reorder | preview <ENG-123> [--prompt "/manage ..."]
hypotenuse identity list | link | unlink
hypotenuse linear status | connect | disconnect
hypotenuse project overview
```

`session view --follow` re-reads activities on an interval (ToolExec's product CLI also polls; the operator CLI is
not where a socket earns its keep). `session view` accepts an issue identifier and resolves the most recent session on
it. `linear connect` prints the authorize URL and opens a browser; the callback lands in the dashboard.

### User docs

Markdown under `frontend/src/content/docs/`, registered in `sections.ts`, public at `/docs`:

| Page | Covers |
|---|---|
| `getting-started.md` | the three parts, sign up, connect Linear, install a runner, delegate an issue |
| `connect-linear.md` | admin consent, scopes and why each is requested, team access, disconnect, what revocation does |
| `install-a-runner.md` | npm / `curl \| bash` / `irm \| iex`, `hypotenuse login`, `runner register`, `daemon start`, `service install`, upgrade |
| `config-file.md` | user-facing tour of [`CONFIG.md`](../CONFIG.md): agents, roles, repositories, sessions, subscriptions |
| `roles.md` | worker vs manager, how a role is chosen, dispatch and review ([phase 14](./phase-14-manager-and-dispatch.md)) |
| `routing.md` | eligibility, issuer preference, stickiness, repository choice, the preview, reason codes |
| `security.md` | where every credential lives (the table from [`ARCHITECTURE.md`](../ARCHITECTURE.md#trust-boundaries-and-credentials)), what a runner token can do, revocation |

No user doc mentions plan phases (rule 11).

## Steps

### 1. Channels — `backend/channels/projectSessions.ts`, `backend/channels/projectRunners.ts`

Ported from ToolExec's `projectRuns.ts`: `name` patterns `/^project:(\d+):sessions$/` and `/^project:(\d+):runners$/`
exported from ops, a shared membership `ChannelMiddleware`. Publishers in `backend/ops/SessionChannelOps.ts` and
`backend/ops/RunnerChannelOps.ts`, wired into the actions listed in Design, each after commit, each logging and
swallowing.

### 2. Reads — `backend/actions/routing/routing-rule-preview.ts`, `backend/actions/project/project-overview.ts`

As designed. Both member-gated, both plain `Action`s (read-only, unaudited), both MCP tools under the publish policy.
`agent-session:view` gains `parent`, `children`, `workItems`, and `runner` summaries if earlier phases did not already
return them.

### 3. Cancel — `backend/actions/agent-session/agent-session-cancel.ts`

`AuditedAction`. Marks the live work item `cancelled` with `cancelledBy = userId`, publishes `cancel` on the
runner's channel, and enqueues the attribution sentence the daemon will include in the final response (the daemon
reads it from the cancel payload on its next heartbeat or claim). When no work item is live but the session is
`awaitingInput`, enqueues a server-side `response`.

### 4. Frontend pages — `frontend/src/pages/`

- `HomePage.tsx` (project home), `SessionsPage.tsx`, `SessionPage.tsx`, `RunnersPage.tsx`, `RoutingPage.tsx`,
  `IdentitiesPage.tsx`.
- `components/settings/sections/Linear.tsx` registered in the settings section list (next to General, Members, Tags,
  Mcp, DangerZone).
- `components/session/` — `ActivityTranscript.tsx`, `PlanChecklist.tsx`, `WorkItemTimeline.tsx`,
  `SessionHeader.tsx`; transcript pure passes in `utils/transcript.ts` (group ephemeral chains, collapse long results)
  with unit tests.
- `components/runners/{RunnerCard,RunnerFleetTable}.tsx` (on `#ui` `CapacityBar`) — the fleet's two views.
- `components/runners/RegisterRunnerModal.tsx` — shows the token once with copy buttons and the exact commands.
- `components/routing/RuleTable.tsx`, `RuleEditor.tsx`, `PreviewPanel.tsx`.
- All types via `ActionResponse<…>` from `@backend/*`; all gating via `can()`; all live updates via
  `LiveSocketContext` subscriptions keyed on the page's subject.

### 5. CLI — `cli/src/commands/{session,runner,routing,identity,linear,project}.ts`

The commands above, each a thin client over `cli/src/api/client.ts`, `--json` everywhere, tables otherwise. Spawn
tests in `backend/__tests__/cli/cli.test.ts` drive each against a real server (ToolExec's pattern).

### 6. User docs — `frontend/src/content/docs/*.md`, `frontend/src/content/docs/sections.ts`

The seven pages. Screenshots captured from a seeded app by `frontend/scripts/capture-doc-illustrations.mjs` (ported).

### 7. Tests

- `backend/__tests__/channels/project-sessions.test.ts`, `project-runners.test.ts` — Bowser (outsider) is refused;
  a member receives `{event:"session", id}` after `daemon:events`; the frame key set is exactly as specified; a
  heartbeat that changes nothing publishes nothing; a burst of 50 activity deliveries for one session publishes at
  most a handful of frames.
- `backend/__tests__/actions/routing-rule-preview.test.ts` — every reason code produced by constructing the runner
  state for it; the preview and `work:route` agree on the same fixture (property: same inputs, same reasons).
- `backend/__tests__/actions/agent-session-cancel.test.ts` — live item → cancelled + frame on `runner:<id>` + audit
  row; `awaitingInput` session → server-side response in the outbox; no live item and not awaiting → 406.
- `backend/__tests__/actions/project-overview.test.ts` — counts match seeded rows; window boundaries.
- `frontend/src/__tests__/transcript.test.ts` — the pure passes.
- Playwright: `e2e/sessions.spec.ts` (list → page → transcript renders; a new activity arrives live; cancel),
  `e2e/runners.spec.ts` (register shows token once; revoke flips the row live), `e2e/routing.spec.ts` (reorder
  persists; preview shows reasons), `e2e/linear-settings.spec.ts` (connected state against finear),
  `e2e/identities.spec.ts`, `e2e/docs.spec.ts` (every docs page renders, no broken links).

## Verification

```bash
cd backend && bun run lint && bun test __tests__/channels __tests__/actions/routing-rule-preview.test.ts \
  __tests__/actions/agent-session-cancel.test.ts __tests__/actions/project-overview.test.ts __tests__/cli
cd ../frontend && bun run lint && bun run build && bun test src/__tests__ && bun run test:e2e
```

Manually with `bun dev`, finear, and a daemon running the fake agent:

1. Delegate an issue in finear; the Sessions list shows it within a second, without reload.
2. Open it: the acknowledgement thought, plan, actions, and the PR link appear as the fake agent emits them.
3. Stop the daemon; the Runners page flips it to offline after `runners.offlineAfter`; delegate another issue and the
   session page's Turns column shows `queued` with reason `offline`.
4. Routing → Preview on that issue lists the runner as ineligible with `offline`.
5. Start the daemon; the work is claimed; cancel from the session page; the Linear session's last response names the
   dashboard and your name.
6. `hypotenuse session list --json | jq length` equals the page's total.

## Definition of done

- [ ] `project:<id>:sessions` and `project:<id>:runners` channels, membership-gated, content-free, publishers never throw
- [ ] Heartbeat publishes only on change; activity frames coalesced per session
- [ ] Session page: transcript (ephemeral shown, collapsed), plan, links, turns with reason codes, parent/children, cancel
- [ ] Runners page with register-once token modal, drain, revoke, live status
- [ ] Routing editor with reorder guard and `routing-rule:preview` sharing reason codes with `work:route`
- [ ] Identities page with explicit OAuth link and admin management
- [ ] Linear settings section and project home (`project:overview`)
- [ ] CLI parity for every new route; spawn tests for each
- [ ] Seven user docs pages registered in `sections.ts`
- [ ] Playwright specs green in CI

## Learnings from the build

_Nothing yet — this phase has not been built._
