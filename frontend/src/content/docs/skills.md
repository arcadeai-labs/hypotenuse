# Skills

A skill is a procedure written once and shared: how your team writes release notes, runs a standup summary,
triages a bug report. The project keeps a library of them, and each bot is given the ones it may use. A bot sees
each of its skills by name and one-line description in its [prompt](/docs/prompts), and runs one with its
`use_skill` tool; a person runs one by starting a message with `/` and the skill's name.

**Settings → Skills** is the library.

![Settings → Skills: the library, one skill opened to its template and versions](illustration:skills)

## Writing a skill

| Field | What it is |
|---|---|
| **Name** | lowercase letters, digits, and hyphens — `release-notes`. It is what `/release-notes` calls |
| **Description** | one line saying what it does. Every bot that has the skill reads it, so make it say when to use it |
| **Arguments** | what it takes, in order: each with a name, an optional description, and either **Required** or a default |
| **Template** | markdown: the instructions, with the arguments filled in |
| **Who may see and attach it**, **Who may change it** | [tags](/docs/tags), as a bot's access lists work; empty means every member |

In the template:

- `$version` is the argument named `version`;
- `$1`, `$2`, … are the arguments by place;
- `$ARGUMENTS` is everything typed after the skill's name.

The last argument takes the rest of the line, so `/release-notes 2.4 the billing team` gives `version` the value
`2.4` and `audience` the value `the billing team`. Quote a word to keep it whole, or name it:
`/release-notes audience:customers 2.4`.

Every save is a new **version**. Open a skill to see its template and its versions, each with what it changed from
the one before. Bots never edit skills: a skill is shared, and a change to it reaches every bot that uses it.

## Giving a bot a skill

**Skills** on a bot's page attaches one from the library. By default the bot follows the skill's **latest** version;
**Pin to version** keeps it on one, so a change to the library reaches it only when someone moves the pin.
**Detach** takes it away.

![A bot's skills: one following the latest version, one pinned](illustration:bot-skills)

## Running a skill

In a conversation, a message that starts with `/` and the name of one of the bot's skills runs it:

```
/release-notes 2.4 customers
```

The bot reads the filled-in template in place of the message, and the [transcript](/docs/conversations) shows
**Ran skill /release-notes** beside your message; open it to see exactly what the bot read. If a required argument
is missing, the line reads **Could not run skill**, says what the skill needs, and the bot is told to ask for it.

A message that starts with `/` and a name the bot does not have is an ordinary message.

## Who may do what

Any member may write a skill. Who sees one, and who may change or delete it, is decided by its own access lists;
admins always pass. Attaching a skill to a bot needs the skill's read access and the bot's
[write access](/docs/bots#who-may-read-and-change-it). Every change is in the project's [audit log](/docs/audit).
