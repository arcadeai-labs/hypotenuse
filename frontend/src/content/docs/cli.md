# The CLI

`hypotenuse` is the command line for Hypotenuse. It signs in to a server through your browser and does from a
terminal what you can click in the dashboard: pick a project, add members, send invites, manage tags, connect
integrations such as Linear, read `@hypotenuse`'s agent sessions, and read the audit log. Later releases add the runner daemon that runs coding agents on your machine.

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
| `project list`, `view`, `create --name`, `edit <project> --name`, `delete <project> --yes`, `use <project>` | your projects |
| `member list`, `add --email`, `remove <userId>` | the selected project's members |
| `invite list`, `pending`, `create --email [--tag <id>]`, `accept <id>`, `reject <id>` | invitations; `pending` lists the ones addressed to you |
| `tag list`, `create <name>`, `edit <id> --name`, `delete <id>`, `assign <id> --user <userId>`, `unassign <id> --user <userId>` | permission tags |
| `audit list [--since 7d] [--until <time>] [--action tag:edit]` | the audit log; times are ISO-8601, epoch milliseconds, or `7d` / `12h` / `30m` ago |
| `integration list`, `view <type>`, `connect <type> [--no-browser] [--timeout <seconds>]`, `disconnect <type> [--yes]` | the selected project's integrations — today `linear` — below |
| `session list [--type linear] [--status <status>] [--role <role>] [--issue ENG-123]`, `view <id>` | the selected project's agent sessions, below |
| `check-update`, `upgrade` | updates, below |

Admin-only commands are refused for members with the same message the dashboard shows. `hypotenuse <command>
--help` lists each command's options.

### Integrations

An integration connects the project to a system that starts agent work. Linear is the first kind, and its type is
`linear`; other kinds may follow, each under its own type, and the same commands will cover them.
`hypotenuse integration list` shows every kind the server knows and whether the project has connected it.

`hypotenuse integration view linear` shows which Linear workspace the project is connected to, the `@hypotenuse`
app user, the granted scopes and teams, and when its token expires. It never shows a token.

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
sent.

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

- `credentials.json` — your sign-in for each server, readable only by you. Keep it private: it acts as you.
- `update.json` — when the update check last ran.
