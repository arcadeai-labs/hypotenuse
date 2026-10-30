# Audit log

Hypotenuse keeps a record of every decision a person makes in a project: who made it, what they did, what it was
done to, and what it looked like before and after. The record is written in the same database transaction as the
change, so the log can never say something happened that did not, or miss something that did.

## Where to read it

| Log | Where | Who can read it |
|---|---|---|
| A project's | the project switcher → **Audit log**, or **Open audit log** in the command palette (`⌘K`) | the project's admins, and its organization's owners |
| An organization's | **Organization → Audit log**, or **Open organization audit log** in the command palette | the organization's owners |

An organization's log holds its own changes — renaming it, changing who owns it, its invitations — and every row of
every project in it, including projects that have since been deleted. Filter it by project to read one, or choose
**Organization only** for the organization's own changes — its owners, invites, and settings — with no project's.

![An organization's audit log, with its filters](illustration:audit)

Both logs read newest first, and filter by date, by action, and by who made the change. **Details** on a row shows
the state before and after, and what was asked for.

## Who made a change

| Shown as | Who |
|---|---|
| A person's name | someone signed in to Hypotenuse, in the dashboard, the CLI, or their own MCP client |
| Platform participant | someone on Slack, Linear, or Pylon who answered a bot there — approving a tool call, for instance. They may have no Hypotenuse account: who may talk to a bot is decided by the platform |
| System | something Hypotenuse did for a person rather than because of a choice: the organization and Default project that signing up creates |

A change an organization owner makes in a project they never joined is marked as made with **organization-owner
standing** in its details, so the log always says why they could.

## What is recorded

Every change a person decides on: organizations, projects, members and their roles, tags and who holds them,
invitations sent, accepted, and declined, and — as they arrive — bots, their settings, where they are bound, the
tools they may use, and the approvals people give them.

Passwords, tokens, keys, signing secrets, and request headers are never recorded. They are removed from what was
asked for before it is written, at any depth, and the before and after snapshots have nowhere to hold one.

## What is not recorded, and why

Some writes are deliberately left out, because something else records them better or because nobody decided them:

| Not in the audit log | Why | Where it is recorded instead |
|---|---|---|
| Reading anything | nothing changed | — |
| Signing in and out | sign-in churn is not a change to a project | the server's logs |
| Marking a notification read | a reading habit, not a project change | the notification itself |
| Clocks and sweeps: delivering notifications, expiring invitations, deleting old audit rows | the clock acting, not a person | the rows they change |
| Platform deliveries: Slack, Linear, and Pylon webhooks | anyone on the internet can send one, so they may never write to this log | the platform event's own record |
| A bot's own work: each step it takes and each tool it runs | hundreds per conversation | the conversation's transcript |
| Sending a bot's replies to a platform | the machine half of a reply | the outbox |
| A sandbox's progress reports | volume, with a better record | the sandbox job's events |
| Cost records | an accounting ledger, not a decision | the cost records |

What these trace back to *is* in the log: creating the bot, binding it to a channel, granting it a tool, approving its
call.

## How long it is kept

A year. Rows older than that are deleted once a day. An operator sets the window with `AUDIT_RETENTION_DAYS`.

Rows are never edited. Deleting an organization, a project, or a person does not delete the record of it.
