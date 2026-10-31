# The webhook platform

The **webhook** platform makes any system a channel: a support tool, an internal chat, a script. It sends people's
messages to the bot as signed JSON, and receives everything the bot shows — status, streamed text, plans, messages,
questions, and approvals — as signed JSON too. [Connect it](/docs/connecting-a-platform) on a bot's page; the
manifest gives you the events URL, and you give Hypotenuse a delivery URL and a signing secret.

## Signing

Both directions are signed the same way, with the secret you connected:

```
Hypotenuse-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + body)>
```

`body` is the raw request body, byte for byte. A signature more than a few minutes old is refused, so a captured
request cannot be replayed later.

## Sending a message to the bot

`POST` the events URL with a JSON body:

| Field | Required | What it is |
|---|---|---|
| `type` | no | `message` (the default), `interaction`, `signal`, or `lifecycle` |
| `messageId` | yes | your id for the message. A message delivered twice is taken once |
| `eventId` | no | your id for this delivery, if a retry should be recognised by something other than `messageId` |
| `channel` | yes | the channel's id, or `{id, name?, private?, shared?, dm?}` |
| `conversation` | yes | your id for the thread. Messages with the same one are one conversation |
| `sender` | yes | `{id, name, isBot?}`. A sender marked `isBot`, or the bot's own user id, is ignored |
| `text` | for a message | what they wrote |
| `mentions` | no | `true` when the message addresses the bot. In a channel bound to listen when mentioned, only these start a conversation |
| `edited`, `deleted` | no | an edit or a deletion is recorded and ignored |

```json
{
  "messageId": "m-1042",
  "channel": { "id": "support", "name": "support" },
  "conversation": "thread-77",
  "sender": { "id": "u-9", "name": "Grace" },
  "text": "Can you check the Globex refund?",
  "mentions": true
}
```

The answer is `200` as soon as the delivery is recorded; the bot works afterwards. Every delivery is in the project's
**Events** log, with what became of it.

The other types:

| `type` | Extra fields | What it does |
|---|---|---|
| `interaction` | `interaction: {kind, targetId, value}` | `kind: "answer"` answers the question whose `questionEntryId` is `targetId`, with `value` as the answer. `kind: "approval"` decides the approval whose `approvalId` is `targetId`, with `value` `approve` or `deny` — if the channel's binding lets that sender decide |
| `signal` | `signal: "stop"` or `"disengage"` | cancels the conversation, or ends it |
| `lifecycle` | `lifecycle: "uninstall"` or `"channel_archived"` | marks the installation uninstalled, or the channel archived |

## A refused request

A request to an unknown URL, to an installation that is not connected, or with a missing, wrong, or stale signature
is answered with the same `404` and the same body, byte for byte:

```json
{"error":"not found"}
```

So a request that fails tells nobody whether the URL exists. If your deliveries are refused, check the secret and
your clock before the URL.

## What the bot sends you

Everything the bot shows is a `POST` to your delivery URL, signed as above, with `Hypotenuse-Delivery: <id>` — the
same id on a retry, so you can drop a repeat. The body is `{deliveryId, kind, channel, conversation, ...}`:

| `kind` | Extra fields | What it is |
|---|---|---|
| `status` | `text` | what the bot is doing now: *Thinking…*, *Waiting for approval to run mail/send_email*. Show it until the next one |
| `stream` | `text` | the reply so far, while the model writes it. Each one replaces the last; the `message` that follows replaces them all |
| `plan` | `steps: [{seq, tool, state}]` | the tools of the turn under way, each `running`, `done`, or `error` |
| `message` | `kind` (`reply_and_wait`, `complete`, `fail`), `text` | what the bot says |
| `question` | `text`, `options?`, `questionEntryId` | a question. Offer the options as buttons, and send the choice back as an `answer` interaction with `targetId` set to `questionEntryId` — or let the next message in the thread be the answer. Nothing else is sent in the conversation until it is answered |
| `approval` | `approvalId`, `name`, `server`, `tool`, `args`, `inChannel`, `actions` | a tool call waiting for approval. When `inChannel` is true, offer `actions` (`approve`, `deny`) and send the choice back as an `approval` interaction with `targetId` set to `approvalId`. When false, it is decided in the dashboard |

Answer `2xx` once you have it. You may answer `{"messageId": "…"}` to tell Hypotenuse your id for what you posted.

| You answer | Hypotenuse |
|---|---|
| `2xx` | marks it sent |
| `408`, `429` (honouring `Retry-After`), `5xx`, or nothing | tries again later, with the same `Hypotenuse-Delivery` |
| any other `4xx` | gives up on that delivery |

Deliveries for one conversation arrive in order.
