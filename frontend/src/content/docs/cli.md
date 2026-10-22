# The CLI

`hypotenuse` is the command line for Hypotenuse. It signs in to a server through your browser and does from a
terminal what you can click in the dashboard: pick a project, add members, send invites, manage tags, connect
integrations such as Linear, register your machine as a runner, decide how work is routed, read and stop `@hypotenuse`'s agent sessions, and read the audit log. It is also the runner itself: `hypotenuse daemon` turns this machine into one ([the daemon](/docs/daemon)).

## Installing

Four ways, all the same program:

```bash
# macOS and Linux: a self-contained binary in /usr/local/bin
curl -fsSL https://raw.githubusercontent.com/arcadeai-labs/hypotenuse/main/install.sh | bash

# Windows (PowerShell): a binary in %LOCALAPPDATA%\hypotenuse, added to your PATH
irm https://raw.githubusercontent.com/arcadeai-labs/hypotenuse/main/install.ps1 | iex

# npm or bun
npm i -g @arcadeai/hypotenuse
bun i -g @arcadeai/hypotenuse
```

The binaries need nothing else. **npm and bun installs need [Bun](https://bun.sh) on the machine**, because the
package is a Bun program — it is not enough to have Node.

The install scripts take `HYPOTENUSE_INSTALL_DIR` to put the binary somewhere else and `HYPOTENUSE_VERSION` to pin a
release, e.g. `HYPOTENUSE_VERSION=0.1.0`.

## Signing in

```bash
hypotenuse login
```

Your browser opens a page on the dashboard asking **Sign in the hypotenuse CLI on _this machine_?** Sign in there
if you are not already — with whatever you use to sign in on the web — and click **Approve**. The terminal finishes
by itself. You never type a password into the terminal.

On a machine with no browser — an SSH session, a build box — use a code instead:

```bash
hypotenuse login --no-browser
```

It prints a URL (`/cli/activate` on the dashboard) and a code like `WDJB-MJHT`. Open the URL on any device, sign
in, type the code, and approve. The code works once and expires after ten minutes.

`--device <name>` sets the name the dashboard shows for this machine; it defaults to the hostname.

`hypotenuse whoami` shows who you are signed in as and where. `hypotenuse logout` signs this CLI out: it revokes
the sign-in on the server and forgets it on this machine.

## Signed-in CLIs

Every CLI signed in as you is listed under **Account → CLI sign-ins**, with the machine's name, when it signed in,
when it was last used, and when it expires. **Revoke** signs that CLI out on its next command.

A sign-in lasts 90 days from the last day it was used, so a CLI you use stays signed in and one you forget lapses on
its own. It acts as you in every project you belong to — no more — and leaving a project takes away its access
there at once. It can never approve another CLI; that always takes the dashboard.

## Choosing a server and a project

Commands talk to the server you last signed in to. To use another, pass `--url` or set `HYPOTENUSE_URL`:

```bash
hypotenuse login --url http://localhost:8080
```

| Highest wins | Server |
|---|---|
| 1 | `--url <origin>` |
| 2 | `HYPOTENUSE_URL` |
| 3 | where `hypotenuse login` last signed in |
| 4 | `[server] url` in `~/.config/hypotenuse/config.toml` |
| 5 | `https://api.hypotenuse.cloud` |

The daemon reads its config first: `--url`, then `HYPOTENUSE_URL`, then `[server] url`, then the only server this
machine has a runner on.

Commands about a project act on the one you select:

```bash
hypotenuse project list
hypotenuse project use my-team        # by slug or id; remembered per server
hypotenuse --project 12 member list   # or name it for one command (also HYPOTENUSE_PROJECT)
```

## Commands

| Command | Does |
|---|---|
| `login`, `logout`, `whoami` | sign in and out, as above |
| `project list`, `view`, `overview [--window 24h\|7d]`, `create --name`, `edit <project> --name`, `delete <project> --yes`, `use <project>` | your projects; `overview` is the project home, below |
| `member list`, `add --email`, `remove <userId>` | the selected project's members |
| `invite list`, `pending`, `create --email [--tag <id>]`, `accept <id>`, `reject <id>` | invitations; `pending` lists the ones addressed to you |
| `tag list`, `create <name>`, `edit <id> --name`, `delete <id>`, `assign <id> --user <userId>`, `unassign <id> --user <userId>` | permission tags |
| `audit list [--since 7d] [--until <time>] [--action tag:edit]` | the audit log; times are ISO-8601, epoch milliseconds, or `7d` / `12h` / `30m` ago |
| `integration list`, `view <type>`, `connect <type> [--no-browser] [--timeout <seconds>]`, `disconnect <type> [--yes]` | the selected project's integrations — today `linear` — below |
| `session list [--type linear] [--status <status>] [--role <role>] [--issue ENG-123] [--runner <id>]`, `view <id\|ENG-123> [--transcript] [--follow]`, `cancel <id>` | the selected project's agent sessions, below |
| `event list [--type <eventType>] [--outcome <outcome>] [--hide-ignored] [--session <id>] [--since 7d]`, `view <id>` | the selected project's event log: Linear's webhooks and how each was routed, below |
| `runner register [--name <name>] [--replace] [--force]`, `list [--status <status>] [--all]`, `view <runner>`, `edit <runner> [--name] [--enable\|--disable]`, `revoke <runner> [--yes]` | the selected project's runners, below |
| `routing list`, `add --name <name> --role manager\|worker [match flags] [--repository <repo>] [--disabled]`, `edit <id> [...]`, `remove <id>`, `reorder <id...>`, `preview <ENG-123> [--prompt <text>] [--with-repository]`, `settings [...]` | the selected project's routing rules and settings, below |
| `identity list [--user <id>]`, `link --user <id> --linear-user <id> [--name] [--email]`, `unlink <id>` | links between Linear users and project members, below |
| `config init [--repo <path>...]`, `validate [--online]`, `schema`, `path` | the daemon's config file — [the daemon](/docs/daemon), [every key](/docs/config) |
| `daemon start [--foreground]`, `stop [--timeout] [--cancel] [--force]`, `restart`, `status`, `logs [-f] [--session <id>]`, `reload` | run this machine as a runner — [the daemon](/docs/daemon) |
| `agents list [--all]`, `kill <session\|issue> [--reason]`, `login <agent> [--method <id>]` | the coding agents this machine runs — [coding agents](/docs/agents) |
| `worktrees list`, `cleanup [--dry-run] [--all] [--older-than <duration>] [--force]` | the git worktrees the daemon made for its sessions — [worktrees](/docs/worktrees) |
| `service install [--print]`, `uninstall`, `status` | the daemon as a launchd or systemd user service |
| `doctor [--agent <id>] [--offline]` | check this machine's runner setup end to end |
| `check-update`, `upgrade [--no-restart]` | updates, below; `upgrade` also restarts a running daemon on the new version |

Admin-only commands are refused for members with the same message the dashboard shows. `hypotenuse <command>
--help` lists each command's options.

### Integrations

An integration connects the project to a system that starts agent work. Linear is the first kind, and its type is
`linear`; other kinds may follow, each under its own type, and the same commands will cover them.
`hypotenuse integration list` shows every kind the server knows and whether the project has connected it.

`hypotenuse integration view linear` shows which Linear workspace the project is connected to, the `@hypotenuse`
app user, the granted scopes and teams, when its token expires, when Linear's last webhook arrived, and what became
of the most recent ones (`handled`, `ignored`, `failed`, …). It never shows a token.

`hypotenuse integration connect linear` (project admins) prints the address of Linear's consent screen and opens it in your
browser; `--no-browser` only prints it, for SSH. Whoever opens it must be an **admin of the Linear workspace**,
signed in to the dashboard as you. Once they approve, Linear sends the browser back to the dashboard and the
command prints the connection. It waits five minutes by default; if the dashboard shows an error, the command
times out and the dashboard says why. Running it again on a connected project reconnects the same workspace.

`hypotenuse integration disconnect linear` (project admins) revokes the app's tokens at Linear, which uninstalls
`@hypotenuse` from the workspace at once. It asks first; `--yes` skips the question, and is required when the
command is not run from a terminal.

What the consent screen asks for, and what each error means, is in [Connecting Linear](/docs/connecting-linear).

### Agent sessions

Every time someone in the connected workspace delegates an issue to `@hypotenuse` or mentions it, Linear opens an
agent session, and Hypotenuse keeps a copy, marked with the integration it came from (`linear`).
`hypotenuse session list` shows them, newest first: the issue, its
status as Linear reports it (`pending`, `active`, `awaitingInput`, `error`, `complete`, `stale`, `stopping`), and
whether it started from a delegation or a mention. `--type`, `--status`, `--role`, and `--issue ENG-123` narrow the list.

`hypotenuse session view <id>` shows one session and its whole conversation in order: what people typed into it,
and everything Hypotenuse wrote back, each with its delivery status — `sent`, `pending` while it waits its turn or
Linear's rate limit, `failed` when Linear refused it, or `superseded` when a later activity replaced it before it was
sent. Give it an issue identifier instead (`hypotenuse session view ENG-123`) and it shows the newest session on that
issue. Above the conversation it lists the session's runner and its owner, the Hypotenuse member who started it
when their Linear account is linked, and its **turns** — each piece of work the session took, where it ran, and,
for one still waiting, why, as one of the [reason codes](/docs/routing#why-work-waits) (`offline`, `no_capacity`,
…). `--transcript` prints only the conversation. `--follow` keeps printing new activities as they arrive, re-reading
every two seconds (`--interval <seconds>`), until you press Ctrl-C; with `--json` each new activity is one line of
JSON. `session list --runner <id>` lists the sessions a runner holds.

For a session a manager dispatched, `session view` names the planning session it came from; for a planning session,
it lists every issue it dispatched with the worker's status, its review round, and its pull requests.

`hypotenuse session cancel <id>` stops a session's work, as pressing **Stop** in Linear does: work no runner has
started is cancelled and the session says so; a running turn is told to stop and report the state it left things in.
What Linear shows names you. A session waiting on a question it asked is answered and stopped; a session with
nothing to stop is refused. Any member can do it.

### Events

`hypotenuse event list` is the project's event log: every webhook its Linear workspace sent in the last 14 days,
newest first — the event, the issue, its outcome (`handled`, `ignored`, `duplicate_of_dispatch`, `failed`,
`pending`, and for inbox notifications `noted`, `mention_without_session`, `assigned_not_delegated`, `disengaged`), how the session was **routed as** (`worker (default)`, `manager (rule /manage)`, `worker
(dispatched)`), where its **turn** is now (`queued: no_capacity`, `running on dev-laptop`, `cancelled: stop`), and a
one-line summary of what Hypotenuse did. `--type Issue`, `--outcome failed`, `--session <id>`, and `--since 12h`
narrow it; `--hide-ignored` leaves out the issue changes Hypotenuse does not act on.

`hypotenuse event view <id>` shows one event in full. Project admins also get the payload exactly as Linear sent
it; members are told it is for admins, because it can describe issues `@hypotenuse` was never asked about.

### The project at a glance

`hypotenuse project overview` is the dashboard's home page in the terminal: whether Linear is connected and when
its last webhook arrived (and how many failed), how many runners are online, draining, and offline and how many of
their slots are busy, the sessions started in the last day by status and role — with the median time to the first
acknowledgement and to a runner taking the work — and every piece of work waiting right now, with its reason code
and how long it has waited. `--window 7d` counts the last week instead.

### Routing

`hypotenuse routing list` shows the project's routing rules in the order they are tried. The first enabled rule
whose match holds for a new session decides whether a **manager** or a **worker** answers it; when none matches, a
worker does. Every project starts with four rules: `/manage` and `/work`, which match a mention beginning with that
word; one sending issues labelled `hypotenuse:manager` to a manager; and one, disabled, sending top-level issues in a
project with no PRD yet to a manager. [Routing](/docs/routing) explains the whole decision.

`hypotenuse routing add --name <name> --role manager|worker` adds a rule at the end. The match flags are all
optional, and every one given must hold:

| Flag | Matches when |
|---|---|
| `--label <labels>` | the issue has any of these labels (repeatable, or comma-separated) |
| `--team <keys>` | the issue is in one of these teams, by key (`ENG`) |
| `--linear-project <ids>` | the issue is in one of these Linear projects, by id |
| `--prefix /manage` | the mention starts with this word |
| `--has-parent`, `--no-parent` | the issue is, or is not, a sub-issue |
| `--project-has-content`, `--project-empty` | the issue's Linear project has, or has no, content (its PRD) yet |
| `--origin delegation\|mention` | the session started that way |

`--repository <repo>` also pins the repository the work happens in, and `--disabled` adds the rule switched off.
Labels and team keys are checked against the connected Linear workspace; a project with no working connection skips
the check and says so.

`hypotenuse routing edit <id>` takes the same flags; any match flag replaces the rule's whole match. `--enable` and
`--disable` switch it on and off, and `--clear-repository` removes the pin. `hypotenuse routing remove <id>` deletes
a rule, and `hypotenuse routing reorder <id...>` sets the order, listing every rule id, first tried first.

`hypotenuse routing preview ENG-123` shows what would happen if the issue were delegated now: the rule that
matches and the role it picks, every runner with whether it could take the work and each
[reason](/docs/routing#why-work-waits) it could not, and the repository it would use. `--prompt "/manage plan it"`
previews a mention with that text instead of a delegation. `--with-repository` asks Linear to rank the candidate
repositories, which spends the workspace's Linear API budget; without it, several candidates are listed unranked.
Any member may preview.

`hypotenuse routing settings` shows how long work waits: the queue timeout, how long a follow-up waits for the
runner that has its worktree, how long an offer to a runner stands, how long a stopped runner has to confirm, and how
sure Linear must be of a repository before Hypotenuse picks it without asking. Change them with `--queue-timeout 45m`,
`--sticky-timeout 10m` (`0` never waits), `--offer-ttl 10s`, `--stop-grace 30s`, `--repository-confidence 0.7`, and
`--max-review-rounds 3`; `--reset <key>` returns one to its default. It also shows what a
[manager](/docs/manager-and-worker) may do: `--max-parallel-dispatch 3` caps the dispatched workers one planning
session has under way, and `--manager-can-complete yes|no` decides whether a manager may move an issue to a completed
or canceled state (no by default; a worker never may).

Reading rules and settings is open to every member; changing them is for project admins.

### Identities

When someone starts a session, Hypotenuse prefers runners owned by that person. It recognises them by a project member
with the same e-mail as their Linear account, or by a link an admin made. `hypotenuse identity list` shows the links
and how each was made. `hypotenuse identity link --user <id> --linear-user <id>` links a Linear user to a member
(admins only), and `hypotenuse identity unlink <id>` removes a link — your own, or anyone's as an admin. Linking
yourself by signing in to Linear is not available yet. A link only changes which runner is preferred, never what
anyone may do.

### Runners

A runner is a machine that runs coding agents for the project. `hypotenuse runner register` registers **this**
machine, owned by you, in the selected project. It is named after the machine unless you pass `--name`. Its token
is saved in `credentials.json`, never printed. The command then checks in with the server once, so the runner shows
up with its machine details straight away, and fails loudly if the token does not work. Names are unique in a project:
`--replace` revokes the runner with that name and registers a new one, which is also how you replace a token you
think has leaked. A machine holds one runner per server, so registering into a different project needs `--force`.
Without it, the CLI refuses to orphan the runner you already have.

`hypotenuse runner list` shows the project's runners: who owns each, whether it is `online`, `draining`, or
`offline`, how much work it is doing out of how much it takes, and its last check-in. `--all` includes revoked
runners. `hypotenuse runner view <runner>` (by id or name) adds what the server last heard: roles, agents,
repositories, the teams, projects, and labels it takes work from, and whether its live connection is attached.

`hypotenuse runner edit <runner> --disable` pauses a runner: it stays connected but is offered no work, until
`--enable`. `--name` renames it. `hypotenuse runner revoke <runner>` revokes it for good. Its token stops working and
its daemon is told to stop at once. If it is this machine's runner, the token is removed from `credentials.json`.
Editing and revoking are for the runner's owner or a project admin. [Runners](/docs/runners) explains what a runner
can and cannot do for you.

## Output and scripting

Tables and messages are for people; add `--json` (`-j`) and stdout carries the server's answer as JSON, with no
color, ready for `jq`:

```bash
hypotenuse --json member list | jq -r '.memberships[].user.email'
```

Lists take `--page` and `--limit` (25 by default). A command that fails exits non-zero and says why on stderr, so
stdout is only ever data. `-v` prints each request. Color follows the terminal: it is off when output is piped, under
`NO_COLOR` or `--no-color`, and forced on by `FORCE_COLOR` or `--force-color`.

## Updating

```bash
hypotenuse check-update   # is there a newer release, and what changed
hypotenuse upgrade        # install it, the same way this copy was installed
```

`upgrade` uses npm or bun for those installs and swaps the binary in place for the others. **On Windows**, a
running program cannot be replaced, so `upgrade` prints the install line to run instead.

Once a day the CLI checks for a new release in the background and mentions it after a command finishes. Set
`HYPOTENUSE_NO_UPDATE_CHECK=1` to turn that off; it is never shown when output is piped or under `--json`.

## Files

Everything lives in `~/.config/hypotenuse/` (or `$XDG_CONFIG_HOME/hypotenuse/`):

- `credentials.json` — your sign-in and this machine's runner token for each server, readable only by you. Keep it
  private: it acts as you. The CLI refuses to read it if other users can (`chmod 600` it, as the error says).
- `config.toml` — the daemon's config ([every key](/docs/config)).
- `update.json` — when the update check last ran.

The daemon keeps its database, log, and control socket in `~/.local/state/hypotenuse/`. `hypotenuse config path`
prints the files in use.
