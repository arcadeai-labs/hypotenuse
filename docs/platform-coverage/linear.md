# Linear platform coverage

Every interaction Hypotenuse has with Linear, the module that handles it, and the test that proves it (AGENTS.md
rule 10). `backend/__tests__/docs/coverage.test.ts` asserts each row's test file exists and mentions the row's id.
The tests talk to [finear](https://github.com/pmdroid/finear) — a Linear-compatible server running real GraphQL
against Linear's pinned schema, OAuth with PKCE and refresh rotation, agent sessions, and signed webhooks — fetched
at a pinned commit by `bun run finear:fetch` and booted in process by `backend/__tests__/linear/finear.ts`, behind a
proxy that records every request. Each bot fixture registers its own OAuth client on finear, with its own webhook.

Rows marked *unconfirmed* follow Linear's documentation but have not yet been seen against a live workspace; the
first real install pins them.

| Id | Interaction | Module | Test |
|---|---|---|---|
| `linear.manifest` | the app manifest per bot — Linear's `schemaVersion 1.0.0`, `distribution: public`, the webhook URL and its resource types (`AgentSessionEvent`, `AppUserNotification`, `PermissionChange`, `Issue`), the OAuth redirect — and the pre-filled creation link (`?manifest=`); a URL Linear would refuse is said in the instructions | `backend/ops/LinearManifestOps.ts` | `backend/__tests__/linear/install.test.ts` |
| `linear.app.register` | the app's Client ID, Client Secret, and webhook signing secret connected and sealed; the installation stays pending until installed | `backend/actions/bot-installation/bot-installation-connect.ts` | `backend/__tests__/linear/install.test.ts` |
| `linear.oauth.install` | `oauth/authorize` with `actor=app`, the six scopes, a single-use state, and PKCE (S256); `oauth/token` with the `code_verifier`; the workspace and app user recorded | `backend/platforms/linear/adapter.ts` | `backend/__tests__/linear/install.test.ts` |
| `linear.oauth.denied` | a person declining the install leaves the installation as it was, with Linear's reason | `backend/actions/bot-installation/bot-installation-oauth-callback.ts` | `backend/__tests__/linear/install.test.ts` |
| `linear.out.viewer` | `viewer` and `organization` to learn the app user and workspace at install, and to check the token (`bot-installation:test`) | `backend/platforms/linear/adapter.ts` | `backend/__tests__/linear/install.test.ts` |
| `linear.in.signature` | `Linear-Signature` (hex HMAC-SHA256 of the raw body) and the signed `webhookTimestamp` within 60 seconds; the previous secret during a rotation; a bad signature and a stale timestamp the same 404 | `backend/platforms/linear/adapter.ts` | `backend/__tests__/linear/install.test.ts` |
| `linear.in.dedupe` | a delivery retried with the same `Linear-Delivery` is one trigger event | `backend/platforms/linear/events.ts` | `backend/__tests__/linear/install.test.ts` |
| `linear.in.unknown-workspace` | a delivery naming another `organizationId` is answered 200 and recorded `unknown-installation` | `backend/ops/TriggerEventOps.ts` | `backend/__tests__/linear/install.test.ts` |
| `linear.in.body-cap` | a body past `PLATFORM_MAX_BODY_BYTES` is 413 | `backend/ops/IngressOps.ts` | `backend/__tests__/linear/install.test.ts` |
| `linear.in.inactive` | an errored or uninstalled installation that still holds its secret is answered 200 and the delivery dropped, never refused | `backend/ops/InstallationOps.ts` | `backend/__tests__/linear/install.test.ts` |
| `linear.multi-bot` | two bots, two apps, one workspace: each verifies with its own secret (one's secret on the other's URL is the 404), and each session goes to its own bot | `backend/platforms/linear/adapter.ts` | `backend/__tests__/linear/install.test.ts` |
| `linear.tokens.refresh` | `installations:refresh-tokens` refreshes a token that expires within six hours, under the installation's row lock; both tokens rotate | `backend/ops/LinearOps.ts` | `backend/__tests__/linear/install.test.ts` |
| `linear.tokens.replay` | a refresh whose answer was lost leaves the tokens as they were and is replayed with the same refresh token, within Linear's 30-minute grace | `backend/ops/LinearOps.ts` | `backend/__tests__/linear/install.test.ts` |
| `linear.tokens.invalid-grant` | `invalid_grant` marks the installation `error`, saying to install it again | `backend/ops/LinearOps.ts` | `backend/__tests__/linear/install.test.ts` |
| `linear.tokens.never-revoke` | nothing calls `oauth/revoke`: revoking any token of an `actor=app` install uninstalls the app | `backend/ops/LinearOps.ts` | `backend/__tests__/linear/install.test.ts` |
| `linear.secrets` | no client secret, webhook secret, access token, or refresh token in any answer, audit row, log line, or stored row outside the sealed column | `backend/ops/InstallationCredentialOps.ts` | `backend/__tests__/linear/install.test.ts` |
| `linear.in.created` | `AgentSessionEvent` `created`: a conversation keyed by the session, its first inbox row the issue, Linear's `promptContext`, and guidance | `backend/platforms/linear/events.ts` | `backend/__tests__/linear/session.test.ts` |
| `linear.in.ack-clock` | the acknowledgement reaches Linear within its ten seconds while the model is still thinking | `backend/ops/TriggerEventOps.ts` | `backend/__tests__/linear/session.test.ts` |
| `linear.out.ack` | the acknowledgement: a non-ephemeral `thought`, on the bucket's reserve | `backend/platforms/linear/adapter.ts` | `backend/__tests__/linear/session.test.ts` |
| `linear.out.hygiene` | a delegated issue that is not started, completed, or canceled moves to its team's first `started` state (`issue` `team.states`, `issueUpdate`); never the assignee | `backend/platforms/linear/adapter.ts` | `backend/__tests__/linear/session.test.ts` |
| `linear.in.prompted` | `AgentSessionEvent` `prompted`: the prompt's `content.body` (or `body`) into the inbox, answering a waiting question | `backend/platforms/linear/events.ts` | `backend/__tests__/linear/session.test.ts` |
| `linear.out.status` | a working line as an ephemeral `thought` | `backend/platforms/linear/adapter.ts` | `backend/__tests__/linear/session.test.ts` |
| `linear.out.plan` | the turn's steps as the session's `plan` (`agentSessionUpdate`), `inProgress` / `completed` / `canceled` | `backend/platforms/linear/adapter.ts` | `backend/__tests__/linear/session.test.ts` |
| `linear.out.action` | an `action` activity with its `result` for each step that finished since the last plan sent, once | `backend/platforms/linear/adapter.ts` | `backend/__tests__/linear/session.test.ts` |
| `linear.out.response` | the answer as a `response` activity, which completes the session | `backend/platforms/linear/adapter.ts` | `backend/__tests__/linear/session.test.ts` |
| `linear.out.error` | a failed task as an `error` activity | `backend/platforms/linear/adapter.ts` | `backend/__tests__/linear/session.test.ts` |
| `linear.out.elicitation` | a question as an `elicitation`, its options as the `select` signal's `signalMetadata.options` | `backend/platforms/linear/adapter.ts` | `backend/__tests__/linear/session.test.ts` |
| `linear.out.nothing-after-elicitation` | while the bot waits on an answer, nothing is written to the session | `backend/ops/SurfaceOps.ts` | `backend/__tests__/linear/session.test.ts` |
| `linear.out.approval` | an approval as an `elicitation` with the dashboard link; `Approve #id` / `Deny #id` as `select` options when the binding lets the channel decide | `backend/platforms/linear/adapter.ts` | `backend/__tests__/linear/session.test.ts` |
| `linear.in.approval-option` | a prompt reading `Approve #id` decides the approval as the participant, audited `actorType: participant` | `backend/ops/TriggerEventOps.ts` | `backend/__tests__/linear/session.test.ts` |
| `linear.in.stop` | a prompt with the `stop` signal cancels the turn and is answered once with a `response` quoting the note, never acting on it | `backend/platforms/linear/events.ts` | `backend/__tests__/linear/session.test.ts` |
| `linear.in.undelegate` | an `Issue` `update` taking the delegate away from the bot disengages the issue's sessions, silently | `backend/platforms/linear/events.ts` | `backend/__tests__/linear/session.test.ts` |
| `linear.in.re-engage` | after a disengagement, the person's next prompt wakes the session again | `backend/ops/TriggerEventOps.ts` | `backend/__tests__/linear/session.test.ts` |
| `linear.in.issue-completed` | an `Issue` `update` to a `completed` or `canceled` state, by someone other than the bot, disengages | `backend/platforms/linear/events.ts` | `backend/__tests__/linear/session.test.ts` |
| `linear.in.issue-removed` | an `Issue` `remove` disengages | `backend/platforms/linear/events.ts` | `backend/__tests__/linear/session.test.ts` |
| `linear.in.unassigned` | `AppUserNotification` `issueUnassignedFromYou` disengages | `backend/platforms/linear/events.ts` | `backend/__tests__/linear/session.test.ts` |
| `linear.in.permission-change` | `PermissionChange`: the team access recorded on the installation; sessions on teams the app lost disengage (*unconfirmed*) | `backend/platforms/linear/events.ts` | `backend/__tests__/linear/session.test.ts` |
| `linear.in.notification` | every other `AppUserNotification` starts nothing and is recorded with a decided outcome (`assigned-not-delegated`, `notification-<type>`) | `backend/platforms/linear/events.ts` | `backend/__tests__/linear/session.test.ts` |
| `linear.in.oauth-revoked` | `OAuthApp` `revoked`: the installation uninstalled, its tokens forgotten (never revoked), live sessions disengaged; installing again by OAuth works | `backend/ops/TriggerEventOps.ts` | `backend/__tests__/linear/session.test.ts` |
| `linear.channel.team` | an issue with no project: the channel is its team (`team:<id>`) | `backend/platforms/linear/events.ts` | `backend/__tests__/linear/session.test.ts` |
| `linear.channel.project` | an issue in a project: the channel is the project (`project:<id>`) | `backend/platforms/linear/events.ts` | `backend/__tests__/linear/session.test.ts` |
| `linear.memory.boundary` | channel memory written on one issue of a project is found on another issue of it, and not in another project | `backend/platforms/linear/events.ts` | `backend/__tests__/linear/session.test.ts` |
| `linear.channel.moved` | an issue moved to another project mid-session keeps its conversation and channel | `backend/ops/TriggerEventOps.ts` | `backend/__tests__/linear/session.test.ts` |
| `linear.out.mention-safe` | no outbound text carries a literal `@<app name>`: every recorded `agentActivityCreate` is scanned | `backend/ops/LinearMarkdownOps.ts` | `backend/__tests__/linear/session.test.ts` |
| `linear.out.ratelimited` | `RATELIMITED` (HTTP 400, `extensions.code`, `X-RateLimit-Requests-Reset`) reschedules the row until the reset; no worker waits | `backend/ops/LinearOps.ts` | `backend/__tests__/linear/session.test.ts` |
| `linear.out.retry-idempotent` | an activity whose answer was lost is retried with the same client id; a retry first asks `agentActivity(id)`, so it lands once | `backend/platforms/linear/adapter.ts` | `backend/__tests__/linear/session.test.ts` |
| `linear.out.bucket` | the per-installation token bucket defers a send before Linear is called, and keeps a reserve for acknowledgements | `backend/lua/linear-bucket.lua` | `backend/__tests__/linear/session.test.ts` |
| `linear.tool.issue-view` | `linear_issue_view` reads the session's own issue (`issue`), scoped from the conversation | `backend/tools/linear-issue-view.ts` | `backend/__tests__/linear/session.test.ts` |
| `linear.tool.comment` | `linear_comment_create` (`commentCreate`) on the session's issue, only after a person's approval | `backend/tools/linear-comment-create.ts` | `backend/__tests__/linear/session.test.ts` |
| `linear.conformance` | the channel framework's conformance suite: ordering, supersession, nothing after a question, a question's round trip, approvals under the dashboard and participants policies | `backend/platforms/linear/adapter.ts` | `backend/__tests__/linear/conformance-linear.test.ts` |

## Where finear differs from Linear

Each gap is driven another way meanwhile, never by faking Linear inside `backend/` (AGENTS.md rule 4). None is
filed upstream yet; each needs a person to file it at [`pmdroid/finear`](https://github.com/pmdroid/finear/issues).

| Gap | Rows | Meanwhile | Status |
|---|---|---|---|
| No `AppUserNotification`, `PermissionChange`, `OAuthApp revoked`, or `Issue remove` deliveries from an app's webhook | `linear.in.unassigned`, `linear.in.permission-change`, `linear.in.notification`, `linear.in.oauth-revoked`, `linear.in.issue-removed` | the test signs the body with the app's real secret and delivers it (`inject` in `backend/__tests__/linear/harness.ts`) | to file |
| No `RATELIMITED` refusal and no `X-RateLimit-*` headers | `linear.out.ratelimited` | the harness's proxy answers one request with Linear's documented refusal | to file |
| One person per workspace, so no second person can be a listed approver or a non-requester | `linear.conformance` | the `listed` policy's case is not run for Linear | to file |
| Clients are registered at boot only; one app per bot needs them at run time | every row | the harness calls finear's own `registerClient` in process | to file |
| Refuses an app's activity on a `complete` or `error` session until a person prompts it; whether real Linear does is unconfirmed | `linear.out.retry-idempotent` | a retry asks `agentActivity(id)` before sending again | to file |
