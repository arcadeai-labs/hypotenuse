# Coding agents

A runner does its work with a **coding agent** on your machine: Claude Code, Codex, Gemini CLI, Copilot, goose,
OpenCode, Cursor, and anything else that speaks the [Agent Client Protocol](https://agentclientprotocol.com). The
daemon starts the agent for each turn, gives it the issue, Linear's context, and the conversation so far, and turns
everything it does into the Linear session: its thinking, each tool it runs, its plan, its questions, and its answer.

## Supported agents

Name a preset and the daemon knows how to start it:

| Preset | Starts | Logs in with |
|---|---|---|
| `claude` | `npx -y @agentclientprotocol/claude-agent-acp` | your Claude Code login on this machine |
| `codex` | `npx -y @agentclientprotocol/codex-acp` | `CODEX_API_KEY` / `OPENAI_API_KEY`, or a ChatGPT login |
| `gemini` | `npx -y @google/gemini-cli --acp` | a Gemini login or `GEMINI_API_KEY` |
| `copilot` | `npx -y @github/copilot --acp` | your GitHub login |
| `goose` | `goose acp` | goose's own provider config |
| `opencode` | `opencode acp` | opencode's own provider config |
| `cursor` | `cursor-agent acp` | your Cursor login |
| `qwen` | `npx -y @qwen-code/qwen-code --acp --experimental-skills` | your Qwen login |
| `cline` | `npx -y cline --acp` | Cline's config |
| `auggie` | `npx -y @augmentcode/auggie --acp` | your Augment login |
| `kilo` | `npx -y @kilocode/cli acp` | Kilo's config |

```toml
[agents.claude]
preset = "claude"

[agents.codex]
preset = "codex"
env = { CODEX_API_KEY = "$OPENAI_API_KEY" }

[agents.my-agent]
command = ["/opt/my-agent/bin/agent", "--acp"]   # any ACP agent on stdio
```

`args` are appended to a preset's own arguments, and `env` is added to the agent's environment. The agent inherits
the daemon's environment except the daemon's own `HYPOTENUSE_*` settings; it gets `HYPOTENUSE_SESSION_ID`,
`HYPOTENUSE_ISSUE`, and the other per-session variables. Every key and variable is in the
[config file reference](/docs/config).

## Logging in

An agent logs in once, on the machine, never in the middle of a turn:

```bash
hypotenuse doctor --agent claude   # can it open a session?
hypotenuse agents login claude     # log it in, then check again
```

`agents login` asks the agent how it signs in. A login that happens in a terminal runs right there, attached to
yours; one the agent can do itself is asked for over the protocol. Agents that sign in with their own tools (for
example `claude` after `claude login`, or an API key in `env`) need nothing more.

If a turn finds the agent logged out, the session says so in Linear — *"claude on runner evan-mbp is not logged in.
On that machine, run: `hypotenuse agents login claude`"* — and the runner stops being offered work for that agent.
`agents login` tells a running daemon once the agent can open a session again (so does `hypotenuse daemon
reload`), and work resumes.

## What you see in Linear

| The agent | The session shows |
|---|---|
| thinks | a passing thought, updated every few seconds; its last reasoning stays |
| runs a tool | the action while it runs (*Running* `npm test`), then what it did and a short result (*Ran* `npm test`) — a diff as `+12 −3 in src/app.ts` with the diff folded underneath |
| keeps a plan | the session's plan, kept current |
| names the work | the session's title |
| asks a question | an elicitation — a choice when it offered choices |
| finishes | its answer as the response |
| refuses, runs out of tokens, crashes, or times out | an error that says which, and that a reply continues |

A long build that prints nothing still shows *"Still working"* every `keepalive_interval`, so Linear never thinks
the session is stuck.

## Permissions

When an agent asks before running a tool, the role's `permission_policy` answers:

| Policy | What happens |
|---|---|
| `allow` (workers' default) | allowed once — never "always", which would outlive your view of it |
| `deny` | rejected once; the agent sees the refusal and carries on without it |
| `ask` (managers' default) | the session asks you: *"The agent wants to run `rm -rf build/` in acme/web. Allow it?"* with the agent's own choices |

Policies can differ by kind of tool:

```toml
[roles.worker]
agent = "codex"
permission_policy = { default = "allow", execute = "ask", fetch = "deny" }
```

**Answering a question.** Pick a choice, or reply with its name, its number, or a plain *yes* / *no*. The agent is
waiting, not stopped: the turn carries on the moment you answer. A reply that is not one of the choices — *"don't
delete build, run the tests first"* — rejects the request and becomes your next instruction to the agent. Nobody
answering for `idle_timeout` ends the turn with *"Waited 15m for an answer; reply to resume."*

The policy covers what the agent asks about. Agents that edit files or run commands without asking are limited by
their own sandbox settings, not by Hypotenuse; files the agent reads and writes *through* the daemon are confined
to its working directory and the role's `additional_directories`.

## Stopping

Press **Stop** in Linear and the agent is told to stop at once. It gets `stop_grace` (10 seconds) to wind down, then
it is terminated, and the session says where the work was left. Nothing is still running after a stop: the next
message starts the agent again, picking its session back up where the agent supports that.

| Stopped by | The session ends with |
|---|---|
| Stop in Linear | *"Stopped at your request. Changes so far are …"* |
| `hypotenuse agents kill` or the dashboard | an error saying it was cancelled, and from where |
| `turn_timeout` | *"Stopped after 1h. Reply to continue from where it left off."* |
| the daemon shutting down mid-turn | *"The runner … shut down mid-turn. Reply to continue …"* |
| un-delegating, dismissing the session, or completing the issue | nothing — you stepped away, so it stays quiet |

## Follow-ups

Your next message goes to the same runner, which continues the agent's own session when the agent can resume one —
so it only needs your new message. Otherwise, or on another runner, the agent starts fresh with the whole
conversation in its prompt.

> **Where this is today.** Each session works in its own directory under the daemon's state directory
> (`workspaces/<session>`); git worktrees of your repositories, and the `hypotenuse` tools the agent uses to read
> and update Linear, come next.

## Logs

Every session has its own log of the agent's output and of each message exchanged with it:

```bash
hypotenuse daemon logs --session 92 -f
```

An error in Linear quotes at most the last 20 lines of the agent's output, with anything shaped like a key or token
replaced by `[redacted]`. `log.level = "trace"` adds message contents to the session log, which can then hold code
and secrets from your repository — keep it for debugging.
