# Linear

In Linear, each bot is **its own Linear app**: its own name and avatar, its own place in the assignee menu, and its
own `@mention`. Delegate an issue to it, or mention it in a comment, and Linear opens an **agent session** on the
issue: the bot acknowledges within seconds, then thinks, plans, works, and answers inside that session. It
remembers each Linear project it works in.

Connecting a bot takes a few minutes on its page, under **Channels → Platforms → Linear**, and needs the bot's write
access. A **Linear workspace admin** creates and installs the app.

## 1. Create the app

Linear has no way for another service to create an app, so an admin creates it from a link Hypotenuse fills in.

1. **Get the creation link** shows a link to Linear's new-application form, filled in with the bot's name, its
   webhook, and where Linear sends people back after an install. The webhook URL in it is private to the bot and
   shown once; asking for a new link makes a new URL and stops the old one.
2. Open the link as a Linear workspace admin and create the app. On the app's page, also turn on the **OAuthApp**
   webhook, so that uninstalling the app in Linear reaches Hypotenuse.
3. Copy the app's **Client ID**, **Client Secret**, and **webhook signing secret** into the connect form, and
   **Connect**. The secrets are stored encrypted and never shown again.

Linear only sends webhooks to a public HTTPS address. If yours is not, the link's instructions say so.

## 2. Install it

**Install to Linear** takes you to Linear's install page for the bot's app. Approve it as a workspace admin and you
come back to the bot's page, which says which workspace the bot is installed in and under what name. The app asks to
read and write issues and comments, and to be **assignable** (so issues can be delegated to it) and **mentionable**.

**Test** asks Linear whether the app's token still works. Hypotenuse renews the token by itself before it expires.

![A bot's Linear block on its Channels section: its app created in Linear and connected, waiting to be installed](illustration:bot-linear)

## Delegating and mentioning

- **Delegate an issue** to the bot — in the issue's assignee menu, under agents — and Linear opens a session. The
  person stays the assignee; the bot is the delegate. If the issue is not started yet, the bot moves it to the
  team's first *started* state. It never changes the assignee.
- **Mention the bot** in a comment, and Linear opens a session for that comment.
- **Write in the session** to add to what you asked, answer a question, or choose an option.

## What the session shows

- **A thought** within seconds, so Linear knows the bot heard you; then a short-lived thought for what it is doing
  ("Searching memory…").
- **The plan**: the session's checklist lists the tools it runs, ticking each off, with an **action** for each one
  that finished.
- **A question** asks you for input; its choices are options you pick. Nothing more appears until you answer.
- **An approval request** names the tool and its arguments and links to the request in Hypotenuse. If the channel's
  approval policy lets people in the channel decide (see [Channels](/docs/channels#binding-a-channel)), it offers
  **Approve #…** and **Deny #…**: choosing one decides it, recorded in the audit log as you.
- **The answer** ends the session's turn, or an **error** when the bot could not do it. Write in the session again to
  continue.
- The bot never writes its own `@name`, so it never mentions itself into a second session.

The bot can also read the issue it is working on, and comment on it — each comment waits for a person to approve it.

## Memory follows the Linear project

Each **Linear project** is a channel, with its own memory: what the bot learns on one issue of a project, it can use
on the project's other issues — and so can any other bot working in that Linear project — and not elsewhere. An issue with no project uses its **team's** channel. A session
keeps the channel it started in, even if its issue moves to another project; the next session on the issue uses the
new project.

## Stopping the bot

- **Stop** in the session ends what the bot is doing at once; it answers once to say it stopped, quoting what you
  wrote with the stop without acting on it.
- **Un-delegating** the issue, **completing** or **canceling** it, **deleting** it, or **unassigning** the bot stops
  its sessions on the issue silently. Write in a session again to bring it back.
- Removing the app's access to a team stops its sessions there; uninstalling the app stops everything.

From Hypotenuse, cancel the conversation from its page (see [Stopping a bot](/docs/conversations#stopping-a-bot)).

## Troubleshooting

| Symptom | What to do |
|---|---|
| Delegating does nothing | Is the app installed (the block says where)? The project's **Events** page shows every delivery from Linear and what it decided |
| The session says the agent did not respond | The bot's acknowledgement did not reach Linear in time. Check the block for an error, and **Test** |
| **Test** fails, or the block says to install the app again | Linear refused the app's token: it was uninstalled or its access revoked. Install it again |
| Linear refuses the webhook URL when creating the app | The deployment's address is not public HTTPS. Fix `APPLICATION_URL`, then get a new creation link |
| A delivery is recorded `unknown-installation` | It came from a workspace this bot's app is not installed in. Each workspace needs its own install |

Every step — connecting, installing, disconnecting, and every approval decided in a session — is in the
[audit log](/docs/audit), with the secrets left out. From the command line, the same steps are
`hypotenuse linear link|connect|install` (see [the CLI](/docs/cli#platforms-and-channels-from-the-command-line)).
