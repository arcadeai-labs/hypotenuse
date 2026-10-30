# Memory

A bot remembers what it learns, so the next conversation does not start from nothing. Its memory is a set of short
markdown **documents**, each at a path such as `people/kim.md` or `facts/deploy-process.md`. Every change is a new
**version**, and earlier versions are kept, so you can always see what a bot believed and when it changed its mind.

**Memory** in the sidebar (`g m`) opens the project's shared memory; **Memory** on a bot's page opens what that bot
remembers about each of its channels.

![The memory explorer: search, and each document with how much it has faded](illustration:memory)

## Two scopes

| Scope | Who reads it | Who changes it | Fades |
|---|---|---|---|
| **Channel memory** | one bot, in one channel | the bot as it works; people who may change the bot | yes, and is eventually forgotten when unused |
| **Project memory** | every bot, in every channel of the project | the project's admins, and promotion | in ranking only; never forgotten on its own |

Channel memory belongs to **one bot in one channel**. Two bots in the same Slack channel keep separate channel
memories, and share the project's. What a bot learned in one channel never appears in another: a channel's memory
carries what its members said there.

What counts as a channel depends on where the bot is talking:

| Where | The channel, for memory | One conversation |
|---|---|---|
| The API | the `channelKey` the caller names — `default` if none ([see the API](/docs/talking-to-a-bot-over-the-api)) | one conversation the caller starts |
| Slack | a Slack channel, or a direct message with the bot | a thread |
| Linear | a Linear project; an issue in no project falls back to its team | an agent session on an issue |
| Pylon | a customer account (the company) | an issue |

![A bot's memory: its channels beside the list, each with how many documents it holds](illustration:memory-channel)

## How a bot uses it

A bot has six memory tools, and uses them without asking anyone:

| Tool | What it does |
|---|---|
| `memory_search` | finds memories by meaning and by their words, in its channel's memory, the project's, or both |
| `memory_list` | lists documents by path, such as everything under `people/` |
| `memory_read` | reads one document, or an earlier version of it |
| `memory_write` | writes a whole document as a new version |
| `memory_edit` | changes some lines of a document, refused if it changed since the bot read it |
| `memory_forget` | forgets a document; its history is kept |

A bot writes only to its **channel** memory. Project memory is shared with every channel, so it changes only when a
person writes it or promotes something into it; a bot that tries is told to ask.

**After a conversation comes to rest** — [resting or ended](/docs/conversations#what-a-conversation-is-doing), with at
least four new entries since it last looked — the bot's `fast` model reads
what was said since it last looked and writes down the facts worth keeping under `facts/` in that channel's memory:
decisions, commitments, names and roles, preferences, how things are done. Each fact cites the transcript entries it
came from, and a fact that corrects an earlier one updates that document rather than adding a near-duplicate. Small
talk and things only true during the conversation are left out.

## Search

The explorer's search is the bot's own: it ranks memories by meaning (with an embedding model) and by their words,
fuses the two rankings, and weighs the result by how fresh each memory is. Every result shows its parts:

| Shown | Means |
|---|---|
| **score** | what the bot ranks by: relevance weighed by decay |
| **relevance** | the two rankings fused, before decay; 1.00 is first on both |
| **decay** | how much weight the memory has left (see below) |
| **meaning** / **words** | its place in each ranking, or — when it was not found that way |

In a channel's explorer, **Include project memory** searches both, as the bot does. A search from the dashboard
does not count as using a memory, so it does not keep one fresh.

### Without an embedding model

Search by meaning needs an **embedding model**: a [model name](/docs/models#the-embedding-model) called `embedding`.
Without one, search finds memories by their words only, and the explorer says so in a banner. Memory still works —
it just will not find "how do we ship" from a document that says "deploy process".

When an embedding model is added or changed, the project's memory is re-embedded in the background; until it
finishes, the banner counts the chunks still waiting, and those are found by their words only. **Reindex** (admins)
starts that work again if it stopped.

## Decay

A memory nobody uses fades. Its **decay** starts at 1 when it is written or last used, and halves every
**half-life** — by default 30 days for channel memory and 180 days for project memory, set per bot on its page
under [Memory](/docs/bots#memory). Being read by the bot, or being among the top three results of one of its
searches, resets the clock.

- Decay **ranks** memories; it never hides one. A memory keeps a quarter of its weight however old it is, so an exact
  match is still found.
- In the explorer, each document's bar is its decay; hover it for its half-life.
- A **channel** memory that has faded below 5%, was read fewer than three times, and is not pinned is **forgotten**
  by the hourly decay clock, with "faded" as the reason. Its history is kept.
- **Project** memory is never forgotten by decay; a person forgets it.
- **Pinned** documents never fade.

Earlier versions are kept for 90 days, then removed — except the current version, which is never removed, and any
version a promotion cites.

## Correcting the bot

When a bot remembers something wrong, fix the memory rather than the persona. Open the document from the explorer or
a search, then:

![A memory document: its text, its history, and what changed since the version before](illustration:memory-document)

| Action | What it does | Who may |
|---|---|---|
| **Edit** | writes a new version; your note says why. If someone (or the bot) changed it while you edited, the save is refused and your text kept, so you can look at what changed and save again | channel: who may change the bot; project: admins |
| **Pin** / **Unpin** | a pinned memory never fades | the same |
| **Forget** | no bot finds it any more; its history stays, and any earlier version can be restored | the same |
| **Promote** | copies a channel's memory into project memory, citing where it came from | who may change the bot, and is an admin |
| **Restore this version** | on an earlier version: makes it current again | the same as Edit |

**New document** in the explorer writes one from scratch — a fact you want every conversation in a channel, or the
whole project, to know.

Every one of these is recorded in the [audit log](/docs/audit) with who did it; a memory's own text is not copied
there, only its length and a fingerprint.

Each version also says **where it came from**: the conversation and entries a bot learned it from (a link opens the
transcript with those entries marked), the person who wrote it, or the channel memory it was promoted from.

## Promotion

Promotion is how something learned in one channel becomes something every bot knows. It is always a person's
decision: a bot cannot move a channel's memory into the project's on its own, because that would show one channel's
conversations to every other.

**Promote** asks for the path in project memory (the same by default) and a note, then opens the copy. The copy cites
the channel version it came from, and that version is kept for as long as the copy cites it.

## Who may see it

Reading a channel's memory takes read access to its bot; reading project memory takes membership in the project. See
[who may read and change a bot](/docs/bots#who-may-read-and-change-it).
