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
| a GitHub repository | git and `gh` get a token for that one repository, one command at a time — see [Working on a repository](#working-on-a-repository) |
| the rest of the internet | depends on the project's egress mode — see [Egress](#egress-what-a-sandbox-may-reach-on-the-network) |
| anything else in Hypotenuse | refused: a job token is not a person, and cannot read or change a project |

The job token never reaches anything you can read: if the agent prints it, the job's transcript, status, and
artifacts show `hyp_job_[redacted]` instead.

What the agent writes reaches the bot marked as the coding agent's output, never as a person's words, and it never
counts as an answer to a question the bot asked the people in the conversation.

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

A job on a repository in **read** mode asks first too: it pushes nothing, but it still runs the repository's code.
**Off** refuses it.

Setting **Allow**, or removing a bot's token budget, takes admin standing in the project: either one lets the bot spend
the project's money with nobody asked. Anyone who may change the bot can tighten them.

## Working on a repository

A bot can start a job on a GitHub repository its project has [granted it](/docs/repositories) by naming it
(`owner/name`) in `sandbox_start`. Before the agent starts, the repository is cloned into the sandbox, and the
agent works in that checkout. A bot holding no grant for the repository is told so, and to ask a project admin.

| Mode | For | What the job may do |
|---|---|---|
| **write** (the default) | changing the code | push a branch and open a pull request. Needs a grant that allows pushes, and follows the bot's **Sandboxes** setting |
| **read** | questions about the code ("how does auth work in `acme/api`?") | read and run it, never push. Waits for approval like any job under **Ask first**, and runs for at most 15 minutes |

The bot can also name a branch, tag, or commit to check out — a pull request's branch, to address its review.

- **Branches.** A write job is told to push a new branch under the grant's branch prefix (by default
  `hypotenuse/<bot>/`), never to the default branch. A [repository ruleset](/docs/repositories) on GitHub is what
  enforces it.
- **Pull requests.** The agent opens one with `gh pr create` and reports its link, which comes back to the
  conversation. Commits are authored as the bot, with the person who asked as co-author when they are a Hypotenuse
  user.
- **Credentials, one command at a time.** The sandbox holds no GitHub token. Each `git` or `gh` command asks
  Hypotenuse for a token good for one repository — at write only for the repository a write job was started on, and
  only when its grant allows a push; read for any other repository granted to the bot. The token lives for that
  command, is never written to disk or the environment, and every token a job was given is **revoked when the job
  ends**.
- **The managed `gh`.** The `gh` in a sandbox works with no `gh auth login`: inside the checkout it uses that
  repository, and anywhere else it needs `--repo owner/name`; it never guesses.

Every token a job asked for — handed out, reused, or refused, with the reason — is recorded with the job.

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
| Model requests in flight at once, per job | 4 | the deployment |

A model request that could take a job past its token budget — its input plus the `max_tokens` it asks for — is
refused (HTTP 402) before it is sent, and a job already at its budget is refused and cancelled. A request the agent
abandons part way is still counted. A job past its time limit
ends as **timed out**. A job whose agent goes quiet, or whose supervisor stops answering, is ended for it, so a stuck
sandbox never runs on.

## Where jobs run

**Settings → Sandboxes** says where the project's jobs run — the provider and its options, the egress mode, how many
at once, and the longest a job may run — and what is in effect now. Every member can read it; only admins change it. A blank field is
the deployment's default.

![Project settings: the sandbox provider, image, concurrency, and longest run](illustration:settings-sandboxes)

| Provider | Where a job runs | For |
|---|---|---|
| **Vercel Sandbox** | a Vercel Sandbox microVM on the project's own Vercel account, billed to that team | production |
| **Docker** | a container on the server's own Docker | development only: a production deployment refuses it |

A job reads the provider when it starts, not when the bot asked for it: a job waiting its turn when an admin switches
providers starts on the new one.

## Vercel

Jobs on Vercel run on **your** Vercel account. An admin connects it once, under **Settings → Sandboxes**:

1. **A token.** In Vercel, **Account Settings → Tokens**, create a token scoped to the team the sandboxes should be
   billed to. Hypotenuse stores it encrypted and never shows it again — only its last four characters.
2. **The team id**, `team_…`, under the team's **Settings → General**.
3. **The project id**, `prj_…`, under the Vercel project's **Settings → General**. Sandboxes belong to a Vercel
   project; any project will do, and a dedicated empty one keeps them apart from your deployments.

Hypotenuse checks the token, team, and project before it saves them (it lists the project's sandboxes; it creates
nothing), so a wrong one is refused there and then. **Test** checks a saved connection again. Then choose **Vercel
Sandbox** as the provider — that checks the connection once more.

| Setting | What it does | Default |
|---|---|---|
| Runtime | the stock runtime each sandbox boots: `node24`, `node22`, or `python3.13` | `node24` |
| vCPUs | 1 to 8 per sandbox; each comes with 2 GiB of memory | 2 |
| Egress | `open-world` or `allowlist` — see below | `open-world` |

Vercel boots stock runtimes, so each job first installs what the coding agent needs — bun, the coding CLI, and, for a
job on a repository, the GitHub CLI — which adds some seconds to its start. A job's page shows what its sandbox was
given: its vCPUs, memory, time limit, and runtime.

A connection cannot be removed while the project's jobs run on it, or while one of its sandboxes is still alive:
without the account, nothing could destroy that sandbox.

### Egress: what a sandbox may reach on the network

| Mode | While the job is set up | While the agent works |
|---|---|---|
| `open-world` | anything | anything — except a job on a repository, which is held to this server and GitHub |
| `allowlist` | this server, GitHub, and the npm registry (to install its tools) | **only** this server and, for a job on a repository, `github.com` and `api.github.com` |

In `allowlist` mode everything else is blocked by Vercel, outside the sandbox: the agent cannot fetch a web page,
install a package once it is working, or send anything anywhere but Hypotenuse — whose model proxy, MCP gateway, and
memory are all it needs. The list narrows after the tools are installed and before the repository is cloned, so a
repository's contents never meet open egress. Choose it when the work touches code or data that must not leave; leave
`open-world` when the agent needs to install packages or read documentation as it works.

Docker cannot enforce a list, so `allowlist` is refused there.

A bot can **require** an allowlist (its **Sandboxes** section: **Require an egress allowlist**). Its jobs then always
run behind one, whatever the project's mode — and on a provider that cannot enforce one, `sandbox_start` refuses, and
the bot tells you why. Any writer of the bot may turn it on; turning it off takes an admin.

## The sandboxes themselves

Every sandbox Hypotenuse asks a provider for is written down before it is created — its provider, the job it ran,
what it was given — and stamped when it is destroyed. The **Sandboxes** page lists the ones that may still be running.
A job's sandbox ends with the job; one that is left over (a failed start, a deploy at the wrong moment) is collected
by a sweep within the hour, and an admin can destroy it sooner from that list. A sandbox whose job is still running
is the job's: cancel the job instead.

From the [command line](/docs/cli), `hypotenuse sandbox list`, `sandbox view`, `sandbox events`, `sandbox cancel`,
and `sandbox answer` follow jobs, `hypotenuse project settings` reads and changes where they run, and
`hypotenuse connection` connects the account a hosted provider runs on.
