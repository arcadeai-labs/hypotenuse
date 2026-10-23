---
name: hypotenuse
description: Operate a Hypotenuse server from the terminal with the `hypotenuse` CLI — sign in, pick a project, manage members, invites, tags, connect trigger integrations (Linear), register and manage runners, run this machine as a runner (config file, daemon, user service, doctor), edit routing rules and settings, point the project's telemetry at OpenTelemetry collectors, link Linear users to members, read and stop agent sessions, and read the audit log. Use when asked to administer Hypotenuse projects, check what @hypotenuse did on an issue, or check who changed what.
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
  chosen with `hypotenuse project use`, else the person's only project when they are in just one.
- The server is `--url`, else `HYPOTENUSE_URL`, else wherever `login` last signed in.
- `HYPOTENUSE_NO_UPDATE_CHECK=1` turns off the background update notice.

## Commands

| Command | Does |
|---|---|
| `hypotenuse login [--no-browser] [--device <name>]` | Sign in through the dashboard. A person must approve in a browser; `--no-browser` prints a code to type at `/cli/activate` on any device. Never ask for a password. |
| `hypotenuse logout` | Revoke this CLI's sign-in on the server and forget it locally. |
| `hypotenuse whoami` | Who this CLI is signed in as, on which server. |
| `hypotenuse project list\|view\|overview\|create\|edit\|delete\|use` | The caller's projects. `delete` needs `--yes`. `use <id\|slug>` selects the project later commands act on. `overview [--window 24h\|7d]` summarizes the selected project: Linear's connection and last webhook, runners online and slots busy, sessions in the window by status and role with median acknowledgement and claim times, and the turns waiting now with their reason codes. |
| `hypotenuse member list\|add\|remove` | The selected project's members. `add --email`, `remove <userId>` (admin). |
| `hypotenuse invite list\|pending\|create\|accept\|reject` | Invitations. `create --email [--tag <id>]` (admin); `pending` lists invites addressed to you; `accept`/`reject <inviteId>`. |
| `hypotenuse tag list\|create\|edit\|delete\|assign\|unassign` | Permission tags. `assign <tagId> --user <userId>` (admin). The `admin` tag is reserved. |
| `hypotenuse audit list [--since 7d] [--until <time>] [--action tag:edit]` | Who changed what, newest first (admin). Times are ISO-8601, epoch ms, or `7d` / `12h` / `30m`. |
| `hypotenuse integration list\|view\|connect\|disconnect` | The selected project's trigger integrations — today the only type is `linear`, its Linear workspace connection. `list` shows each type this server supports and whether the project is connected. `view <type>` shows the workspace, the `@hypotenuse` app user, scopes, and token health (never a token). `connect <type>` (admin) prints the consent URL — a **workspace admin** of that system (for `linear`, a Linear workspace admin) must approve it in a browser — and waits until the integration is active (`--no-browser`, `--timeout <seconds>`). `disconnect <type> --yes` (admin) revokes the tokens; the agent stops answering there at once. |
| `hypotenuse session list\|view\|cancel` | The selected project's agent sessions — each time `@hypotenuse` was delegated an issue or mentioned, in any trigger type (Linear today). `list [--status <status>] [--role manager\|worker] [--type linear] [--issue ENG-123] [--runner <id>]`, newest first; `view <id\|ENG-123>` (an issue identifier names its newest session) shows the session (issue, status, origin, role, runner, issuer, links), its turns (kind, status, runner, and for a waiting turn its reason code such as `offline` or `no_capacity`), and every activity in order, both directions, with each write's delivery status (`pending`, `sent`, `failed`, `superseded`); `--transcript` prints only the activities; `--follow [--interval <seconds>]` keeps printing new ones until interrupted (one JSON object per line under `--json`); `cancel <id>` stops its work as Stop in Linear does (work not started is cancelled; a running turn is told to stop and report). |
| `hypotenuse event list\|view` | The selected project's event log: every webhook its Linear workspace sent in the last 14 days and how each was routed. `list [--type AgentSessionEvent\|Issue\|…] [--outcome handled\|ignored\|duplicate_of_dispatch\|failed\|pending] [--hide-ignored] [--session <id>] [--since 12h]`, newest first, shows each event's issue, outcome, what it did, the role it was routed as and why (`worker (default)`, `manager (rule /manage)`, `worker (dispatched)`), and where its turn is now (`queued: no_capacity`, `running on <runner>`); `view <id>` shows one in full, with the payload Linear sent for project admins only. |
| `hypotenuse runner register\|list\|view\|edit\|revoke` | The selected project's runners — machines that run coding agents. `register [--name <name>] [--replace] [--force]` registers **this** machine as the signed-in person, saves the runner token to `credentials.json` (never printed), and sends a first heartbeat; `--replace` revokes the runner of that name first. `list [--status online\|offline\|draining\|revoked] [--all]`; `view <id\|name>` shows capabilities, subscriptions, and whether its socket is attached; `edit <id\|name> [--name] [--enable\|--disable]` renames or pauses it; `revoke <id\|name> --yes` revokes it for good (its owner or an admin). |
| `hypotenuse routing list\|add\|edit\|remove\|reorder\|preview\|settings` | The selected project's routing rules — the first enabled rule whose match holds decides whether a new session gets a **manager** or a **worker** (no match: worker). `list`; `add --name <name> --role manager\|worker [--label <l>] [--team <key>] [--linear-project <id>] [--prefix /manage] [--has-parent\|--no-parent] [--origin delegation\|mention] [--repository <repo>] [--disabled]` (labels and team keys are checked against the connected workspace); `edit <id>` with the same flags (any match flag replaces the whole match) plus `--enable\|--disable` and `--clear-repository`; `remove <id>`; `reorder <id...>` lists every rule id in the new order; `preview <ENG-123> [--prompt "/manage ..."] [--with-repository]` shows how the issue would route if delegated now — the matching rule, the role, every runner with whether it could take the work and its reason codes, and the repository (any member; `--with-repository` asks Linear to rank repositories, spending its API budget); `settings` shows the routing timers, `settings [--queue-timeout 30m] [--sticky-timeout 10m] [--offer-ttl 10s] [--stop-grace 30s] [--repository-confidence 0.7] [--max-review-rounds 3] [--reset <key>]` changes them. Changes are admin-only. |
| `hypotenuse telemetry exporter list\|view\|add\|edit\|remove\|test` | Where the selected project's OpenTelemetry goes: each exporter is an OTLP/HTTP collector that receives every turn as one trace, at a content level (`metadata`, `content`, or `full` — full sends prompts and source code). `list` and `view <id>` show endpoint, level, signals, sample share, header names (never values), and the last export or error (any member); `add --name <name> --endpoint <https-url> [--header KEY=VALUE...] [--content <level>] [--signals traces,metrics,logs] [--sample 0.5] [--attribute KEY=VALUE...] [--no-agent-native] [--disabled]`; `edit <id>` with the same flags plus `--clear-headers` and `--enable\|--disable` (headers are kept unless given); `remove <id>`; `test <id>` sends a probe and prints each signal's answer, exiting 1 on a failure. Changes and tests are admin-only; header values are never printed. |
| `hypotenuse identity list\|link\|unlink` | Links between people in the project's Linear workspace and project members; routing prefers the runners of whoever started a session. `list [--user <id>]` shows each link and how it was made (e-mail match, Linear sign-in, admin); `link --user <id> --linear-user <id> [--name] [--email]` links one (admin); `unlink <id>` removes your own link, or anyone's as an admin. |
| `hypotenuse config init\|validate\|schema\|path` | The daemon's TOML config (`-c <path>`, else `HYPOTENUSE_CONFIG`, else `~/.config/hypotenuse/config.toml`). `init [--repo <path>...] [--force]` writes a commented starter filled in from this machine; `validate [--online] [--offline]` checks shape, references, and this machine (git clones, prompt files, agent commands), and with `--online` the server, runner token, project, and team keys — exit 0 valid (warnings allowed), 1 errors, 2 unreadable; `--json` prints `{ valid, errors: [{ path, message, hint? }], warnings }`. `schema` prints the JSON Schema; `path` prints the config, state directory, and credentials file in use. |
| `hypotenuse daemon start\|stop\|restart\|status\|logs\|reload` | The runner daemon. `start` backgrounds it and waits until it is ready (`--foreground` stays attached, as a service manager runs it; `--log-level <level>` overrides `[log] level`, and `debug` logs every agent activity); `stop [--timeout 10m] [--cancel]` lets running turns finish (or stops them) and exits, `--force` signals it without its control socket; `status` exits 3 when it is not running; `logs [-f] [-n 200] [--session <id>]` (`--session` shows that session's agent log: the agent's stderr and ACP trace); `reload` re-reads the config and says what needs a restart — the daemon also watches its config file, reloading on save and restarting itself (after running turns finish) when a change needs it. One daemon per machine. |
| `hypotenuse agents list\|kill\|login` | The coding agents this machine runs. `list [--all]` shows the agent sessions the daemon is running (session, issue, role, agent, state, how long, pid, worktree); `kill <session-id\|ENG-123> [--reason]` stops that session's running turn, which says so in Linear (with the reason); both exit 3 when the daemon is not running. `login <agent> [--method <id>]` logs a coding agent in on this machine — a terminal login runs attached, an agent-run one over ACP — then confirms it can open a session (exit 1 if not). |
| `hypotenuse worktrees list\|cleanup` | The git worktrees (and scratch directories) the daemon made for its sessions, one per session under `sessions.worktree_root`. `list` shows each one's repository, branch, issue, state, last use, size, and whether it is safe to remove now (not in use, no uncommitted changes, no unpushed commits, no `.hypotenuse-keep` file). `cleanup [--dry-run] [--all] [--older-than 7d] [--force]` removes what the cleanup policy allows and prints every kept one with its reason; `--all` ignores the policy, `--force` overrides every rule but "in use". Both work without a running daemon, from `state.db` and the disk. |
| `hypotenuse service install\|uninstall\|status` | Run the daemon as a user service (launchd on macOS, systemd user unit on Linux) with the `PATH` of the installing shell; `install --print` shows the unit without installing it. Windows: prints the foreground command and the Task Scheduler recipe. |
| `hypotenuse doctor [--agent <id>] [--offline]` | A checklist of this machine's runner setup — version, tools, config, credentials, server and token, daemon and service, agents, repositories, disk — exit 1 when a check fails. `--agent <id>` starts that agent, runs the ACP `initialize` handshake, and opens a session — a failure names `hypotenuse agents login <id>`. |
| `hypotenuse mcp --session <id> --nonce <n>` | Hidden: the stdio MCP server the daemon hands a coding agent for one turn — the Linear tools scoped to that session. Not for running by hand. |
| `hypotenuse check-update` | Whether a newer release exists, with its changelog. |
| `hypotenuse skill` | Print this skill, the same text on every install (npm or binary); `--json` wraps it as `{ skill }`. |
| `hypotenuse upgrade [--no-restart]` | Upgrade in place, by however it was installed (npm, bun, or binary), then drain and restart a running daemon on the new version. |

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
hypotenuse --json config validate | jq -r '.errors[] | "\(.path): \(.message)"'
hypotenuse daemon start && hypotenuse --json daemon status | jq '{connected: .server.connected, slots}'
```
