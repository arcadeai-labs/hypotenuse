# Channels

A bot answers where your team already works. Three things decide where that is:

| Thing | What it is |
|---|---|
| **An installation** | the bot's own app on a platform — its events URL, its credentials, its delivery address. One per bot per platform workspace. See [Connecting a platform](/docs/connecting-a-platform) |
| **A channel** | one place on that platform — a channel, a team, a customer account. It is also where the bot's [memory](/docs/memory) of that place is kept |
| **A binding** | the bot listening in a channel, with settings of its own |

A bot hears from every channel its installation is in, but **answers only where it is bound**. Everything a
platform delivers is recorded, answered or not, under **Events** — see [below](#what-happened-to-a-message).

## The Channels section

![A bot's Channels section: its webhook app, two bound channels, and a private channel waiting to be bound](illustration:bot-channels)

A bot's page has a **Channels** section, which anyone who may [change the bot](/docs/bots#who-may-read-and-change-it)
can edit:

- **Platforms** — each platform the bot can be installed on, with its status (*Not connected*, *Waiting to be
  connected*, *Connected*, *Not delivering*), **Get manifest**, the connect form, **Test**, and **Disconnect**.
- **Bound channels** — each channel the bot listens in, with its settings.
- **Heard from, not bound** — channels that messaged the bot while it was not bound there, each with **Bind**.

## A binding's settings

| Setting | Choices | What it decides |
|---|---|---|
| **Listens to** | when mentioned (the default), every message, direct messages | which messages start or join a conversation. A reply in a thread the bot is already in always reaches it |
| **A message while it works arrives** | before its next step (the default), after its turn | whether a message reaches a working bot mid-turn, or waits until it has answered |
| **Approvals decided** | only in the dashboard (the default), anyone in the channel, only listed people | who may approve or deny the bot's [tool calls](/docs/approvals) from inside the channel. See [Who decides in a channel](/docs/tags#who-decides-in-a-channel) |
| **Its facts may be promoted to project memory** | off by default | whether a person may [promote](/docs/memory) what the bot learned here to the whole project |
| **Listening** | on by default | turn it off to pause the bot in this channel without losing the binding |

**Unbind** stops the bot listening there. The channel's conversations and memory stay, and binding it again picks
them up. Every change to a binding is in the [audit log](/docs/audit).

## Binding a channel

A bot binds itself when it is first messaged in a channel, according to the **Listening** section of its page:

| Kind of channel | Binds itself by default |
|---|---|
| public | yes |
| private | no — a person binds it |
| direct messages | no — a person binds it |

A channel the bot did not bind itself in shows under **Heard from, not bound**, and **Bind** binds it.

- **A private channel** asks first, in so many words: *Everyone who can read this bot in Hypotenuse will be able to
  read this channel's conversations and memory.* Binding it is your decision, recorded in the audit log, because it
  shows that channel to everyone who may read the bot here — people who may not be in the channel itself.
- **A channel shared with another organization** asks too: its people could then talk to the bot. Until someone
  allows it, the bot ignores messages there.

## How much a bot takes

The **Listening** section also sets two limits:

| Limit | Default | Past it |
|---|---|---|
| **One person, a minute** | 20 messages | that person's messages are ignored until the minute ends |
| **One channel, a minute** | 60 messages | everyone's messages in the channel are ignored until the minute ends |

## What happened to a message

**Events** in the sidebar (`g e`) is the project's log of every delivery a platform sent: when it arrived, from which
platform, and what became of it. It is an admin's page, because it carries what people wrote in every channel.

| Status | Outcome, for example | Meaning |
|---|---|---|
| Processed | `message` | it became a message in a conversation |
| Processed | `interaction` | a button press answered a question or decided an approval |
| Ignored | `unbound` | the channel is not bound — bind it on the bot's page |
| Ignored | `not-addressed` | the binding listens when mentioned, and nobody mentioned the bot |
| Ignored | `loop` | the bot's own message, or another bot's |
| Ignored | `rate-limited` | over one of the limits above |
| Failed | — | something went wrong processing it; the detail says what |

Filter by status, or type the start of an outcome. A delivery that arrives twice is recorded once.
