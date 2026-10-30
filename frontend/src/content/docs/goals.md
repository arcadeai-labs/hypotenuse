# Goals

A goal is something a bot works toward across conversations: "Every billing question answered the same day",
"Keep the platform team's open incidents under five". Its **active** goals are in its [prompt](/docs/prompts),
highest priority first, with their notes, so they shape every turn.

**Goals** on a bot's page lists them and adds new ones.

![A bot's goals: two active, one achieved, and the form that adds another](illustration:bot-goals)

## A goal

| Field | What it is |
|---|---|
| **Goal** | what it is working toward, in a line |
| **What done looks like** | more about it, optional |
| **Priority** | high, medium, or low — orders the goals in its prompt |
| **Status** | **active** (in its prompt), **achieved**, or **dropped**. Achieved and dropped goals stay on the list, quieter, and leave the prompt |
| **Notes** | where it stands. The bot writes here too |
| **Review** | how often the bot should look at it again: never, every day, every week, every two weeks, every month, or every three months |

**Edit** changes any of them; **Delete** removes the goal. To keep a finished goal on record, mark it achieved or
dropped instead.

## What the bot does with them

The bot reads its goals with `goal_list` and records progress with `goal_update`: it may mark a goal achieved,
dropped, or active again, and rewrite its notes. It cannot add, retitle, or delete a goal — people do that; a bot
that thinks a goal should change says so in its reply.

## Reviews

A goal with a review interval is **Review due** once that long has passed since it was last reviewed (or since it
was made). The next turn the bot takes, its prompt asks it to review the goal, and its `goal_update` marks the
review done. Reviews happen when the bot is working; a bot nobody talks to does not wake up to review its goals.

## Who may change goals

Anyone who may [change a bot](/docs/bots#who-may-read-and-change-it) may add, edit, and delete its goals; anyone who
may read it sees them. Every change a person makes is in the project's [audit log](/docs/audit).
