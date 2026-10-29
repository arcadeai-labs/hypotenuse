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

![A bot's page: identity, model, access, and budget, with its properties beside them](illustration:bot)

Each section saves on its own. The panel on the right sums the bot up: whether it is enabled, its model, who may
read and change it, and whether you may change it.

| Section | What it holds |
|---|---|
| **Identity** | its name, the display name platforms show, its slug, a one-line description, whether it is enabled, its avatar, and its persona |
| **Model** | which of the project's model names it uses: its main model and its fast one |
| **Access** | who may read it, who may change it, and whom it asks for help |
| **Budget** | a monthly ceiling in US dollars — **not enforced yet** |

The page also shows **Channels**, **Tools**, **Skills**, **Prompts**, and **Goals**, each reading *Not available
yet*. They will hold where the bot listens, what it may call, and how it works between conversations.

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

The persona is who the bot is, in markdown. It opens every conversation the bot has, so everything else it does is
read through it. **Preview** shows it the way the bot's own messages are drawn.

- **Say who it is and whom it serves.** "You are Ada, the support team's teammate in #billing" beats "You are a
  helpful assistant".
- **Say how it should sound.** Short or thorough, formal or plain, whether it uses lists.
- **Say what it must not do**, and what to do instead: "Never promise a refund; say a person on the billing team will
  confirm it."
- **Say when to hand off.** Name the situations where it should ask a person rather than guess.
- **Keep facts out.** Things that change — prices, on-call rotas, release dates — belong in memory, not in the
  persona.
- **Keep it short.** A page is plenty; every word is read on every turn.

## Who may read and change it

A bot carries two access lists of [tags](/docs/tags): who may **read** it (see it in the list, open its page, and
later read its conversations) and who may **change** it (edit or delete it). Leave a list empty and every member of
the project passes; check tags and only members holding at least one of them do. Admins always pass.

- A member who may read a bot but not change it sees its page with every control disabled, saying why.
- A bot someone may not read is simply not there for them — not in the list, and its page reads as not found.
- You cannot save a list that leaves you out, unless you are an admin: a member who did so would lock themselves out
  of the bot they were editing.

These lists govern the dashboard and the CLI. Who may *talk* to a bot is decided by the platform it is bound in:
anyone who can write in a Slack channel, comment on a Linear issue, or reply on a Pylon ticket where the bot is
bound may address it there.

**Who it asks for help** is the tag whose holders the bot will notify when it needs a person and nobody in the
channel has answered. It defaults to the project's admins.

## Budget

A monthly spending ceiling in US dollars, or none. It is recorded and shown now, labelled **Not enforced yet**:
nothing stops a bot at its budget until model calls are priced.
