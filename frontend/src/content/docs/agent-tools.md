# Agent tools

Every coding agent Hypotenuse runs gets one more MCP server for its turn, named `hypotenuse`: a small, closed set of
tools to read and update **Linear**, scoped to the session it is working in. The agent never holds a Linear token
or your runner's token, and nothing it does through these tools can reach past the session's issue.

## What an agent can do

| Tool | Worker | Manager | Does |
|---|---|---|---|
| `linear_get_issue` | ✓ | ✓ | reads an issue — title, description, state, labels, people, parent, sub-issues, relations, project — its own by default |
| `linear_list_comments` | ✓ | ✓ | reads an issue's comments, threaded, 25 at a time |
| `linear_comment` | its own issue | issues it manages | comments as Hypotenuse, optionally in a thread |
| `linear_set_issue_state` | its own issue | issues it manages | moves an issue by state name or type; a worker cannot cancel one |
| `linear_set_plan` | ✓ | ✓ | replaces the session's plan |
| `linear_ask_user` | ✓ | ✓ | asks you a question, with choices if it has them, and ends its turn |
| `linear_report_pr` | ✓ | ✓ | links its pull request to the session (only one on the session's repository) |
| `linear_search_issues` | ✓ | ✓ | finds issues by text, team, state type, label, or project — at most 25 |
| `linear_create_issue` | | ✓ | creates an issue, credited to whoever started the session |
| `linear_update_issue` | | ✓ | edits an issue it manages — never its assignee |
| `linear_create_sub_issue` | | ✓ | breaks an issue it manages into sub-issues |
| `linear_create_relation` | | ✓ | marks issues as blocking, related, or duplicates |
| `linear_get_project` | | ✓ | reads a project: its PRD, status, lead, issue counts, documents |
| `linear_update_project` | | ✓ | writes the PRD, summary, or status of its issue's project — never the lead or members |
| `linear_create_document`, `linear_update_document` | | ✓ | writes documents on its issue's project, or on an issue it manages |
| `linear_list_labels` | | ✓ | lists the labels it can use |
| `hypotenuse_dispatch` | | ✓ | delegates an issue it manages to `@hypotenuse` and starts a worker on it, or sends a finished worker back with changes |

**What a manager manages:** the session's issue, its sub-issues (five levels down), issues the session created, and
other issues in the same team. Everything is also limited to the teams you granted Hypotenuse when you
[connected Linear](/docs/connecting-linear).

A dispatched worker's result comes back to the manager as a review turn — see
[managers and workers](/docs/manager-and-worker). `linear_set_issue_state` never lets a worker move an issue to a
completed or canceled state, and lets a manager do it only where the project allows.

## Questions end the turn

When the agent needs your decision it calls `linear_ask_user`. Linear shows the question — as choices when the agent
offered some — and the session waits for you (*awaiting input*). The agent's turn ends there and holds nothing on
the runner while you think; your answer starts its next turn, with the question in its history.

An agent that asks in plain text instead and ends its turn has given an answer, so the session reads as complete.
Hypotenuse's prompts tell agents to use the tool.

## What it writes, and who it is

Everything is written by the `@hypotenuse` app user. An issue a manager creates says whose request led to it
(*"Peach via Hypotenuse"*). Comments, descriptions, and documents go to Linear as the agent wrote them, at most
64 KB each; agents are told to mention people and issues by their Linear URLs, which Linear turns into mentions.

Every write is recorded with the session's turn: what the agent changed in Linear, and when. These calls
share the workspace's Linear budget (5,000 requests an hour) with everything else Hypotenuse does: reads are cached
for a minute within a turn, and when the budget runs out a read fails with a note to try again shortly while a
write waits up to 30 seconds.

## Why not Linear's own MCP server

Linear publishes an MCP server of its own. Handing it to a coding agent would put a Linear token on your machine,
with access to every team the workspace granted — and an agent reads untrusted text all day (issue descriptions,
dependencies, web pages). It would also give a worker fixing one issue the whole API.

The `hypotenuse` tools are the opposite: no token in the agent's reach, and every call checked on the server against
the one session it belongs to — the right runner, a turn that is still running, the session's role, and the target's
issue and team. If you add Linear's server yourself as an [extra MCP server](/docs/config) with a personal API key,
`hypotenuse config validate` warns you: the agent then acts in Linear **as you**, outside all of this.

## More MCP servers

A role can give its agent more MCP servers — Sentry, internal docs — with `extra_mcp_servers` in the
[config file](/docs/config). `$VAR` in their `env` and `headers` comes from the daemon's environment when a turn
starts; an unset one fails the turn with an error naming the variable. An HTTP server is only passed to agents that
support HTTP MCP, and a turn whose agent does not says so in the session. The name `hypotenuse` is taken.
