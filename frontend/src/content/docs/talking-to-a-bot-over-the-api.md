# Talking to a bot over the API

The HTTP API is a channel like any other: a program, a script, or you with `curl` can start a conversation with a bot,
send it messages, and read its answers. Anyone who may [read a bot](/docs/bots#who-may-read-and-change-it) may talk to
it this way. Every request is authenticated as a person — a dashboard session, a [CLI](/docs/cli) token
(`Authorization: Bearer hyp_cli_…`), or an MCP client's OAuth token; these same actions are MCP tools and
`hypotenuse conversation` commands.

A bot answers in the background. You either **poll** the transcript, or give a **callback URL** and have each of its
messages posted to you, signed.

## Start a conversation

```http
PUT /api/project/:projectId/bot/:botId/conversation
{ "text": "Summarize yesterday's incidents.", "requestId": "incident-digest-2026-10-29" }
```

| Field | |
|---|---|
| `text` | your first message, in markdown |
| `requestId` | your own id for this request. Send the same one again and you get the conversation the first request made, so a retry never starts two |
| `channelKey` | which of the bot's API channels to use (`default` if omitted). A channel is the boundary of what the bot will remember |
| `callbackUrl` | a public `https` URL to post the bot's messages to (see below) |
| `title` | a title for lists |

The answer is the conversation, already `working`. `PUT /api/project/:projectId/conversation/:id/message` sends
another message (`text`, optional `requestId`, and `delivery`: `steer`, the default, reaches the bot before its next
step even mid-turn; `queue` waits for its current turn to end). `POST …/conversation/:id/cancel` stops it.

## Poll for the answer

```http
GET /api/project/:projectId/conversation/:id/entries?since=0
```

Entries come oldest first, each with a `seq`. Keep the last `seq` you saw and pass it as `since` next time. The answer
also carries the conversation, so you know to stop polling when its `state` is no longer `working`. What the bot said
to you is the input of its `reply_and_wait`, `ask_question`, `complete`, or `fail` call — a `tool_call_intent` entry
with that `toolName`.

## Get called back instead

With a `callbackUrl`, every message the bot posts — a reply, a question, a final summary, a failure, or an error that
ended its turn — is `POST`ed to that URL as JSON:

```json
{ "conversationId": 42, "entrySeq": 9, "kind": "reply", "text": "Two incidents…" }
```

`kind` is `reply`, `question` (with `options` when it offered choices), `complete`, `fail`, or `error`. Answer with any
`2xx`. A timeout, a `408`, a `429`, or a `5xx` is retried with growing back-off for up to a day; any other `4xx` gives
up. A retry carries the same `Hypotenuse-Delivery` header, so drop one you have already handled.

Callbacks are signed with the bot's **callback secret**. Someone who may change the bot creates it — **Callback
secret** in the bot's **Callback** section, `hypotenuse bot callback-secret <bot>`, or `POST /api/project/:projectId/bot/:botId/callback-secret`
— and it is shown **once**; creating a new one retires the old at once. A conversation cannot have a callback until the
bot has a secret. The callback URL must be public: private and loopback addresses are refused.

### Verify the signature

Each callback carries `Hypotenuse-Signature: t=<unix seconds>,v1=<hex>`, where the hex is the HMAC-SHA256, keyed with
the secret, of the timestamp, a dot, and the **raw** body. Check it before trusting anything in the body:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

/** Whether a Hypotenuse callback is genuine and less than five minutes old. */
export function verifyHypotenuse(secret: string, header: string, rawBody: string): boolean {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=", 2)));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - t) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v1);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

Verify the body exactly as it arrived — parsing and re-serializing the JSON first changes the bytes and the signature
will not match.
