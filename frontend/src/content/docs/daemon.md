# The daemon

The `hypotenuse` daemon is what makes a machine a [runner](/docs/runners). It keeps the machine connected to the
project, takes the work routed to it, runs it, and reports back. It reads one config file, keeps its own small
database, and runs until you stop it — as a user service it starts at login and comes back after a crash.

Each turn it takes runs a [coding agent](/docs/agents) on this machine.

## Set up a machine

Install the CLI ([how](/docs/cli#installing)), then:

```bash
hypotenuse login                         # approve the CLI in your browser
hypotenuse project use acme
hypotenuse runner register               # this machine, named after its host
hypotenuse config init --repo ~/code/web # a starter config, filled in from the clone
hypotenuse config validate --online      # checks the file, this machine, and the server
hypotenuse daemon start
```

`config init` writes `~/.config/hypotenuse/config.toml` with the server you signed in to, the coding agent it found
on this machine, and each `--repo` you named (its name, its `origin`, and its default branch). Everything else is a
commented example. Every key is in the [config file reference](/docs/config).

## Check the config

```bash
$ hypotenuse config validate
✕ roles.worker.agent: unknown agent "codx" (did you mean "codex"?)
✕ repositories[1].path: ~/code/api-old is not a git repository
! repositories[0].base_branch: "trunk" not found on origin (github.com/acme/web)
2 errors, 1 warning
```

Validation names the exact key that is wrong. It checks the file's shape (an unknown key is an error, never ignored),
the references between tables, and this machine: each repository is a clone whose `origin` matches, prompt files
exist, each agent's command is on your `PATH`. `--online` also asks the server whether the runner token works, the
project matches, and your `[subscriptions] teams` exist in the Linear workspace. It exits `0` when the file is
valid, `1` on errors, and `2` when the file cannot be read; `--json` prints the findings for scripts.

The daemon runs the same checks when it starts and refuses an invalid file rather than starting half-configured.

## Start, stop, and look

| Command | Does |
|---|---|
| `hypotenuse daemon start` | starts it in the background and waits until it is connected and ready — or prints why it is not |
| `hypotenuse daemon status` | the runner, the server connection, busy slots, and events waiting to be sent; exits `3` when the daemon is not running |
| `hypotenuse daemon logs -f` | follows the log; `--session <id>` shows one session's agent log instead — the agent's output and every message exchanged with it |
| `hypotenuse daemon reload` | re-reads the config (as `kill -HUP` does) and says which changes need a restart |
| `hypotenuse daemon stop` | takes no new work, lets running turns finish (up to `--timeout`, 10 minutes), then exits |
| `hypotenuse daemon stop --cancel` | stops running turns at once; each says in Linear where it was stopped |
| `hypotenuse daemon restart` | stop, then start |

**Reload** applies what is safe at once — roles, subscriptions, limits, the log level, prompts and policies for new
turns, new repositories — and forgets that an agent was found logged out, so it is offered work again. Changing the server, an existing repository's path, or the command of an agent that is
running needs `hypotenuse daemon restart`, and `reload` says so instead of half-applying it.

If a daemon stops answering, `daemon stop` says so and suggests `hypotenuse daemon stop --force`, which stops the
process without its help and clears its lock. Work it held returns to the queue after its lease lapses.

## One daemon per machine

A machine runs one daemon, whatever config it reads. A second `daemon start` — even with another `-c` file — finds
the first and refuses. Hypotenuse also refuses a second runner on the same machine, which covers a second user on a
shared build box. To serve two projects from one machine, register it in the one that needs it more.

## Run it as a service

```bash
hypotenuse service install     # launchd on macOS, a systemd user unit on Linux
hypotenuse service status
hypotenuse service uninstall
```

The service runs `hypotenuse daemon start --foreground` for your user (never system-wide), starts at login, and
restarts it after a crash — but not after a problem a restart cannot fix, such as an invalid config or a revoked
runner. It records the `PATH` of the shell you installed it from, because services start with almost none and
agents need `npx`, `node`, `git`, and `gh`; run `service install` again after you install new tools. On Linux,
`loginctl enable-linger $USER` keeps it running while you are logged out. `service install --print` shows the unit
without installing it.

### Windows

There is no Windows service yet. Run the daemon in a terminal with `hypotenuse daemon start --foreground`, or start
it at logon with Task Scheduler: create a task that runs at log on of your user, with the action
`hypotenuse.exe daemon start --foreground` and *Start in* your home directory, and untick *Stop the task if it runs
longer than*.

## Upgrading

`hypotenuse upgrade` installs the new release and then hands a running daemon over to it: the daemon finishes the
turns it is running (up to ten minutes), then restarts on the new version — under a service, the service manager
restarts it. `hypotenuse upgrade --no-restart` leaves the old version running until you `daemon restart`. On
Windows, stop the daemon before upgrading.

## When the network goes away

The daemon is built for laptops. While the server is unreachable — a train, a closed lid, a deploy — a running turn
keeps going and everything it reports is kept on disk, then sent in order when the connection returns, once each.
Passing "still thinking" updates that would be stale by then are dropped. A turn interrupted by the machine
sleeping too long, or by the daemon being killed, goes back to the queue and returns to this runner when it is back.

## Revocation

When a runner is revoked, its daemon stops at once and logs
`runner revoked on the server; run "hypotenuse runner register" to re-register`. It will not start again with that
token, so a revoked laptop in a drawer stays quiet. Register again for a new one.

## `hypotenuse doctor`

When a runner is not picking anything up, run `hypotenuse doctor`. It checks, in order: the version and whether an
update exists; `git`, `gh`, and Bun; the config file; the credentials; the server, the runner token, latency and
clock skew; the daemon and its service; each agent's command; each repository's origin; and free disk space. Each
line is ✓, ! (a warning), or ✕, and it exits `1` if anything failed. `hypotenuse doctor --agent claude` also starts
that agent, asks it to introduce itself, and opens a session, which shows whether it needs you to log in first —
`hypotenuse agents login claude` does that ([coding agents](/docs/agents#logging-in)).

## Files

| What | Where |
|---|---|
| Config | `~/.config/hypotenuse/config.toml` (`-c <path>` or `HYPOTENUSE_CONFIG` for another) |
| Credentials | `~/.config/hypotenuse/credentials.json`, readable only by you; the daemon refuses it otherwise |
| State, log, control socket | `~/.local/state/hypotenuse/` — or, for a config elsewhere, `.hypotenuse-state/` beside it |
| Session logs | `sessions/<session>.log` in the state directory |
| Worktrees | `~/.hypotenuse/worktrees/<repository>/<ISSUE>` (`sessions.worktree_root`) — [worktrees](/docs/worktrees) |

`hypotenuse config path` prints the ones in use.
