# Pylon platform coverage

Every interaction Hypotenuse has with Pylon, the module that handles it, and the test that proves it (AGENTS.md
rule 10). `backend/__tests__/docs/coverage.test.ts` asserts each row's test file exists and mentions the row's id.
The tests talk to the Pylon fake (`backend/__tests__/fakes/pylon/server.ts`): Pylon's REST API in both regions,
its per-endpoint rate limits and `429`s, and its webhooks — the bot's Trigger templates rendered and signed as Pylon
signs them. Pylon publishes no machine-readable spec we could find, so the fake validates every request body against
schemas that cite the doc page each field came from, and suites assert no call was invalid.

Webhook payloads are templates a Pylon admin writes, so "events" here are the four Triggers the manifest asks for.
Rows that follow Pylon's documentation but have not yet been seen against a live Pylon organization are *unconfirmed*
in the [learnings](../plans/phase-16-pylon.md#learnings-from-the-build); the first real install pins them.

| Id | Interaction | Module | Test |
|---|---|---|---|
| `pylon.manifest` | what a Pylon admin creates for one bot: an API token with its own identity named for the bot, a webhook to the bot's URL, and four Triggers ("New issue created", "Issue has a new message", "Issue assigned", "Issue status changed"), each a "Send webhook" with a body template of ids only | `backend/platforms/pylon/events.ts` | `backend/__tests__/pylon/install.test.ts` |
| `pylon.connect` | the token, the webhook secret, the region, and the token's name connected and sealed; the token checked at once (`probeOnConnect`); the customer reply policy refused here and kept | `backend/actions/bot-installation/bot-installation-connect.ts` | `backend/__tests__/pylon/install.test.ts` |
| `pylon.connect.refused` | a token Pylon refuses (`invalid_api_token`) leaves the installation `error` with Pylon's code | `backend/platforms/pylon/adapter.ts` | `backend/__tests__/pylon/install.test.ts` |
| `pylon.out.me` | `GET /me` names the token's own user (loop filtering) and the organization | `backend/platforms/pylon/adapter.ts` | `backend/__tests__/pylon/install.test.ts` |
| `pylon.region` | US `api.usepylon.com` or EU `api.eu.usepylon.com`; `401 wrong_region_token` is said as the region to use | `backend/ops/PylonOps.ts` | `backend/__tests__/pylon/install.test.ts` |
| `pylon.secrets` | no API token or webhook secret in any answer; `apiToken` and `webhookSecret` are in `SENSITIVE_KEYS` | `backend/ops/InstallationOps.ts` | `backend/__tests__/pylon/install.test.ts` |
| `pylon.settings` | `pylon:settings-edit` — the customer reply policy, triggers, listen filters, the token's name, the legacy signature — admin-only and audited, recording who set the policy | `backend/actions/pylon/pylon-settings-edit.ts` | `backend/__tests__/pylon/issue.test.ts` |
| `pylon.in.signature` | `X-Pylon-Signature-V2` = hex HMAC-SHA256 of `<X-Pylon-Timestamp>.<raw body>` (a `hs256=` prefix tolerated), the timestamp within 300 seconds | `backend/platforms/pylon/adapter.ts` | `backend/__tests__/pylon/install.test.ts` |
| `pylon.in.refusal` | a stale timestamp, the wrong secret, no signature, a legacy signature not accepted, and an unknown routing key are one byte-identical 404 | `backend/ops/IngressOps.ts` | `backend/__tests__/pylon/install.test.ts` |
| `pylon.in.legacy` | the legacy `X-Pylon-Signature` (an HMAC of the body alone, never expiring) only when the installation sets `legacySignature` | `backend/platforms/pylon/adapter.ts` | `backend/__tests__/pylon/install.test.ts` |
| `pylon.in.retry` | Pylon's retries (no delivery id, a new timestamp, `X-Pylon-Retry-Number`) are one trigger event: the id is a hash of the body within `dedupeWindowSeconds` | `backend/platforms/pylon/events.ts` | `backend/__tests__/pylon/install.test.ts` |
| `pylon.in.unknown` | an event Hypotenuse does not read, or an issue Pylon no longer has, is recorded and starts nothing | `backend/platforms/pylon/events.ts` | `backend/__tests__/pylon/install.test.ts` |
| `pylon.hydrate` | the issue (`GET /issues/{id}`), its account (`GET /accounts/{id}`), and the message (`GET /issues/{id}/messages`) read before processing, outside its transaction, and stored on the event | `backend/platforms/pylon/adapter.ts` | `backend/__tests__/pylon/issue.test.ts` |
| `pylon.in.issue_created` | a new issue in a listened team and tag becomes a conversation, addressed, from the requester; its first message is the same message as its "new message" delivery | `backend/platforms/pylon/events.ts` | `backend/__tests__/pylon/issue.test.ts` |
| `pylon.trigger.auto_triage` | with `autoTriage` off, a new issue is `noted: auto-triage-off` | `backend/platforms/pylon/events.ts` | `backend/__tests__/pylon/issue.test.ts` |
| `pylon.listen` | an issue outside the listened teams or tags is `noted: not-listened` | `backend/platforms/pylon/events.ts` | `backend/__tests__/pylon/issue.test.ts` |
| `pylon.channel.account` | an issue's channel is its account (`account:<id>`, the account's name and domains); with no account, `unassigned` | `backend/platforms/pylon/events.ts` | `backend/__tests__/pylon/issue.test.ts` |
| `pylon.binding` | an account binds itself with approval policy `participants` (`autoBindApprovalPolicy`): only the team sees internal notes | `backend/ops/TriggerEventOps.ts` | `backend/__tests__/pylon/issue.test.ts` |
| `pylon.in.self` | a note or reply by the bot's own token, or another bot's of the project, is `ignored: loop` | `backend/platforms/pylon/events.ts` | `backend/__tests__/pylon/issue.test.ts` |
| `pylon.in.customer_message` | a customer's message continues the conversation the bot has on the issue | `backend/platforms/pylon/events.ts` | `backend/__tests__/pylon/issue.test.ts` |
| `pylon.in.untrusted` | a customer's message never decides an approval, whatever it says (`untrusted`) | `backend/ops/TriggerEventOps.ts` | `backend/__tests__/pylon/issue.test.ts` |
| `pylon.in.mention` | a teammate's internal note mentioning the bot by name is addressed to it, the mention cut out; it starts a conversation or answers a question | `backend/platforms/pylon/events.ts` | `backend/__tests__/pylon/issue.test.ts` |
| `pylon.in.note_unaddressed` | any other internal note is `noted: note-not-addressed` | `backend/platforms/pylon/events.ts` | `backend/__tests__/pylon/issue.test.ts` |
| `pylon.in.teammate_reply` | a teammate's customer-facing reply is `noted: teammate-reply` | `backend/platforms/pylon/events.ts` | `backend/__tests__/pylon/issue.test.ts` |
| `pylon.in.approve_note` | a teammate's note `approve <id>` / `deny <id>` decides the approval, audited as a participant | `backend/ops/TriggerEventOps.ts` | `backend/__tests__/pylon/issue.test.ts` |
| `pylon.in.assigned` | an issue assigned to the bot becomes (or continues) a conversation that remembers it was assigned (`assignedIssueId`) | `backend/platforms/pylon/events.ts` | `backend/__tests__/pylon/issue.test.ts` |
| `pylon.trigger.assignment` | `assignment` decides whether an assignment starts work | `backend/platforms/pylon/events.ts` | `backend/__tests__/pylon/issue.test.ts` |
| `pylon.in.unassigned` | assigned to anyone else, the conversations the bot was assigned on the issue end silently; one it only triaged does not | `backend/platforms/pylon/events.ts` | `backend/__tests__/pylon/issue.test.ts` |
| `pylon.in.closed` | an issue `closed` ends its conversations silently | `backend/platforms/pylon/events.ts` | `backend/__tests__/pylon/issue.test.ts` |
| `pylon.out.ack` | `POST /issues/{id}/note` "Looking into this." opens the conversation's Pylon-only thread (`thread_name`); later acknowledgements post nothing | `backend/platforms/pylon/adapter.ts` | `backend/__tests__/pylon/issue.test.ts` |
| `pylon.out.note` | every later note joins the thread (`message_id` of the first); a final answer is always a note | `backend/platforms/pylon/adapter.ts` | `backend/__tests__/pylon/issue.test.ts` |
| `pylon.out.steps` | the turn's finished steps as a checklist in its final note — one note a turn; statuses and plans post nothing on their own | `backend/platforms/pylon/adapter.ts` | `backend/__tests__/pylon/issue.test.ts` |
| `pylon.out.question` | a question is a note to the team, answered by a note mentioning the bot | `backend/platforms/pylon/adapter.ts` | `backend/__tests__/pylon/issue.test.ts` |
| `pylon.out.draft` | an approval of a customer reply is a draft reply (`POST /issues/{id}/draft-reply`, the bot's `user_id`) … | `backend/platforms/pylon/adapter.ts` | `backend/__tests__/pylon/issue.test.ts` |
| `pylon.out.approval_note` | … and a note quoting it, asking for `approve <id>`; any other approval is a note | `backend/platforms/pylon/adapter.ts` | `backend/__tests__/pylon/issue.test.ts` |
| `pylon.out.reply` | `POST /issues/{id}/reply` answering the newest customer-visible message, with exactly the approved text | `backend/tools/pylon-write.ts` | `backend/__tests__/pylon/issue.test.ts` |
| `pylon.out.reply_idempotent` | `custom_source.external_id` is the call's idempotency key, so a resend returns the message Pylon has | `backend/tools/pylon-write.ts` | `backend/__tests__/pylon/issue.test.ts` |
| `pylon.policy.never` | under `never` (the default) the reply tool is not offered, and a call is refused | `backend/tools/pylon-write.ts` | `backend/__tests__/pylon/issue.test.ts` |
| `pylon.policy.approve` | under `approve` every reply waits for a person | `backend/tools/pylon-write.ts` | `backend/__tests__/pylon/issue.test.ts` |
| `pylon.policy.auto_low` | under `auto-on-low-risk` a reply the risk check rates low is sent, audited as `pylon:auto-reply` by the admin who set the policy | `backend/tools/pylon-write.ts` | `backend/__tests__/pylon/issue.test.ts` |
| `pylon.policy.auto_high` | … and one it rates high (or cannot rate) waits for a person | `backend/tools/pylon-write.ts` | `backend/__tests__/pylon/issue.test.ts` |
| `pylon.risk` | the `fast` model rates a draft: refunds, legal, security, commitments, angry customers are high | `backend/ops/PylonRiskOps.ts` | `backend/__tests__/pylon/issue.test.ts` |
| `pylon.out.bucket` | writes take a token from the installation's bucket (30 a minute, a reserve for acknowledgements); an empty bucket reschedules the row before Pylon is called | `backend/ops/PylonOps.ts` | `backend/__tests__/pylon/issue.test.ts` |
| `pylon.out.429` | Pylon's `429 rate_limited` reschedules the row after `Retry-After` | `backend/ops/PylonOps.ts` | `backend/__tests__/pylon/issue.test.ts` |
| `pylon.tool.issue_view` | `pylon_issue_view`: the conversation's issue and its messages and notes | `backend/tools/pylon-read.ts` | `backend/__tests__/pylon/issue.test.ts` |
| `pylon.tool.account_view` | `pylon_account_view`: the issue's account | `backend/tools/pylon-read.ts` | `backend/__tests__/pylon/install.test.ts` |
| `pylon.tool.account_issues` | `pylon_account_issues`: `POST /issues/search` by the account | `backend/tools/pylon-read.ts` | `backend/__tests__/pylon/install.test.ts` |
| `pylon.tool.contact_view` | `pylon_contact_view`: a contact of the issue's account only | `backend/tools/pylon-read.ts` | `backend/__tests__/pylon/install.test.ts` |
| `pylon.tool.issue_update` | `pylon_issue_update`: `PATCH /issues/{id}` (state, tags, assignee, custom fields), each waiting for an approval | `backend/tools/pylon-write.ts` | `backend/__tests__/pylon/install.test.ts` |
| `pylon.memory.isolation` | one account's channel memory is never read on another account's issue | `backend/ops/MemoryAccessOps.ts` | `backend/__tests__/pylon/issue.test.ts` |
| `pylon.memory.promotion` | promoting a fact that names the customer (its name or a domain) is refused | `backend/ops/PromotionGuardOps.ts` | `backend/__tests__/pylon/issue.test.ts` |
| `pylon.conformance` | the shared conformance suite (ordering, nothing after a question, a question's round trip, approvals under `dashboard` and `participants`) | `backend/platforms/pylon/adapter.ts` | `backend/__tests__/pylon/conformance-pylon.test.ts` |
