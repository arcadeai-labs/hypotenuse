# Daemon configuration reference

This is the reference for the `hypotenuse` daemon's config file: every key, its type, default, and validation rule.
It is a live document under rule 14 of [`AGENTS.md`](../AGENTS.md). The zod schema in `cli/src/config/schema.ts` is
the source of truth, and `cli/__tests__/config/docs-parity.test.ts` asserts that the keys in the tables below equal
the schema's leaf keys. Add a key to both, in the same commit, or neither.

The design behind it (validation passes, reload, precedence) is in
[`phase-10-daemon-and-config.md`](./plans/phase-10-daemon-and-config.md). How the daemon uses agents, worktrees,
and MCP servers is in [phase 11](./plans/phase-11-acp-agent-host.md),
[phase 12](./plans/phase-12-worktrees-and-session-lifecycle.md), and [phase 13](./plans/phase-13-hypotenuse-mcp.md).

## Files and locations

| What | Default | Override |
|---|---|---|
| Config file | `~/.config/hypotenuse/config.toml` | `-c / --config <path>`, then `HYPOTENUSE_CONFIG` |
| Credentials (server URL, runner id and token, operator login) | `~/.config/hypotenuse/credentials.json` (`0600`) | follows `$XDG_CONFIG_HOME` |
| State database | `~/.local/state/hypotenuse/state.db` | `--state-dir`; follows `$XDG_STATE_HOME`; a `-c` config puts state in `<config dir>/.hypotenuse-state/` |
| Control socket | `~/.local/state/hypotenuse/daemon.sock` (`0600`) | with the state directory |
| Daemon log | `~/.local/state/hypotenuse/daemon.log` | `[log] file` |
| Per-session agent logs | `~/.local/state/hypotenuse/sessions/<agentSessionId>.log` | with the state directory |
| Worktrees | `~/.hypotenuse/worktrees/<repository>/<ISSUE-ID>` | `[sessions] worktree_root` |
| Update-check cache | `~/.config/hypotenuse/update.json` | — |
| Machine lock | `~/.local/state/hypotenuse/daemon.pid` — always this path, whatever `--state-dir` or `-c` say; it records the running daemon's control-socket path, and liveness is checked against that recorded path | — |

**One daemon per machine** is enforced twice. Locally, the lock above lives at a fixed path, so a second daemon
started with a different config or state directory still finds it. On the server, every heartbeat carries a
`machineId`, a stable hash of the OS machine id (`/etc/machine-id`, macOS `IOPlatformUUID`, Windows
`MachineGuid`). `daemon:heartbeat` and `daemon:connect` both refuse a runner whose `machineId` belongs to
another online runner, naming it, and a unique index on online runners' `machineId` makes the check atomic. This catches a second OS user on a shared box, and two projects on one laptop.

`hypotenuse config path` prints the resolved paths. `hypotenuse config init` writes a starter file,
`hypotenuse config validate` checks one, and `hypotenuse config schema` prints the JSON Schema. The first line
of a generated file points editors at that schema:

```toml
#:schema https://hypotenuse.dev/schemas/config-v1.json
```

## Format and conventions

- **TOML**, parsed with `Bun.TOML.parse`. Unknown keys are **errors**, so a typo can't silently do nothing.
- **Durations** are strings with a unit: `"45s"`, `"10m"`, `"2h"`, `"7d"`.
- **Sizes** are strings with a unit: `"500MB"`, `"2GB"`.
- **Paths** expand `~` and `$VAR`. A relative path resolves against the **config file's directory**.
- **`$VAR` / `${VAR}`** in `env` and `headers` values (agents, MCP servers) are resolved from the daemon's
  environment when a turn starts. An unset variable fails that turn with an error that names the variable,
  never its value.
- **Changes take effect** on `hypotenuse daemon reload` or `SIGHUP`. Changing `server.*`, an existing
  repository's `path`, or an agent `command` in use needs `hypotenuse daemon restart`; `reload` tells you so.

## Top level

| Key | Type | Default | Rules |
|---|---|---|---|
| `config_version` | integer | — (required) | must be `1` |

## `[server]`

| Key | Type | Default | Rules |
|---|---|---|---|
| `url` | string (URL) | the only server in `credentials.json` | required if `credentials.json` has zero or several servers; overridden by `--url` / `HYPOTENUSE_URL` |
| `project` | string | the registered runner's project | slug or numeric id; must match the project the runner token belongs to (`config validate --online` checks); overridden by `--project` |

## `[runner]`

| Key | Type | Default | Rules |
|---|---|---|---|
| `name` | string | the machine's hostname | 1–64 chars; display only — the runner's identity is its token |
| `max_parallel_jobs` | integer | CPU cores ÷ 4, at least 1, at most 8 | 1–32. Jobs (turns) running at once on this machine. Idle sessions waiting for a follow-up do not hold a slot. See [Parallelism](#parallelism) |
| `roles` | array of `"manager"` \| `"worker"` | `["worker"]` | each needs a `[roles.<name>]` table |

## Parallelism

How many jobs this machine runs at once is decided at three levels, and a job starts only when **all three** have
room:

```
runner.max_parallel_jobs          3   ███ the machine
roles.<role>.max_parallel         1   █   e.g. at most one manager turn at a time
agents.<agent>.max_parallel       2   ██  e.g. two Claude sessions on one subscription
```

- The machine cap is required in effect (it has a default). The role and agent limits are optional and can only
  lower what the machine allows.
- A **job** is one turn: a new session, a follow-up prompt, a dispatch, or a manager review. A session waiting for
  a person between turns holds nothing.
- The daemon reports all three limits on every heartbeat. The server counts this runner's live jobs per role and
  per agent itself and **never offers a job that would exceed any of them**, so a full runner is skipped rather
  than offered work it must refuse.
- **One daemon per machine.** A second `hypotenuse daemon start` on the same machine refuses to start, so the cap
  is a real machine-wide limit. See `machine_id` under [Files and locations](#files-and-locations).

```toml
[runner]
max_parallel_jobs = 3

[roles.manager]
agent = "claude"
max_parallel = 1          # never more than one manager turn at once

[agents.claude]
preset = "claude"
max_parallel = 2          # one Claude Max seat handles two sessions comfortably
```

## `[subscriptions]`

Which Linear work this runner accepts. All three filters must match. An empty list means "no restriction" on
that dimension. These are routing **preferences**: the server never offers work outside them, and the
installation's team access still applies.

| Key | Type | Default | Rules |
|---|---|---|---|
| `teams` | array of strings | `[]` (all teams the installation can access) | Linear team keys, e.g. `"ENG"`; unknown keys are reported by `config validate --online` |
| `projects` | array of strings | `[]` | Linear project ids or exact names |
| `labels` | array of strings | `[]` | issue must carry at least one of these labels |

## `[agents.<id>]`

One table per coding agent. `<id>` is how roles refer to the agent (`[a-z0-9-]+`). A role whose `agent` names a
preset id without a table gets the preset with defaults.

| Key | Type | Default | Rules |
|---|---|---|---|
| `preset` | string | — | one of the presets below; exactly one of `preset` / `command` |
| `command` | array of strings | — | the full launch command for an ACP agent speaking stdio; the first element must resolve on `PATH` |
| `args` | array of strings | `[]` | appended after the preset's or command's own arguments |
| `env` | table of strings | `{}` | added to the agent's environment; `$VAR` allowed |
| `auth_method` | string | — | which of the agent's advertised ACP `authMethods` to use when it reports `auth_required` |
| `startup_timeout` | duration | `"60s"` | time allowed for the process to answer `initialize` (`npx` cold installs are slow) |
| `max_parallel` | integer | — (no agent limit) | 1–32. Jobs using this agent at once, across every role that uses it, inside `runner.max_parallel_jobs` — for rate limits or subscription seats; a value ≥ the machine cap is a warning |

**Presets**

| Preset | Launches |
|---|---|
| `claude` | `npx -y @agentclientprotocol/claude-agent-acp` |
| `codex` | `npx -y @agentclientprotocol/codex-acp` |
| `gemini` | `npx -y @google/gemini-cli --acp` |
| `copilot` | `npx -y @github/copilot --acp` |
| `goose` | `goose acp` |
| `opencode` | `opencode acp` |
| `cursor` | `cursor-agent acp` |
| `qwen` | `npx -y @qwen-code/qwen-code --acp --experimental-skills` |
| `cline` | `npx -y cline --acp` |
| `auggie` | `npx -y @augmentcode/auggie --acp` |
| `kilo` | `npx -y @kilocode/cli acp` |

Agents authenticate with their own credentials on this machine (Claude Code login, `OPENAI_API_KEY`, and so
on). If one needs an interactive login, run `hypotenuse agents login <id>`. `hypotenuse doctor --agent <id>`
checks it.

## Roles

`[roles.manager]` and `[roles.worker]`. A role is an entry prompt, a coding agent, and a policy. Which role
answers a Linear session is decided by the project's routing rules on the server. A runner only receives roles
listed in `runner.roles`.

| Key | Type | Default | Rules |
|---|---|---|---|
| `agent` | string | — (required) | an `[agents.<id>]` id or a preset name; `config validate` suggests near misses |
| `prompt` | string | the built-in template for the role | exactly one of `prompt` / `prompt_file` may be set; neither means the built-in |
| `prompt_file` | path | — | Markdown template; must exist; variables must be known |
| `permission_policy` | `"allow"` \| `"ask"` \| `"deny"`, or a table | worker: `"allow"`, manager: `"ask"` | the table form is `{ default = "allow", execute = "ask", fetch = "deny" }` with keys `default`, `read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, `other` (ACP tool kinds) |
| `max_parallel` | integer | — (no role limit) | 1–32. Jobs of this role running at once, inside `runner.max_parallel_jobs`; a value ≥ the machine cap is a warning (no effect) |
| `mode` | string | — | ACP session mode / `mode` config option to select after creating the session, if the agent offers it |
| `turn_timeout` | duration | `[sessions] turn_timeout` | overrides the session default for this role |
| `additional_directories` | array of paths | `[]` | extra directories the agent may read and write through ACP `fs/*`, besides its worktree |
| `extra_mcp_servers` | array of tables | `[]` | see below |

**`extra_mcp_servers` entries**

| Key | Type | Rules |
|---|---|---|
| `name` | string | unique within the role; `hypotenuse` is reserved |
| `command` | array of strings | stdio server; exactly one of `command` / `url` |
| `env` | table of strings | `$VAR` allowed |
| `url` | string | HTTP MCP server; only passed to agents that advertise HTTP MCP support |
| `headers` | table of strings | `$VAR` allowed |

Adding Linear's own MCP server (`mcp.linear.app`) with a personal API key is allowed and warned about. The agent
would act in Linear **as you**, outside the session's scope, instead of through the scoped tools of the built-in
`hypotenuse` server.

**Permission policies**

| Policy | What happens when the agent asks permission for a tool call |
|---|---|
| `allow` | allowed once |
| `deny` | rejected once; the agent sees the refusal |
| `ask` | posted to the Linear session as a choice (`select` elicitation); the agent waits until someone answers, up to `idle_timeout`. A free-text reply instead of a choice rejects the call and becomes the next instruction |

### Prompt templates

`prompt` and `prompt_file` are Markdown with `{{dotted.variable}}` substitutions and no logic. The rendered text
becomes the `<role-instructions>` section of the agent's prompt. The rest of the prompt (Linear's context,
guidance, conversation history, the request, and environment notes) is added by Hypotenuse
([phase 11](./plans/phase-11-acp-agent-host.md#4-prompt-assembly)).

| Variable | Value |
|---|---|
| `issue.identifier` | `ENG-123` |
| `issue.title` | the issue title |
| `issue.url` | the Linear issue URL |
| `issue.description` | the issue description (Markdown) |
| `issue.team.key`, `issue.team.name` | the issue's team |
| `session.url` | the Linear agent session URL |
| `session.id` | the Hypotenuse agent session id |
| `role` | `manager` or `worker` |
| `creator.name`, `creator.email` | who started the session (empty when an automation did) |
| `repository.name`, `repository.remote`, `repository.base_branch` | the chosen repository (empty for repository-less turns) |
| `worktree.path`, `worktree.branch` | where the agent is working |
| `runner.name` | this runner |
| `dispatch.parent_identifier` | for dispatched work, the issue the manager dispatched from |

**The built-in templates**, in short:

- **Worker:** implement the issue in the worktree; keep a plan current; commit in small steps that reference
  the issue identifier; push the branch and open a pull request; report it with `linear_report_pr` as soon as
  it exists; ask with `linear_ask_user` and end the turn when a decision belongs to a person; finish with a
  short summary of what changed and what to review; never claim to be a person.
- **Manager:** own the shape of the work; write or refine the PRD (project description or a Linear document);
  break it into issues and sub-issues with clear acceptance criteria; dispatch implementable issues with
  `hypotenuse_dispatch`; review workers' results when review turns arrive; ask before large scope changes;
  never write code itself.

`hypotenuse config validate` rejects unknown variables (`{{issue.titel}}` suggests `{{issue.title}}`).

## `[[repositories]]`

One entry per repository this runner can work in. Routing only offers work that needs a repository to runners
that have it, matched by normalized `remote`.

| Key | Type | Default | Rules |
|---|---|---|---|
| `name` | string | last path segment of `remote` | unique; used in worktree paths |
| `path` | path | — (required) | an existing git repository (a clone, not a worktree) |
| `remote` | string | the repository's `origin` | normalized (`git@github.com:acme/web.git` = `https://github.com/acme/web` = `github.com/acme/web`); must match `origin`; unique |
| `base_branch` | string | `origin/HEAD`'s branch, else `main` | must exist on origin (checked unless `--offline`) |
| `setup` | array of strings | `[]` | shell commands run in each new worktree, in order |
| `setup_timeout` | duration | `"10m"` | per command |
| `branch_prefix` | string | `"hypotenuse"` | branches are `<prefix>/<issue-id>-<slug>` |
| `worktrees` | `"always"` \| `"never"` | `[sessions] worktrees` | `"never"` runs the agent in `path` itself, one session at a time, on a clean tree only (warned) |
| `cleanup` | as `[sessions] cleanup` | `[sessions] cleanup` | per-repository override |
| `pr_url_patterns` | array of strings (regex) | `[]` | extra PR URL patterns for self-hosted forges; GitHub, GitLab, and Bitbucket are built in |

## `[sessions]`

| Key | Type | Default | Rules |
|---|---|---|---|
| `worktrees` | `"always"` \| `"never"` | `"always"` | see `[[repositories]] worktrees` |
| `worktree_root` | path | `"~/.hypotenuse/worktrees"` | writable; not inside a configured repository |
| `cleanup` | `"on-complete"` \| `"on-merge"` \| `"ttl"` \| `"never"` | `"on-complete"` | when a worktree becomes eligible for removal. Uncommitted changes, unpushed commits, a `.hypotenuse-keep` file, or a running session always keep it |
| `cleanup_ttl` | duration | — | required when `cleanup = "ttl"` |
| `cleanup_grace` | duration | `"1h"` | `on-complete` waits this long after a session completes, in case a follow-up arrives |
| `turn_timeout` | duration | `"60m"` | maximum length of one turn; ≥ `idle_timeout` |
| `idle_timeout` | duration | `"15m"` | maximum silence from the agent, or wait for an answer, before the turn is stopped; ≥ `keepalive_interval` |
| `keepalive_interval` | duration | `"10m"` | a "still working" thought after this much silence; must be under 30m, Linear's stale window |
| `stop_grace` | duration | `"10s"` | after a stop, how long the agent gets to wind down before it is terminated |
| `min_free_disk` | size | `"2GB"` | free space required under `worktree_root` to start a new worktree |

## `[log]`

| Key | Type | Default | Rules |
|---|---|---|---|
| `level` | `"error"` \| `"warn"` \| `"info"` \| `"debug"` \| `"trace"` | `"info"` | overridden by `-v` (debug) and `HYPOTENUSE_LOG_LEVEL`; `trace` logs ACP message contents to session logs |
| `file` | path | `<state dir>/daemon.log` | rotated at 10 MB, five kept |

## Environment variables

| Variable | Effect |
|---|---|
| `HYPOTENUSE_CONFIG` | config file path (after `-c`) |
| `HYPOTENUSE_URL` | server URL (after `--url`) |
| `HYPOTENUSE_LOG_LEVEL` | log level (after `-v`) |
| `HYPOTENUSE_NO_UPDATE_CHECK` | `1` disables the once-a-day update notice |
| `HYPOTENUSE_SERVICE` | set by `hypotenuse service install`'s unit; makes the daemon exit (and let the service manager restart it) instead of re-execing after an upgrade |
| `XDG_CONFIG_HOME`, `XDG_STATE_HOME` | move the config and state directories |
| `NO_COLOR`, `FORCE_COLOR` | CLI output color |

The daemon sets these in every agent's environment and every setup command's environment:
`HYPOTENUSE_SESSION_ID`, `HYPOTENUSE_LINEAR_SESSION_ID`, `HYPOTENUSE_ISSUE`, `HYPOTENUSE_ISSUE_URL`,
`HYPOTENUSE_BRANCH`, `HYPOTENUSE_BASE_BRANCH`, `HYPOTENUSE_ROLE`, `HYPOTENUSE_SESSION_URL`, and
`GIT_TERMINAL_PROMPT=0`.

## A complete example

A runner that serves both roles: a Claude Code manager and a Codex worker, across two repositories.

```toml
#:schema https://hypotenuse.dev/schemas/config-v1.json
config_version = 1

[server]
url = "https://api.hypotenuse.dev"
project = "acme"

[runner]
name = "evan-mbp"
max_parallel_jobs = 3
roles = ["manager", "worker"]

[subscriptions]
teams = ["ENG", "WEB"]          # only these Linear teams
labels = []                     # any label

[agents.claude]
preset = "claude"

[agents.codex]
preset = "codex"
env = { CODEX_API_KEY = "$OPENAI_API_KEY" }

[roles.manager]
agent = "claude"
prompt_file = "prompts/manager.md"   # relative to this file
permission_policy = "ask"            # every tool call that needs approval goes to Linear
turn_timeout = "30m"

[roles.worker]
agent = "codex"
# no prompt: the built-in worker template
permission_policy = { default = "allow", fetch = "ask" }

[[roles.worker.extra_mcp_servers]]
name = "sentry"
command = ["npx", "-y", "@sentry/mcp-server"]
env = { SENTRY_AUTH_TOKEN = "$SENTRY_AUTH_TOKEN" }

[[repositories]]
name = "web"
path = "~/code/web"
remote = "github.com/acme/web"
base_branch = "main"
setup = ["bun install --frozen-lockfile"]

[[repositories]]
name = "api"
path = "~/code/api"
remote = "github.com/acme/api"
base_branch = "develop"
setup = ["uv sync", "cp .env.example .env"]
setup_timeout = "15m"
cleanup = "on-merge"

[sessions]
worktree_root = "~/.hypotenuse/worktrees"
cleanup = "on-complete"
turn_timeout = "90m"
idle_timeout = "20m"
keepalive_interval = "10m"

[log]
level = "info"
```

`hypotenuse config validate` on this file checks:

- both repositories are git clones whose `origin` matches;
- `main` and `develop` exist on origin;
- `prompts/manager.md` exists and uses only known variables;
- `npx` is on `PATH`;
- the keepalive is under Linear's 30-minute stale window and the timeouts are ordered.

`--online` also checks the server, the runner token, the project, and the team keys.

## Validation messages, by example

```
$ hypotenuse config validate
✗ roles.worker.agent: unknown agent "codx" (did you mean "codex"?)
✗ repositories[1].path: ~/code/api-old is not a git repository
✗ sessions.keepalive_interval: 45m is longer than Linear's 30m stale window
! repositories[0].base_branch: "trunk" not found on origin (github.com/acme/web)
! agents.claude.max_parallel: 4 is not below runner.max_parallel_jobs (3); it has no effect
! roles.worker.extra_mcp_servers[0].env.SENTRY_AUTH_TOKEN: $SENTRY_AUTH_TOKEN is not set in this environment
3 errors, 2 warnings
```

Exit codes: `0` valid (warnings allowed), `1` errors, `2` the file could not be read or parsed (with line and
column). `--json` prints `{ valid, errors: [{ path, message, hint? }], warnings: [...] }`.
