# Phase 16 — Pylon

> **Goal:** A bot works a support team's Pylon queue as its own teammate. When a customer issue arrives or changes, the bot reads it, works out an answer from its memory of that customer and the shared tools, and posts what it found as an **internal note** for the support team. It sends a customer-facing reply only when the bot's policy allows it, or when a person approves it. It remembers each customer company across all of that company's issues.

> **Status: planned, not built.** Builds on [the channel framework](./phase-13-channel-framework.md), the [durable agent loop](./phase-08-durable-agent-loop.md), [memory](./phase-09-memory.md), and the approval gate from [shared MCP servers](./phase-10-shared-mcp-servers.md). [Slack](./phase-14-slack.md) and [Linear](./phase-15-linear.md) are siblings.

Pylon is customer support, which changes two things compared with Slack and Linear.

**The person who started the conversation is usually a customer, not a teammate.** In Slack and Linear, whoever can reach the bot is a colleague, and the platform's membership is a fine gate. In Pylon, the issue's requester is someone outside the company, and anything the bot says to them speaks for the company. So the default audience is the support team (an internal note). Customer-facing text goes through a deliberate per-bot policy, plus an approval unless the policy says otherwise.

**Pylon has no agent-session primitive.** Linear has `AgentSessionEvent`; Slack has assistant threads and streaming. Pylon has issues, messages, internal-note threads, drafts, and webhooks. Status, plan, and questions therefore render as internal notes, and approvals render as a draft reply plus a note.

## Scope

**In:**

- **Identity per bot.** A Pylon API token created by a Pylon admin with **its own identity**: the token has its own name, icon, and role, and its actions are attributed to that name. Pylon offers this when a token is created (Settings → Integrations & dev → API tokens). The token is pasted into Hypotenuse and sealed on `bot_installations`. US/EU region is selected; a token sent to the wrong region answers `401 wrong_region_token`.
- **Ingress.** A Pylon webhook destination per bot installation, pointing at `/api/webhooks/pylon/<installationKey>`, with its signing secret pasted back. Verification:
  - `Pylon-Webhook-Signature: hs256=<hex>` over `<Pylon-Webhook-Timestamp>.<raw body>`, HMAC-SHA256;
  - the legacy `X-Pylon-Signature` (hex HMAC of the raw body) is accepted only if a destination is marked legacy.
- **Mapping:**
  - **channel** = the issue's **account** (the customer company);
  - **conversation** = the **issue**;
  - **participants** = the requester contact and the Pylon users who write on the issue.
- **Triggers that start or continue work**, each a per-bot setting:
  - a new issue (`auto-triage`);
  - an internal note that mentions the bot by name;
  - the bot being assigned an issue;
  - a new customer message on an issue the bot is working.
- **The interactive surface**, built from Pylon primitives:

  | Element | Pylon primitive |
  |---|---|
  | status, plan, steps, questions | internal notes (`POST /issues/{id}/note`) in one Pylon-only thread per conversation |
  | approval of a customer reply | a draft reply (`POST /issues/{id}/draft-reply`) plus a note asking for approval |
  | approved reply | `POST /issues/{id}/reply` |

- **Optional issue updates** through tools, gated by approval policy: tags, custom fields, state (`waiting_on_customer`, …), and assignee (`PATCH /issues`).
- **Customer context tools:** read the account, its contacts, and its issues.
- An in-process Pylon fake. A `docs/PYLON_COVERAGE.md` matrix with its docs test.

**Out:**

- Posting into a customer's Slack Connect thread through Pylon's Slack-backed threads. Pylon requires a human user's verified Slack identity for those, so bot and standalone API identities are refused.
- Ticket forms, the customer portal, knowledge-base authoring, and macros. These are candidates for tools later.
- Phone/call recordings.
- Merging or marking spam. These are irreversible and stay with people.

## What already exists

| Piece | Where | Use here |
|---|---|---|
| Channel adapter contract, outbox, ingress shape | [the channel framework](./phase-13-channel-framework.md) | Pylon is one adapter |
| Approval gate | [shared MCP servers](./phase-10-shared-mcp-servers.md) | A customer reply is an approval-gated action like any risky tool |
| Help escalation | [the channel framework](./phase-13-channel-framework.md) (`help_requests`, after ToolExec's [`HelpOps`](https://github.com/arcadeai-labs/toolexec/blob/main/backend/ops/HelpOps.ts)) | When nobody answers a note |
| Webhook verification pattern | [Slack](./phase-14-slack.md), [Linear](./phase-15-linear.md) | Raw body, constant time, byte-identical refusals |
| Pylon API | [Pylon developer docs](https://docs.usepylon.com/pylon-docs/developer/api/api-reference) | Bearer token; US `https://api.usepylon.com`, EU `https://api.eu.usepylon.com` |

## What this must not weaken

1. **Nothing reaches a customer by default.** A bot's `customerReplyPolicy` starts at `never`. Changing it is an audited admin decision. Even under `approve`, the text that goes out is the approved draft, byte for byte.
2. **Answer the webhook fast.** Verify, record, 200, enqueue. Never call Pylon inline.
3. **No Pylon token leaves the server.** No serializer field can hold the token or the webhook secret.
4. **The bot never hears itself.** Messages and notes authored by any of this project's bot tokens are dropped at processing.
5. **Respect Pylon's rate limits.** Notes and replies are 30/min per endpoint; reads mostly 120/min. A `429` carries `Retry-After` and `X-Retry-After`. The outbox reschedules and never sleeps.
6. **Memory of one customer stays with that customer.** Channel memory is per account. Facts about customer A are never retrieved while working on customer B's issue. Promotion to project memory strips customer-identifying detail, or is refused.

## Design

### 1. Installation

`pylon:connect` stores `{ region, apiToken }`, then:

1. Calls `GET /me` to learn the token's identity (its user/bot id and name). This id is how the bot recognizes its own messages.
2. Lets the admin set:
   - `customerReplyPolicy`: `never | approve | auto-on-low-risk`;
   - which triggers are on;
   - the Pylon team(s) and tags the bot listens to.

Then the admin creates a webhook destination in Pylon pointing at the URL Hypotenuse shows, and pastes back its signing secret (`pylon:webhook-register`). Pylon shows that secret only once.

### 2. Ingress — `webhooks:pylon`

`POST /api/webhooks/pylon/:installationKey`, with `web.rawBody: true`, no rate limit, and never MCP:

1. Resolve the key to an installation.
2. Read `Pylon-Webhook-Timestamp` and reject if it is more than 300 s from Postgres's clock.
3. Compute hex HMAC-SHA256(secret, `<timestamp>.<raw body>`) and constant-time compare it with the value after `hs256=` in `Pylon-Webhook-Signature`.
4. Insert `trigger_events` (`type: "pylon"`, `externalEventId` = the payload's event id, else sha256(body)) with `ON CONFLICT DO NOTHING`.
5. Answer 200 and enqueue.

Unknown key, stale timestamp, and bad signature get one byte-identical 404.

Pylon retries up to five times over about 31 hours, and marks a destination inactive after 7 days without a success. A health check on the bot's Pylon tab shows the last delivery received.

### 3. Processing

| Event (exact names confirmed against a live destination; see Open questions) | Condition | Outcome |
|---|---|---|
| issue created | `auto-triage` on, issue in a listened team/tag | Upsert channel (`account.id`) and conversation (`issue.id`). Inbox row from the title and first message; wake |
| issue updated: assignee became the bot | — | Same as created, if not already a conversation |
| issue updated: new customer message | Conversation exists and is not `ended` | Inbox row (`deliveryKey = message.id`); wake, or steer the running tick |
| issue updated: internal note mentioning the bot's name | — | Inbox row from a teammate. If the conversation is `waiting` on an answer, it answers it |
| issue updated: state → `closed` | — | Disengage silently; conversation `ended` |
| issue updated: assignee changed away from the bot | Bot was assignee | Disengage silently |
| anything authored by our bot tokens | — | `ignored-own-bot` |
| account events | — | Update the channel's display name/details; start nothing |

Webhook payloads may not carry message bodies. If they do not, the processor sets `checkAfter`, and a follow-up job reads `GET /issues/{id}/messages` (120/min) outside the transaction. This is the same second-look pattern as Linear notifications.

### 4. The interactive surface

Every conversation has one Pylon-only internal thread, named "Hypotenuse — <bot name>". It is created by the first note (`thread_name`), and its `thread_id` is stored on the conversation.

| Contract | Pylon |
|---|---|
| ack | Note: "Looking into this." |
| `status`, `plan`, `steps` | **Batched** into one note per tick (Pylon has no ephemeral or edit-in-place element we can rely on), as a checklist. Kept under the 30/min note limit |
| `question` (to the team) | Note with the question. A teammate's note mentioning the bot answers it |
| `approval` (of a customer reply) | `POST /issues/{id}/draft-reply` with the proposed text, owned by the bot's token, plus a note: "Draft reply ready. Reply 'approve' here, or approve in Hypotenuse". Approval sends exactly that text with `POST /issues/{id}/reply` (`message_id` = the latest customer-visible message, `custom_source.external_id` = the outbox row id, so a resend returns the existing message) |
| `response` (final) | Under `never`: a note with the findings and the suggested reply. Under `approve`: the approval above. Under `auto-on-low-risk`: a reply sent directly when the `fast` model's risk check passes, plus a note saying it was sent |
| `escalation` | Note plus `help_requests` |
| `error` | Note |

`PylonMarkdownOps` converts markdown to the `body_html` Pylon takes and escapes anything that is not ours.

### 5. Customer replies are a gated action

`pylon_reply_to_customer` is a tool like any other. Its approval policy comes from `customerReplyPolicy`:

| Policy | Behaviour |
|---|---|
| `never` | The tool is not offered to the model. Findings go to notes |
| `approve` | The tool creates an `approvals` row and a draft. Sending waits for a decision by a Pylon teammate (a note "approve") or a Hypotenuse user with `canWriteBot` |
| `auto-on-low-risk` | The `fast` model classifies the draft (refund, legal, security, commitments, or angry customer → high risk). Low risk sends; high risk falls back to `approve`. Every auto-send is audited as the policy's decision, naming the admin who set it |

### 6. Memory boundary

The account (customer company) is the channel. A bot remembers a customer's setup, history, contacts, and preferences across their issues. Issues with no account use a per-installation `unassigned` channel. Promotion of a fact from an account's memory to project memory ([memory](./phase-09-memory.md)) requires that the fact names no customer. The promotion prompt is told this, and a check refuses facts containing the account's name or domains.

### 7. Tools

Scoped to the installation, and for the issue tools, to the conversation's issue:

- `pylon_issue_view` (`GET /issues/{id}`, `GET /issues/{id}/messages`)
- `pylon_account_view`
- `pylon_account_issues` (`POST /issues/search` by account)
- `pylon_contact_view`
- `pylon_issue_update` (tags, custom fields, state, assignee via `PATCH /issues`; approval-gated)
- `pylon_reply_to_customer` (§5)

### 8. The Pylon fake

`backend/__tests__/pylon/fake-pylon.ts` is an in-process server that:

- serves the endpoints above with Pylon's rate-limit headers;
- signs and delivers webhooks with the current scheme (and the legacy one on request);
- records every call;
- validates request bodies against a schema we hold. Each field cites the Pylon doc page it came from, because Pylon publishes no machine-readable spec we could find.

## Schema sketch

No new tables:

- `bot_installations` (`type: "pylon"`):
  - `externalTeamId` = Pylon org id from `/me`
  - `details`:
    - `region`, `selfId`, `selfName`, `installationKey`
    - `listen { teamIds[], tags[] }`
    - `triggers { autoTriage, mention, assignment }`
    - `customerReplyPolicy`
    - sealed `{ apiToken, webhookSecret }`
- `channels`:
  - `type: "pylon"`
  - `externalId` = `account:<id>` or `unassigned:<installationId>`
  - `details { name, domains[] }`
- `conversations`:
  - `externalId` = `issue:<id>`
  - `details { number, link, noteThreadId, lastCustomerMessageId, draftId? }`

## Actions and policy sketch

| Action | Route | RBAC | MCP | Audited |
|---|---|---|---|---|
| `pylon:connect` | `PUT /bot/:botId/pylon` (`secret()` token) | admin | yes | yes |
| `pylon:webhook-register` | `PUT /bot/:botId/pylon/webhook` (`secret()`) | admin | yes | yes |
| `pylon:settings-edit` | `POST /bot/:botId/pylon/settings` (policy, triggers, listen) | admin | yes | yes |
| `pylon:status` | `GET /bot/:botId/pylon` | member + `canReadBot` | yes | no |
| `pylon:disconnect` | `DELETE /bot/:botId/pylon` | admin | yes | yes |
| `webhooks:pylon` | `POST /webhooks/pylon/:installationKey` | none (signed) | **never** | no (machine ingress) |

`apiToken` and `webhookSecret` join `SENSITIVE_KEYS`.

## Frontend and user docs

- Bot page, **Pylon** tab:
  1. Connect a token (with the instructions: create a token *with its own identity*, named after the bot).
  2. Register the webhook.
  3. Customer reply policy, with plain-language consequences.
  4. Triggers and listen filters.
  5. Health.
- `frontend/src/content/docs/pylon.md`: setup, what the team sees in internal notes, approving a reply, why nothing reaches customers by default.

## Steps

### 1. Ops — `backend/ops/PylonOps.ts`, `backend/ops/PylonMarkdownOps.ts`

`PylonOps.request(installation, method, path, body)` is the single caller: region base URL, Bearer auth, typed errors (including `wrong_region_token`), and 429 handling.

### 2. Adapter — `backend/channels/pylon/index.ts`

`capabilities`:

- streaming: no
- plan: as a note
- buttons: no
- drafts: yes

### 3. Event processing — `backend/channels/pylon/events.ts`

### 4. Tools — `backend/tools/pylon/*.ts`

### 5. Actions — `backend/actions/pylon/*.ts`, `backend/actions/webhooks/webhooks-pylon.ts`

### 6. Frontend — `frontend/src/pages/bots/BotPylonTab.tsx`

### 7. CLI — `cli/src/commands/pylon.ts`

### 8. Docs — `docs/PYLON_COVERAGE.md`, `backend/__tests__/docs/pylon-coverage.test.ts`, `frontend/src/content/docs/pylon.md`

### 9. Fake and tests — `backend/__tests__/pylon/*`

## Test plan

- **Signatures:** current and legacy schemes, stale timestamps, the wrong secret, unknown keys. Refusals are byte-identical.
- **Triage end to end:** issue created → ack note → one batched status note → findings note with a suggested reply. **Zero** calls to `/reply` under `never`.
- **Approval:** under `approve`, a draft is created; a teammate's "approve" note sends exactly the draft text; a resend with the same `custom_source.external_id` does not duplicate.
- **Auto-reply:** under `auto-on-low-risk`, a refund request goes to approval, and a "how do I reset my password" question sends.
- **Disengagement:** closed issues and reassignment.
- **Loop filtering:** our own notes never wake the bot.
- **Memory isolation:** account A's memory is never retrieved on account B's issue (assert over the retrieval log). Promotion refuses a fact naming the customer.
- **Rate limits:** 31 notes in a minute are spread out by the outbox, with no 429 left unhandled.
- **Coverage:** every `PC-*` row names its test.

## Verification

```bash
cd backend && bun test __tests__/pylon && bun test __tests__/docs
bun run lint
```

By hand against a Pylon sandbox org:

1. Create a token with its own identity.
2. Register the webhook.
3. Open a test issue from a test account.
4. Read the internal notes.
5. Approve a draft.

## Definition of done

- [ ] A bot connects to Pylon with its own token identity and a verified webhook destination
- [ ] New, assigned, and mentioned issues become conversations; customer messages continue them
- [ ] Status, plan, questions, and findings appear as internal notes in one thread per conversation
- [ ] Customer replies are impossible under `never`, drafted and approval-gated under `approve`, and risk-checked under `auto-on-low-risk`
- [ ] Channel memory is per customer account and never crosses accounts
- [ ] `docs/PYLON_COVERAGE.md`, the Pylon tab, CLI, and `pylon.md` ship in the same PR

## Open questions

- **Webhook event names and payloads.** Public docs show the signature scheme, but the event names (`issue.created` / `issue_created`?) and whether payloads include message bodies sit behind Pylon's authenticated docs. Confirm against a live destination before building §3, and record them in the coverage matrix.
- **Webhook vs Triggers.** Pylon also has rule-based "Triggers" that can call webhooks. Is a plain webhook destination enough to see internal notes and assignment changes, or must admins build a Trigger?
- **Mentioning a token identity.** Can teammates `@mention` a token-with-its-own-identity in an internal note, or do we match the bot's name in plain text?
- **Draft ownership.** `draft-reply` requires `user_id` for "unlinked or service tokens". Does a token with its own identity count as one, and whose drafts list does the draft land in?
- **Customer-facing default.** Is `never` the right default for every customer, or should a project be able to set an org-wide default?

## Learnings from the build

Not built yet.
