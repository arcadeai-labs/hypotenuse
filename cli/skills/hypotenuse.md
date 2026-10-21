---
name: hypotenuse
description: Operate a Hypotenuse server from the terminal with the `hypotenuse` CLI — sign in, pick a project, manage members, invites, tags, connect Linear, read Linear agent sessions, and read the audit log. Use when asked to administer Hypotenuse projects, check what @hypotenuse did on an issue, or check who changed what.
---

# hypotenuse

`hypotenuse` is the command-line client for a [Hypotenuse](https://github.com/arcadeai-labs/hypotenuse)
server. It calls the same HTTP actions the dashboard does, as the person who signed it in.

## Conventions

- **stdout is data, stderr is for people.** Pass `--json` (`-j`) to get the action's named object
  (`{ projects, pagination }`, `{ project }`, …) on stdout with no color. Parse that, never the
  tables.
- A non-zero exit code means the command failed; the reason is on stderr.
- Lists take `--page` and `--limit` (default 25) and answer a
  `pagination: { page, limit, total, pages }` envelope.
- Project-scoped commands act on `--project <id|slug>`, else `HYPOTENUSE_PROJECT`, else the project
  chosen with `hypotenuse project use`.
- The server is `--url`, else `HYPOTENUSE_URL`, else wherever `login` last signed in.
- `HYPOTENUSE_NO_UPDATE_CHECK=1` turns off the background update notice.

## Commands

| Command | Does |
|---|---|
| `hypotenuse login [--no-browser] [--device <name>]` | Sign in through the dashboard. A person must approve in a browser; `--no-browser` prints a code to type at `/cli/activate` on any device. Never ask for a password. |
| `hypotenuse logout` | Revoke this CLI's sign-in on the server and forget it locally. |
| `hypotenuse whoami` | Who this CLI is signed in as, on which server. |
| `hypotenuse project list\|view\|create\|edit\|delete\|use` | The caller's projects. `delete` needs `--yes`. `use <id\|slug>` selects the project later commands act on. |
| `hypotenuse member list\|add\|remove` | The selected project's members. `add --email`, `remove <userId>` (admin). |
| `hypotenuse invite list\|pending\|create\|accept\|reject` | Invitations. `create --email [--tag <id>]` (admin); `pending` lists invites addressed to you; `accept`/`reject <inviteId>`. |
| `hypotenuse tag list\|create\|edit\|delete\|assign\|unassign` | Permission tags. `assign <tagId> --user <userId>` (admin). The `admin` tag is reserved. |
| `hypotenuse audit list [--since 7d] [--until <time>] [--action tag:edit]` | Who changed what, newest first (admin). Times are ISO-8601, epoch ms, or `7d` / `12h` / `30m`. |
| `hypotenuse linear status\|connect\|disconnect` | The selected project's Linear workspace connection. `status` shows the workspace, the `@hypotenuse` app user, scopes, and token health (never a token). `connect` (admin) prints Linear's consent URL — a **Linear workspace admin** must approve it in a browser — and waits until the connection is active (`--no-browser`, `--timeout <seconds>`). `disconnect --yes` (admin) revokes the tokens; the agent stops answering in Linear at once. |
| `hypotenuse session list\|view` | The selected project's Linear agent sessions — each time `@hypotenuse` was delegated an issue or mentioned. `list [--status <status>] [--role manager\|worker] [--issue ENG-123]`, newest first; `view <id>` shows the session (issue, status, origin, role, links) and every activity in order, both directions, with each write's delivery status (`pending`, `sent`, `failed`, `superseded`). |
| `hypotenuse check-update` | Whether a newer release exists, with its changelog. |
| `hypotenuse upgrade` | Upgrade in place, by however it was installed (npm, bun, or binary). |

## Examples

```bash
hypotenuse --json whoami | jq -r .user.email
hypotenuse project use my-team
hypotenuse --json member list | jq '.memberships[] | {email: .user.email, tags: [.tags[].name]}'
hypotenuse invite create --email luigi@example.com --tag 3
hypotenuse --json audit list --since 1d --action membership:delete
hypotenuse --json linear status | jq '.installation | {status, organizationName, appUserId}'
hypotenuse --json session list --issue ENG-123 | jq '.agentSessions[] | {id, status}'
hypotenuse --json session view 42 | jq '.activities[] | {seq, direction, contentType, deliveryStatus}'
```
