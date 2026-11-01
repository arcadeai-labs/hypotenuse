# Slack

In Slack, each bot is **its own Slack app**: its own `@name`, avatar, and place in each channel. People mention it in
a channel, reply in its thread, or message it directly, and watch it work in that thread — a status line while it
thinks, its answer streamed as it writes, a plan of the tools it is running, buttons for its questions and approval
requests, and the answer. It remembers each channel it works in.

Connecting a bot takes a few minutes on its page, under **Channels → Platforms → Slack**, and needs the bot's write
access. You also need to be allowed to create and install apps in your Slack workspace.

## 1. Create the app

There are two ways; both end with the same app.

- **With a configuration token** (quickest). In Slack, open [api.slack.com/apps](https://api.slack.com/apps), and
  under **Your App Configuration Tokens** choose **Generate Token** for your workspace. Paste the access token
  (`xoxe.xoxp-…`) into **Create the app**. Hypotenuse creates the bot's app from its manifest and keeps the app's
  credentials, encrypted. The configuration token is used for that one call and never stored; Slack expires it
  after twelve hours anyway.
- **By hand.** **Get manifest** shows the app's manifest, once — it contains the bot's private events URL — and a
  link to Slack's new-app form with the manifest filled in. Open the link and pick the workspace (or, in Slack,
  choose **Create New App → From a manifest** and paste it). Then copy the app's **Client ID**,
  **Client Secret**, and **Signing Secret** (under **Basic Information**) into the connect form, and **Connect**.

The manifest asks for only what the bot needs: to see mentions and messages in the threads it is part of and in its
direct messages, to post and edit its own messages, to set its status, and to look up people's names.

## 2. Install it

**Install to Slack** takes you to Slack's install page for the bot's app. Approve it and you come back to the bot's
page, which says where it is installed. If you installed the app from Slack's own settings instead, paste its
**Bot User OAuth Token** (`xoxb-…`) into the connect form's **Bot token** field: Hypotenuse checks it and the app is
installed.

**Test** asks Slack whether the bot's token still works.

![A bot's Slack block on its Channels section: its app created and connected, waiting to be installed, with the configuration-token and manual paths beside it](illustration:bot-slack)

## 3. Invite it to channels

In a channel, type `/invite @` and the bot's name. A bot whose **auto-bind** covers public channels (the default)
starts listening there at once; private channels and direct messages are bound on the bot's page, or by turning on
auto-bind for them (see [Channels](/docs/channels#binding-a-channel)). Removing the bot from a channel unbinds it and
ends its conversations there.

## What people see

- **Mention the bot** in a bound channel and it answers in a thread under your message. Anyone in the thread can
  reply there without mentioning it again; a message elsewhere in the channel that does not mention it is ignored.
- **Message it directly** (once direct messages are bound) and each new message starts its own thread.
- While it works, Slack shows its **status** ("Thinking…", "Searching memory…") under the thread, its answer
  **streams** in as it writes, and a **plan** message lists the tools it is running, ticking each off.
- A **question** comes with a button for each choice (a menu past five); press one, or just reply in the thread.
- An **approval request** names the tool and its arguments, with **Approve** and **Deny** — if the channel's
  approval policy lets people in the channel decide. Otherwise it links to the request in Hypotenuse. A button
  pressed after the request was decided changes nothing.
- The bot never pings `@channel` or `@here`, and never mentions itself. An answer longer than Slack allows is cut
  short with a link to the whole conversation in Hypotenuse.

## Stopping the bot

Cancel the conversation from its page in Hypotenuse (see [Stopping a bot](/docs/conversations#stopping-a-bot)), or
press **Stop** where Slack's AI surface offers it in the bot's thread.
Removing the bot from the channel stops all of its conversations there; uninstalling the app (or revoking its token)
stops everything, and its events URL stops working until **Install to Slack** installs it again.

## What is refused

- **Slack Connect channels** — shared with another organization — are refused, unless a person binds the channel and
  allows shared channels on its binding: the other organization's people could then talk to the bot.
- **Other bots.** The bot never answers a message from a bot, its own included, so two bots in a channel cannot talk
  each other into a loop.
- **Edits.** Editing or deleting a message the bot already read does not change what it read.

## Troubleshooting

| Symptom | What to do |
|---|---|
| The bot does not answer a mention | Is the channel bound and enabled on the bot's page? The project's **Events** page shows every delivery from Slack and why it was ignored (`unbound`, `not-addressed`, `shared-channel`, `rate-limited`) |
| Slack says "Your URL didn't respond" | The events URL was replaced by a newer manifest, or the app was disconnected. Create the app again |
| Slack disabled the app's events | Slack turns off event delivery after many failed deliveries. Fix the cause, then turn **Event Subscriptions** back on in the app's settings |
| **Test** fails with `invalid_auth` or `token_revoked` | The app was uninstalled or its token revoked. Install it again |
| The install page says the redirect URL is not allowed | The app was created from an older manifest. Create it again from a fresh one |

Every step — creating, connecting, installing, disconnecting — is in the [audit log](/docs/audit), with the secrets
left out. From the command line, the same steps are `hypotenuse slack create|connect|install` (see
[the CLI](/docs/cli#platforms-and-channels-from-the-command-line)).
