# Asking a person for help

Sometimes a bot needs something nobody in the conversation can give it: a decision only the billing team can make,
a fact nobody in the channel knows. Then it **asks a person on the team** — not in the channel, because the question
may be about the channel or the people in it, but privately, through the **Help inbox**.

![The help inbox: a request from a bot, marked urgent and blocking](illustration:help)

## What the bot does

When a bot asks for help:

1. The request lands in the **Help inbox** (`g i`), and the people it asks are notified.
2. The bot says in the channel only that it has asked a person on the team.
3. A **blocking** request — the default — pauses the conversation until someone answers. A non-blocking one lets the
   bot carry on; the answer arrives later as a message.

A request names how **urgent** it is (low, normal, or urgent), what the bot needs to know, and the context it found.
A bot may have at most five requests in one conversation.

## Who is asked

The people a bot asks are the holders of its **help tag**, set in the **Access** section of its page — those of them
who may read the bot. With no help tag, or nobody holding it who may read the bot, the project's admins are asked.

Those people may answer, and so may anyone who may change the bot. Anyone who may read the bot sees its requests in
the inbox.

## Answering

Open a request from the inbox or its notification. It shows the question, the context, the bot, and the
conversation it came from. Write your answer — markdown is fine — and **Send answer**. The bot reads it as a message
*Answer from* you, and carries on. Your answer is delivered into the conversation; it is not posted in the channel.

Someone who may change the bot may instead **Cancel request**: the bot is told the request was withdrawn and carries
on without an answer.

A request nobody answers **expires** — after a day unless the bot asked for longer, and never after more than a
week — and the bot is told nobody answered in time.

Answering and cancelling are in the [audit log](/docs/audit).
