# Tags

A tag is a role you name: `support`, `eng`, `finance`. An admin creates a project's tags under **Settings → Tags** and
grants them to members under **Settings → Members**. A tag means nothing on its own; it means something when an
**access list** names it.

Every project has one reserved tag, `admin`, which makes its holder an admin of the project. It cannot be renamed or
deleted, and no other tag can be named `admin`.

Tag names are compared without regard to case or surrounding spaces, so `Finance` and `finance` are the same tag, and a
project cannot have both. No tag can be named `*`, which an access list reads as "every member".

## Access lists

Some things in a project — bots first — carry two lists of tag names: who may **read** it, and who may **write** it.
Who satisfies a list:

| The list | Who passes |
|---|---|
| anything, and you are an admin (or an owner of the organization) | you |
| empty | every member of the project |
| contains `*` | every member of the project |
| names tags | members who hold at least one of them |

So a bot readable by `["support", "eng"]` is visible to anyone holding either tag, and to every admin. Admins always
pass, so a list can never lock everyone out of the thing it protects.
[Bots](/docs/bots#who-may-read-and-change-it) shows the lists on a bot's page.

## Renaming and deleting a tag

Renaming a tag updates every access list that names it, so nobody's access changes.

Deleting a tag is refused while any access list still names it, and the refusal says which. Remove the tag from those
lists first. Deleting it from the lists for you would quietly change who has access — a list naming only that tag
would become empty, and an empty list means *everyone*.

## Channels: who talks, who reads, who binds

A bot's access lists govern the dashboard, the API, and the CLI. On a platform, the platform decides:

| Who | May | Decided by |
|---|---|---|
| anyone who can write in a channel where the bot is bound | talk to the bot there, and answer its questions | the platform's own permissions — Hypotenuse adds no second gate and links no accounts |
| anyone who may **read** the bot | read the conversations and memory of every channel it is bound in, and [chat](/docs/chat) with it in the dashboard | the bot's read list |
| anyone who may **change** the bot | connect and disconnect its [platforms](/docs/connecting-a-platform), bind and unbind its [channels](/docs/channels), and change a binding's settings | the bot's write list |

So binding a **private** channel shows it to everyone on the bot's read list, who may not be in the channel. That is
why the bot never binds a private channel or a direct message by itself unless its **Listening** settings say so, and
why binding one by hand asks you to confirm, in so many words, that *everyone who can read this bot in Hypotenuse will
be able to read this channel's conversations and memory*. The confirmation is in the [audit log](/docs/audit).

## Who decides in a channel

A bot's [tool calls that wait for approval](/docs/approvals) can be decided in the dashboard by anyone who may decide
that bot's approvals. Each binding also says who may decide them **from inside the channel**, with the platform's
buttons:

| The binding's approval policy | Who may approve or deny in the channel |
|---|---|
| **Only in the dashboard** (the default) | nobody — the message links to the approval, decided in the dashboard |
| **Anyone in the channel** | anyone the platform lets write in the channel |
| **Only listed people** | the platform user ids the binding lists |

A decision made in a channel is recorded on the approval, with the person's platform name, and in the audit log as a
decision by a platform participant. Changing a binding's policy is in the audit log too.
