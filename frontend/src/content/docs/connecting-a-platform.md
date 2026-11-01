# Connecting a platform

Each bot has **its own app** on each platform, with its own name and avatar there, so people see which bot they are
talking to. Connecting one takes a few minutes on the bot's page, under **Channels → Platforms**, and needs the
bot's write access. Today you can connect [Slack](/docs/slack), [Linear](/docs/linear), and [Pylon](/docs/pylon) — each with its own
steps, on its own page — and the [webhook platform](/docs/webhook-platform): any system that can send and receive
signed JSON. The steps below are the webhook platform's.

## 1. Get the manifest

**Get manifest** makes the bot a pending installation and shows, once:

- **the events URL** — where the platform sends people's messages to this bot. It contains a secret routing key, so
  copy it now with the copy button: it is never shown again. Asking for a new manifest makes a new URL and stops
  the old one;
- **what to do with it**, for that platform;
- **the manifest** — the app's definition: its name, the URL, and what the platform must send.

## 2. Create the app on the platform

Use the manifest to create the bot's app on the platform, pointing it at the events URL. For the webhook platform,
that means configuring your system to POST to the events URL and to receive the bot's messages at a URL of yours.

## 3. Connect it

The connect form takes what the platform gave you:

| Field | What it is |
|---|---|
| **Delivery URL** | where the bot's messages are POSTed (webhook platform) |
| **Signing secret** | the shared secret both sides sign with, at least 16 characters. It is stored encrypted and never shown again — not to you, not to the bot, not in any answer |
| **Bot user id** (optional) | the sender id the platform gives the bot's own messages, so the bot never answers itself |

**Connect** makes the installation *Connected*. **Test** asks the platform to answer and says what went wrong if it
did not. An installation whose deliveries keep failing reads *Not delivering*, with the platform's last error.

## 4. Bind channels

The bot now hears from every channel the platform sends it, and binds itself in public ones (see
[Channels](/docs/channels#binding-a-channel)). Bind private channels and direct messages on the bot's page.

## Disconnecting

**Disconnect** uninstalls the app at once: the bot stops hearing from and posting to that platform. Its channels,
conversations, and memory stay. Connecting again needs a new manifest. A bot with an app cannot change its slug,
because the app's definition contains it — disconnect first.

Every step — getting a manifest, connecting, disconnecting — is in the [audit log](/docs/audit), with the secret
left out.
