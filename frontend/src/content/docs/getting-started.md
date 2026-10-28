# Getting started

Hypotenuse is a persistent, multiplayer agent for your team. A project holds **bots**; each bot has its own prompts,
its own identity in Slack and Linear, its own model, and its own tools. People reach a bot where they already work —
a Slack thread, a Linear agent session, a Pylon ticket — and it answers there. When a task needs code, the bot hands it
to a **sandbox** that clones the repository, does the work, and opens a pull request.

Hypotenuse is in development. This page grows as each part ships.

## The words

| Word | What it is |
|---|---|
| **Organization** | Who you are: its members and its projects. |
| **Project** | Where bots live, with the memory, MCP servers, skills, and model connections they share. |
| **Bot** | An agent with a name, an identity on each platform, prompts, goals, and a model. Always shown with the **bot** badge. |
| **Channel** | A place a bot listens and remembers: a Slack channel, a Linear project, a Pylon customer account. |
| **Conversation** | One thread of work inside a channel: a Slack thread, a Linear agent session, a Pylon issue. |

## Reading a conversation's state

Every conversation is in one of four states, and the dashboard and the CLI draw each with the same shape:

| Glyph | State | Means |
|---|---|---|
| ◔ | Working | The bot is taking a step right now. |
| ○ | Hibernating | Nothing to do until someone writes again. This is the normal resting state. |
| ◉ | Waiting for an answer or approval | A person is needed — answer where the question was asked. |
| ◷ | Waiting on a sandbox or a timer | The bot is waiting on work it started. |
| ✓ | Ended, complete | Done. |
| ✕ | Ended, failed | The turn failed; the transcript says why. |

## Find your way around

![The app shell: the organization and project switchers above the sidebar's destinations](illustration:shell)

- **⌘K** (Ctrl+K on Windows and Linux) opens the command palette. It reaches every page and every action you are
  allowed to take.
- **?** lists every keyboard shortcut. **g** then a letter goes to a page: **g h** Home, **g c** Conversations,
  **g b** Bots, **g m** Memory, **g s** Sandboxes.
- **[** collapses the sidebar to icons.
- The sidebar shows every destination from the start. One whose page has not shipped yet reads *Not available yet*.

## Light and dark

Hypotenuse follows your system's appearance until you choose otherwise. Pick **System**, **Light**, or **Dark** from
the account menu at the foot of the sidebar, from the toggle at the top of these docs, or with *Theme: …* in the
command palette. The choice is remembered in this browser.
