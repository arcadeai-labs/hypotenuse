# Projects

A project is where bots live, together with everything they share: the project's memory, its MCP servers, its
skills, its model connections, and its platform installs. Every project belongs to one organization.

## Who sees a project

You see a project if you are a **member** of it, or if you **own** its organization. The project switcher lists
exactly those. Being in the organization alone shows you nothing — see [Organizations](/docs/organizations).

**Organization → Projects** lists the same projects with **your role** in each: *Member*, *Admin* (you hold the
project's admin tag), or *Admin (owner)* (you are an admin because you own the organization).

## Members and admins

Inside a project there are two levels, and no ladder of roles between them:

| A project member may | Only a project admin may |
|---|---|
| view the project, its bots (where their access lists allow), conversations, and memory | connect platforms, model providers, MCP servers, and sandbox providers |
| create a bot, and edit a bot they can write | manage members, tags, and invitations; edit the project's settings |
| answer and cancel in the dashboard what they can read | read the audit log |

An **admin** is a member who holds the project's reserved `admin` tag. An owner of the organization counts as an
admin in every project, whether or not they have joined it. Everything finer than member and admin is a **tag** —
see [Tags](/docs/tags).

## Settings

A project's **Settings** has these sections:

- **General** — the project's name. Its slug follows the name.
- **Models** — the model providers it connects and the model names its bots use. See [Models](/docs/models).
- **MCP servers** — the shared tool servers its bots may be given. See [MCP servers](/docs/mcp-servers).
- **Skills** — the project's library of skills. See [Skills](/docs/skills).
- **Prompt sections** — sections of the prompt every bot in the project includes. See [Prompts](/docs/prompts).
- **Sandboxes** — where its bots' sandbox jobs run: the provider, the image, how many at once, and the longest one
  may run. See [Sandboxes](/docs/sandboxes).
- **Members** — who is in the project and which tags they hold. See [Members](/docs/members).
- **Tags** — the project's roles. See [Tags](/docs/tags).
- **Danger zone** — delete the project.

Every member can read the settings; only admins change them. A button you cannot use is shown disabled, with the
reason, rather than hidden.

## Deleting a project

Deleting a project removes it and everything in it — its bots, memory, members, tags, and invitations — and cannot
be undone. Its audit history is kept.
