# Chat

The dashboard has a chat of its own, so the person configuring a bot can talk to it the way a teammate on a platform
would — and check that a prompt edit, a memory, an MCP server, or a skill does what they meant. It is a real
platform, called **Dashboard** wherever a platform is named: the bot streams its reply, shows what it is doing, asks
its questions with buttons, and waits for approvals in cards you decide in place.

![A dashboard chat: a reply, a question answered by button, and a tool call waiting for approval in its card](illustration:chat)

## Starting a chat

- **Chat** on a bot's page, or beside its row on the Bots page, opens that bot's chat.
- **Chat** in the sidebar (`g t`) lists the bots you may read; pick one.
- The command palette (`⌘K`) has **Chat with …** for each of them.

A bot's chat opens the newest chat **you** started with it, or an empty box if you have none. Your first message
starts the conversation. **New chat** starts another one; **Transcript** opens the same conversation as its
[transcript](/docs/conversations#reading-a-transcript).

Anyone who may [read a bot](/docs/bots#who-may-read-and-change-it) may chat with it. A chat is a conversation like
any other: it is listed under **Conversations**, and everyone who may read the bot may read it.

## Fresh channels and memory

A chat lives in a channel, and a channel is where a bot's [memory](/docs/memory) is kept.

| You start | It lives in | What the bot remembers there |
|---|---|---|
| **New chat** | the bot's shared **dashboard** channel | everything it learned in earlier dashboard chats, plus the project's memory |
| **New chat in a fresh channel** | a new scratch channel of its own | only the project's memory: the channel's memory starts empty |

A fresh channel is how you check what a bot does **without** what it has picked up in conversation — a new prompt,
say, tried on a clean slate. What it learns there stays there. Project memory is shared by every channel, so a
fresh channel still has it.

## While it works

While the bot is working, the chat shows, live:

- **the status line** under the last message — *Thinking…*, *Waiting for approval to run mail/send_email* — saying
  what it is doing right now;
- **its reply as it writes it**, in a bubble with a dashed edge, which becomes its message when the step finishes. If
  a step is retried, what the interrupted one had written disappears;
- **its plan**: the tools of the turn under way, each running, done, or failed.

Between your message and its reply, everything the bot did — tool calls, model steps, prompt changes, its thinking —
is folded into one line, **Worked through N steps**. Click it to open the transcript at those steps. A warning sign
on the line means a reply, a question, or a summary it tried to post failed or was interrupted; the transcript says
which.

Each of its messages has **Details**, collapsed: the model it used, the tokens it read and wrote, how long the step
took, and the hash of the prompt it was sent.

## Answering and approving in place

- **A question** the bot asks is a card. Its options are buttons while it waits on you: a click sends that option
  as your answer. Or write your own answer in the box. Once answered, the buttons are disabled.
- **A tool call that needs [approval](/docs/approvals)** is a card with the tool, the arguments it wants to send, and
  **Approve** and **Deny**. Deciding here is the same as deciding in the approvals inbox, recorded as decided from
  the dashboard. Only people who may decide that bot's approvals see the buttons enabled; everyone else sees why.

## Running a skill

Type `/` in the box and the bot's [skills](/docs/skills) are listed, filtered as you type. `↑` `↓` move through
them, and `Enter` or `Tab` puts `/name ` in the box, ready for what follows it. `Enter` sends; `Shift+Enter` starts a
new line.

## Reading any conversation as a chat

Every conversation's page has **Chat** and **Transcript** at the top. A dashboard chat opens as a chat; one from the
API or another platform opens as its transcript. Messages from a platform carry the name the person has there.
