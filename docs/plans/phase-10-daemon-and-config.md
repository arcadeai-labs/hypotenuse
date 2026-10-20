# Phase 10 — The daemon and its config file

> **Goal:** `hypotenuse daemon start` turns a person's machine into a runner. The daemon reads a validated
> TOML config file, holds the runner's connection to the server (heartbeat over HTTP, a content-free ping over
> WebSocket), runs up to `max_parallel_jobs` jobs in slots (with optional per-role and per-agent limits), keeps its own state in `bun:sqlite`, and
> answers the CLI's `daemon`, `agents`, and `worktrees` commands over a local control socket. It survives
> laptop sleep, Wi-Fi changes, server deploys, and its own upgrade without losing a session's events.

> **Status: planned, not built.** It depends on [runners](./phase-08-runners.md), which gives it a token and the
> `daemon:*` actions, and on [the CLI and distribution](./phase-05-cli-and-distribution.md), which gives it a
> binary, a logger, a shutdown registry, and `upgrade`. The [ACP agent host](./phase-11-acp-agent-host.md)
> and [worktrees](./phase-12-worktrees-and-session-lifecycle.md) plug into the slots this phase creates.

Before this phase, the server can route a work item to a runner and nothing claims it. The runner is a row and a
token. This phase is the process at the other end of that token: the part that has to be correct on hardware we
do not own, behind networks we do not control, configured by a person in a text editor.

Three things make that harder than it sounds, and each one shapes the design below:

1. **The config file is the product's main user interface on the runner side.** It names coding agents,
   repositories, prompts, and policies, and most of its mistakes would otherwise surface twenty minutes later,
   in Linear, as an `error` activity on somebody else's issue. So validation has to be good enough to be the
   first thing anyone runs, and the daemon refuses to start on an invalid file rather than starting degraded.
2. **The network is not reliable and the daemon cannot assume the server is up.** The heartbeat is the
   correctness channel and the WebSocket is an accelerant, exactly as on the server
   ([`ARCHITECTURE.md`](../ARCHITECTURE.md#websocket-channels)). Events produced while the server is
   unreachable are persisted locally and replayed in order, so a deploy of `hypotenuse-api` in the middle of a
   turn costs latency and nothing else.
3. **The process lives for weeks.** It is installed as a user service, it upgrades itself, and it holds child
   processes (coding agents) that must not outlive it. Shutdown and restart are designed, not incidental.

## Scope

**In:**

- **The config file:**
  - a zod schema (`cli/src/config/schema.ts`), the TOML loader, and env/flag precedence;
  - `config init`, `config validate` (with `--online`), `config schema`, and `config path`;
  - the reference document [`CONFIG.md`](../CONFIG.md).
- **The credentials file** (`credentials.json`): written by `runner register` and read by the daemon.
- **The daemon process:**
  - foreground and background modes, a pidfile, and the `daemon start|stop|restart|status|logs` commands;
  - the **supervisor** and its session slots;
  - **ServerLink**: heartbeat, WebSocket, reconnect, and the offline event queue;
  - the local **state database** and its migrations;
  - the **control socket** and its JSON-RPC methods;
  - config hot reload on `SIGHUP` (safe keys only);
  - graceful shutdown through the `Closeable` registry;
  - drain-and-re-exec after `hypotenuse upgrade`.
- **User-service management:** `service install|uninstall|status` for launchd (macOS) and systemd user units
  (Linux).
- **`hypotenuse doctor`:** environment, agents, credentials, server reachability, and clock skew.
- **Tests:** CLI unit tests, daemon integration tests against a real booted backend, and user docs.

**Out:**

- Spawning coding agents and mapping their output ([phase 11](./phase-11-acp-agent-host.md)). This phase's
  slots run a **null executor** that claims, posts one `thought`, and completes, so the whole loop is testable
  before ACP exists.
- Worktree creation and cleanup ([phase 12](./phase-12-worktrees-and-session-lifecycle.md)).
- The stdio MCP server ([phase 13](./phase-13-hypotenuse-mcp.md)), except reserving the control-socket method
  it will use.
- A Windows service. On Windows the daemon runs in the foreground (`daemon start --foreground`) and the docs
  show a Task Scheduler recipe. A real service is a later plan.
- Several runners per daemon. One daemon is one runner; two configs on one machine means two daemons with two
  `-c` paths and two state directories.
- Remote configuration. The server never pushes config; `HeartbeatResponse` may carry advisory hints (e.g.
  "your version is below the server's minimum"), and the daemon only logs them.

## Design

### 1. Files and precedence

| File | Default path | Written by | Mode |
|---|---|---|---|
| Config | `~/.config/hypotenuse/config.toml` | the person (or `config init`) | any |
| Credentials | `~/.config/hypotenuse/credentials.json` | `hypotenuse runner register`, `hypotenuse login` | `0600`, directory `0700` |
| State | `~/.local/state/hypotenuse/state.db` | the daemon | `0600` |
| Control socket | `~/.local/state/hypotenuse/daemon.sock` | the daemon | `0600` |
| Pidfile | `~/.local/state/hypotenuse/daemon.pid` | the daemon | `0600` |
| Log | `~/.local/state/hypotenuse/daemon.log` (rotated at 10 MB, 5 kept) | the daemon | `0600` |
| Per-session agent logs | `~/.local/state/hypotenuse/sessions/<agentSessionId>.log` | the ACP host ([phase 11](./phase-11-acp-agent-host.md)) | `0600` |
| Update cache | `~/.config/hypotenuse/update.json` | upgradr ([phase 5](./phase-05-cli-and-distribution.md)) | any |

`$XDG_CONFIG_HOME` and `$XDG_STATE_HOME` are honoured. On macOS the defaults stay XDG-style rather than
`~/Library/Application Support`, because every path appears in error messages and docs and one spelling is
worth more than platform idiom.

**Config path precedence:**

1. `-c / --config <path>`
2. `HYPOTENUSE_CONFIG`
3. `~/.config/hypotenuse/config.toml`

A config given with `-c` puts the state directory beside the config file (`<dir>/.hypotenuse-state/`) unless
`[log].file` or `--state-dir` says otherwise. That keeps two daemons on one machine from sharing a socket by
accident.

**Value precedence**, for the few keys that have a flag or env override:

1. flag
2. environment variable
3. config file
4. default

The overridable keys are `server.url` (`--url`, `HYPOTENUSE_URL`), `server.project` (`--project`), and
`log.level` (`-v`, `HYPOTENUSE_LOG_LEVEL`). Nothing else has an override: an agent command or a repository
path that could also come from the environment is a second source of truth to debug.

### 2. The schema is the source of truth

`cli/src/config/schema.ts` defines one zod object per TOML table: `[server]`, `[runner]`, `[subscriptions]`,
`[agents.<id>]`, `[roles.manager]`, `[roles.worker]`, `[[repositories]]`, `[sessions]`, and `[log]`. Every key
and its default is tabulated in [`CONFIG.md`](../CONFIG.md), and that document is maintained against the schema
(a unit test asserts every leaf key in the schema appears in a `CONFIG.md` table, and vice versa).

Everything else derives from the schema:

- **Parsing.** `Bun.TOML.parse` turns the file into a plain object, and `ConfigSchema.safeParse` turns that
  into a typed `Config`. Durations are strings (`"30m"`, `"2h"`, `"45s"`) parsed to milliseconds in a zod
  transform; paths are expanded (`~`, env vars) and made absolute in a transform. Relative paths resolve
  against the **config file's directory**, so a repo-local config can say `prompt_file = "prompts/worker.md"`.
- **JSON Schema.** `hypotenuse config schema` prints `z.toJSONSchema(ConfigSchema)` with `$id`
  `https://hypotenuse.dev/schemas/config-v1.json`, so editors with Taplo / Even Better TOML can offer
  completion through a `#:schema` directive, which `config init` writes as the file's first line.
- **Validation.** Shape errors come from zod; the semantic checks in §3 run after.
- **Docs.** The `.describe()` on every field is the text in `CONFIG.md`'s tables.

`config_version = 1` is a required top-level key. A config without it is refused with a message naming the
current version. A future breaking change bumps it and ships a `config migrate`; this phase only reserves the
key.

### 3. `config validate` — path-precise, three passes, and fixes suggested

Validation has three layers, and all of them run on every daemon start as well as on demand.

**Pass 1 — shape (zod).** Each issue is printed as `<dotted.path>: <message>`, with the path rendered TOML-style
(`repositories[1].base_branch`, `agents.codex.command`). Unknown keys are errors, not warnings
(`.strict()` on every object): a misspelt `max_concurent_sessions` silently ignored is a runner that takes one
session and nobody knows why.

**Pass 2 — references.** These checks need the whole document:

| Check | Example message |
|---|---|
| A role's `agent` names a defined agent or a preset | `roles.worker.agent: unknown agent "codx" (did you mean "codex"?)` (Damerau–Levenshtein ≤ 2 against the defined ids plus preset names) |
| `runner.roles` names only roles with a `[roles.*]` table | `runner.roles[1]: "reviewer" has no [roles.reviewer] table` |
| Exactly one of `prompt` / `prompt_file` per role | `roles.manager: set prompt or prompt_file, not both` |
| `agents.<id>` has exactly one of `preset` / `command` | `agents.local: set preset or command` |
| Repository names are unique; remotes are unique after normalization | `repositories[2].remote: github.com/acme/web is already repositories[0]` |
| `sessions.keepalive_interval` is under 30 minutes, which is Linear's stale threshold | `sessions.keepalive_interval: 45m is longer than Linear's 30m stale window` |
| `sessions.idle_timeout` ≥ `keepalive_interval`; `turn_timeout` ≥ `idle_timeout` | ordering message |
| `sessions.cleanup = "ttl"` requires `cleanup_ttl` | — |

**Pass 3 — the local machine.** These checks touch the filesystem and `PATH`, still without the network:

| Check | Example message |
|---|---|
| Each `repositories[].path` exists and is a git repository (`git -C <path> rev-parse --git-dir`) | `repositories[0].path: ~/code/web is not a git repository` |
| Its `origin` remote matches `remote` after normalization (`git@github.com:acme/web.git` = `github.com/acme/web`) | `repositories[0].remote: origin is github.com/acme/website, config says github.com/acme/web` |
| `base_branch` exists on origin (`git ls-remote --heads`, skipped with `--offline`) | warning, not error |
| `prompt_file` exists and is readable; its template variables are all known ([phase 11](./phase-11-acp-agent-host.md#4-prompt-assembly)) | `roles.worker.prompt_file: unknown variable {{issue.titel}} (did you mean {{issue.title}}?)` |
| Each used agent's command resolves: the first `command` element on `PATH`, or `npx`/`bunx` for npm presets | `agents.goose.command: "goose" not found on PATH` |
| `sessions.worktree_root` is writable and not inside a configured repository | — |
| `git --version` ≥ 2.38 (needs `git worktree add --orphan`-era behaviour and `worktree list --porcelain -z`) | — |

**`--online`** adds checks that need the network:

- `GET <server.url>/api/status` answers `healthy`.
- `credentials.json` exists for this server and its runner token is accepted (`daemon:heartbeat` with
  `dryRun: true`, which validates and answers without marking the runner online).
- The runner's project matches `server.project`.
- Every `subscriptions.teams` key exists in the installation's catalog. This comes from the heartbeat
  response's echo of unmatched subscription keys, so the daemon never needs `linear:catalog`, which is a human
  action.

**Output.**

- Human output groups by severity, with a final line such as `2 errors, 1 warning`.
- `--json` prints `{ valid, errors: [{ path, message, hint? }], warnings: [...] }`.
- The exit code is 0 when valid (warnings allowed), 1 on errors, and 2 when the file cannot be read or parsed.

TOML syntax errors carry Bun's line and column: `config.toml:14:3: expected "=" after key`.

### 4. `config init`, `config schema`, `config path`

- **`config init`** writes a commented starter file and refuses to overwrite one that exists unless `--force`
  is given. It is deliberately **not interactive**: it fills what it can detect and leaves the rest as
  commented examples.
  - It detects the `server.url` from `credentials.json` if present.
  - With `--repo <path>` (repeatable) it adds each repository, deriving `name` and `remote` from origin and
    `base_branch` from `origin/HEAD`.
  - It enables the `claude` preset if `claude` is on `PATH`, and otherwise the first preset whose binary or
    `npx` resolves.
  - It finishes by running `config validate` and printing the result.
- **`config schema`** prints the JSON Schema to stdout.
- **`config path`** prints the resolved config path, state directory, and credentials path, one per line
  (`--json` for an object). Support's first question is "which file is it reading", and this answers it.

### 5. Credentials

`credentials.json` is keyed by server URL so one machine can hold a personal login against production and a
runner against staging:

```json
{
  "version": 1,
  "servers": {
    "https://api.hypotenuse.dev": {
      "session": { "accessToken": "…", "refreshToken": "…", "expiresAt": 1792000000000 },
      "runner": { "id": 42, "projectId": 7, "name": "evan-mbp", "token": "hyp_rt_…" }
    }
  }
}
```

- **`session`** belongs to the operator CLI (a `hyp_cli_` token from the dashboard sign-in, see
  [phase 5](./phase-05-cli-and-distribution.md)).
- **`runner`** is written once by `hypotenuse runner register`, which shows the plaintext token only in this
  file.
- **The daemon reads only `runner`.** It never uses a personal session, so a person logging out does not stop
  their runner, and revoking the runner does not log them out.

The file is written atomically: write a temp file in the same directory with mode `0600`, `fsync`, then
`rename`. Before using the file the daemon checks its mode and refuses to start on a group- or world-readable
credentials file, with a `chmod 600` hint. That mirrors `ssh`, because a runner token is a credential somebody
can put work through.

### 6. Process model

```
hypotenuse daemon start              # background: re-spawns itself detached, waits for "ready", exits 0
hypotenuse daemon start --foreground # what launchd/systemd run; logs to stderr and the log file
hypotenuse daemon stop               # control socket "drain" with --timeout, then SIGTERM, then SIGKILL
hypotenuse daemon restart            # stop (drain) + start
hypotenuse daemon status             # control socket "status"; exit 3 if not running
hypotenuse daemon logs [-f] [-n 200] [--session <id>]
```

**Background start** spawns `process.execPath` with the same argv plus `--foreground --detached-child`. It sets
`detached: true` and redirects stdio to the log file. Then it waits up to 15 s for the child to write `ready`
to an inherited pipe. If the child reports a fatal error first (invalid config, socket in use, credentials
missing), the parent prints it and exits 1. This is the difference between `daemon start` saying "started" and
the daemon being started.

**The pidfile is the machine lock**, so it always lives at `~/.local/state/hypotenuse/daemon.pid`, ignoring
`--state-dir` and `-c`. A second daemon with a different config still finds it. On start:

- The pidfile is JSON, `{ pid, socketPath, startedAt }`, written with `O_EXCL`. **`socketPath` is the running
  daemon's own control socket**, wherever its state directory put it. Liveness always uses that recorded path,
  never the starting daemon's own path.
Every combination of the two checks has exactly one outcome:

| Recorded pid | Recorded socket | Outcome |
|---|---|---|
| not running | — | **stale**: remove the pidfile and the recorded socket, retake the lock with `O_EXCL` |
| running, and its command line is not a `hypotenuse daemon` | — | **stale** (the pid was reused after a crash or reboot) |
| running `hypotenuse daemon` | answers `status` | **running**: exit 1 with its pid and config path |
| running `hypotenuse daemon` | silent, pidfile younger than 30 s | **starting**: exit 1, "another daemon is starting (pid N)" — the window between `O_EXCL` and binding the socket |
| running `hypotenuse daemon` | silent, pidfile 30 s or older | **hung**: exit 1, "daemon pid N is not responding; `hypotenuse daemon stop --force`" — never reclaimed, because reclaiming would make two daemons |

Retaking a stale lock is itself `O_EXCL`, so two starts racing on one stale lock cannot both win. The command-line
check reads `/proc/<pid>/cmdline` on Linux and `ps -o args= -p <pid>` on macOS.

Both checks are needed: a pid can be reused by an unrelated process after a reboot, and a socket file can
outlive its process. Checking the *recorded* socket is what lets a second start with a different `-c` or
`--state-dir` see the first daemon. `pidfile.test.ts` covers exactly that case.

The lock only sees the current OS user. The server closes the rest of the gap: the daemon computes `machineId`
(sha256 of `/etc/machine-id`, macOS `IOPlatformUUID`, or Windows `MachineGuid`), and `daemon:connect` refuses it
with a 409 naming the other runner if a different online runner already has that id. That covers a second user on a
shared build box and two projects on one laptop. The daemon prints the refusal and exits 1 (`machine_in_use`).
The **first heartbeat** enforces the same rule, so a daemon that heartbeats before it connects cannot slip
through (see [phase 8](./phase-08-runners.md)).

**Startup order** (in `cli/src/daemon/supervisor.ts` `startDaemon()`):

1. load and validate config (passes 1–3, offline) — fatal on error
2. open `state.db`, run local migrations
3. acquire the pidfile; bind the control socket
4. **recover**: every `local_sessions` row in a non-terminal state belongs to a previous process. Its agent
   process is gone (children die with the process group; see below), so mark it `interrupted`, keep its
   worktree, and queue a `status` event so the server knows. The server's lease logic decides whether to
   re-offer it ([phase 9](./phase-09-work-routing.md)).
5. start ServerLink (§8); replay `pending_events`
6. signal `ready`

### 7. The supervisor and its slots

The supervisor owns `runner.max_parallel_jobs` **slots**, plus a counter per role and per agent that has a
`max_parallel`. A slot is either free or holds one
`SessionRunner`. A `SessionRunner` runs one work item at a time for one agent session: the null executor in
this phase, then the ACP host in [phase 11](./phase-11-acp-agent-host.md).

```
            offer (ws ping or heartbeat.offers)
                         │
                         ▼
   free slot for the machine, the role, and the agent? ──no──► ignore (server re-offers after offerTtl)
       │yes
       ▼
   daemon:claim ──409/404──► release slot (someone else claimed / cancelled)
       │200 WorkAssignment
       ▼
   SessionRunner.run(assignment) ──events──► EventSink (ordered, persisted) ──► daemon:events
       │
       ▼
   daemon:complete(outcome) ──► local_sessions.state = idle|done ──► slot freed
```

- **Heartbeat limits** are `{ maxParallelJobs, roles, agents }` from the config. Draining reports
  `maxParallelJobs: 0`. The server does the counting. The daemon's own check above is a guard for a race (an
  offer that arrived just before a reload lowered a limit), not the routing decision.
- **Sticky sessions don't hold slots.** A session whose last turn finished and whose worktree is kept is
  `idle` in `local_sessions`. A follow-up for it is offered to this runner first, but only claimed when a slot
  is free. Holding a slot for an idle session would let three quiet threads block a runner forever.
- **Concurrency is local to the slot.** Each `SessionRunner` gets an `AbortSignal` that fires on cancel, drain
  timeout, or shutdown. Cancels for a session arrive through the supervisor (WS `cancel` frame or
  `heartbeat.cancels`), which looks the session up and aborts its runner.
- **One work item per session.** The supervisor refuses to claim a second work item for a session that already
  has one running. The server never offers one ([`ARCHITECTURE.md`](../ARCHITECTURE.md#work_itemsstatus)),
  and this is the local belt to that brace.

### 8. ServerLink: heartbeat, socket, reconnect, offline queue

`cli/src/daemon/server-link.ts` is the only module that talks to the server. Every request goes through
`cli/src/api/client.ts`, which sets `Authorization: Bearer <runner token>` and
`User-Agent: hypotenuse/<version> (<os>-<arch>)`, and parses Keryx's `{ error }` envelope regardless of status.

**Heartbeat.** It sends `daemon:heartbeat` every 15 s. Every heartbeat also fires immediately after a slot
frees, after a reconnect, and after a config reload. The request is `HeartbeatRequest` from `protocol/`
(see [`RUNNER_PROTOCOL.md`](../RUNNER_PROTOCOL.md)):

- `machineId` and `limits` (machine, per-role, per-agent)
- `RunnerCapabilities`: roles, agents with their availability and the roles they serve, repositories by name and normalized
  remote, subscriptions
- the active work items with their states and the leases to renew
- the daemon version and `PROTOCOL_VERSION`

The response carries `offers`, `cancels`, and `serverTime`. **Offers and cancels are processed exactly as if
they had come from the socket**, which is what makes the socket optional.

**Socket.**

- **Connect.** After a successful heartbeat, `daemon:connect` exchanges the runner token for a session cookie.
  The daemon then opens `wss://<host>/` with `Cookie: __session=…` and sends one
  `{ messageType: "subscribe", channel: "runner:<runnerId>" }`.
- **Frames.** They are content-free:
  - `{ event: "work" }` triggers an immediate heartbeat. That heartbeat returns the offers, and claims follow.
  - `{ event: "cancel" }` does the same; the heartbeat returns the cancels.
  - `{ event: "revoked" }` stops the daemon's work: it drains with cancel and exits with a clear log line
    (`runner revoked on the server; run "hypotenuse runner register" to re-register`).
- **Why only one subscription.** The daemon never unsubscribes, and the subscribe frame is the only one it
  sends on that socket. That is exactly the shape that the open Keryx frame-ordering defect
  (subscribe and unsubscribe on one connection can apply out of order) cannot affect. The defect is recorded
  upstream, not worked around (rule 4).

**Reconnect.** Each failure feeds a backoff of 1 s × 2ⁿ, capped at 30 s, with full jitter. Failures are a
failed heartbeat, a socket close (code 1001 on server shutdown, or anything else), or a 5xx. The backoff
resets after 60 s of healthy heartbeats.

A `401` on heartbeat is not a network failure. The token was revoked or the runner deleted, so it is handled
like `revoked` and **not** retried, because hammering the server with a dead token for a week is how a laptop
in a drawer becomes a rate-limit incident.

**Clock skew.** `serverTime` from each heartbeat is compared with local time. A skew over 30 s logs a warning
once per hour, and `doctor` reports it. The daemon itself never relies on wall-clock agreement (leases are
renewed by heartbeat, not computed locally), but agents that sign things (git commits, `gh` tokens) do.

**The offline event queue.** Events go through the **EventSink**, never straight to the network:

1. A `SessionRunner` emits an event. The sink assigns it a per-session monotonic `seq` and a UUID `eventId`,
   and inserts it into `pending_events` in `state.db` in the same synchronous call. Bun's sqlite is
   synchronous, so an event is durable before the emitter continues.
2. A flusher batches pending events per session, up to 50 events or 64 KB (Keryx's WebSocket payload limit
   does not apply to HTTP, but the server's `WEB_MAX_BODY_SIZE` does). It posts each batch with `daemon:events`
   and deletes the rows the server acknowledged.
3. The server deduplicates on `eventId`. A batch that times out after the server committed it is resent and
   absorbed ([`RUNNER_PROTOCOL.md`](../RUNNER_PROTOCOL.md)).
4. While the server is unreachable, events accumulate. Ephemeral events for a session (thoughts, in-progress
   actions) are **superseded locally**: a newer ephemeral event for the same session deletes older unsent
   ephemeral rows. Linear would replace them on arrival anyway, and replaying 400 stale thoughts after a train
   tunnel would burn the installation's rate-limit budget.
5. `daemon:complete` is itself queued behind its session's events. A turn is never reported finished before
   its last event lands.

### 9. The local state database

`cli/src/daemon/state.ts` opens `state.db` with `PRAGMA journal_mode=WAL`, `synchronous=NORMAL` and
`foreign_keys=ON`. Migrations are an ordered array of SQL strings with `PRAGMA user_version` as the cursor;
there is no ORM on the daemon side.

| Table | Columns | Purpose |
|---|---|---|
| `local_sessions` | `agent_session_id` PK, `linear_session_id`, `issue_identifier`, `role`, `repository`, `state` (`claimed`, `running`, `idle`, `done`, `interrupted`, `cancelled`, `failed`), `work_item_id`, `acp_agent_id`, `acp_session_id`, `pid`, `worktree_id`, `created_at`, `updated_at`, `last_event_at` | what this runner is doing and has done; `acp_session_id` is what `session/load` resumes ([phase 11](./phase-11-acp-agent-host.md)) |
| `worktrees` | `id` PK, `repository`, `path` UNIQUE, `branch`, `base_branch`, `agent_session_id`, `created_at`, `last_used_at`, `state` (`active`, `idle`, `removing`, `removed`), `pushed` | owned by [phase 12](./phase-12-worktrees-and-session-lifecycle.md); created here so the schema is whole from the first migration |
| `pending_events` | `event_id` PK, `agent_session_id`, `seq`, `work_item_id`, `ephemeral`, `payload` JSON, `created_at`, `attempts` | the offline queue (§8) |
| `pending_completions` | `work_item_id` PK, `payload` JSON, `created_at` | `daemon:complete` calls waiting behind their events |

Nothing in `state.db` is the only copy of anything the server needs. If the file is deleted, the next start
treats every server-side lease as abandoned, and the server re-offers. Only the worktrees on disk become
orphans, and `worktrees cleanup --all` finds them by scanning `worktree_root`.

### 10. The control socket

`cli/src/daemon/control-socket.ts` serves newline-delimited JSON-RPC 2.0 on a Unix domain socket using
`Bun.listen({ unix })`. The socket file is `0600`, and that mode **is** the authentication: only the user who
runs the daemon can connect. On Windows it is a named pipe `\\.\pipe\hypotenuse-<user>`, reachable from the
foreground daemon only.

| Method | Params | Result | Used by |
|---|---|---|---|
| `status` | — | `{ pid, version, uptimeMs, configPath, runner: { id, name, projectId }, server: { url, connected, lastHeartbeatAt, socket }, slots: { total, busy }, draining }` | `daemon status`, `doctor` |
| `agents.list` | `{ all? }` | `[{ agentSessionId, issueIdentifier, role, agent, state, pid, startedAt, lastEventAt, worktree }]` | `agents list` ([phase 12](./phase-12-worktrees-and-session-lifecycle.md)) |
| `agents.kill` | `{ target: sessionId \| issueIdentifier, reason? }` | `{ killed: [...] }` | `agents kill` |
| `worktrees.list` | — | `[{ path, repository, branch, state, agentSessionId, lastUsedAt, sizeBytes? }]` | `worktrees list` |
| `worktrees.cleanup` | `{ dryRun, all, olderThanMs }` | `{ removed: [...], kept: [{ path, reason }] }` | `worktrees cleanup` |
| `drain` | `{ timeoutMs, cancel }` | resolves when slots are empty or the timeout fires | `daemon stop`, `upgrade` |
| `reload` | — | `{ applied: [...], requiresRestart: [...] }` | `daemon reload`, `SIGHUP` |
| `mcp.call` | `{ agentSessionId, nonce, tool, input }` | the tool result | reserved for `hypotenuse mcp` ([phase 13](./phase-13-hypotenuse-mcp.md)) |

If the socket is missing, CLI commands that need it print `daemon is not running (start it with "hypotenuse
daemon start")` and exit 3. `--json` callers get `{ running: false }`.

### 11. Reload, drain, shutdown, and upgrade

**Hot reload (`SIGHUP` or `daemon reload`).** The daemon re-reads and re-validates the file. An invalid file is
logged and **ignored**, and the old config stays live. A valid file applies its *safe* keys at once:

- `runner.roles`, `subscriptions.*`
- `max_parallel_jobs` and every `max_parallel`: raising applies at once; lowering never interrupts a running job,
  it takes effect as jobs finish
- `log.level`
- `[roles.*]` prompts and policies, for new turns only
- `[[repositories]]` additions
- `sessions.*` timeouts, for new turns only

Changing `server.url`, `server.project`, an existing repository's `path`, or an agent's `command` while a
session uses it is reported in `requiresRestart`. A heartbeat follows every reload so routing sees the change
within one round trip.

**Drain.** The daemon reports `maxParallelJobs: 0`, claims nothing new, and waits for running turns to finish, up to
`timeoutMs`. With `cancel: true` (or after the timeout), remaining turns take the cancel path from
[phase 11](./phase-11-acp-agent-host.md#9-cancel-stop-and-kill), which posts a final activity explaining the
stop.

**Shutdown.** It uses the `Closeable` registry ported from mcpx's `src/shutdown.ts` (SIGINT → 130,
SIGTERM → 143, SIGHUP is **reload**, not exit, for the daemon). Teardown proceeds in this order:

1. drain with cancel, after a 10 s grace
2. flush `pending_events`, waiting at most 5 s; whatever remains stays queued for the next start
3. close the socket
4. remove the control socket and the pidfile

Coding agents run in their own **process group** (`detached: true`, then `process.kill(-pid)`), so killing the
daemon's tree takes them with it, and a crash of the daemon does not orphan an agent writing to a worktree.

**Upgrade.** `hypotenuse upgrade` ([phase 5](./phase-05-cli-and-distribution.md)) replaces the binary or the npm
install. Then, if the control socket answers:

1. it calls `drain({ timeoutMs: 10 min, cancel: false })`;
2. it calls a final `restart` request, and the daemon re-execs itself with `process.execPath` and its original
   argv;
3. under launchd or systemd, the daemon exits 0 instead and lets the service manager restart it, detected by
   `HYPOTENUSE_SERVICE=1` in the unit's environment.

`upgrade --no-restart` skips steps 1–3 and prints a reminder. upgradr does not handle a running daemon, and
this is that missing piece. On Windows the binary cannot be replaced while running, so upgrade there requires
`daemon stop` first and says so.

### 12. User services

`hypotenuse service install` writes a unit for the current user, never a system-wide one. It runs
`daemon start --foreground` with an absolute `process.execPath` (or, for npm installs, the absolute `bun` path
plus the script path), and with `-c` if the config path is not the default.

| Platform | File | Notable settings |
|---|---|---|
| macOS | `~/Library/LaunchAgents/dev.hypotenuse.daemon.plist` | `RunAtLoad`, `KeepAlive { SuccessfulExit: false }`, `ProcessType Interactive`, `EnvironmentVariables { HYPOTENUSE_SERVICE=1, PATH=<captured at install> }`, stdout/stderr to the log; loaded with `launchctl bootstrap gui/$UID` |
| Linux | `~/.config/systemd/user/hypotenuse.service` | `Restart=on-failure`, `RestartSec=5`, `KillMode=mixed`, `TimeoutStopSec=11min` (drain), `Environment=HYPOTENUSE_SERVICE=1`, `Environment=PATH=<captured>`; enabled with `systemctl --user enable --now`; prints a hint about `loginctl enable-linger` |
| Windows | — | prints the foreground command and a Task Scheduler recipe link to the docs |

**`PATH` is captured at install time.** Services start with a minimal environment, and the agent presets need
`npx`, `node`, `git`, and `gh`. `service status` shows the unit's state and the daemon's `status`, and
`service uninstall` stops and removes the unit.

### 13. `hypotenuse doctor`

`doctor` is a checklist, printed as ✓ / ! / ✗ lines (`--json` for a report). It exits 1 if any check fails.
It answers "why isn't my runner picking anything up" without anyone opening a log.

| Check | How |
|---|---|
| Version and install method | upgradr's `detectInstallMethod`; whether an update is available |
| Bun (npm installs only), git ≥ 2.38, `gh` (optional) | `--version` |
| Config | `config validate` passes 1–3 |
| Credentials | file present, mode `0600`, runner present for `server.url` |
| Server | `/api/status`; heartbeat dry run; latency; clock skew against `serverTime` |
| Daemon | control socket `status`; service unit installed and loaded |
| Agents | for each agent a role uses: command resolves; with `--agent <id>`, a real `initialize` handshake that reports `authMethods` and whether the agent says it needs authentication ([phase 11](./phase-11-acp-agent-host.md#3-initialize-and-authentication)) |
| Repositories | per-repo pass-3 checks plus `git fetch --dry-run` reachability |
| Disk | free space under `worktree_root` against `sessions.min_free_disk` ([phase 12](./phase-12-worktrees-and-session-lifecycle.md)) |

## Steps

### 1. Config schema and loader — `cli/src/config/{schema.ts,loader.ts,durations.ts,paths.ts}`

- Build the zod schema with `.strict()` objects, `.describe()` on every leaf, and the duration and path
  transforms.
- `loadConfig({ path?, overrides })` returns `{ config, path, issues }`. TOML parse errors are mapped to
  `ConfigIssue { path: "", line, column, message }`.
- `renderIssuePath()` produces the TOML-style dotted path.

### 2. Semantic validation — `cli/src/config/validate.ts`

Passes 2 and 3 as pure functions over `(config, env)`, where `env` abstracts `PATH` lookup, `git`, and `fs`, so
unit tests run without a real machine. Also the `--online` checks, which use the API client. Plus
`suggest(name, candidates)` for "did you mean".

### 3. Config commands — `cli/src/commands/config.ts`

`config init` (template in `cli/src/config/template.toml`, embedded with `import … with { type: "text" }`, so
compiled binaries carry it), `config validate`, `config schema`, and `config path`.

### 4. Credentials — `cli/src/config/credentials.ts`

Read, atomic write, the mode check, and lookup by normalized server URL. `runner register`
([phase 8](./phase-08-runners.md)) and `login` ([phase 5](./phase-05-cli-and-distribution.md)) write through it.

### 5. State database — `cli/src/daemon/state.ts`

`bun:sqlite` with WAL, the migration array, and typed accessors for each table.

### 6. ServerLink and EventSink — `cli/src/daemon/server-link.ts`, `cli/src/daemon/event-sink.ts`

Heartbeat loop, socket connect and subscribe, backoff, revoke handling, the persisted queue with supersession,
batching, and completion ordering. Request and response types come from `protocol/`.

### 7. Supervisor — `cli/src/daemon/supervisor.ts`, `cli/src/daemon/null-executor.ts`

`startDaemon()`, recovery, slots, the claim path, cancel routing, drain, and reload. The null executor claims,
emits one `thought` ("Hypotenuse runner <name> received this; no agent host is installed yet") and one
`response`, then completes. It is deleted by [phase 11](./phase-11-acp-agent-host.md), which swaps in the ACP
host behind the same `SessionExecutor` interface.

### 8. Control socket — `cli/src/daemon/control-socket.ts`, `cli/src/daemon/control-client.ts`

The server and its methods, plus a client used by every local command, with the "not running" message and
exit 3.

### 9. Daemon commands — `cli/src/commands/daemon.ts`

`start` (background and foreground, pidfile, ready pipe), `stop`, `restart`, `status`, `logs` (tail with
`-f`, filter by session), and `reload`.

### 10. Service commands — `cli/src/commands/service.ts`, `cli/src/daemon/units/{launchd.plist,systemd.service}`

Templated unit files, plus install, uninstall, and status per platform.

### 11. Doctor — `cli/src/commands/doctor.ts`

The checklist, sharing check functions with `config validate` and the control client.

### 12. Upgrade hook — `cli/src/commands/upgrade.ts`

After a successful upgradr upgrade, drain and restart through the control socket, honouring `--no-restart` and
the service-managed exit.

### 13. Tests

**CLI unit tests (no server):**

- `cli/__tests__/config/schema.test.ts` covers every key's default, duration parsing, and path expansion
  relative to the config file.
- `cli/__tests__/config/validate.test.ts` gives every row of the pass 2 and pass 3 tables a fixture and an
  exact expected message, including "did you mean".
- `cli/__tests__/config/docs-parity.test.ts` asserts that the schema's leaf keys **equal** the keys in
  `CONFIG.md`'s tables.
- `cli/__tests__/config/credentials.test.ts` covers mode `0600`, atomic replace, and refusal on `0644`.
- `cli/__tests__/daemon/state.test.ts` checks migrations are idempotent and that supersession deletes only
  unsent ephemeral rows for the same session.
- `cli/__tests__/daemon/control-socket.test.ts` checks every method's shape against a supervisor stub, the
  socket mode, and the stale-pidfile path.
- `cli/__tests__/commands/config.test.ts` spawns `hypotenuse config validate --json` on fixture files and
  checks exit codes 0, 1, and 2.

**Integration** (`backend/__tests__/daemon/*.test.ts`, spawning the real CLI from `cli/` against
`serverUrl()`, with `XDG_*` pointed at a temp dir):

- `daemon-loop.test.ts`: register a runner over HTTP as Mario, write credentials, and start
  `daemon start --foreground`. Then insert a queued work item for Mario's project (via the routing ops from
  [phase 9](./phase-09-work-routing.md)) and assert the null executor's `thought` and `response` land in
  `agent_activities` and the work item reaches `completed`.
- `daemon-offline.test.ts`: stop the backend's web server mid-turn (`api.stop()` on a second server instance
  used only for this file), let the executor emit events, restart, and assert every event arrives exactly once
  and in `seq` order, with superseded ephemerals absent.
- `daemon-revoke.test.ts`: `runner:revoke` while connected makes the daemon exit within one heartbeat with the
  revoke message, and no further requests carry the token.
- `daemon-drain.test.ts`: `daemon stop` while a turn runs drains it to `completed` within the timeout.
  `daemon stop --timeout 1s --cancel` ends it `cancelled` with a final activity.
- `daemon-recover.test.ts`: `kill -9` the daemon mid-turn, restart it, and assert the session is reported
  `interrupted` and the server re-offers after lease expiry.

## Verification

```bash
bun install
bun run --cwd cli lint && bun run --cwd cli test
cd backend && bun test __tests__/daemon

# by hand, against a local backend
bun run --cwd cli hypotenuse login --url http://localhost:8080
bun run --cwd cli hypotenuse runner register --name dev-laptop
bun run --cwd cli hypotenuse config init --repo ~/code/web
bun run --cwd cli hypotenuse config validate --online
bun run --cwd cli hypotenuse daemon start && bun run --cwd cli hypotenuse daemon status
bun run --cwd cli hypotenuse doctor
kill -HUP "$(cat ~/.local/state/hypotenuse/daemon.pid)"   # reload; check the log line
bun run --cwd cli hypotenuse daemon stop
```

## Definition of done

- [ ] `ConfigSchema` with strict objects, described leaves, duration/path transforms, `config_version = 1`
- [ ] `config validate` reports TOML-pathed errors for all three passes, suggests near names, and exits 0/1/2;
      `--online` checks status, credentials, project, and subscriptions
- [ ] `config init`, `config schema`, and `config path` work, and the template is embedded in compiled binaries
- [ ] `CONFIG.md` and the schema are asserted equal by `docs-parity.test.ts`
- [ ] `credentials.json` written atomically at `0600`; the daemon refuses a readable file
- [ ] `daemon start` background and foreground, ready pipe, pidfile with stale detection, `stop`, `restart`,
      `status`, `logs`, `reload`
- [ ] Supervisor slots, claim path, cancel routing, drain, recovery of interrupted sessions
- [ ] Parallelism at three levels (`max_parallel_jobs`, role and agent `max_parallel`) reported as `limits`; one daemon per machine via the fixed-path lock and `machineId`
- [ ] ServerLink: 15 s heartbeat, one-subscription socket, jittered backoff, 401 = revoked, clock-skew warning
- [ ] EventSink: durable before return, per-session `seq`, ephemeral supersession, ordered completion, server
      dedupe on `eventId`
- [ ] Control socket at `0600` with every method in the table, and a `not running` exit of 3
- [ ] `service install|uninstall|status` for launchd and systemd with a captured `PATH`; the Windows recipe
      documented
- [ ] `doctor` with every check in the table
- [ ] `upgrade` drains and restarts a running daemon
- [ ] User docs: `/docs/runner` (install, register, config, service) and `/docs/config` (rendered from
      `CONFIG.md`'s content)
- [ ] Every test above passes twice in a row

## Commands

```bash
hypotenuse config path
hypotenuse config validate --json | jq '.errors[] | "\(.path): \(.message)"'
hypotenuse config schema > hypotenuse.schema.json
hypotenuse daemon start --foreground -v          # what the service unit runs
hypotenuse daemon logs -f --session <agentSessionId>
hypotenuse service install && hypotenuse service status
hypotenuse doctor --agent claude
sqlite3 ~/.local/state/hypotenuse/state.db 'select agent_session_id, state, issue_identifier from local_sessions;'
sqlite3 ~/.local/state/hypotenuse/state.db 'select count(*), agent_session_id from pending_events group by 2;'
```

## Learnings from the build

_Nothing yet — this phase has not been built._
