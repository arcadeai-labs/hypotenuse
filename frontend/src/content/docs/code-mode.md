# Code mode

Some questions need more data than a bot should read. "Which customers opened more than three tickets this month and
are on the enterprise plan?" would mean pulling every ticket into the conversation, or dozens of tool calls one after
another. With **code mode** the bot writes one short program instead: call the support tool, call the CRM tool, join
them, count, and answer with twelve names. The thousands of rows in between never reach the model.

![A program in a transcript: its source, its result, and the host calls it made](illustration:code-run)

## What a program can do

A bot runs a program with its `run_code` tool. The program is TypeScript or JavaScript; it runs in an isolated
sandbox (QuickJS compiled to WebAssembly) inside Hypotenuse's worker, and can reach exactly these:

| In the program | What it does |
|---|---|
| `memory.search`, `memory.list`, `memory.read` | the bot's [memory](/docs/memory) of this channel and the project's shared memory |
| `memory.write` | writes a new version of a document in this channel's memory |
| `mcp.search`, `mcp.listTools`, `mcp.info` | finds the bot's [MCP](/docs/mcp-servers) tools and reads their input schemas |
| `mcp.exec` | calls one of the bot's MCP tools |
| `mcp.capture` | calls a tool and saves its whole answer to channel memory, returning only an acknowledgement |
| `largeResult.read` | pages through a long tool result from earlier in the conversation |
| `console.log` | output kept beside the result |

That is all. A program has no network, files, packages, timers, or shell, and cannot post to the conversation, ask a
question, or end the bot's turn — it computes, then the bot decides what to say. Work that needs a repository, a
shell, or packages belongs in a [sandbox job](/docs/sandboxes), not in code mode.

Every call goes through the same rules as the bot's own tools: it sees only its own memory, never another channel's;
it cannot change the project's memory; it can use only the MCP servers it was given; and it must read a tool's
schema (`mcp.info`) before calling it.

## Approvals pause a program

A tool call that would [wait for approval](/docs/approvals) as a direct call waits inside a program too. The program
stops **before** the call — nothing is sent — and the conversation waits, showing **Waiting for approval** for each
call. Calls a program makes at the same time wait together; the conversation goes on only once every one of them is
decided.

When they are decided, the **same program** continues from where it stopped. Calls it had already made are not made
again — their answers are replayed from what was recorded — and each approved call runs exactly once. A denied call
throws an error in the program (its `code` is `approval_denied`), which the program can catch to do something else; if
it does not, the program fails and the bot is told a person said no.

The saved state of a paused program is encrypted, signed with a key of the project's own, and bound to its
conversation and call. If it has been tampered with, or the program is not the one that paused, it does not resume
and nothing more runs. It is never shown in a transcript or an answer.

If Hypotenuse is interrupted while a program runs, the program is not run again on its own: the bot is told it was
interrupted, with the calls it had already made, and decides what to do.

## In the transcript

A program appears in the [conversation](/docs/conversations) as one `run_code` row. Opening it shows the program,
its result or error, anything it logged, and every call it made — what it called, whether that call ran because the
tool is allowed or because a person approved it, and how long it took. A program waiting for approval lists the
approvals it waits on, each linking to where it is decided.

## Turning it on and off, and limits

Code mode is on for every bot unless you turn it off. The bot's page has a **Code** section with the switch and three
limits you can set for that bot:

![A bot's Code section: the code-mode switch and its own limits](illustration:bot-code)

| Limit | The deployment's default |
|---|---|
| Time per program | 30 seconds (10 of them computing) |
| Memory | 96 MiB |
| Host calls per program | 256, across every pause |

A bot's limits can only be lower than the deployment's; a higher value is refused. Programs also may not be longer
than 256 KiB, return more than 1 MiB (a bot can save a larger result to memory instead), or log more than 64 KiB.
None of this can be raised from inside a program.

From the command line, `hypotenuse bot edit <bot> --no-code` turns it off, and `--code-timeout`, `--code-memory`,
and `--code-host-calls` set its limits. `hypotenuse code-run list --conversation <id>` and `hypotenuse code-run view
<id>` show a conversation's programs.
