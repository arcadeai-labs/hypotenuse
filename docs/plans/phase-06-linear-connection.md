# Phase 6 — Linear connection

> **Goal:** A project admin connects their Linear workspace to their Hypotenuse project in one click, as the
> `@hypotenuse` app user (`actor=app`). The server stores the tokens encrypted, keeps them fresh forever without
> anyone noticing, knows the app user's id in that workspace, and exposes one GraphQL client that every later
> phase uses to talk to Linear — inside Linear's rate limits, and against
> [finear](https://github.com/pmdroid/finear) in every test.

> **Status: planned, not built.** Builds on [users, tenancy, and audit](./phase-04-users-tenancy-and-audit.md)
> (projects, `AdminMiddleware()`, `AuditedAction`, `CryptoOps`). Nothing here receives a webhook yet — that is
> [webhook ingress and the session mirror](./phase-07-webhook-ingress-and-session-mirror.md).

Every other part of Hypotenuse assumes two facts this phase makes true: that a project knows **which Linear
workspace it is** (so an inbound webhook's `organizationId` resolves to exactly one project), and that the
server can **act in that workspace as the app** whenever it needs to (so an acknowledgement `thought` can be
sent within Linear's 10-second window without a human anywhere near a browser).

Linear's agent model makes the second fact non-trivial. An `actor=app` install is a workspace-level grant made
by a Linear admin, and its access token lasts **24 hours** (`expires_in: 86399`). Since 1 April 2026 every app
receives a refresh token, and **refresh tokens rotate** — each refresh answers with a new one and the old one is
spent. A refresh whose response is lost can be replayed for **30 minutes** to get the same new token. A server
that refreshes naively from two processes at once, or drops a response on the floor, logs itself out of the
workspace; one that never refreshes is dead in a day. The refresh clock below is the whole reason this is a
phase rather than a step.

The other reason is testing. Every later phase is a conversation with Linear, and rule 1 says tests drive a
real server with no mocks. finear is a fake Linear that runs real GraphQL against Linear's own schema, signs
real webhooks, and runs a real OAuth consent screen. This phase builds the harness every later suite uses.

## Scope

**In:**

- `linear_installations` table, one row per project.
- The install flow: `linear:connect` → Linear's consent screen → `linear:callback`, with `state` parked in
  Redis and PKCE.
- `linear:installation` (what is connected, for the settings page and CLI), `linear:disconnect` (revoke and
  forget), `linear:catalog` (teams, projects, labels, workflow states — the pickers later phases need).
- `LinearOps` — the one GraphQL client: base URL from env, bearer from the installation, rate-limit header
  tracking, `RATELIMITED` backoff, typed operations.
- `linear:refresh-tokens` — the refresh clock, with a row lock, rotation, and the replay grace.
- The app-creation **manifest link** helper, so a self-hoster creates the Linear app with every field
  pre-filled.
- `backend/__tests__/linear/finear.ts` — `useFinear()`: in-process finear with an OAuth client whose webhook
  points at the test server, scripted consent, fixture ids.
- Settings → Linear section in the frontend, `hypotenuse linear {status,connect,disconnect}` in the CLI, and the
  user docs page *Connecting Linear*.

**Out:**

- Receiving webhooks, verifying signatures, and everything about agent sessions —
  [phase 7](./phase-07-webhook-ingress-and-session-mirror.md). This phase *configures* the app's webhook URL
  (it is set on the Linear app, not per install) but nothing listens yet.
- The token bucket that budgets Linear calls across a deployment — phase 7, where the outbox is the first
  heavy caller. This phase records the rate-limit headers it sees; phase 7 acts on them.
- Linking Linear users to Hypotenuse users (`linear_identities`) — [phase 9](./phase-09-work-routing.md).
- `client_credentials` tokens. Linear supports them for app actors (30-day token, all public teams, no refresh),
  but they are per *app*, not per workspace install, and their scope is "every public team" rather than the
  teams the admin granted. A per-workspace `authorization_code` install is the only grant that respects the
  admin's team choice. finear does not implement `client_credentials` either. Settled non-goal.
- A second Linear workspace per project, or one workspace shared by two projects. See
  [One project, one workspace](#one-project-one-workspace).

## Design

### The Linear app is the deployment's, the install is the project's

One Linear OAuth application per Hypotenuse deployment, configured by environment:

| Env | Used for |
|---|---|
| `LINEAR_CLIENT_ID` | authorize URL, token exchange, refresh, revoke |
| `LINEAR_CLIENT_SECRET` | token exchange and refresh (HTTP Basic). `secret`, in `hypotenuse-shared` |
| `LINEAR_WEBHOOK_SECRET` | phase 7's signature check. `secret`, in `hypotenuse-shared` |
| `LINEAR_API_URL` | GraphQL and OAuth token endpoints. Default `https://api.linear.app`; finear's URL in tests |
| `LINEAR_OAUTH_URL` | the authorize page. Default `https://linear.app`; finear's URL in tests |
| `APPLICATION_URL` | builds the redirect URI `${APPLICATION_URL}/api/linear/callback` and the webhook URL |

Linear's app model is "one app, many workspace installs", and the agent's identity in each workspace is a
distinct **app user** whose id is unique per workspace. A Hypotenuse project's installation is that app user,
plus its tokens. Self-hosters create their own Linear app; the deployment's admin does it once.

**The manifest link.** Linear accepts a pre-filled app-creation URL
(`https://linear.app/settings/api/applications/new?manifest=<urlencoded JSON>`, schema version `1.0.0`).
`backend/ops/LinearManifestOps.ts` `buildAppManifestUrl({ applicationUrl, name })` emits one with:

- `oauth.client_name` = "Hypotenuse" (2–80 characters, must not contain "Linear" or a URL — asserted in a test,
  because a deployment named "Linear Bot" would otherwise fail at Linear with an unhelpful error)
- `oauth.redirect_uris` = `[${APPLICATION_URL}/api/linear/callback]`
- `oauth.grant_types` = `["authorization_code"]`
- `webhook.enabled` = true, `webhook.url` = `${APPLICATION_URL}/api/webhooks/linear` (HTTPS only; Linear refuses
  loopback, private-network, and linear.app hosts — so local development uses the ngrok tunnel)
- `webhook.resourceTypes` = `AgentSessionEvent`, `AppUserNotification`, `PermissionChange`, `OAuthApp`,
  `Issue`, `Comment`
- `distribution` = `private`

`bun keryx.ts linear:manifest-url` prints it (task-less CLI action, no `web` route), and `docs/DEPLOY.md` walks
through using it. Enabling **Agent session events** turns the Agent Session UI on for a workspace's users the
moment it is installed, which is why the manifest is the only place this is configured and the deploy runbook
says so in bold.

### Scopes

Requested, comma-separated as Linear requires: `read,write,app:assignable,app:mentionable,issues:create,
comments:create`.

| Scope | Why |
|---|---|
| `read` | always present; issues, comments, teams, states, sessions |
| `write` | `issueUpdate` (state moves, delegate), `agentSessionUpdate`, documents and projects for the manager |
| `app:assignable` | the app can be **delegated** issues and be a project member — the main way work starts |
| `app:mentionable` | the app can be @-mentioned in issues and comments — the other way work starts |
| `issues:create` | the manager files issues and sub-issues |
| `comments:create` | worker and manager comment outside the session thread |

`admin` cannot be requested with `actor=app` and is not needed. `customer:*`, `initiative:*`, and
`timeSchedule:write` are not requested; adding one later is a re-consent, which `prompt=consent` on the
authorize URL forces. The granted scope string is stored as returned (apps created before December 2023 receive
an array; normalize both to `string[]`).

### `linear_installations`

| Column | Type | Notes |
|---|---|---|
| `id` | serial PK | |
| `projectId` | int, FK `projects` cascade | **unique** — one installation per project |
| `organizationId` | text | Linear workspace id; **unique** among rows whose `status <> 'revoked'` (partial unique index) |
| `organizationName`, `urlKey` | text | display, and building `https://linear.app/<urlKey>/…` mention links |
| `appUserId` | text | `viewer.id` under the app token — the agent's identity in this workspace |
| `oauthClientId` | text | the `LINEAR_CLIENT_ID` it was installed under; a mismatch after a client rotation is surfaced, not guessed at |
| `scopes` | jsonb `string[]` | as granted |
| `accessTokenEncrypted`, `refreshTokenEncrypted` | text | AES-256-GCM via `ops/CryptoOps.ts` `encryptSecret` |
| `accessTokenLastFour` | text | for the settings page |
| `accessTokenExpiresAt` | timestamptz | `now() + expires_in` |
| `lastRefreshedAt`, `refreshFailedAt` | timestamptz | |
| `refreshError` | text | last refresh failure, shown to admins |
| `canAccessAllPublicTeams` | boolean | from `PermissionChange` (phase 7) and the install's own team query |
| `teamIds` | jsonb `string[]` | the teams the admin granted at install time |
| `status` | text | `active` \| `revoked` \| `error` |
| `installedByUserId` | int, FK `users` set null | |
| `rateLimit` | jsonb | the last-seen `X-RateLimit-*` headers: `{ requestsRemaining, requestsResetAt, complexityRemaining, complexityResetAt }` |
| `createdAt`, `updatedAt` | timestamptz | every timestamp `withTimezone: true` |

`serializeLinearInstallation()` drops both token columns and returns `{ id, projectId, organizationId,
organizationName, urlKey, appUserId, scopes, status, accessTokenLastFour, accessTokenExpiresAt, teamIds,
canAccessAllPublicTeams, refreshError, rateLimit }`. Both token column names join `SENSITIVE_KEYS`, as do
`code`, `code_verifier`, `access_token`, and `refresh_token`.

### One project, one workspace

`organizationId` is unique among live installations. A second project connecting a workspace that is already
connected elsewhere is refused at the callback with a page that names the condition — *"This Linear workspace is
already connected to another Hypotenuse project. Disconnect it there first."* — without naming the other
project, which the connecting admin may not be a member of.

Why not many-to-one: a webhook arrives with nothing but `organizationId` and `appUserId` to route it, and both
are per *workspace*. Two projects sharing a workspace would need a second routing key that Linear does not send.
The way two teams in one workspace split work is runner subscriptions ([phase 8](./phase-08-runners.md)) and
routing rules ([phase 9](./phase-09-work-routing.md)) inside one project, which is also the thing that lets one
person's runner pick up another team's overflow.

### The install flow

```
admin ──GET /api/linear/connect?projectId=1──► hypotenuse-api
         AdminMiddleware; mint state (32 bytes) + PKCE verifier;
         Redis SET linear:oauth:state:<state> {projectId,userId,verifier} EX 600
      ◄── { authorizeUrl } ─────────────────────
browser ──► ${LINEAR_OAUTH_URL}/oauth/authorize?client_id&redirect_uri&response_type=code
              &scope=read,write,app:assignable,app:mentionable,issues:create,comments:create
              &state&actor=app&prompt=consent&code_challenge&code_challenge_method=S256
         Linear admin approves, chooses teams
browser ──GET /api/linear/callback?code&state──► hypotenuse-api
         GETDEL the state (single use); require the same session userId that started it;
         POST ${LINEAR_API_URL}/oauth/token (authorization_code + code_verifier, Basic auth);
         query { viewer { id } organization { id name urlKey } teams { nodes { id key } } } with the new token;
         refuse if organizationId is live elsewhere; upsert the row in one AuditedAction transaction
      ◄── 302 ${FRONTEND_URL}/settings/linear?connected=1   (or ?error=<code>)
```

- **`state` is single-use and bound to the session that started it.** `GETDEL` makes a replayed callback a
  no-op, and the session check stops a callback URL lured into another admin's browser from attaching a
  workspace to *their* project. Both are tests.
- **PKCE as well as the client secret.** Linear supports `S256`; it costs one parameter and protects a code that
  leaks through a referrer or a proxy log.
- **`prompt=consent` always**, so reconnecting after a scope change, or connecting a second workspace from the
  same Linear login, shows the consent screen rather than silently reusing the previous grant.
- **The callback is a browser hop**, like ToolExec's `gateway:oauth-callback`: no JSON, a redirect to the
  frontend with a short error code (`state_expired`, `state_mismatch`, `denied`, `exchange_failed`,
  `workspace_taken`), never MCP, never wrapped by the CLI.
- **Reconnecting replaces tokens on the existing row** (same `projectId`), keeps the id, and clears `status`
  back to `active`. A different `organizationId` on reconnect is refused unless the old installation was
  disconnected first; switching workspaces silently would orphan every mirrored session.

### Refresh, rotation, and the replay grace

`linear:refresh-tokens` runs every 5 minutes on the worker and refreshes every `active` installation whose
`accessTokenExpiresAt` is within 30 minutes. `LinearOps.withInstallationToken()` refreshes inline on a 401 as a
backstop, through the same function.

`refreshInstallationTokens(installationId)` in `backend/ops/LinearOAuthOps.ts`:

1. Open a transaction; `SELECT … FROM linear_installations WHERE id = $1 FOR UPDATE`. The row lock is what makes
   two refreshers — the clock and an inline 401 on the web process — serialize. The second one re-reads, sees a
   fresh `accessTokenExpiresAt`, and returns without calling Linear.
2. Before calling Linear, write the refresh token being spent into Redis:
   `linear:refresh:inflight:<installationId>` = encrypted `{ refreshToken, startedAt }`, `EX 1800`.
3. `POST /oauth/token` with `grant_type=refresh_token`, HTTP Basic client auth.
4. On success: encrypt and store the new access **and new refresh** token, `accessTokenExpiresAt`,
   `lastRefreshedAt`; clear `refreshError`; commit; delete the in-flight key.
5. On a network error or a lost response: commit nothing. The next attempt finds the in-flight key and **replays
   the same refresh token**, which Linear honours for 30 minutes and answers with the same new token pair. This is
   the whole use of the grace period: it turns "the response was lost" from "the workspace is logged out" into a
   retry.
6. On `invalid_grant` after the grace window, or outside any in-flight attempt: `status = error`,
   `refreshError` set, project admins notified (`notifications`, ported from ToolExec). Sessions keep their
   mirrors; nothing new is sent to Linear until an admin reconnects.

The test for step 5 is the one that matters: the harness makes finear answer the first refresh and the client
drop the response; the second attempt must present the *spent* token and still end `active`.

### `LinearOps` — one client

`backend/ops/LinearOps.ts` is the only module that calls `fetch` on `LINEAR_API_URL`. It is a plain fetch-based
GraphQL client, not `@linear/sdk`'s `LinearClient`, for four reasons that each decide it on their own:

1. **Headers.** Rate-limit accounting needs `X-RateLimit-Requests-Remaining`, `-Reset`, `X-Complexity`, and the
   per-endpoint headers on every response. The SDK hides the response.
2. **Schema lag.** The agent surface is a Developer Preview. Fields such as `AgentSessionUpdateInput.summary`,
   `addedExternalUrls`, the `stopping` status, and the `continue` signal appear in the GraphQL schema before (or
   without) appearing in SDK helpers. Raw documents can use them the day they exist.
3. **Idempotency.** `agentActivityCreate(input: { id })` takes a client UUID, and the outbox in phase 7 depends
   on passing it exactly.
4. **One base URL.** Tests point `LINEAR_API_URL` at finear; finear accepts any valid query against its subset
   of the real schema, not only the SDK's generated operations.

`@linear/sdk` is still a dependency — for its **types** (`AgentSessionEventWebhookPayload`, the webhook
payload unions) and, in phase 7, `LinearWebhookClient`'s constants. Operation documents live in
`backend/ops/linear/operations.ts` as typed constants, one per operation, and every one used in production is
also executed against finear in a test, which is the only check that a hand-written document matches the schema.

API surface:

```ts
/** Run one GraphQL operation as the installation's app user. */
linearRequest<T>(installation, document, variables, opts?: { idempotent?: boolean }): Promise<T>
```

- Authorization `Bearer <decrypted access token>`; a 401 triggers one inline refresh and one retry.
- After every response, the `X-RateLimit-*` headers are written to `linear_installations.rateLimit` (throttled
  to one write per 10 s per installation) and to a Redis hash phase 7's token bucket reads.
- **`RATELIMITED`.** Linear answers HTTP 400 with `errors[].extensions.code = "RATELIMITED"`. `LinearOps`
  raises `LinearRateLimitedError` carrying the reset time from the headers. Callers inside a task re-enqueue at
  the reset; callers inside a request return 429 to theirs. It never sleeps inside a request.
- Other GraphQL errors raise `LinearGraphQLError` with Linear's message and `extensions`; HTTP 5xx and network
  errors raise `LinearUnavailableError`, retryable. Only operations marked `idempotent` are retried
  automatically (queries, and mutations that carry a client id).
- Every call logs the operation name, installation id, duration, and complexity — never variables, which can
  carry issue content.

Typed helpers built on it, used by later phases: `getViewer`, `getOrganization`, `listTeams`,
`listWorkflowStates(teamId)`, `listProjects`, `listLabels`, `getIssue(idOrIdentifier)`, `updateIssue`,
`createComment`, `createAgentActivity`, `updateAgentSession`, `createAgentSessionOnIssue`,
`createAgentSessionOnComment`, `getAgentSessionActivities`, `issueRepositorySuggestions`.

### `linear:catalog`

`GET /api/linear/catalog?projectId=` (member) answers `{ teams: [{ id, key, name, states: [{ id, name, type,
position }] }], projects: [{ id, name, teamIds }], labels: [{ id, name, teamId | null }] }`, paged through
Linear's connections server-side and cached in Redis for 60 s per installation. The routing-rules editor, runner
subscriptions view, and the CLI's `routing add` prompt use it, so no client ever holds a Linear token to fill a
dropdown.

### Disconnect

`linear:disconnect` (`DELETE /api/linear/installation`, admin, audited) revokes **both** tokens at
`POST /oauth/revoke` (`token_type_hint` each; a 400 "already revoked" is success), then marks the row `revoked`,
nulls both token columns, and — in phase 7 and later — cancels live sessions. The row is kept so mirrored
sessions keep their foreign key and the audit trail keeps its subject; the partial unique index is what lets
the same workspace connect to another project afterwards.

### RBAC, audit, MCP, CLI

| Action | Route | Level | Audited | MCP | CLI |
|---|---|---|---|---|---|
| `linear:connect` | `GET /linear/connect` | admin | no — it writes only a Redis key; the callback is the decision | yes (returns a URL a person opens) | `linear connect` (opens the browser) |
| `linear:callback` | `GET /linear/callback` | session (the starter) | **yes** — `linear-installation` create/update | never (browser hop) | — |
| `linear:installation` | `GET /linear/installation` | member | read | yes | `linear status` |
| `linear:disconnect` | `DELETE /linear/installation` | admin | yes | yes | `linear disconnect` |
| `linear:catalog` | `GET /linear/catalog` | member | read | yes | used by `routing add` |
| `linear:refresh-tokens` | — (task, 5 min) | — | no — a clock, and the record is the row | never | — |
| `linear:manifest-url` | — (ops CLI) | — | no | never | — |

`linear:callback` joins the never-MCP list by name, with the reason ("a browser hop that consumes an OAuth code")
in `ops/McpToolPolicyOps.ts`.

### The finear harness

`backend/__tests__/linear/finear.ts` exports `useFinear(opts?)`, which every Linear-touching suite calls in its
`beforeAll`. finear is a git dev dependency (`"finear": "github:pmdroid/finear#<sha>"`, pinned) imported
in-process — its standalone `bun run start` cannot register an OAuth client with a webhook, which agent-session
tests require.

```ts
const linear = await useFinear();          // after buildTestUniverse(), so serverUrl() exists
linear.url                                 // set as LINEAR_API_URL / LINEAR_OAUTH_URL for the server under test
linear.human                               // LinearClient with finear-fixture-primary-key (admin "Human 1")
linear.fixtures                            // org, team ENG, states backlog/started/completed, private team
await linear.install(projectId, cookie)    // drives linear:connect → finear consent → linear:callback
linear.appUserId                           // the app's viewer id after install
await linear.control.delegate(issueId)     // POST /__test/agents/delegate (phase 7 onward)
await linear.drain()                       // deliver every pending webhook now
await linear.reset()
```

- **The OAuth client** is registered through `createApplication({ clients: [...] })` with
  `scopes` as above, `redirectUris: [${serverUrl()}/api/linear/callback]`, and
  `webhook: { url: ${serverUrl()}/api/webhooks/linear, secret: LINEAR_WEBHOOK_SECRET, resourceTypes: ["Issue",
  "Comment"], agentSessionEvents: true }`.
- **Consent is scripted.** `linear.install()` follows `authorizeUrl`, scrapes the `name="consent"` nonce from
  finear's HTML, and posts `decision=allow` with the fixture user, workspace, and team ids — ported from
  `approveFixtureConsent` in finear's `examples/agent.ts`.
- **Env is injected before boot**: `LINEAR_API_URL`, `LINEAR_OAUTH_URL`, `LINEAR_CLIENT_ID`,
  `LINEAR_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET` with `_TEST` suffixes in `backend/.env.example`, so
  `loadFromEnvIfSet` selects them under `NODE_ENV=test`. finear binds port 0; the harness rewrites the config
  values after it knows the port and before `api.start()`.

**finear gaps that matter here**, each filed upstream rather than faked (the finear rule in [`AGENTS.md`](../../AGENTS.md)):
no `client_credentials` grant (not used anyway), consent only by HTML scraping (the harness owns that fragility
in one function), and a single fixture OAuth client with no webhook (the harness registers its own).

## Steps

### 1. Schema — `backend/schema/linear_installations.ts`

Table as above; partial unique index `linear_installations_org_live` on `(organizationId) WHERE status <>
'revoked'`; unique on `projectId`. Generate the migration.

### 2. Config — `backend/config/linear.ts`

`declare module "keryx" { interface KeryxConfig { linear: {...} } }` with `clientId`, `clientSecret`,
`webhookSecret`, `apiUrl`, `oauthUrl`, `scopes`, `refreshWindowMs` (30 min), `catalogTtlMs` (60 s). Boot fails in
production without the three secrets; in development a missing client id disables the Connect button with a
reason (`linear:installation` answers `{ installation: null, configured: false }`).

### 3. Ops — `backend/ops/{LinearOps,LinearOAuthOps,LinearManifestOps}.ts`, `backend/ops/linear/operations.ts`

As designed. `LinearOAuthOps`: `buildAuthorizeUrl`, `parkState` / `collectState` (Redis, reusing the shape of
ToolExec's `ops/OAuthClientOps.ts` park/collect), `exchangeCode`, `refreshInstallationTokens`, `revokeTokens`.
`serializeLinearInstallation` lives in `LinearOps`.

### 4. Actions — `backend/actions/linear/{linear-connect,linear-callback,linear-installation,linear-disconnect,linear-catalog,linear-refresh-tokens,linear-manifest-url}.ts`

`linear-callback` extends `AuditedAction` (`auditTargetType = "linear-installation"`); `linear-disconnect` too.

### 5. Frontend — `frontend/src/components/settings/sections/Linear.tsx`

A settings section (`/settings/linear`): disconnected → "Connect Linear" (admins; members see who can);
connected → workspace name and `urlKey`, app user, granted scopes, teams, token expiry, refresh error banner,
last-seen rate-limit headroom, and Disconnect behind a confirmation. Gated with `can()`. Reads
`?connected=1` / `?error=` from the callback redirect and shows the matching alert.

### 6. CLI — `cli/src/commands/linear.ts`

`hypotenuse linear status` (`linear:installation`), `linear connect` (fetches `authorizeUrl`, opens the
browser, then polls `linear:installation` until `active` or 5 minutes), `linear disconnect` (confirms unless
`--yes`). A user-facing change (rule 12) with a version bump (rule 13).

### 7. Docs — `frontend/src/content/docs/connecting-linear.md`, `docs/DEPLOY.md`

User docs: what the consent screen asks for and why each scope; that a Linear admin must approve; that
disconnecting stops the agent in Linear immediately. `DEPLOY.md`: creating the Linear app from the manifest
link, where the three secrets go, and that enabling agent session events turns the agent UI on for users.

### 8. Harness — `backend/__tests__/linear/finear.ts`

As designed, plus `backend/__tests__/linear/finear.test.ts` proving the harness itself: install succeeds, the
app user exists, `viewer.id` under the app token differs from the human's.

### 9. Tests — `backend/__tests__/actions/linear-*.test.ts`, `backend/__tests__/ops/linear-*.test.ts`

| File | Asserts |
|---|---|
| `linear-connect.test.ts` | admin gets an authorize URL with every required parameter (`actor=app`, the six scopes comma-separated, S256 challenge, `prompt=consent`); a member gets 403; Bowser gets 403 identical to a missing project |
| `linear-callback.test.ts` | the full finear flow creates an `active` row with `appUserId` = the app's viewer id; replayed `state` is refused; a different session's `state` is refused; an expired `state` redirects `state_expired`; a denied consent redirects `denied`; a second project connecting the same workspace redirects `workspace_taken` and leaves the first untouched; reconnect keeps the row id; tokens are not in the audit row |
| `linear-disconnect.test.ts` | both tokens revoked at finear (the old access token now 401s); row `revoked`; tokens nulled; the workspace can then connect to another project |
| `linear-catalog.test.ts` | teams with states, projects, labels from finear; cached (second call does not hit finear — counted via finear's request log); member-only |
| `linear-refresh.test.ts` | refresh within the window rotates both tokens; two concurrent refreshes call finear once; a dropped response replays the spent refresh token within 30 minutes and ends `active`; `invalid_grant` ends `error` and notifies admins |
| `linear-ops.test.ts` | every document in `operations.ts` executes against finear without a GraphQL error; a 400 `RATELIMITED` (finear rate-limit fixture, or a stub upstream route if finear lacks one — file it) raises `LinearRateLimitedError` with the reset time; rate-limit headers persist |
| `linear-manifest.test.ts` | the manifest URL parses, validates against Linear's published JSON schema (vendored at `backend/__tests__/fixtures/oauth-app-manifest.schema.json`), and refuses a client name containing "Linear" |

## Verification

```bash
cd backend && bun run migrations && bun run lint
cd backend && bun test __tests__/linear __tests__/actions/linear-*.test.ts __tests__/ops/linear-*.test.ts
cd frontend && bun run lint && bun run build
cd cli && bun run lint && bun test
```

Against a real Linear workspace (staging, once):

```bash
bun keryx.ts linear:manifest-url                       # create the app in Linear from this URL
# set LINEAR_CLIENT_ID / SECRET / WEBHOOK_SECRET in hypotenuse-shared, deploy
hypotenuse login --url https://api.staging.hypotenuse.dev
hypotenuse linear connect                              # approve as a Linear admin, pick teams
hypotenuse linear status --json | jq '.installation | {status, organizationName, appUserId, accessTokenExpiresAt}'
# 25 hours later: still active, accessTokenExpiresAt moved, lastRefreshedAt recent
```

## Definition of done

- [ ] `linear_installations` with the partial unique index on live `organizationId` and unique `projectId`
- [ ] Install flow with single-use, session-bound `state` and PKCE; `prompt=consent`; six scopes
- [ ] Second project connecting the same workspace refused with a non-leaking message
- [ ] Tokens encrypted; token columns and OAuth params in `SENSITIVE_KEYS`; serializer omits them
- [ ] `linear:refresh-tokens` with row lock, rotation, and replay inside the 30-minute grace; inline 401 refresh
- [ ] `LinearOps` is the only `fetch` to Linear; records rate-limit headers; `RATELIMITED` → typed error
- [ ] Every operation document executes against finear in a test
- [ ] `linear:catalog` cached and member-gated
- [ ] Disconnect revokes both tokens and frees the workspace
- [ ] `useFinear()` harness with scripted consent, used by every Linear suite
- [ ] Settings → Linear section, `hypotenuse linear` commands, user docs, DEPLOY.md section, manifest URL helper

## Commands

```bash
# Print the pre-filled Linear app-creation link for this deployment.
cd backend && bun keryx.ts linear:manifest-url

# What is connected, and how fresh is the token?
psql hypotenuse -c "select project_id, organization_name, status, access_token_expires_at, refresh_error from linear_installations;"

# Force a refresh pass now.
cd backend && bun keryx.ts linear:refresh-tokens
```

## Learnings from the build

_Nothing yet — this phase has not been built._
