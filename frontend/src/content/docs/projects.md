# Projects

A project is where bots live, together with everything they share: the project's memory, its MCP servers, its
skills, its model connections, and its platform installs. Every project belongs to one organization.

## Who sees a project

You see a project if you are a **member** of it, or if you **own** its organization. The project switcher lists
exactly those. Being in the organization alone shows you nothing — see [Organizations](/docs/organizations).

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

A project's **Settings** has four sections:

- **General** — the project's name. Its slug follows the name.
- **Members** — who is in the project and which tags they hold. See [Members](/docs/members).
- **Tags** — the project's roles. See [Tags](/docs/tags).
- **Danger zone** — delete the project.

Every member can read the settings; only admins change them. A button you cannot use is shown disabled, with the
reason, rather than hidden.

## Deleting a project

Deleting a project removes it and everything in it — its bots, memory, members, tags, and invitations — and cannot
be undone. Its audit history is kept.
