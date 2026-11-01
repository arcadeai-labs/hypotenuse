# Slack platform coverage

Every interaction Hypotenuse has with Slack, the module that handles it, and the test that proves it (AGENTS.md
rule 10). `backend/__tests__/docs/coverage.test.ts` asserts each row's test file exists and mentions the row's id.
The tests talk to the Slack fake (`backend/__tests__/fakes/slack/server.ts`), which validates every Web API call
against Slack's published OpenAPI spec and every manifest against Slack's manifest schema, both pinned by
`bun run slack:fetch-spec`; methods newer than the spec are described in
`backend/__tests__/fakes/slack/spec/supplement.ts`, each with its documentation page.

Rows marked *unconfirmed* follow Slack's documentation but have not yet been seen against a live workspace; the
first real install pins them (see the Slack plan's open questions).

| Id | Interaction | Module | Test |
|---|---|---|---|
| `slack.manifest` | the app manifest generated per bot — name, bot user, assistant view (with the `assistant_thread_started` subscription Slack requires of it), scopes, events, interactivity, OAuth redirect — valid against Slack's manifest schema, and its pre-filled creation link (`api.slack.com/apps?new_app=1&manifest_json=`) | `backend/ops/SlackManifestOps.ts` | `backend/__tests__/slack/install.test.ts` |
| `slack.app.create` | `apps.manifest.create` with a pasted app configuration token (used once, never stored); the client and signing secrets sealed on a pending installation | `backend/actions/slack/slack-app-create.ts` | `backend/__tests__/slack/install.test.ts` |
| `slack.app.invalid-manifest` | `invalid_manifest` answered with Slack's `errors[].pointer` verbatim; a refused configuration token names the token | `backend/actions/slack/slack-app-create.ts` | `backend/__tests__/slack/install.test.ts` |
| `slack.app.register` | the manual path: the manifest pasted into Slack, the app's credentials connected (pending until installed); a pasted `xoxb-` token activates it | `backend/actions/bot-installation/bot-installation-connect.ts` | `backend/__tests__/slack/install.test.ts` |
| `slack.oauth.install` | `oauth/v2/authorize` with a single-use state, then `oauth.v2.access` (form-encoded) and `auth.test`; the workspace, bot user, and token recorded | `backend/actions/bot-installation/bot-installation-oauth-callback.ts` | `backend/__tests__/slack/install.test.ts` |
| `slack.out.auth-test` | `auth.test` to check a bot token and learn the bot's own user id (connect, `bot-installation:test`) | `backend/platforms/slack/adapter.ts` | `backend/__tests__/slack/install.test.ts` |
| `slack.in.url-verification` | `url_verification` answered with its `challenge` after the signature checks — also before the app is installed | `backend/ops/IngressOps.ts` | `backend/__tests__/slack/install.test.ts` |
| `slack.in.signature` | v0 signing (`X-Slack-Signature`, `X-Slack-Request-Timestamp`, five minutes), the previous secret during a rotation; every refusal one byte-identical 404 | `backend/platforms/slack/adapter.ts` | `backend/__tests__/slack/install.test.ts` |
| `slack.in.retry` | a delivery retried with `X-Slack-Retry-Num` is one event (`event_id`) | `backend/ops/TriggerEventOps.ts` | `backend/__tests__/slack/install.test.ts` |
| `slack.in.ack` | every delivery is answered 200 within Slack's three seconds, whatever a tick is doing | `backend/ops/IngressOps.ts` | `backend/__tests__/slack/thread.test.ts` |
| `slack.in.app-mention` | `app_mention` in a bound channel starts a conversation for its thread | `backend/platforms/slack/events.ts` | `backend/__tests__/slack/thread.test.ts` |
| `slack.in.dedupe` | `app_mention` and `message.channels` for one message are one inbox row (keyed by team, channel, `ts`) | `backend/platforms/slack/events.ts` | `backend/__tests__/slack/thread.test.ts` |
| `slack.in.thread-reply` | `message.channels` / `message.groups` in the bot's thread continues it without a mention; elsewhere it is not addressed | `backend/platforms/slack/events.ts` | `backend/__tests__/slack/thread.test.ts` |
| `slack.in.dm` | `message.im`: each top-level DM message is its own conversation, under the bot's DM auto-bind | `backend/platforms/slack/events.ts` | `backend/__tests__/slack/thread.test.ts` |
| `slack.in.edit` | `message_changed` / `message_deleted` never become new messages | `backend/platforms/slack/events.ts` | `backend/__tests__/slack/thread.test.ts` |
| `slack.in.loop` | the bot's own messages and any bot's (`bot_id`, `bot_message`) are dropped | `backend/platforms/slack/events.ts` | `backend/__tests__/slack/thread.test.ts` |
| `slack.in.shared-channel` | `is_ext_shared_channel` (Slack Connect) is refused unless the binding allows shared channels | `backend/ops/TriggerEventOps.ts` | `backend/__tests__/slack/thread.test.ts` |
| `slack.in.block-actions` | `block_actions` (a form whose `payload` is JSON): `q:<question>:<option>` answers a question, `a:<approval>:approve` or `:deny` decides an approval under the binding's policy | `backend/platforms/slack/events.ts` | `backend/__tests__/slack/conformance-slack.test.ts` |
| `slack.in.stop` | `agent_session_stopped` cancels the thread's conversation; nothing more is posted (*unconfirmed*) | `backend/platforms/slack/events.ts` | `backend/__tests__/slack/thread.test.ts` |
| `slack.in.member-joined` | `member_joined_channel` for the bot records the channel and binds it under the bot's auto-bind | `backend/ops/TriggerEventOps.ts` | `backend/__tests__/slack/thread.test.ts` |
| `slack.in.channel-left` | `channel_left` / `group_left`: the binding is removed (or disabled) and the channel's live conversations end | `backend/ops/TriggerEventOps.ts` | `backend/__tests__/slack/thread.test.ts` |
| `slack.in.uninstall` | `app_uninstalled`, and `tokens_revoked` naming the bot: the installation is uninstalled, its conversations end, its URL is the 404 | `backend/ops/TriggerEventOps.ts` | `backend/__tests__/slack/thread.test.ts` |
| `slack.in.app-home` | `app_home_opened`, `assistant_thread_started`, `assistant_thread_context_changed`, and other events are recorded and change nothing | `backend/platforms/slack/events.ts` | `backend/__tests__/slack/install.test.ts` |
| `slack.out.status` | `assistant.threads.setStatus` for the working line; Slack clears it when the bot posts | `backend/platforms/slack/adapter.ts` | `backend/__tests__/slack/thread.test.ts` |
| `slack.out.stream` | `chat.startStream` / `chat.appendStream` (`markdown_text` deltas) / `chat.stopStream`; a row that does not extend the stream restarts it (*unconfirmed*) | `backend/platforms/slack/adapter.ts` | `backend/__tests__/slack/thread.test.ts` |
| `slack.out.stream-age` | a stream older than Slack's ten minutes is closed and another started | `backend/platforms/slack/adapter.ts` | `backend/__tests__/slack/thread.test.ts` |
| `slack.out.plan` | the turn's plan as one `chat.postMessage`, then `chat.update` of it as steps run | `backend/platforms/slack/render.ts` | `backend/__tests__/slack/thread.test.ts` |
| `slack.out.message` | the answer as `chat.postMessage` in the thread | `backend/platforms/slack/adapter.ts` | `backend/__tests__/slack/thread.test.ts` |
| `slack.out.mrkdwn` | markdown to `mrkdwn`; `<!channel>` / `<!here>` / the bot's own mention never sent; past 40,000 characters, truncated with a transcript link | `backend/ops/SlackMarkdownOps.ts` | `backend/__tests__/slack/thread.test.ts` |
| `slack.out.question` | a question with buttons (`q:<question>:<option>`), a menu past five options | `backend/platforms/slack/render.ts` | `backend/__tests__/slack/conformance-slack.test.ts` |
| `slack.out.approval` | an approval with Approve / Deny (`a:<approval>:…`) and the dashboard link; under the dashboard policy, the link alone | `backend/platforms/slack/render.ts` | `backend/__tests__/slack/thread.test.ts` |
| `slack.out.ratelimited` | HTTP 429 `ratelimited` with `Retry-After` reschedules the outbox row; no worker waits | `backend/ops/SlackOps.ts` | `backend/__tests__/slack/thread.test.ts` |
| `slack.out.bucket` | the per-installation token bucket defers a send before Slack is called | `backend/lua/slack-bucket.lua` | `backend/__tests__/slack/thread.test.ts` |
| `slack.out.undeliverable` | any other `ok: false` (`not_in_channel`, `invalid_auth`) makes the row undeliverable | `backend/platforms/slack/adapter.ts` | `backend/__tests__/slack/thread.test.ts` |
| `slack.secrets` | no bot token, client or signing secret, or configuration token in any answer, audit row, log line, or stored row outside the sealed column | `backend/ops/InstallationOps.ts` | `backend/__tests__/slack/secrets.test.ts` |
