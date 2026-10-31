# MCP servers

A bot does its real work with **tools**: reading and sending email, opening pull requests, looking things up in
your company's systems. Hypotenuse does not write those tools. It connects to **MCP servers** — an Arcade gateway,
GitHub's, your own — once per project, and each bot is given the servers it may use.

**Settings → MCP servers** lists the project's servers. Members can see them and browse their tools; only the
project's admins connect, change, test, sign in to, and remove them.

![Settings → MCP servers: each server with its status, and one opened to its tools](illustration:mcp-servers)

## Connecting a server

A server is a **name** and a **URL**. The name is a short slug — `arcade`, `github` — and is how a bot names a tool:
`github/create_pull_request`. The URL is the server's Streamable HTTP endpoint and must be a public `https` address;
the server refuses private and local addresses, when you save it and again every time it connects.

How the server checks who is calling is its **auth mode**:

| Auth mode | What you give | What is sent |
|---|---|---|
| **None** | nothing | nothing |
| **Headers** | header names and values, such as an API key | those headers, on every request |
| **Bearer** | a token | `Authorization: Bearer <token>` |
| **OAuth** | nothing, or a client id (and secret) if the server's sign-in does not register clients itself | a token from signing in, refreshed as it expires |

Credentials are encrypted when you save them and are **never shown again** — not to you, not to a bot, not in a
transcript or the audit log. The page shows only the header names and the last four characters of a bearer token.
To change a credential, enter a new one.

A header value may contain `{{bot.identity}}` or `{{bot.slug}}`, filled in for each bot that calls. With an Arcade
gateway, set `Arcade-User-ID` to `{{bot.identity}}`: each bot is then its own user there, with its own tool
authorizations, so one bot's access to a mailbox is never another's.

Saving connects once and lists the server's tools. For an **OAuth** server, **Sign in** sends you to the server's
own sign-in page and back; the server is ready once you return. If its sign-in later expires and cannot be
refreshed, the server shows **Needs sign-in** until an admin signs in again.

**Test** connects now and records whether it worked. **Refresh tools** re-reads the server's tool list, which is
otherwise refreshed every hour. **Disable** hides the server from every bot without forgetting it; **Remove** takes
it from every bot and deletes its credentials.

## Browsing tools

Open a server to see its tools: each one's name, what it says it does, and its **annotations** — the server's own
claims about it, such as **read-only**. Annotations are hints from the server, not guarantees, which is why
read-only tools still ask for approval unless a bot's settings say otherwise.

## Giving a server to a bot

A server does nothing until a bot is given it, on the bot's page under **Tools** — see
[Bots](/docs/bots#tools). Anyone who may change the bot can give it servers and decide which of their tools run
without asking.

A bot does not see every tool at once. It **searches** for a tool by what it wants to do, **reads** that tool's
description and inputs, and then **calls** it — and, unless the call is allowed outright, the call waits for a
person to [approve](/docs/approvals) it.

| Tool | What the bot does with it |
|---|---|
| `mcp_search` | finds tools across its servers by what they do, and learns whether each would wait for approval |
| `mcp_list_tools` | lists every tool it may call, or one server's — offered even to a bot with no server, so asking a bot what tools it has gets a straight answer |
| `mcp_info` | reads one tool's description and inputs — required before the bot may call it |
| `mcp_exec` | calls a tool; may wait for approval |
| `read_large_result` | reads more of a result too long to show at once |

A result longer than about 10,000 characters is stored rather than handed to the model whole: the bot sees the
start of it and reads the rest a page at a time, or saves the whole result into its channel
[memory](/docs/memory) to search later. Stored results are deleted 30 days after their conversation ends.
