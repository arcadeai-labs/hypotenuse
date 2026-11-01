# Bots

A bot is a teammate with its own name, face, and manner. People will reach it where they already work — Slack,
Linear, Pylon — and it answers there. In the dashboard, **Bots** in the sidebar lists the bots of the active project
you may read, and each bot has a page where it is configured. Every avatar that stands for a bot carries the **bot**
badge, everywhere, so nobody mistakes one for a person.

![The Bots list: each bot with its badge, what it is for, and its model names](illustration:bots)

Any member of a project can create a bot, with **New bot** on the Bots page or in the command palette (`⌘K`). A new
bot starts enabled, open to every member, and using the `default` and `fast` [model names](/docs/models). Until the
project has set both of those, the Bots page says no bot can run yet — an admin sets them under **Settings → Models**.

## The bot page

![A bot's page: identity, model, access, budget, prompt, goals, skills, and memory, with its properties beside them](illustration:bot)

Each section saves on its own. The panel on the right sums the bot up: whether it is enabled, its model, who may
read and change it, and whether you may change it.

| Section | What it holds |
|---|---|
| **Identity** | its name, the display name platforms show, its slug, a one-line description, whether it is enabled, its avatar, and its persona |
| **Model** | which of the project's model names it uses: its main model and its fast one |
| **Access** | who may read it, who may change it, and whom it asks for help |
| **Budget** | a monthly ceiling in US dollars, and the most model steps one turn may take |
| **Prompt** | its prompt budget in tokens, how many sections it may add to its own prompt, and a link to its [prompt](/docs/prompts) |
| **Goals** | what it works toward — see [Goals](/docs/goals) |
| **Skills** | which of the project's [skills](/docs/skills) it may use, and which version of each |
| **Memory** | how fast memories fade in its searches, and a link to the memory explorer |
| **Tools** | which MCP servers it may use, which of their tools run without asking, and what its tools can do |
| **Code** | whether it may run programs ([code mode](/docs/code-mode)), and its own, lower limits for them |
| **Sandboxes** | whether it may hand code work to a [sandbox job](/docs/sandboxes) — off, after a person's approval (the default), or at once — and the most model tokens one job may use |
| **Approvals** | who may decide its tool calls, and how long a waiting call lasts |
| **Channels** | its apps on platforms, the channels it is bound in and their settings, and channels that messaged it unbound — see [Channels](/docs/channels) |
| **Listening** | where it binds itself when invited, and how many messages a minute one person, and one channel, may send it |

**Chat** at the top of the page opens the bot's [chat](/docs/chat), where you talk to it in the dashboard.

**Prompt** at the top of the page opens the bot's [prompt](/docs/prompts): every section of what it is told before
each step, their versions, and a preview of the whole.

**Enabled** decides whether the bot takes new conversations. **Delete bot**, behind a confirmation, removes it for
good.

## Identity

- **Name** is how the dashboard and the CLI refer to it. **Display name** is what Slack, Linear, and Pylon show; it
  starts as the name.
- **Slug** is a short, unique id in the project — lowercase letters, digits, and dashes — made from the name when the
  bot is created.
- **Avatar**: a **square** PNG or JPEG of at most **512 KB**. It is uploaded the moment you choose it, and **Remove**
  goes back to the bot's monogram. A bot without a picture is its initials on a tinted rounded square, never a
  person-like silhouette.

### Writing a persona

The persona is who the bot is, in markdown. It is the **Identity** section of the bot's [prompt](/docs/prompts),
which opens every step the bot takes, so everything else it does is read through it. **Preview** shows it the way
the bot's own messages are drawn. Saving it makes a new version of the Identity section; its history, and the rest
of the prompt, are on the bot's Prompt page. The bot can never edit its own Identity.

- **Say who it is and whom it serves.** "You are Ada, the support team's teammate in #billing" beats "You are a
  helpful assistant".
- **Say how it should sound.** Short or thorough, formal or plain, whether it uses lists.
- **Say what it must not do**, and what to do instead: "Never promise a refund; say a person on the billing team will
  confirm it."
- **Say when to hand off.** Name the situations where it should ask a person rather than guess.
- **Keep facts out.** Things that change — prices, on-call rotas, release dates — belong in
  [memory](/docs/memory), not in the persona.
- **Keep it short.** A page is plenty; every word is read on every turn. Procedures that matter only sometimes belong
  in a [contextual section](/docs/prompts#when-a-section-loads) or a [skill](/docs/skills).

## Who may read and change it

A bot carries two access lists of [tags](/docs/tags): who may **read** it (see it in the list, open its page, and
later read its conversations) and who may **change** it (edit or delete it). Leave a list empty and every member of
the project passes; check tags and only members holding at least one of them do. Admins always pass.

- A member who may read a bot but not change it sees its page with every control disabled, saying why.
- A bot someone may not read is simply not there for them — not in the list, and its page reads as not found.
- You cannot save a list that leaves you out, unless you are an admin: a member who did so would lock themselves out
  of the bot they were editing.

These lists govern the dashboard and the CLI. Who may *talk* to a bot is decided by the platform it is bound in:
anyone who can write in a channel where the bot is bound may address it there. Everyone who may read the bot may read
those conversations — see [Channels: who talks, who reads, who binds](/docs/tags#channels-who-talks-who-reads-who-binds).

**Who it asks for help** is the tag whose holders the bot will notify when it needs a person and nobody in the
channel has answered. It defaults to the project's admins.

## Budget

A monthly spending ceiling in US dollars, or none. Once the costs its model provider reports reach it, the bot takes
no more steps that month: a conversation that would go on fails its turn, saying so. Only a provider that reports a
price (the Vercel AI Gateway) counts toward it yet; calls to other providers are recorded but not priced.

**Steps per turn** caps how many model steps one [turn](/docs/conversations) may take — 50 unless you change it. A
turn that reaches it fails, saying how many steps it took, rather than running on.

## Prompt

**Prompt budget** is the most its prompt may be, in tokens (about four characters each): 8,000 unless you change it,
from 1,000 to 200,000. Contextual sections are dropped to fit it, and a change that would push the sections that
always load over it is refused. **Sections it may add** caps how many sections the bot may add to its own prompt —
10 unless you change it; 0 stops it. See [Prompts](/docs/prompts).

## Goals and skills

**Goals** lists what the bot works toward; active goals are in its prompt. See [Goals](/docs/goals).

**Skills** attaches procedures from the project's library. The bot follows each skill's latest version unless you
pin one. See [Skills](/docs/skills).

## Memory

A bot remembers what it learns in each channel, and reads the project's shared memory too — see
[Memory](/docs/memory). A channel's memory is shared by every bot working there, so a second bot in the channel
starts out knowing what the first learned. It searches, lists, reads, writes, edits, and forgets its channel's memory with six
`memory_*` tools, without asking, and after each conversation comes to rest it writes down the facts worth keeping.

A memory nobody uses fades: it loses half its weight in search every **half-life**. The section sets two, each a
whole number of days from 1 to 3650:

| Setting | Default | What it does |
|---|---|---|
| **Channel memory half-life** | 30 days | how fast channel memory fades in this bot's searches; one that fades far enough unread is forgotten, measured with the longest channel half-life of the project's bots |
| **Project memory half-life** | 180 days | how fast the project's shared memory fades in this bot's searches; project memory is never forgotten by fading |

**Memory** at the top of the page, or the link in the section, opens the memory explorer: project memory, and the memory of each channel.

## Tools

![A bot's Tools: its servers, the patterns that let calls run without asking, and what its tools can do](illustration:bot-tools)

A bot calls tools on the project's [MCP servers](/docs/mcp-servers). **Add server** gives it one; until then it has
none. For each server, two settings decide which calls run without a person's [approval](/docs/approvals):

- **Allowed tools** — patterns naming the calls that run without asking. Empty, the default, means every call
  waits. As you type, the section shows which of the server's tools each pattern matches.

  | Pattern | Allows |
  |---|---|
  | `github/create_issue` | that one tool |
  | `github/*` | every tool of that server |
  | `*/search` or `search` | a tool of that name on any server |
  | `/^github\/list_/` | any `server/tool` the regular expression matches |

- **Run read-only tools without asking** — calls to tools the server marks read-only run at once. Off by default:
  the mark is the server's claim, not a promise, so turn it on only for servers you trust to tell the truth.

**What its tools can do** is a few lines the bot reads in its instructions, written by its `fast` model from the
tools it can see, in themes and without tool names — so it searches for the right tool rather than guessing one. It
is rewritten whenever a server's tools change.

The **Approvals** section sets two more. **Approver tag** names a tag whose holders may approve or deny this bot's calls besides the people who may change
it; they are the ones notified. **Approvals expire after** sets how long a call waits before it counts as denied —
a day unless you change it.

## Talking to it

Anyone who may read a bot may [chat with it](/docs/chat) in the dashboard and
[talk to it over the API](/docs/talking-to-a-bot-over-the-api), and its page lists its
[conversations](/docs/conversations). **Callback secret** creates the secret its API callbacks are signed with; it is
shown once.
