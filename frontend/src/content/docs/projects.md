# Projects

A **project** is your team's home in Hypotenuse, and the boundary for everything in it. Its members, their tags,
its invitations, its audit log, and later its Linear connection, runners, routing rules, and agent sessions all
belong to exactly one project.

A project connects **at most one Linear workspace**. If your company has two workspaces, make two projects.

## Your projects

The **project switcher** at the top of the sidebar lists every project you belong to. Choosing one makes it the
*active* project, which every page then shows. The browser remembers your choice.

From the same menu you can open **Invites**, the **Audit log**, and **New project**. Whoever creates a project
becomes its admin.

## Settings

**Settings** in the sidebar opens the active project's settings, in sections:

| Section | What it holds | Who can change it |
|---|---|---|
| General | The project's name | Admins |
| MCP endpoint | The URL to point an MCP client at | — (read only) |
| Members | Who belongs, and their tags | Admins |
| Tags | The project's tags | Admins |
| Danger zone | Deleting the project | Admins |

Every member can open every section. A section that a member can read but not change says so rather than hiding.
If you start editing a section and click away, Hypotenuse asks before throwing your changes away.

## The MCP endpoint

Hypotenuse is also an [MCP](https://modelcontextprotocol.io) server. Point an MCP client — Claude, ChatGPT, VS Code,
or any other — at the URL under **Settings → MCP endpoint**. The client signs in with OAuth as you and can do what you
can do in the dashboard, and nothing more: it cannot sign up, sign in, or reach anything a runner uses.

## Deleting a project

Only an admin can delete a project, from **Settings → Danger zone**, by typing the project's name to confirm.
Deleting it removes its tags, memberships, invitations, settings, and notifications. Its audit log is kept until it ages out.
