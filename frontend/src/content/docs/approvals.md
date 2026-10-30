# Approvals

A bot that many people can talk to should not post to the wrong channel, email a customer, or merge a pull request
just because someone asked it to. So by default **every tool call a bot makes on an [MCP server](/docs/mcp-servers)
waits for a person to approve it**, until the bot's settings allow that tool outright.

![The approvals inbox: each call a bot is waiting on, with who asked and where](illustration:approvals)

## What waits

When a bot calls a tool, Hypotenuse decides before anything is sent:

| The bot's settings for that server | The tool | What happens |
|---|---|---|
| a pattern allows it | any | it runs |
| **Run read-only tools without asking** is on | the server marks it read-only | it runs |
| neither | any | it waits for approval |

The conversation pauses — the bot shows **Waiting for approval** — and the people who may decide are notified. Other
calls the bot made in the same step that did not need approval have already run.

## Deciding

**Approvals** in the sidebar lists the calls waiting on someone; the notification bell links to each. An approval
shows the bot, the tool, the exact arguments it wants to send (with anything that looks like a secret removed), the
conversation it came from, and who was talking to the bot.

| Choice | What happens |
|---|---|
| **Approve** | that exact call — that tool, those arguments — runs once, and the bot carries on with its result |
| **Deny** | nothing is sent; the bot is told who denied it and not to try again. A note you add is passed on |
| **Always allow** | approves this call, and adds the tool to the bot's allowlist so later calls run without asking |

An approval names one call. It cannot be reused for another call or for other arguments, and once it has run it is
spent. If a server goes down mid-call, the bot is told the call may or may not have happened — it is never sent
twice on its own.

A call nobody decides **expires** after a day (each bot can change this) and counts as denied. Cancelling the
conversation expires its waiting approvals too.

## Who decides

Anyone who may **change** the bot may decide its approvals. A bot may also name an **approver tag**: people with
that tag may decide its approvals too, and they are the ones notified. With no approver tag, the project's admins
are notified. Everyone who may read the bot can see its approvals.

Every decision is recorded in the [audit log](/docs/audit), including an **Always allow**'s change to the bot's
allowlist. You can also decide from the [command line](/docs/cli) with `hypotenuse approval`.
