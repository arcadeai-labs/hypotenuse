# The dashboard

A bot answers people in Slack threads, Linear agent sessions, Pylon issues, and the dashboard's own chat, often many
at once. None of those places shows you all of it. The dashboard does: **Home** shows what every bot is doing right
now, **Inbox** collects everything waiting on a person, and every conversation opens to a live transcript you can
step into.

Everything here updates as it happens, without reloading. The page re-reads when something changes, through the same
checks as the first read, so you only ever see what you are allowed to see.

## Home

**Home** in the sidebar (or <kbd>g</kbd> <kbd>h</kbd>) is mission control for the project you have selected.

![Home: the project's numbers, a card per bot, what needs a person, and what changed recently](illustration:dashboard-home)

- **The top row** counts the project's conversations that are working, waiting, and hibernating, how many things
  need a person, and the model spend recorded today. Today starts at midnight UTC, so everyone sees the same day.
  When a spend ends in **+**, some of the day's model calls were on a model with no price, so the true number is
  higher.
- **A card per bot** shows its conversations by state, with waiting ones split by what they wait on: an answer, an
  approval, the team, a sandbox job, or a timer. Click a kind to see those conversations. The card also shows how
  many ended today, what needs a person, and its spend.
- **Needs a person** lists the newest items in the [inbox](#the-inbox).
- **Recently changed** lists the conversations that moved last. Each row shows its state with a short line saying
  what that means right now:

| State | The line under it |
|---|---|
| Working | which turn it is on |
| Waiting for an answer | when it asked |
| Waiting for approval | how many approvals it needs |
| Waiting for the team | when it asked the team |
| Waiting on a sandbox | which [sandbox job](/docs/sandboxes) |
| Waiting on a timer | when it wakes |
| Hibernating | when the last message was |
| Ended | how it ended; a failed one can be [retried](#stepping-in) |

## The inbox

**Inbox** (<kbd>g</kbd> <kbd>n</kbd>) lists everything in the project that is waiting on a person, newest first:

- **Approvals**: a bot wants to call a tool its allowlist does not cover ([approvals](/docs/approvals)).
- **Help requests**: a bot asked the team a question it could not answer itself ([escalation](/docs/escalation)).
- **Sandbox questions**: a coding agent in a [sandbox](/docs/sandboxes) asked its conversation something.

![The inbox: approvals, help requests, and sandbox questions, each with its bot](illustration:inbox)

Click an item to open the page where you answer it. Answering there does exactly what answering on the platform does.
An approval decided here updates the Slack message, so its buttons read *Answered by* you, and the record says you
decided it. If you may read an item but not answer it, the row says so.

## Conversations

**Conversations** lists every conversation you can see. Filter it by state, by what a waiting conversation waits on,
and by platform. A conversation on Slack, Linear, or Pylon has a link beside it that opens the thread, agent session,
or issue on that platform. See [conversations](/docs/conversations) for what each state means.

Open a conversation to see its transcript, live: messages, the bot's reasoning, each tool call and what it returned,
programs and their calls, memory it read and wrote, sandbox jobs, approvals and how they were decided, and where the
conversation was summarised to save space. A long transcript opens at its newest entries. Use **Show earlier entries**
to page back. Entries from before a summary are never deleted, so you can still read them.

**Sent to the platform**, under the transcript, lists everything the conversation sent out: each message, status
update, plan, question, and approval card, with its delivery status. **Queued**, **Sending**, and **Sent** are normal.
**Replaced** means a newer status took its place before it went out. **Retrying** and **Undeliverable** mean it did
not arrive. Hover one to see why.

## Stepping in

From a conversation's page you can:

- **Cancel** it. This does the same thing as stopping the bot on its platform. Anyone who may read the bot may cancel.
- **Answer** a question it asked, or an approval it is waiting on, right there.
- **Retry** a conversation whose turn failed. The bot starts a new turn and is told a person asked it to try again,
  so it reads why it failed before it repeats itself. Nothing that already ran is run again. Retrying spends a turn on
  the bot's model, so it takes [write access to the bot](/docs/bots#who-may-read-and-change-it).

Each of these is recorded in the [audit log](/docs/audit) as your decision.

## Correcting what a bot remembers

The [memory explorer](/docs/memory) is where you browse, search, edit, forget, and promote what bots remember. Every
search result shows how much it has faded, so you can see why an old fact ranked low.

## A bot's activity

A bot's page opens with **Activity**: its conversations by state, what needs a person, how many channel memories it
has where it works, and today's spend. Each number links to the list behind it.

## Who sees what

Everything on these pages follows the bot's [read access](/docs/bots#who-may-read-and-change-it). If you cannot read a
bot, its conversations, inbox items, memory, and activity are left out of every list, count, and search result, and
the page gets no live updates about it. Stepping in follows the same rules as the action itself: answering an
approval takes the bot's write access or its approver tag, answering a help request takes write access or its help
tag, and answering a sandbox question takes write access.

## Jumping around

Press <kbd>⌘</kbd> <kbd>K</kbd> (<kbd>Ctrl</kbd> <kbd>K</kbd> elsewhere) and type a name to jump to any bot, recent
conversation, or channel you can see.

## From the CLI

```bash
hypotenuse project overview                 # what every bot is doing now
hypotenuse inbox list --kind approval       # what waits on a person
hypotenuse conversation list --waiting help --platform slack
hypotenuse conversation outbox 42           # what conversation 42 sent, and whether it arrived
hypotenuse conversation retry 42            # retry a failed turn
```
