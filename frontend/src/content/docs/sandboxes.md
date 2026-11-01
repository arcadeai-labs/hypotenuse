# Sandboxes

Some work needs a real machine: reading a repository, changing it, running its tests, trying a script, taking an
hour. A bot does not do that on Hypotenuse's servers. It hands the work to a **sandbox job**: a coding agent in an
ephemeral sandbox that starts empty, does the one task, reports back into the conversation it came from, and is
destroyed when the job ends.

![The Sandboxes page: each job with its bot, status, and the tokens it used](illustration:sandboxes)

## What runs where

| Where | What runs there |
|---|---|
| The conversation | The bot. It decides to start a job, writes the task, answers the agent's questions, and reads the result. |
| The sandbox | The coding agent and a small supervisor. Its files, shell, and packages are its own, and gone when the job ends. |
| Hypotenuse's servers | Everything the sandbox reaches: the model proxy, the gateway to MCP servers, and the bot's memory. |

A job belongs to the conversation that started it and works with that bot's authority — never more.

## What a sandbox can reach

A sandbox holds exactly one credential: its **job token**, which works only while the job is alive and only for that
job. It holds no model key, no MCP server credential, and no platform token. Everything else goes through
Hypotenuse, which attaches the real credential on its own side:

| The sandbox asks for | What happens |
|---|---|
| a model | the **model proxy** forwards the request to the bot's own Anthropic model connection, and only for the models the bot uses (its main and fast ones) |
| an MCP tool | the **gateway** serves the bot's own [MCP servers](/docs/mcp-servers), and lists and runs only the tools the bot may call without asking |
| a tool outside the bot's allowlist | **refused**. A sandbox cannot wait for an [approval](/docs/approvals), so the agent is told to ask instead, or to say in its result that the call is needed |
| memory | it can search what the bot remembers about this channel and the project, read-only |
| anything else in Hypotenuse | refused: a job token is not a person, and cannot read or change a project |

## Starting a job

A bot starts a job with its `sandbox_start` tool, naming the work in a short title and writing the task in full —
the agent sees nothing of the conversation. A job either does the task once and ends, or is **interactive**: it
waits for the bot's next instruction after each turn.

Starting a job is not waiting for it. Usually the bot then ends its turn with `sandbox_wait`, and the conversation
shows **Waiting on a sandbox** until the job ends, asks the bot a question it must answer, or finishes an
interactive turn — each wakes it, and the job's result arrives as a message. A person writing in the channel
meanwhile wakes it too, so you can ask how it is going. The bot can also tell you it started the job and carry on;
the result still arrives when the job ends.

Whether a bot may start jobs is its **Sandboxes** setting, on [its page](/docs/bots):

![A bot's Sandboxes section: whether it may start jobs, and its token budget per job](illustration:bot-sandbox)

| Setting | What happens when the bot calls `sandbox_start` |
|---|---|
| **Ask first** (`approve`, the default) | the job waits for a person to [approve](/docs/approvals) it, like a tool call outside the allowlist |
| **Allow** | the job starts at once |
| **Off** | the bot cannot start jobs |

## In the conversation

A job appears in the [transcript](/docs/conversations) as one `sandbox` row with the job's title and where it is now,
and the bot waiting on it as a `waits on sandbox` row. Opening the first shows the task the bot wrote, what the
agent last reported, how it ended, and a link to the job; the second links to the job too.

**Sandboxes** in the sidebar (`g s`) lists the project's jobs, newest first, for the bots you may read; filter by
status or by bot. A job's page shows:

- its status, its bot, and the conversation it belongs to;
- the task, and — folded — the exact briefing the agent was given;
- what the agent last reported, what it said at the end, and its **artifacts** (named texts it handed back, such as
  its result or a report);
- the questions it asked and how they were answered, and the messages the bot sent it;
- its own transcript: what the agent said, which tools it ran, and what they returned, read live while it runs.

![A sandbox job's page: its task, status, questions, and transcript](illustration:sandbox-job)

## Questions from a sandbox

When the agent needs a decision it should not guess, it asks. It asks one of two ways:

- **The conversation.** The question goes to the bot. If the bot knows the answer it replies; if only the people
  there can, it asks them and passes their answer on. Anyone who may change the bot can also answer it on the job's
  page.
- **The team.** The question lands in the [Help inbox](/docs/escalation), like a bot's own request for help, and is
  answered there.

A question can be *blocking* — the agent waits for the answer — or not, and the agent carries on meanwhile. A job may
ask at most five.

## Stopping a job

A job stops when any of these happens:

- someone presses **Stop** in the channel, or [cancels the conversation](/docs/conversations) — every job it started
  stops too;
- someone who may change the bot presses **Cancel job** on the job's page;
- the bot calls `sandbox_cancel`.

A job that has not started ends at once. A running one stops within a heartbeat, its sandbox is destroyed, and the
conversation is told it was cancelled.

## Limits

| Limit | Default | Who changes it |
|---|---|---|
| Jobs running at once, per project | 3 | an admin, under **Settings → Sandboxes** |
| Jobs running at once, per bot | 1 | the deployment |
| The longest one job may run | 1 hour | an admin, but only lower than the deployment's ceiling |
| An interactive job left waiting for its next instruction | expires after 30 minutes | the deployment |
| Model tokens one job may use | no cap | the bot's **Sandboxes** section: **Tokens per job** |

A job over its token budget is refused its next model request (HTTP 402) and cancelled. A job past its time limit
ends as **timed out**. A job whose agent goes quiet, or whose supervisor stops answering, is ended for it, so a stuck
sandbox never runs on.

## Where jobs run

**Settings → Sandboxes** says where the project's jobs run — the provider, the image, how many at once, and the
longest a job may run — and what is in effect now. Every member can read it; only admins change it. A blank field is
the deployment's default.

![Project settings: the sandbox provider, image, concurrency, and longest run](illustration:settings-sandboxes)

The **Docker** provider runs jobs on the server's own Docker. It is for development only: a production deployment
refuses it, so a project there runs its jobs on the deployment's hosted provider.

From the [command line](/docs/cli), `hypotenuse sandbox list`, `sandbox view`, `sandbox events`, `sandbox cancel`,
and `sandbox answer` follow jobs, and `hypotenuse project settings` reads and changes where they run.
