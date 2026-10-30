# Conversations

A conversation is one thread of work between a bot and the people talking to it — today, a conversation started over
the [HTTP API](/docs/talking-to-a-bot-over-the-api); later, a Slack thread, a Linear agent session, or a Pylon issue.
Everything in it is kept: every message, everything the bot thought it should do, every tool it called and what came
back. A bot holds nothing in memory between steps, so a conversation survives deploys and restarts mid-thought.

Anyone who may [read a bot](/docs/bots#who-may-read-and-change-it) may see its conversations, write in them, and
cancel them. **Conversations** in the sidebar lists the project's, newest activity first, and a bot's page lists its
own; opening one shows its transcript, live.

![Conversations: each with its state, bot, channel, and last activity](illustration:conversations)

## What a conversation is doing

Every conversation is in one of four states.

| State | What it means for you |
|---|---|
| **Working** | The bot is on it. Write again and it reads your message before its next step, without stopping what it is doing. |
| **Resting** (`hibernating`) | The bot answered and is waiting for anyone to say something. Writing wakes it. |
| **Waiting** | The bot paused on purpose: for the answer to a question it asked, until a time it chose, or for a person to [approve](/docs/approvals) a tool call. Your next message is the answer to its question; while it sleeps on a timer or waits for an approval, messages are kept and read when it wakes. |
| **Ended** | Closed, with an outcome: **completed** (it said the work was done), **failed** (it could not, and said why), or **cancelled** (someone stopped it). Writing again starts a new turn in the same conversation. |

A **turn** is everything the bot does between your message and its answer. A bot always ends a turn deliberately —
by replying, asking, pausing, completing, or failing. If it stops without doing one of those, it is reminded once;
if it does it again, the turn fails with that reason rather than leaving you waiting on silence. A turn also fails
when it takes more model steps than the bot allows (50 unless changed on the bot), and a bot whose monthly budget is
spent takes no more steps that month.

## Reading a transcript

![A conversation's transcript: messages, a collapsed tool call, state changes, and its properties](illustration:conversation)

| You see | It is |
|---|---|
| A message from you or a teammate | what was said, in order |
| A message from the bot | text it wrote along the way; what it *posts* is in its reply, question, or summary |
| A tool call, collapsed | what the bot asked a tool to do, and what came back. Open it to see both |
| **Interrupted** on a tool call | the process running the call stopped before it finished. The bot is told, and checks before trying again |
| A thin line saying the state changed | the bot woke, rested, paused, ended, or was reminded to finish its turn |
| A divider reading *summary* | the conversation grew long, so its earlier part was summarized for the bot. Nothing above it is deleted, and the bot can still search it |

## Stopping a bot

**Cancel** ends a conversation at once. A bot in the middle of a step stops within about a second; a call it was
running is marked interrupted. Cancelling an ended conversation does nothing, and writing to a cancelled one starts a
new turn.
