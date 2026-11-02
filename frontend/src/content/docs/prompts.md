# Prompts

Before every step, a bot is told who it is, what it is for, and how it works here. That text — its **prompt** — is
built from **sections**: short, titled pieces of markdown, each with its own history. People write most of them;
a bot may rewrite the ones you let it, and every change it makes is kept, marked, and can be put back.

**Prompt** at the top of a bot's page opens its prompt: every section in the order the bot reads them, and beside
them a preview of exactly what it would be sent.

![A bot's prompt: its sections in order, one opened to its history, and the preview beside them](illustration:bot-prompt)

## Sections

A new bot starts with three:

| Section | Loads | The bot may edit it |
|---|---|---|
| **Identity** | always | never — it is the bot's [persona](/docs/bots#writing-a-persona) |
| **How I work** | always | yes |
| **Things I have learned** | always | yes |

**How I work** and **Things I have learned** start empty. Add more with **Add a section** at the bottom of the
page.

Each section shows its title, when it loads, its version and who wrote it, and about how many tokens it costs.

- **Edit** changes its title, its text, and when it loads. A change to the title or text is a **new version**. The
  save is checked against the version you opened: if the bot (or a teammate) changed it meanwhile, the save is
  refused and you reload and try again, so nobody's edit is lost.
- **Editable by the bot** lets the bot rewrite the section itself. Leave it off for anything the bot must not talk
  itself out of — guardrails, escalation rules, who it serves.
- **Delete** takes the section out of the prompt from the bot's next step. Its versions are kept. *Identity* cannot
  be deleted.

## When a section loads

- **Always** — in every step.
- **When its keywords come up** (*contextual*) — only when one of its keywords appears in the conversation's title,
  the latest message, or the channel's name. With no keywords, the words of its title are used.

Contextual sections keep the prompt short: a release-notes procedure needs to be there when someone asks for
release notes, not on every turn.

## The order

The bot reads its prompt in a fixed order:

1. its **Identity**;
2. the project's sections that always load;
3. its own sections that always load;
4. contextual sections that matched — the project's, then its own;
5. its active [goals](/docs/goals), highest priority first;
6. the [skills](/docs/skills) it has;
7. what its [tools](/docs/mcp-servers) can do;
8. where the conversation is — its channel and its title;
9. how its tools work, and the style rules every bot follows.

Within each group, sections keep the order they were added in. The Prompt page numbers them in this order.

## The budget

Each bot has a **prompt budget** in tokens — 8,000 unless you change it under **Model & budget → Prompt** on its
page, anywhere from 1,000 to 200,000. A token is about four characters.

- When matched contextual sections would push the prompt over its budget, the last of them are left out until it
  fits, and the transcript says which were dropped.
- Sections that always load are never dropped. A change that would push them over the budget — a longer section,
  a section made to load always, a smaller budget — is refused when you save it, saying so.

## Versions

**History** on a section lists every version, newest first: who wrote it — a person, **the bot** (marked, and
linked to the conversation it wrote it in), or a revert — and the note saying why. Choose a version to see what it
changed from the one before. **Revert to this** puts that version's text back as a new version; nothing is ever
overwritten.

## The preview

The preview is the prompt the bot would be sent now, built the same way a step builds it:

- its size against the budget;
- its **hash** — the transcript records the hash of every prompt the bot was sent, so you can tell when it changed;
- the sections included, and any contextual ones dropped to fit;
- the full text.

Type a message under **A message to it** to see which contextual sections that message would bring in.

## When the bot edits itself

A section marked editable can be changed by the bot with its `prompt_edit` tool, and the bot can add sections of its
own with `prompt_create` — contextual by default, up to the number set under **Sections it may add** on its page (10
unless you change it; 0 stops it). Every one of those edits is a version marked as the bot's, with the conversation
it came from, and the next step of every conversation shows the change in its [transcript](/docs/conversations).

Facts that change — who is on call, a customer's plan — belong in [memory](/docs/memory). Sections are for how the
bot works.

## Project sections

**Settings → Prompt sections** holds sections every bot in the project includes, after its *Identity* — how your
company writes, what no bot may ever do. Every member can read them and their history; only admins add, change,
revert, and delete them, and no bot may edit one. On a bot's Prompt page they appear in their place, marked
**Every bot**.

## Who may change a prompt

Anyone who may [change a bot](/docs/bots#who-may-read-and-change-it) may change its sections, add them, and revert
them. Anyone who may read it sees its sections, their history, and the preview. Every change a person makes is in
the project's [audit log](/docs/audit).
