# Phase 11 — ACP agent host

> **Goal:** For each claimed work item, the daemon spawns the role's coding agent over the
> [Agent Client Protocol](https://agentclientprotocol.com), gives it a prompt built from Linear's context and the
> session's history, and turns everything the agent does into Linear activities: thoughts, actions, a plan,
> questions, and a final response or error. Any ACP agent works; a dozen are one config line. A person's "stop"
> in Linear stops the agent within seconds and says where it left off.

> **Status: planned, not built.** It replaces the null executor from
> [the daemon](./phase-10-daemon-and-config.md) behind the same `SessionExecutor` interface. Worktrees come from
> [phase 12](./phase-12-worktrees-and-session-lifecycle.md) (this phase runs in a plain temporary directory until
> then), and the MCP server it hands the agent comes from [phase 13](./phase-13-hypotenuse-mcp.md).

ACP is why Hypotenuse can say "as many coding agents as possible" without a driver per agent. Claude Code, Codex,
Gemini CLI, Copilot, goose, OpenCode, Cursor, and others speak the same JSON-RPC over stdio. They take a working
directory and MCP servers, accept a prompt made of content blocks, and stream back `session/update` notifications:
thought and message chunks, tool calls and their updates, plans, and titles. They ask permission through
`session/request_permission`. That is very close to the shape of a Linear agent session. Linear wants a thought
within 10 seconds, visible actions, a plan, questions as elicitations, and one response at the end. Most of this
phase is the mapping between the two, plus the edges ACP leaves to the client: authentication, permissions,
cancel, and crashes.

## Scope

**In:**

- The `@agentclientprotocol/sdk` client, pinned to an exact version.
- **Agent presets** and custom agent commands.
- The `initialize` handshake and authentication handling, including `hypotenuse agents login <agent>` for
  terminal-auth agents.
- Session creation and resumption (`session/new`, `session/load`, `session/resume`).
- **Prompt assembly** from the role prompt, Linear context, guidance, history, and the follow-up.
- The **ACP → protocol event mapping** with coalescing.
- **Permission policy** (`allow` / `ask` / `deny`) and the elicitation round trip.
- `fs/*` handlers confined to the worktree.
- ACP `elicitation/create` handling.
- **Cancel, stop, and kill.**
- Timeouts, crash handling, per-session agent logs, and `stopReason` mapping.
- A **fake ACP agent** fixture for tests.
- `doctor --agent` handshake checks.

**Out:**

- Worktree lifecycle and cleanup ([phase 12](./phase-12-worktrees-and-session-lifecycle.md)).
- The Hypotenuse MCP server's tools ([phase 13](./phase-13-hypotenuse-mcp.md)); this phase passes it in
  `mcpServers` and asserts the agent connected to it.
- Manager-specific behaviour ([phase 14](./phase-14-manager-and-dispatch.md)); here a role is just a prompt,
  an agent, and a policy.
- ACP `terminal/*` client methods. We advertise `terminal: false`, and agents run their own shells inside the
  worktree. Revisit if an agent we care about refuses to run commands without a client terminal.
- ACP v2 (experimental). We implement stable `protocolVersion: 1` only.
- Images and audio in prompts. Linear issue attachments are referenced as links in the prompt text, not
  embedded.

## Design

### 1. The SDK, and why it is pinned exactly

`@agentclientprotocol/sdk` **2.0.0** was released on 2026-10-19 and removed the `ClientSideConnection` /
`Client` interface API that most examples online still use. The 2.x API is builder-style:

```ts
const result = await acp.client({ name: "hypotenuse" })
  .onRequest(acp.methods.client.session.requestPermission, onPermission)
  .onRequest(acp.methods.client.fs.readTextFile, onRead)
  .onRequest(acp.methods.client.fs.writeTextFile, onWrite)
  .onRequest(acp.methods.client.elicitation.create, onElicit)
  .onNotification("*", onUnknown)
  .connectWith(acp.ndJsonStream(stdin, stdout), async (ctx) => { … ctx.buildSession(…) … });
```

- **Pin it exactly.** `cli/package.json` pins `"@agentclientprotocol/sdk": "2.0.0"` with no caret. A major
  version one day old will have point releases that change behaviour, and the daemon is the one component a
  person cannot easily roll back.
- **One wrapper owns the SDK.** `cli/src/acp/connection.ts` is the only module that imports it, so a 2.x → 3.x
  change touches one file.
- **Upgrades are deliberate.** They happen by editing the pin, with the fake-agent suite and the nightly
  real-agent smoke ([phase 17](./phase-17-conformance-and-e2e.md)) as the gate.

### 2. Agent presets

`cli/src/acp/presets.ts` maps a preset id to a launch command. Commands come from the ACP registry
(`https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`), copied into code rather than fetched at
runtime: a daemon that cannot reach a CDN must still start its agents, and a registry change should arrive as a
reviewed diff.

| Preset | Command | Auth notes |
|---|---|---|
| `claude` | `npx -y @agentclientprotocol/claude-agent-acp` | Claude Code login on the machine; `claude` CLI must be logged in. Formerly `@zed-industries/claude-code-acp` (deprecated) |
| `codex` | `npx -y @agentclientprotocol/codex-acp` | `CODEX_API_KEY` / `OPENAI_API_KEY`, or ChatGPT login; `NO_BROWSER=1` is set by the daemon. Formerly `@zed-industries/codex-acp` |
| `gemini` | `npx -y @google/gemini-cli --acp` | Gemini login or `GEMINI_API_KEY`. `--experimental-acp` is deprecated |
| `copilot` | `npx -y @github/copilot --acp` | GitHub login |
| `goose` | `goose acp` | goose's own provider config |
| `opencode` | `opencode acp` | opencode's own provider config |
| `cursor` | `cursor-agent acp` | Cursor login |
| `qwen` | `npx -y @qwen-code/qwen-code --acp --experimental-skills` | Qwen login |
| `cline` | `npx -y cline --acp` | Cline config |
| `auggie` | `npx -y @augmentcode/auggie --acp` | `AUGMENT_DISABLE_AUTO_UPDATE=1` is set by the daemon |
| `kilo` | `npx -y @kilocode/cli acp` | Kilo config |
| `custom` | `[agents.<id>] command = [...]` | whatever the agent advertises |

A config entry with `preset = "codex"` may add `env` and `args` (appended after the preset's own arguments). It
may set `auth_method` to choose among the agent's advertised `authMethods`. `command` replaces the preset
entirely. Presets that launch through `npx` get `npm_config_yes=true` and inherit the daemon's captured `PATH`
([phase 10](./phase-10-daemon-and-config.md#12-user-services)).

The agent process is spawned with:

- `cwd` set to the worktree
- `detached: true`, so it gets its own process group
- stdin and stdout piped as the ACP stream
- stderr appended to `~/.local/state/hypotenuse/sessions/<agentSessionId>.log`, prefixed with a timestamp
- an environment of the daemon's environment, minus `HYPOTENUSE_*` credentials-adjacent variables, plus the
  agent's `env` and the per-session variables from [phase 12](./phase-12-worktrees-and-session-lifecycle.md)

### 3. Initialize and authentication

```ts
initialize({
  protocolVersion: 1,
  clientCapabilities: {
    fs: { readTextFile: true, writeTextFile: true },
    terminal: false,
    auth: { terminal: true },
    elicitation: { form: true, url: true },
    session: { configOptions: { boolean: true } },
  },
  clientInfo: { name: "hypotenuse", title: "Hypotenuse", version },
});
```

The agent answers with `agentCapabilities` and `authMethods`. Both are recorded in `local_sessions` and on the
next heartbeat's `RunnerCapabilities.agents[]`, so the dashboard can show which agents on which runner support
`loadSession`.

**Authentication is a property of the machine, not of the turn.** A turn is not the moment to ask a person to log
in. Most agents authenticate from credentials already on disk, so the host calls `authenticate` only when needed:

| Situation | Behaviour |
|---|---|
| `authMethods` empty, or the agent creates a session without complaint | proceed |
| `session/new` fails with `-32000 auth_required` and the config names `auth_method` of `type: "agent"` | call `authenticate({ methodId })` once, then retry `session/new` |
| `auth_required` and the only methods are `type: "terminal"` | fail the turn with an `error` activity: `"<agent> on runner <name> is not logged in. On that machine, run: hypotenuse agents login <agent>"`; mark the agent `available: false` in capabilities so routing stops offering roles that need it until the next successful handshake |
| `auth_required` and the method needs a URL the person must visit (ACP `elicitation/create` mode `url` during auth) | emit an `elicitation` with Linear's **`auth` signal** and `signalMetadata: { url, providerName: <agent title>, userId: <issuer's Linear user id if known> }`; wait for the next prompt, then retry |

**`hypotenuse agents login <agent>`** runs the agent's terminal auth method interactively. It spawns the agent
with the method's `args` and `env`, attaches the TTY, and then performs a fresh `initialize` + `session/new` to
confirm. **`hypotenuse doctor --agent <id>`** does the handshake non-interactively and reports the outcome.

### 4. Prompt assembly

`cli/src/acp/prompt.ts` builds the `ContentBlock[]` for `session/prompt` from the `WorkAssignment` (see
[`RUNNER_PROTOCOL.md`](../RUNNER_PROTOCOL.md)) and the role config. It is the **only** implementation of a
Hypotenuse prompt: tests, `config validate`, and a future `hypotenuse prompt preview` all call it.

The prompt is a single `text` block with sections, plus `resource_link` blocks for the issue URL and attachments:

```
<hypotenuse>
You are working as the {{role}} agent for Linear issue {{issue.identifier}} on behalf of {{creator.name}}.
You are an AI agent; never claim to be a person. …
</hypotenuse>

<role-instructions>            ← the role's prompt / prompt_file, rendered with the variables below
…
</role-instructions>

<linear-context>               ← WorkAssignment.promptContext, verbatim (Linear's XML-like block)
…
</linear-context>

<guidance>                     ← WorkAssignment.guidance, nearest team first, then parent teams, then workspace
<rule origin="team" team="ENG">…</rule>
<rule origin="workspace">…</rule>
</guidance>

<conversation>                 ← WorkAssignment.history: prior prompts, responses, elicitations, errors
<turn role="user" at="…">…</turn>
<turn role="agent" at="…">…</turn>
</conversation>

<request>                      ← this turn: the follow-up body, or "Begin." for a new session
…
</request>

<environment>
Working directory: {{worktree.path}} (branch {{worktree.branch}}, from {{repository.base_branch}})
Linear tools: the "hypotenuse" MCP server. Use linear_ask_user to ask a question and then end your turn.
</environment>
```

**Template variables** use `{{dotted.path}}` with no logic. Unknown variables are an error at `config validate`
time ([phase 10](./phase-10-daemon-and-config.md#3-config-validate--path-precise-three-passes-and-fixes-suggested))
and render as empty at runtime, logged once.

| Group | Variables |
|---|---|
| Issue | `issue.identifier`, `issue.title`, `issue.url`, `issue.team.key`, `issue.team.name`, `issue.description` |
| Session | `session.url`, `session.id`, `role`, `creator.name`, `creator.email` |
| Repository and worktree | `repository.name`, `repository.remote`, `repository.base_branch`, `worktree.path`, `worktree.branch` |
| Runner | `runner.name` |
| Dispatch | `dispatch.parent_identifier` (manager dispatches, [phase 14](./phase-14-manager-and-dispatch.md)) |

**History comes from activities, not comments.** The server builds `WorkAssignment.history` from
`agent_activities`, because Linear's best practice is explicit that comments can be edited and activities are
frozen. Only `prompt`, `response`, `elicitation`, and `error` activities are included. Thoughts and actions are
too verbose to replay, and an agent that kept its own session (`session/load`) already has them.

**A follow-up body** comes from the `prompted` webhook's `agentActivity`. The server normalizes
`agentActivity.body` and `agentActivity.content.body` (the docs and the schema disagree) into
`WorkAssignment.prompt` before the daemon sees it, so the daemon reads one field.

**Resumed sessions get less.** When the follow-up resumes an existing ACP session (§5), the prompt is just
`<request>` plus a one-line `<hypotenuse>` reminder. The agent already holds the rest, and re-sending the whole
context every turn would cost tokens and confuse agents that treat it as new instructions.

### 5. Sessions: new, load, resume

| Work item kind | ACP session present in `local_sessions` | Agent capability | Call |
|---|---|---|---|
| `session_created`, `dispatch`, `review` (first turn) | — | — | `session/new { cwd, mcpServers }` |
| `prompt` (follow-up), same runner | yes | `sessionCapabilities.resume` | `session/resume` — no replay, cheapest |
| `prompt`, same runner | yes | `loadSession` | `session/load` — the agent replays history as `session/update`s, which the mapper **discards** (it is not new work) until `session/load` returns |
| `prompt`, same runner | yes, but load/resume fails | — | `session/new`, with full history in the prompt; logged |
| `prompt`, re-offered to another runner | no | — | `session/new`, with full history; the server already posted the "continuing on <runner>" thought |

**`mcpServers` always includes the Hypotenuse server:**

```ts
{ name: "hypotenuse",
  command: <absolute path of the running hypotenuse binary, or bun + script for npm installs>,
  args: ["mcp", "--session", agentSessionId, "--nonce", <per-turn nonce>],
  env: [{ name: "HYPOTENUSE_STATE_DIR", value: stateDir }] }
```

The role's `extra_mcp_servers` from config come next. ACP requires stdio MCP server commands to be absolute
paths, so `process.execPath` is resolved once at startup. [Phase 13](./phase-13-hypotenuse-mcp.md) explains why
the arguments carry a nonce and no token.

**`configOptions` and modes.** If the agent advertises a `mode` config option (or legacy modes) and the role
config names `mode = "…"`, the host calls `session/set_config_option` (or `session/set_mode`) once after
creation. This is how a manager role can run an agent in a planning or read-only mode where the agent offers
one.

### 6. Mapping ACP to protocol events

`cli/src/acp/mapping.ts` is a pure state machine: `(state, acpUpdate) → (state, SessionEvent[])`. That makes it
exhaustively unit-testable from recorded transcripts. Event shapes are the `SessionEvent` union in `protocol/`.

| ACP | State kept | Emitted |
|---|---|---|
| `agent_thought_chunk { content: text }` | thought buffer | nothing until flush; **flush every 3 s or at 2 KB**, then `thought { body, ephemeral: true }`. The final buffered thought of a turn is flushed non-ephemeral, so the session keeps the agent's last reasoning |
| `agent_message_chunk` | message buffer, keyed by `messageId` | nothing; at turn end the concatenated text becomes `response { body }` |
| `tool_call { toolCallId, title, kind, status: pending/in_progress, rawInput, locations }` | `toolCalls[toolCallId]` | `action { action: verb(kind) + title, parameter: compactParameter(...), ephemeral: true }` |
| `tool_call_update { status: completed }` | merge | `action { action: pastTense(...), parameter, result: compactResult(...), ephemeral: false }` |
| `tool_call_update { status: failed }` | merge | `action { …, result: "Failed: <first line>" }` |
| `plan { entries }` | last plan | `plan { entries: [{ content, status }] }`, with `in_progress` mapped to `inProgress`, the whole list every time, and **deduplicated** (an identical plan is not re-sent) |
| `session_info_update { title }` | — | `summary { title }`, trimmed to 255 characters and one line |
| `usage_update` | — | `usage { used, size, cost? }`, shown on the dashboard only |
| `current_mode_update`, `config_option_update`, `available_commands_update` | recorded | nothing |
| `user_message_chunk` | — | ignored (only seen during `session/load` replay) |
| `notice`, `compaction_*` (capability-gated) | — | not advertised; ignored if sent |
| unknown `sessionUpdate` | — | logged once per kind; ignored |

**`compactParameter`** keeps actions readable in Linear, where an action is one line:

- the first location's worktree-relative path for `read`, `edit`, `delete`, and `move`
- the command line for `execute`, truncated to 200 characters
- the query for `search` and `fetch`
- otherwise the first 200 characters of `rawInput` as JSON

**`compactResult`** is Markdown, capped at 2 KB:

- diff content becomes `+12 −3 in src/app.ts`, with the full diff inside a collapsible `+++ Diff` … `+++`
  section up to the cap
- terminal and text content becomes its last 20 lines in a fenced block

**Verbs** come from ACP's `kind`:

| `kind` | In progress | Done |
|---|---|---|
| `read` | Reading | Read |
| `edit` | Editing | Edited |
| `delete` | Deleting | Deleted |
| `move` | Moving | Moved |
| `search` | Searching | Searched |
| `execute` | Running | Ran |
| `think` | Thinking | Thought |
| `fetch` | Fetching | Fetched |
| `other` | the tool's `title` | the tool's `title` |

**Turn end**, from `session/prompt`'s result:

| `stopReason` | Emitted |
|---|---|
| `end_turn` | flush thoughts; `response { body }` from the message buffer, or `"Done."` plus the last action summary if the agent said nothing |
| `cancelled` | the stop path's final `response` (§7) |
| `refusal` | `error { body: "The agent declined to continue: <message buffer or 'no reason given'>" }` |
| `max_tokens` | `error { body: "The agent ran out of output tokens. Progress so far is on <branch>; reply to continue." }` |
| `max_turn_requests` | `error { body: "The agent hit its per-turn request limit. Reply to continue." }` |

**What the person sees first.** A daemon claim usually happens within a second or two, but agent start-up
(npx install, model warm-up) can take longer. The server already posted the acknowledgement thought
([phase 7](./phase-07-webhook-ingress-and-session-mirror.md)). The host emits `thought { "Starting <agent> in
<repo>@<branch>…", ephemeral: true }` before spawning, so the session visibly moves within Linear's window
regardless.

**Keepalive.** If no event has been emitted for `sessions.keepalive_interval` during a running turn, the host
emits `thought { "Still working: <last action>", ephemeral: true }`. That keeps the session out of Linear's
30-minute `stale` state on long builds.

### 7. Permissions, elicitations, and the round trip

`session/request_permission` gives a tool call and options such as `allow_once`, `allow_always`, `reject_once`,
and `reject_always`. `cli/src/acp/permissions.ts` answers according to the role's `permission_policy`:

| Policy | Answer |
|---|---|
| `allow` (default for `worker`) | the first option of kind `allow_once`, else `allow_always`. Never `allow_always` when `allow_once` exists: a session-wide grant would outlive the person's view of it |
| `deny` | the first `reject_once`, else `reject_always`. The tool call then fails, and the agent sees why |
| `ask` | ask the person in Linear |

Policies can be refined per tool kind: `permission_policy = { default = "allow", execute = "ask", fetch = "deny" }`.

**`ask` is an elicitation that ends the turn's wait, not the turn.**

1. The host emits `elicitation { body, signal: "select", signalMetadata: { options: [{ label, value }] } }`.
   - `body` reads like: "The agent wants to run `rm -rf build/` in acme/web. Allow it?".
   - Each `value` is an ACP `optionId` and each `label` is its `name`.
   - Linear moves the session to `awaitingInput`.
2. The permission request stays pending. The agent process keeps running, blocked on our answer. Its turn
   timer pauses; `idle_timeout` keeps running.
3. The server records the elicitation and routes the next `prompted` event for this session to this runner as a
   `prompt` work item with `answersElicitation: <eventId>` ([`RUNNER_PROTOCOL.md`](../RUNNER_PROTOCOL.md)).
   The daemon delivers it to the waiting session instead of starting a new turn.
4. The reply is matched against the pending options, in order:
   1. an exact `value`
   2. an exact `label`, case-insensitive and trimmed
   3. a 1-based number ("2")
   4. yes or no words ("yes", "allow", "ok", "go ahead" mean allow once; "no", "deny", "don't" mean reject once)
5. If the reply matches, the host answers the permission request with that option and the turn resumes.
6. If it doesn't match, the person wrote something else. Linear says free text dismisses an elicitation and
   must be interpreted. The host answers `reject_once`, lets the turn end, and queues the text as the **next
   prompt** for the same session. "Don't delete build, run the tests first" is then an instruction rather than a
   failed match.
7. If `idle_timeout` expires while waiting, the host answers `cancelled` and ends the turn with an `error`:
   "Waited <idle_timeout> for an answer; reply to resume."

**ACP `elicitation/create`** (agent-initiated questions) uses the same machinery:

- **`mode: "form"` with an enum-only schema** becomes a `select` elicitation over the enum.
- **Any other form** becomes a plain `elicitation` with the schema's fields described in Markdown. The reply
  text is returned as `{ action: "accept", content: { <single string field>: text } }` when the schema has
  exactly one string field. Otherwise the host answers `decline` and forwards the text as the next prompt.
- **`mode: "url"`** becomes an `elicitation` with the **`auth` signal** and `signalMetadata.url`. The host
  answers `accept` once the next prompt arrives and calls `elicitation/complete` handling as the agent expects.

Questions the agent asks through the MCP tool `linear_ask_user` take a different path
([phase 13](./phase-13-hypotenuse-mcp.md)). The turn ends, and the answer arrives as an ordinary follow-up.

### 8. Filesystem handlers

`fs/read_text_file` and `fs/write_text_file` resolve `params.path` with `realpath` (for writes, the parent
directory's `realpath`). They refuse with JSON-RPC error `-32002` and the message "outside the session
worktree" for anything outside:

- the session's worktree
- the role's `additional_directories`, if configured

Writes create parent directories and write atomically. `line` and `limit` on reads are honoured (1-based).
These handlers are the only file access the daemon performs on an agent's behalf. Agents that write files
themselves are confined by their own sandboxes, not by us, and the docs say so plainly.

### 9. Cancel, stop, and kill

There are several ways to end a turn, and they share **one path**, `SessionRunner.cancel(reason)`:

| Trigger | `reason` | Final activity |
|---|---|---|
| Linear `prompted` with `signal: "stop"` (WS `cancel` or `heartbeat.cancels`) | `stop` | `response`: "Stopped at your request. Changes so far are on branch `<branch>` in `<worktree>` (<n> files changed, not pushed)." |
| Issue un-delegated, session dismissed, or issue completed or canceled (server-side cancel) | `disengaged` | none from the daemon; the server already decided not to speak (AIG: respect disengagement) |
| `agents kill` / dashboard `agent-session:cancel` | `killed` | `error`: "Cancelled by <who> from <where>." |
| `turn_timeout` | `timeout` | `error`: "Stopped after <turn_timeout>. Reply to continue from where it left off." |
| daemon drain with cancel | `shutdown` | `error`: "The runner <name> shut down mid-turn. Reply to continue (it may resume on another runner)." |

The cancel path:

1. Send ACP `session/cancel { sessionId }`, a notification.
2. Answer every pending `session/request_permission` with `{ outcome: "cancelled" }`, and every pending
   `elicitation/create` with `cancel`. The spec requires this, and agents block on it otherwise.
3. Wait up to `sessions.stop_grace` (default 10 s) for `session/prompt` to return `stopReason: "cancelled"`.
4. If it hasn't returned, send SIGTERM to the agent's process group, wait 5 s more, then send SIGKILL.
5. Flush thoughts. Emit the final activity for the reason. **After a `stop` signal Linear only accepts
   `response` or `error`** (the session is `stopping`), so the mapper drops any action or thought that races in
   after step 1.
6. `daemon:complete { outcome: "cancelled" }`.

On `stop`, the agent's process is not reused. The next follow-up starts it again and resumes the ACP session if
the agent supports it. That is slower than keeping it, and guarantees that "stop" means nothing is still running.

### 10. Crashes, timeouts, and logs

| Failure | Detection | Result |
|---|---|---|
| Agent process exits during a turn | stdout EOF / `exit` event | `error`: "<agent> exited unexpectedly (code <n>). Last output: ```<last 20 stderr lines>```"; `outcome: failed` |
| Agent fails to start (ENOENT, npx install failure) | spawn error / exit before `initialize` | `error` with the command and stderr tail; agent marked `available: false` until a later handshake succeeds |
| `initialize` doesn't answer in 60 s (`npx` cold installs are slow) | timer | as above |
| JSON-RPC parse error on stdout (an agent printing logs to stdout) | SDK error | logged; three in a row fail the turn with an `error` naming the agent |
| `idle_timeout` with no ACP traffic while not awaiting a person | timer | cancel path with `reason: timeout` |
| `turn_timeout` | timer from `session/prompt` | cancel path with `reason: timeout` |

Every session's stderr and a one-line-per-message JSON-RPC trace (method names and sizes, not contents, unless
`log.level = "trace"`) go to `~/.local/state/hypotenuse/sessions/<agentSessionId>.log`. `hypotenuse daemon logs
--session <id>` tails it. Errors quote at most 20 lines of it, after redacting anything matching common secret
shapes (`sk-…`, `ghp_…`, `xox…`, `Bearer …`). A stderr line is the likeliest place for an agent to print a key,
and the Linear issue may be visible to the whole workspace.

### 11. The fake ACP agent

`cli/__tests__/fixtures/fake-acp-agent.ts` is a real ACP agent built on the same SDK's agent side, run with
`bun`. It reads a **scenario** from `FAKE_ACP_SCENARIO` (a name) or `FAKE_ACP_SCRIPT` (a path to JSON), and it
writes every request it receives to `FAKE_ACP_RECORD` (a JSONL path) so tests can assert on what Hypotenuse
sent.

| Scenario | Behaviour |
|---|---|
| `happy` | thought chunks → plan (3 entries) → `tool_call` edit `src/a.ts` → update completed with a diff → plan all completed → message chunks → `end_turn` |
| `permission` | `tool_call` execute → `request_permission` with allow_once / reject_once → continues per the answer |
| `elicit-form` / `elicit-url` | `elicitation/create` in form (enum) or url mode |
| `long` | emits nothing for a configurable duration, then ends — exercises keepalive and `idle_timeout` |
| `slow-cancel` | ignores `session/cancel` — exercises SIGTERM/SIGKILL |
| `crash` | exits 1 mid-turn after writing to stderr |
| `refusal`, `max-tokens` | ends with that `stopReason` |
| `auth-required` | fails `session/new` with `-32000` until `authenticate` is called (or never, with a terminal-only method) |
| `loadable` | advertises `loadSession` and replays recorded history on `session/load` |
| `mcp-probe` | calls the `hypotenuse` MCP server's `linear_get_issue` and echoes the result ([phase 13](./phase-13-hypotenuse-mcp.md)) |
| `stdout-noise` | prints a non-JSON line to stdout |

`[agents.fake] command = ["bun", "<abs>/cli/__tests__/fixtures/fake-acp-agent.ts"]` is how tests configure it.
No test in CI launches a real coding agent. The nightly smoke in
[phase 17](./phase-17-conformance-and-e2e.md) does.

## Steps

### 1. Pin and wrap the SDK — `cli/package.json`, `cli/src/acp/connection.ts`

Pin `@agentclientprotocol/sdk` to `2.0.0`. `AcpConnection` spawns the process, builds `ndJsonStream`,
registers handlers, exposes `initialize`, `newSession`, `loadSession`, `resumeSession`, `prompt`, `cancel`,
`setConfigOption`, and an async iterator of updates, and closes cleanly.

### 2. Presets — `cli/src/acp/presets.ts`

The table above, `resolveAgentCommand(config, agentId)`, and the per-preset env defaults. The table is also
exported for `config validate`'s "did you mean" and for `CONFIG.md`.

### 3. Host — `cli/src/acp/host.ts`

`AcpSessionExecutor implements SessionExecutor` performs spawn → initialize → auth → session selection (§5) →
prompt → map → complete. It deletes `cli/src/daemon/null-executor.ts`.

### 4. Prompt — `cli/src/acp/prompt.ts`, `cli/src/acp/templates/{worker.md,manager.md}`

`buildPrompt(assignment, roleConfig, worktree)`, the variable renderer, and the default role templates
(embedded as text imports). `listTemplateVariables()` is used by `config validate`.

### 5. Mapping — `cli/src/acp/mapping.ts`, `cli/src/acp/summarize.ts`

The state machine, coalescing timers (injected clock), `compactParameter`, `compactResult`, verbs, and the
stop-reason table.

### 6. Permissions and elicitations — `cli/src/acp/permissions.ts`, `cli/src/acp/elicitation.ts`

Policy resolution, the option ↔ select mapping, `matchReply()`, the pending-request registry, and cancel-all.

### 7. Filesystem — `cli/src/acp/fs.ts`

Confined read and write with `realpath` checks.

### 8. Cancel and failure handling — `cli/src/acp/lifecycle.ts`

`cancel(reason)`, process-group signalling, timers, stderr capture with redaction, and the final-activity table.

### 9. CLI — `cli/src/commands/agents.ts` (`agents login`), `cli/src/commands/doctor.ts` (`--agent`)

### 10. Fake agent — `cli/__tests__/fixtures/fake-acp-agent.ts`, `cli/__tests__/fixtures/scenarios/*.json`

### 11. Tests

**Unit tests (`cli/__tests__/acp/`):**

- `mapping.test.ts` drives recorded update sequences (one per scenario, plus edge cases) and **asserts the exact
  emitted event list**: types, ephemerality, bodies, plan dedupe, and the 3 s and 2 KB flushes with an injected
  clock.
- `summarize.test.ts` covers parameter and result compaction, the diff summary, and the 2 KB cap.
- `prompt.test.ts` renders golden prompts for the new, follow-up, resumed, and dispatched cases; checks guidance
  ordering (team before workspace); and checks that an unknown variable renders empty and is reported.
- `permissions.test.ts` checks each policy against option sets that lack `allow_once`, each `matchReply` rule,
  and that free text yields `reject_once` plus a queued prompt.
- `fs.test.ts` refuses `../`, absolute paths outside the worktree, and symlinks escaping it, and allows
  `additional_directories`.
- `host.test.ts` runs the real host against the fake agent with a capturing sink, one test per scenario,
  including `slow-cancel` (SIGKILL within `stop_grace` + 5 s) and `crash` (an `error` with the stderr tail,
  redacted).

**End-to-end (`backend/__tests__/e2e/acp.test.ts`):** a real backend, finear, the real daemon, and the fake
agent.

- Delegate an issue in finear to the app. Assert finear's `agentSession.activities` is exactly: the server ack
  `thought`, the "Starting…" thought replaced by later ephemerals, then the persisted actions, the plan on the
  session, and the `response`. Assert the session status is `complete`.
- `permission` with `permission_policy = "ask"`: the session reaches `awaitingInput` with a `select`
  elicitation. A finear `/__test/agents/prompt` with "allow" resumes the turn to `complete`. A reply of "run the
  tests instead" ends the turn and starts a new one whose prompt contains that text.
- `long` with `/__test/agents/stop`: within `stop_grace` the session ends with the "Stopped at your request"
  `response`, and the fake agent's process is gone.
- `auth-required` with a terminal-only method: an `error` naming `hypotenuse agents login fake`, and the next
  heartbeat reports the agent unavailable.

## Verification

```bash
bun run --cwd cli lint && bun run --cwd cli test
cd backend && bun test __tests__/e2e/acp.test.ts

# by hand: a real agent against a local backend and finear, or real Linear through ngrok
hypotenuse doctor --agent claude
hypotenuse agents login codex
FAKE_ACP_SCENARIO=happy hypotenuse daemon start --foreground -c ./examples/fake.toml -v
```

## Definition of done

- [x] SDK pinned to `2.0.0`, imported only by `cli/src/acp/connection.ts`
- [ ] Every preset in the table launches; custom `command` works; per-agent `env` and `args`
- [x] `initialize` with the capabilities above; auth handled per the table; `agents login`; unavailable agents
      reported in capabilities
- [x] `session/new`, `session/resume`, `session/load` (replay discarded), and fallback with history
- [x] `buildPrompt` is the only prompt builder; template variables validated
- [x] The mapping table implemented exactly, with coalescing, keepalive, plan dedupe, and summary trimming
- [x] `allow`/`ask`/`deny` policies, per-kind overrides, the select round trip, free-text fallback, and the
      idle wait
- [x] `elicitation/create` form and url, including the `auth` signal
- [x] `fs/*` confined to the worktree
- [x] One cancel path for all five reasons; Linear's `stopping` rule respected
- [x] Crash, start failure, init timeout, stdout noise, and both timeouts handled; per-session logs with
      redaction
- [x] The fake agent supports every scenario and records requests
- [x] User docs: `/docs/agents` (supported agents, login, permissions)

## Commands

```bash
hypotenuse agents login claude
hypotenuse doctor --agent codex --json | jq '.agents'
hypotenuse daemon logs --session <agentSessionId> -f
FAKE_ACP_SCENARIO=permission bun cli/__tests__/fixtures/fake-acp-agent.ts   # speaks ACP on stdio
```

## Learnings from the build

**Built.** Everything in the Definition of done, at CLI 0.7.0, with the departures below. The daemon's slots run
`AcpSessionExecutor`; the null executor is gone, and every real-daemon suite (`backend/__tests__/daemon/`) now runs
the fake ACP agent through it. No real coding agent has run a turn in CI; the presets were checked against the ACP
registry, not launched.

### Where the pieces live

- **`cli/src/acp/`** — `connection.ts` (the only SDK importer: spawn in a process group, stdout filtered to JSON
  before the SDK sees it, stderr and a JSON-RPC trace to callbacks), `host.ts` (`AcpSessionExecutor`: one `Turn`
  per claim), `mapping.ts` (`TurnMapper`), `summarize.ts` (verbs, compaction, the diff stat, redaction),
  `prompt.ts` + `templates/{worker,manager}.md`, `permissions.ts`, `elicitation.ts` (questions and the
  `QuestionQueue`), `fs.ts` (`ConfinedFs`), `lifecycle.ts` (session logs, the stop-activity table),
  `presets.ts` (launch command and environment; the preset table stays in `config/presets.ts`), `handshake.ts`
  (`doctor --agent` and `agents login`; it replaced `daemon/acp-probe.ts`).
- **Commands:** `cli/src/commands/agents.ts` — `agents list`, `agents kill` (the control-socket methods phase 10
  left without commands), and `agents login`.
- **Server:** `work_items.awaiting_answer_since` and `answers` (migration `0007`), `answerWaitingTurn` and
  `releaseAnswers` in `ops/WorkItemOps.ts`, the heartbeat's `answers`, and `daemon:complete`'s `answersConsumed`.
- **Tests:** `cli/__tests__/acp/` (unit, and `host.test.ts` against the fake agent), `cli/__tests__/commands/
  agents.test.ts`, `backend/__tests__/routing/answers.test.ts` (the server's round trip with a scripted daemon),
  and `backend/__tests__/daemon/acp.test.ts` (end to end).

### Where the build departs from the plan

| Plan | Built | Why |
|---|---|---|
| A reply to an `ask` arrives as a `prompt` work item with `answersElicitation` | **the held item is marked awaiting an answer when it posts an `elicitation`; the reply is appended to its `answers` and carried by every heartbeat's `answers`; `daemon:complete` lists `answersConsumed`, and the rest become the next `prompt` turn** — additive to `protocol/`, no version bump | the one-turn-per-session index forbids a second live item, and the turn being answered is the one that is running. Reporting what was consumed (rather than what was not) means a lost daemon loses no reply |
| `mcpServers` always includes the `hypotenuse` server; `<environment>` names its tools | **only the role's `extra_mcp_servers`**; the built-in templates name no tools | `hypotenuse mcp` does not exist yet. Handing every agent a server that fails to start would put an MCP error in every turn |
| `backend/__tests__/e2e/acp.test.ts` | **`backend/__tests__/daemon/acp.test.ts`** | beside the other real-daemon suites, and their `DaemonHome` |
| "a plain temporary directory" until worktrees | **`<state dir>/workspaces/<agentSessionId>`**, kept | a follow-up must `session/load` in the same `cwd`; a fresh temp directory per turn would break every resume |
| `action: verb(kind) + title` | **`action` is the verb; `parameter` the compact path, command, or query; an `other` tool's title is its action** | Linear renders the pair as "**Ran** `npm test`"; the ACP title usually repeats the parameter |
| `killed` → "Cancelled by <who> from <where>" | **"Cancelled from runner <name> (`hypotenuse agents kill`)"**, and the dashboard's own sentence | the daemon does not know who ran the command |
| Timeouts take "the cancel path with `reason: timeout`" | **the same path, completing `failed`** with the error text | the server asked for nothing, and the dashboard should show a failure, not a cancellation |
| The cancel path sends `session/cancel` and waits `stop_grace` | **waits for `session/prompt` to answer, then closes stdin, then SIGTERM, 5 s, SIGKILL**, all within `stop_grace` + 5 s | an agent exits when its stdin closes, so closing it before the prompt answers would cut its wind-down short |
| `auth_required` during auth with a URL is its own row | **the generic `elicitation/create` url path** (an `auth` elicitation; the next reply accepts) | the agent asks the same way either way |
| An agent marked unavailable recovers "at the next successful handshake" | **`daemon reload` forgets it, and `agents login` sends a reload when it succeeds** | an unavailable agent is offered no work, so no turn would ever find it healthy again |
| `doctor --agent` runs `initialize` | **`initialize` and `session/new` in a scratch directory** | a logged-out agent answers `initialize` happily; only a session shows it |
| `mcp-probe` scenario | **not built** | there is no MCP server to probe until the Hypotenuse MCP plan lands |
| — | **`creator: { name, email }` on the assignment** (additive) | the `creator.*` template variables had nothing to read. `issue.team.name` still renders empty: the issue snapshot has the key only |

### Decisions the plan left open

| Question | Answer |
|---|---|
| Which `elicitation`s mark a turn awaiting | every one a held turn posts; one that ends its turn (a future `linear_ask_user`) just completes, and a reply that arrives in between is unconsumed, so it becomes the next turn as it should |
| A second reply while the first is unread | an ordinary follow-up, queued behind the turn with the "queued behind" thought |
| Free text while several questions wait | every waiting question is declined (permissions: `reject_once`; elicitations: `decline`) and the text becomes the next prompt |
| An agent-run auth method when the config names none | the first one the agent advertises that is not `terminal` |
| What "thoughts flushed before an action" means | a buffered thought flushes (ephemeral) before any action, plan, or question, so order is kept; only the turn's last thought persists |
| A `cancelled` stop reason the host did not ask for | treated as `end_turn` |
| Unknown template variables at runtime | rendered empty and logged as a warning once per variable |

### Traps found while building

- **`return promise` inside `try … finally` runs `finally` first.** The turn's `finally` closes the agent, so
  `return this.stopped()` closed it before the cancel path had sent `session/cancel`; the SDK's `notify` then hung
  until the close rejected it. `return await` it.
- **A dying agent closes the connection a moment before it exits.** The pending `session/prompt` rejects with "ACP
  connection closed" first; wait briefly for the exit code before reporting, or every crash reads as a protocol
  error.
- **The SDK answers a non-JSON stdout line with a parse error the agent never reads.** Filtering stdout ourselves
  is the only way to count noise, and it keeps the SDK's stream clean.
- **Every turn is a new agent process**, so a scripted agent cannot count turns in memory; the fake counts the
  prompts its record file holds for `HYPOTENUSE_SESSION_ID`.
- **No routing clock runs in the suites.** A follow-up the server queued is offered only when a test calls
  `route()`; the real-daemon tests that span two turns loop on it.
- **A daemon killed with `SIGKILL` cannot kill its agents.** They are in their own process groups and exit when
  their stdin closes, which every agent tested does; nothing reaps one that does not yet.
