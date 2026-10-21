---
name: hypotenuse
description: Operate a Hypotenuse server from the terminal with the `hypotenuse` CLI — sign in, pick a project, manage members, invites, tags, connect trigger integrations (Linear), register and manage runners, edit routing rules and settings, link Linear users to members, read and stop agent sessions, and read the audit log. Use when asked to administer Hypotenuse projects, check what @hypotenuse did on an issue, or check who changed what.
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
| `hypotenuse integration list\|view\|connect\|disconnect` | The selected project's trigger integrations — today the only type is `linear`, its Linear workspace connection. `list` shows each type this server supports and whether the project is connected. `view <type>` shows the workspace, the `@hypotenuse` app user, scopes, and token health (never a token). `connect <type>` (admin) prints the consent URL — a **workspace admin** of that system (for `linear`, a Linear workspace admin) must approve it in a browser — and waits until the integration is active (`--no-browser`, `--timeout <seconds>`). `disconnect <type> --yes` (admin) revokes the tokens; the agent stops answering there at once. |
| `hypotenuse session list\|view\|cancel` | The selected project's agent sessions — each time `@hypotenuse` was delegated an issue or mentioned, in any trigger type (Linear today). `list [--status <status>] [--role manager\|worker] [--type linear] [--issue ENG-123]`, newest first; `view <id>` shows the session (issue, status, origin, role, links) and every activity in order, both directions, with each write's delivery status (`pending`, `sent`, `failed`, `superseded`).; `cancel <id>` stops its work as Stop in Linear does (work not started is cancelled; a running turn is told to stop and report). |
| `hypotenuse runner register\|list\|view\|edit\|revoke` | The selected project's runners — machines that run coding agents. `register [--name <name>] [--replace] [--force]` registers **this** machine as the signed-in person, saves the runner token to `credentials.json` (never printed), and sends a first heartbeat; `--replace` revokes the runner of that name first. `list [--status online\|offline\|draining\|revoked] [--all]`; `view <id\|name>` shows capabilities, subscriptions, and whether its socket is attached; `edit <id\|name> [--name] [--enable\|--disable]` renames or pauses it; `revoke <id\|name> --yes` revokes it for good (its owner or an admin). |
| `hypotenuse routing list\|add\|edit\|remove\|reorder\|settings` | The selected project's routing rules — the first enabled rule whose match holds decides whether a new session gets a **manager** or a **worker** (no match: worker). `list`; `add --name <name> --role manager\|worker [--label <l>] [--team <key>] [--linear-project <id>] [--prefix /manage] [--has-parent\|--no-parent] [--origin delegation\|mention] [--repository <repo>] [--disabled]` (labels and team keys are checked against the connected workspace); `edit <id>` with the same flags (any match flag replaces the whole match) plus `--enable\|--disable` and `--clear-repository`; `remove <id>`; `reorder <id...>` lists every rule id in the new order; `settings` shows the routing timers, `settings [--queue-timeout 30m] [--sticky-timeout 10m] [--offer-ttl 10s] [--stop-grace 30s] [--repository-confidence 0.7] [--max-review-rounds 3] [--reset <key>]` changes them. Changes are admin-only. |
| `hypotenuse identity list\|link\|unlink` | Links between people in the project's Linear workspace and project members; routing prefers the runners of whoever started a session. `list [--user <id>]` shows each link and how it was made (e-mail match, Linear sign-in, admin); `link --user <id> --linear-user <id> [--name] [--email]` links one (admin); `unlink <id>` removes your own link, or anyone's as an admin. |
| `hypotenuse check-update` | Whether a newer release exists, with its changelog. |
| `hypotenuse upgrade` | Upgrade in place, by however it was installed (npm, bun, or binary). |

## Examples

```bash
hypotenuse --json whoami | jq -r .user.email
hypotenuse project use my-team
hypotenuse --json member list | jq '.memberships[] | {email: .user.email, tags: [.tags[].name]}'
hypotenuse invite create --email luigi@example.com --tag 3
hypotenuse --json audit list --since 1d --action membership:delete
hypotenuse --json integration view linear | jq '.integration | {type, status, workspaceName, externalAppUserId}'
hypotenuse --json session list --issue ENG-123 | jq '.agentSessions[] | {id, status}'
hypotenuse --json runner list | jq '.runners[] | {name, status, owner: .owner.name}'
hypotenuse --json session view 42 | jq '.activities[] | {seq, direction, contentType, deliveryStatus}'
```
