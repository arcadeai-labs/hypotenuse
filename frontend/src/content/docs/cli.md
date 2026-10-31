# Command line

`hypotenuse` is the command line for Hypotenuse. It signs in through your browser and then does what the
dashboard does — organizations, projects, members, invites, tags, model connections and aliases, bots, and the
audit log — over the same API, as you.
Everything it can do, your role must already allow; it never adds permissions of its own.

## Installing

Any one of these:

```bash
curl -fsSL https://raw.githubusercontent.com/arcadeai-labs/hypotenuse/main/install.sh | bash   # macOS, Linux
irm https://raw.githubusercontent.com/arcadeai-labs/hypotenuse/main/install.ps1 | iex          # Windows
npm i -g @arcadeai/hypotenuse
bun i -g @arcadeai/hypotenuse
```

The install scripts download a self-contained binary. The npm package is a [Bun](https://bun.sh) bundle, so the npm
and bun installs need Bun on the machine. `hypotenuse --version` prints what you have.

## Signing in

```bash
hypotenuse login
```

`login` opens your browser at **Sign in the hypotenuse CLI**. Sign in to the dashboard if you are not already, check
the machine name, and choose **Approve**; the terminal finishes on its own. The CLI never sees your password.

On a machine with no browser — an SSH session, a build box — use `hypotenuse login --device`. It prints an address
and a short code; open the address on any device where you are signed in, type the code, and approve. Only type a
code you got from your own terminal: the CLI it belongs to will act as you.

`--name <name>` sets the machine name the dashboard shows (the hostname by default). `--url <server>` signs in to a
server other than the hosted one; later commands keep using it.

`hypotenuse whoami` says who the CLI is signed in as, and where. `hypotenuse logout` signs it out and forgets the
sign-in.

A sign-in lasts 90 days from its last use, so a CLI you use stays signed in and one you forget lapses by itself.
**Account → CLI sign-ins** lists every CLI signed in as you, with when each was last used; **Revoke** signs one out
on its next command.

## Choosing an organization and a project

Most commands act on one project, and a few on one organization. Pick them once:

```bash
hypotenuse org list
hypotenuse org use mushroom-kingdom
hypotenuse project list
hypotenuse project use castle
```

An id or a slug works anywhere a command names one. `--org <id|slug>` and `--project <id|slug>` override the choice
for one command, as do the `HYPOTENUSE_ORG` and `HYPOTENUSE_PROJECT` environment variables. If you belong to
exactly one organization or project, commands use it without asking.

An explicit `--org` widens three listings to the whole organization: `project list`, `invite list` (its pending
invites), and `audit list`.

## Commands

| Command | What it does |
|---|---|
| `hypotenuse login`, `logout`, `whoami` | Sign this machine in or out, and say who it is |
| `hypotenuse org list`, `org view`, `org use` | Your organizations, and choosing one |
| `hypotenuse org create --name`, `org edit --name --slug`, `org delete --yes` | Make an organization; rename or delete one you own |
| `hypotenuse org members`, `org member set-role <userId> owner\|member`, `org member remove <userId>` | An organization's people. Changing roles and removing people needs an owner; pass your own id to leave |
| `hypotenuse project list`, `project view`, `project use` | Your projects, and choosing one |
| `hypotenuse project create --name`, `project edit --name`, `project delete --yes` | Make a project in the chosen organization; rename or delete one where you are an admin |
| `hypotenuse member list`, `member add --email`, `member remove <userId>` | The project's members. Adding takes someone already in the organization; anyone else gets an invite |
| `hypotenuse invite list`, `invite pending`, `invite create --email [--tag <id>]`, `invite accept <id>`, `invite reject <id>` | Invitations. `create` invites into the project; `--organization-only` invites into the organization instead. `pending` lists invitations addressed to you |
| `hypotenuse tag list`, `tag create <name>`, `tag edit <id> --name`, `tag delete <id>`, `tag assign <id> --user <userId>`, `tag remove <id> --user <userId>` | The project's [tags](/docs/tags) and who holds them. The `admin` tag is reserved |
| `hypotenuse model connection list`, `model connection view <connection>` | The project's model providers: each one's provider, base URL, the last four characters of its key, and whether its last test passed |
| `hypotenuse model connection add --name --provider [--base-url]`, `model connection rotate <connection>` | Connect a provider (`anthropic`, `openai`, `gateway`, or `openai-compatible`, which needs `--base-url`), or replace a connection's key. Admins only; see **API keys** below |
| `hypotenuse model connection edit <connection> --name --base-url`, `model connection test <connection>`, `model connection models <connection>`, `model connection remove <connection>` | Rename one or change its base URL (`--default-base-url` goes back to the provider's); check its key works; list the models it offers; delete it. Admins only |
| `hypotenuse model alias list`, `model alias set <name> --connection --model`, `model alias remove <name>` | The model names bots use. `default` and `fast` must both exist before any bot can run, and `list` says which are missing. `set` creates an alias or changes the one of that name; `--max-output-tokens` and `--temperature` tune it, and `--kind embedding` (only for the alias named `embedding`) makes it the model memory embeds with. Admins only to change |
| `hypotenuse bot list`, `bot view <bot>` | The bots you can read, and one bot's settings and persona (its prompt's Identity section) |
| `hypotenuse bot create --name --persona-file`, `bot edit <bot>`, `bot delete <bot> --yes` | Make a bot, change it, or delete it. See **Bots from the command line** below |
| `hypotenuse bot callback-secret <bot>` | Create the secret a bot signs its API callbacks with, and print it once. See **Talking to a bot** below |
| `hypotenuse mcp-server list`, `mcp-server view <server>`, `mcp-server match <server> --pattern` | The project's shared [MCP servers](/docs/mcp-servers): each one's endpoint, how it signs in (never the credential), its status, and the tools it offers; and which tools an allowlist pattern would let through |
| `hypotenuse mcp-server add <name> --endpoint`, `mcp-server edit <server>`, `mcp-server test <server>`, `mcp-server refresh <server>`, `mcp-server sign-in <server>`, `mcp-server remove <server> --yes` | Connect a server, change it, check it answers, re-list its tools, sign the project in to an OAuth server, or disconnect it. Admins only; see **MCP servers from the command line** below |
| `hypotenuse bot tools list <bot>`, `bot tools add <bot> <server>`, `bot tools remove <bot> <server>` | Which MCP servers a bot may use, the calls it makes without asking (`--allow`), and whether read-only tools ask (`--auto-allow-read-only`). Changing them needs write access to the bot |
| `hypotenuse prompt list [--bot]`, `prompt view <section>`, `prompt versions <section>`, `prompt preview --bot` | A bot's [prompt sections](/docs/prompts), or with no `--bot` the project's; one section's text; its history (a person, the bot itself, a revert); and the exact system prompt the bot would be sent, with which sections were in and out. See **Prompts, goals, and skills from the command line** below |
| `hypotenuse prompt add --title`, `prompt edit <section>`, `prompt revert <section> --to`, `prompt remove <section> --yes` | Add a section, change its text or settings, put an earlier version back, or delete it. A bot's sections need write access to the bot; the project's need an admin |
| `hypotenuse goal list --bot`, `goal view <goal>`, `goal add --bot --title`, `goal edit <goal>`, `goal remove <goal> --yes` | A bot's [goals](/docs/goals): what it works toward, at what priority, and how often it reviews them |
| `hypotenuse skill list [--bot]`, `skill view <skill>`, `skill versions <skill>`, `skill add <name>`, `skill edit <skill>`, `skill remove <skill> --yes` | The project's [skills](/docs/skills), or with `--bot` the ones a bot has |
| `hypotenuse skill attach <skill> --bot [--pin]`, `skill detach <skill> --bot` | Let a bot use a skill — at its latest version, or pinned to one — or take it away |
| `hypotenuse installation manifest --bot`, `installation connect --bot --delivery-url`, `installation test <id>`, `installation list --bot`, `installation view <id>`, `installation disconnect <id> --yes` | A bot's platform apps: get the events URL the platform delivers to, connect its credentials, check it works, and disconnect it. See **Platforms and channels from the command line** below |
| `hypotenuse slack create --bot`, `slack connect --bot --client-id`, `slack install <id>` | A bot's own [Slack](/docs/slack) app: create it with a configuration token, or connect one made from the manifest; then print the link that installs it into the workspace |
| `hypotenuse channel list [--bot]`, `channel view <id>` | The platform channels the project's bots hear from, and how each bot is bound there |
| `hypotenuse binding list --bot`, `binding create --bot --channel`, `binding edit <id>`, `binding delete <id> --yes` | Where a bot listens: bind it to a channel, change how it listens, or unbind it. Changing needs write access to the bot |
| `hypotenuse help-request list`, `help-request view <id>`, `help-request answer <id> --text`, `help-request cancel <id>` | The help inbox: questions bots escalated to the team, and your answers. See **The help inbox from the command line** below |
| `hypotenuse participant list`, `participant view <id>` | The people on platforms who have written to the project's bots (`--type`, `--query` narrow the list) |
| `hypotenuse event list`, `event view <id>` | Every platform delivery the bots received and what became of it — answered, ignored because the channel is unbound, rate-limited (`--status`, `--outcome`, `--installation` narrow the list). Admins only |
| `hypotenuse approval list`, `approval view <id>`, `approval approve <id>`, `approval deny <id>` | Tool calls bots are waiting on ([approvals](/docs/approvals)): list them (`--status pending`, `--bot`, `--conversation` narrow it), read one, and decide it. See **Approvals from the command line** below |
| `hypotenuse large-result view <lr_id>` | A tool result too long to show in a transcript, which the transcript names `lr_<id>`: a page at a time (`--offset`, `--limit`) or `--all` |
| `hypotenuse conversation create --bot --text [--web [--fresh]]`, `conversation message <id> --text` | Start a conversation with a bot — over the API, or with `--web` in its dashboard chat — or send one a message. See **Talking to a bot** below |
| `hypotenuse conversation list`, `conversation view <id>`, `conversation follow <id>`, `conversation cancel <id>` | The conversations with bots you can read (`--bot`, `--state` narrow the list); one conversation's state; its transcript as the bot works; stopping it |
| `hypotenuse memory search <query>`, `memory list`, `memory view <path>`, `memory versions <path>`, `memory channels --bot` | Search what bots [remember](/docs/memory) the way a bot does, list documents with how much each has faded, read one (`--version-id` for an earlier version) and its history, and list the channels a bot remembers. See **Memory from the command line** below |
| `hypotenuse memory write <path> --text`, `memory forget <path>`, `memory pin <path>`, `memory promote <path> --bot --channel`, `memory reindex` | Correct or add a memory, forget one, pin one so it never fades (`--unpin` to undo), copy a bot's channel memory into project memory, and re-embed after the embedding model changes |
| `hypotenuse audit list` | The project's [audit log](/docs/audit), newest first, or with `--org` the organization's (`--org-only` for its own rows, no project's) |
| `hypotenuse check-update`, `hypotenuse upgrade` | See whether a newer release exists, and install it |

`audit list` reads the last 30 days unless told otherwise. `--since` and `--until` take a date (`2026-10-01`), epoch
milliseconds, or a span back from now (`7d`, `12h`, `30m`); `--action tag:edit`, `--actor-type user`, and
`--target-type tag` narrow it further.

Deleting an organization, a project, a bot, an MCP server, a prompt section, a goal, a skill, or a binding, and
disconnecting an installation, asks for `--yes` before it runs.

A model connection or an MCP server is named by its id or its name, a bot by its id or its slug, an alias by its
name, and a channel, an installation, a binding, a help request, and an approval by their ids.

### API keys

The CLI never takes an API key as a flag's value, because a flag lands in your shell history and in the list of
running processes. Give it one of these instead:

```bash
pbpaste | hypotenuse model connection add --name anthropic --provider anthropic --api-key-stdin
hypotenuse model connection add --name openai --provider openai --api-key-env OPENAI_API_KEY
hypotenuse model connection rotate anthropic     # on a terminal: asks for the key without showing it
```

`--api-key-stdin` reads the key from standard input; `--api-key-env <NAME>` reads it from that environment variable;
with neither, a terminal asks for it and does not echo what you type. The key goes straight to the server, which
stores it encrypted and never shows it again — only its last four characters. A new or rotated key reads as
`unverified` until `model connection test` checks it; `test` exits non-zero when the check fails, so a script can
stop there.

```bash
hypotenuse model connection test anthropic
hypotenuse model connection models anthropic
hypotenuse model alias set default --connection anthropic --model claude-sonnet-4-5
hypotenuse model alias set fast --connection anthropic --model claude-haiku-4-5 --max-output-tokens 2000
hypotenuse model alias list
```

### Bots from the command line

A bot's persona is markdown, so `bot create` and `bot edit` read it from a file:

```bash
hypotenuse bot create --name Ada --persona-file ada.md --description "Answers questions about billing"
hypotenuse bot edit ada --read operators,viewers --write operators --help-tag operators
hypotenuse bot edit ada --avatar-file ada.png
hypotenuse bot edit ada --disable
```

- `--read` and `--write` take comma-separated tag names; `--read ""` or `--read "*"` lets every member in. Admins can
  always read and change every bot, and the server refuses a change that would lock you out of a bot.
- `--avatar-file` takes a square PNG or JPEG of at most 512 KB; `bot edit --no-avatar` removes it.
- `--model` and `--fast-model` name model aliases (`default` and `fast` unless you say otherwise).
- `--help-tag <tag>` names who the bot asks for help; `--no-help-tag` goes back to the project's admins.
- `--budget <usd>` records a monthly budget, which stops the bot once the cost its provider reports reaches it; `--no-budget` clears it.
- `--max-steps <n>` caps the model steps one turn may take (1–500, default 50).
- `--channel-half-life <days>` and `--project-half-life <days>` set how fast the bot's memory fades:
  the days until a memory it has not used weighs half as much (1–3650; 30 for channel memory and 180 for project
  memory unless you say otherwise).
- `--approver-tag <tag>` lets that tag's holders decide the bot's tool-call approvals too, besides the people who
  can change the bot; `--no-approver-tag` goes back to only them.
- `--approval-ttl <duration>` sets how long an approval waits before it expires and counts as denied: seconds, or
  `30m`, `24h`, `7d` (one minute to 30 days; a day unless you say otherwise).
- `--no-code` stops the bot running programs ([code mode](/docs/code-mode)); `--code` turns it back on.
  `--code-timeout <seconds>`, `--code-memory <MiB>`, and `--code-host-calls <n>` set the bot's own limits, which may
  only be lower than the deployment's; together they replace the bot's limits, and `--no-code-limits` goes back to
  the deployment's.
- `--enable` and `--disable` decide whether the bot accepts new conversations.
- `bot edit --auto-bind <kinds>` sets where the bot starts listening by itself when it is invited to a platform
  channel: any of `public`, `private`, and `dm`, comma-separated, or `none`. A private channel or a DM it does not
  bind itself in waits for a person to bind it.
- `bot edit --participant-rate-limit <n>` and `--channel-rate-limit <n>` cap the messages a minute one platform
  person, or one channel, may send the bot; past that it ignores them for the rest of the minute.

`bot edit` changes only what its flags name.

### MCP servers from the command line

An admin connects a server once for the whole project, then gives it to bots:

```bash
hypotenuse mcp-server add docs --endpoint https://mcp.example.com/mcp
pbpaste | hypotenuse mcp-server add linear --endpoint https://mcp.linear.app/mcp --bearer-stdin
hypotenuse mcp-server add search --endpoint https://search.example.com/mcp --header "X-Team: billing" --headers-stdin < secret-headers.txt
hypotenuse mcp-server add github --endpoint https://api.githubcopilot.com/mcp/ --oauth
hypotenuse mcp-server view docs
hypotenuse mcp-server match linear --pattern "/^linear\/list_/" --pattern "*/search"
hypotenuse bot tools add ada linear --allow linear/list_issues --auto-allow-read-only
hypotenuse bot tools list ada
```

- How a server signs in follows from the flags: `--header "Name: value"` or `--headers-stdin` (one `Name: value`
  per line) sends headers, `--bearer-stdin` or `--bearer-env <NAME>` a bearer token, `--oauth` an OAuth sign-in,
  and none of them nothing; `--auth none|headers|bearer|oauth` says it outright. As with API keys, a credential
  never goes on the command line: `--header` is for values that are not secret. Only one flag may read standard
  input.
- `--oauth` prints the URL to open in a browser to sign the project in; `mcp-server sign-in <server>` prints a fresh
  one later. `--client-id` with `--client-secret-stdin` or `--client-secret-env` uses a client you registered
  instead of one registered for you.
- `add`, `test`, and `refresh` connect and list the server's tools; `test` and `refresh` exit non-zero when it does
  not answer. `edit` changes only what its flags name (`--name`, `--endpoint`, new credentials, `--timeout-ms` or
  `--default-timeout`, `--enable` or `--disable`), and new credentials reconnect it.
- The server never answers a credential: `view` and `list` show header names, a bearer token's last four
  characters, and whether an OAuth server is signed in.
- `bot tools add` gives a bot a server or changes its settings for it. Each `--allow <pattern>` (`server/tool`,
  `server/*`, `*/tool`, a bare tool name, or `/regex/`) names calls that run without asking and replaces the list;
  `--no-allow` clears it, so every call asks. `--auto-allow-read-only` lets tools the server marks read-only run
  without asking.

### Platforms and channels from the command line

A bot reaches a platform through its own app there — an installation. Get the manifest, create the app on the
platform with it, then connect the credentials the platform shows:

```bash
hypotenuse installation manifest --bot ada
echo "$WEBHOOK_SECRET" | hypotenuse installation connect --bot ada --delivery-url https://hooks.example.com/ada --signing-secret-stdin
hypotenuse installation test 3
hypotenuse channel list --bot ada
hypotenuse binding create --bot ada --channel 17
hypotenuse binding create --bot ada --channel 18 --confirm-audience
hypotenuse binding edit 5 --mode all --approval-policy participants
```

- `installation manifest` prints the **events URL** the platform delivers to. It is shown once: copy it then.
  Asking for the manifest again before connecting mints a new URL, and the old one stops working. `--type` names the
  platform (`webhook` unless you say otherwise) and `--workspace` the platform workspace the app is for.
- `installation connect` makes the installation active. The signing secret comes from `--signing-secret-stdin`,
  `--signing-secret-env <NAME>`, or a hidden prompt on a terminal — never from the command line — and is never
  shown again. `--delivery-url` is where the bot's messages are sent; `--bot-user-id` is the bot's own id on the
  platform, so it never answers itself.
- `installation test` checks the platform answers with those credentials and exits non-zero when it does not.
  `installation disconnect --yes` forgets the credentials and stops the platform's deliveries; the bot's channels,
  bindings, and conversations stay.
- **Slack** has its own commands, because its app is created and installed rather than pointed at a URL:

  ```bash
  SLACK_CFG=xoxe.xoxp-… hypotenuse slack create --bot ada --config-token-env SLACK_CFG
  hypotenuse slack install 4          # prints the install link: open it and approve
  hypotenuse installation test 4
  ```

  `slack create` uses the configuration token once (`--config-token-stdin`, `--config-token-env`, or a prompt) and
  never stores it. For an app you created from `installation manifest --type slack`, `slack connect` takes its
  `--client-id` and `--app-id`, its secrets from `--client-secret-env` and `--signing-secret-env`, and, if you
  installed it from Slack's own settings, `--bot-token-env`. `slack install` prints a link that works once, for ten
  minutes.
- A channel appears once the bot hears from it. `channel list --bot` shows each one with the bot's binding, or
  `unbound`.
- `binding create` lets the bot listen in a channel. Everyone who can read the bot in Hypotenuse can then read that
  channel's conversations with it and its memory, so a **private** channel is refused without `--confirm-audience`,
  and a channel shared with another organization without `--allow-shared`.
- A binding's settings, on `create` and `edit`: `--mode mentions|all|dm` (only messages that address the bot, every
  message, or a direct message); `--delivery steer|queue` (a message reaches a working bot before its next step, or
  after its turn); `--approval-policy dashboard|participants|listed` (who may decide the bot's approvals from inside
  the channel: nobody, anyone there, or the platform users named with `--approver <id>`, repeatable);
  `--allow-promotion` (facts from the channel may be promoted to project memory). `edit` also takes
  `--no-approvers`, `--no-allow-promotion`, `--no-allow-shared`, and `--enable` / `--disable`, and changes only what
  its flags name.

`participant list` shows who on each platform has written to the bots, and `event list` (admins) every delivery
with what became of it; `event view <id>` prints one as it was received.

### The help inbox from the command line

When nobody in a conversation can answer a bot, it asks the team. Read and answer those questions:

```bash
hypotenuse help-request list --status pending
hypotenuse help-request view 4
hypotenuse help-request answer 4 --text "Yes — refund it, the customer was double-charged"
hypotenuse help-request cancel 5
```

- `answer` sends the bot a message, "Answer from <your name>: …", and it carries on. `--text -` reads the answer
  from standard input. The people the bot asks (holders of its help tag, or the admins) and anyone who can change
  the bot may answer; `list` and `view` say whether you can.
- `cancel` withdraws a request nobody needs to answer, and the bot carries on without it. It needs write access to
  the bot.
- The command is `help-request`, so that `help` keeps meaning help: `hypotenuse <command> --help` shows any
  command's options.

### Approvals from the command line

A tool call outside a bot's allowlist waits for a person. Find it, read it, and decide it:

```bash
hypotenuse approval list --status pending
hypotenuse approval view 12
hypotenuse approval approve 12
hypotenuse approval approve 13 --always
hypotenuse approval deny 14 --note "Draft it in the thread instead of sending it"
```

- `approve` runs exactly that call, with those arguments, once, and the bot carries on. `--always` also lets the bot
  make that `server/tool` call without asking from now on.
- `deny` tells the bot not to retry; `--note` is what the bot reads about what to do instead.
- Deciding needs write access to the bot or its approver tag; `list` and `view` say whether you can. The decision
  is recorded as made from the CLI, in the project's audit log.

### Programs from the command line

What a bot ran in [code mode](/docs/code-mode), with what it called:

```bash
hypotenuse code-run list --conversation 42
hypotenuse code-run view 7
```

- `list` shows each program's status, first line, how many host calls it made, and how it ended, newest first.
- `view` prints the program, its result or error, what it logged, every host call with how the gate let it through,
  and the approvals a paused program waits on. A paused program's saved state is never shown.

### Prompts, goals, and skills from the command line

A bot's system prompt is built from sections. See which ones a message would bring in, and the exact text the bot
would be sent, before you change anything:

```bash
hypotenuse prompt list --bot ada
hypotenuse prompt preview --bot ada --message "how do we deploy?" --sections
hypotenuse prompt add --bot ada --title "Deploys" --contextual --keyword deploy --body-file deploys.md
hypotenuse prompt versions things-i-have-learned --bot ada
hypotenuse prompt revert things-i-have-learned --bot ada --to 1
```

A section is named by its id, or by its key with `--bot`; without `--bot` a key names one of the project's sections,
which every bot includes and only an admin changes. `versions` shows the edits a bot made to itself, with the
conversation each came from, and `revert` puts an earlier text back as a new version.

```bash
hypotenuse goal add --bot ada --title "Answer every billing question the same day" --priority high --review-every 7d
hypotenuse skill add release-notes --description "Write release notes" --arg 'since!' --arg audience=customers --body-file release-notes.md
hypotenuse skill attach release-notes --bot ada
```

In a skill's template, `$since` is the named argument, `$1` the first, and `$ARGUMENTS` everything typed after the
skill's name. Someone in a conversation runs it with `/release-notes v2.1`.

### Talking to a bot

A conversation started from the command line lives in the bot's API channel, or with `--web` in its dashboard
chat. Start one, and follow the bot as it works:

```bash
hypotenuse conversation create --bot ada --text "Why did invoice 1042 go out twice?" --follow
hypotenuse conversation message 12 --text "It was the March run" --follow
git diff | hypotenuse conversation create --bot ada --text - --title "Review this diff"
hypotenuse conversation create --bot ada --web --fresh --text "Try this without what you remember" --follow
```

- `--follow` (or `conversation follow <id>` later) prints the transcript — what you and the bot said, one line per
  tool call, and each change of state — and keeps polling until the bot stops working. Then it prints where the
  conversation rests: hibernating until someone writes, waiting for an answer, or ended. It exits non-zero when the
  conversation failed. `follow --since <seq>` skips what you have read. On a terminal it also shows the bot's text as
  it is written, replaced by the finished message; piped or `--json` output has only the finished lines.
- `--text -` reads the message from standard input.
- `--web` starts the conversation in the bot's dashboard chat, where it shows in the dashboard as it streams;
  `--web --fresh` starts it in a new scratch channel whose memory is empty. A dashboard chat takes no `--channel`
  and no `--callback-url`.
- `--channel <key>` picks one of the bot's API channels; a channel is the boundary of what the bot remembers, and the
  default is `default`.
- `--request-id <id>` makes a retry safe: the same id again returns the first result instead of acting twice.
- `message --queue` holds the message until the bot finishes its current turn; without it the bot sees the message
  before its next step.
- `conversation cancel <id>` stops the bot and ends the conversation as cancelled; writing to it again starts a new
  turn.
- `--callback-url <url>` has each of the bot's messages POSTed to that URL, signed with the bot's callback secret.
  `hypotenuse bot callback-secret ada > ada-callback.secret` creates the secret (it needs write access to the bot)
  and prints it once — it is never shown again. Replacing an existing secret needs `--yes`, and callbacks signed with
  the old one stop at once.

Anyone who can read a bot can talk to it, and see and cancel its conversations.

### Memory from the command line

Every `memory` command acts on one of two scopes. With neither `--bot` nor `--channel` it acts on **project
memory**, which every bot of the project shares; with both it acts on **channel memory** — one bot's memory of one
channel. `memory channels --bot <bot>` lists a bot's channels and their ids.

```bash
hypotenuse memory channels --bot ada
hypotenuse memory search "deploy process" --bot ada --channel 3 --scope both
hypotenuse memory list --bot ada --channel 3
hypotenuse memory view facts/deploys.md --bot ada --channel 3
hypotenuse memory versions facts/deploys.md --bot ada --channel 3
cat deploys.md | hypotenuse memory write facts/deploys.md --text - --note "From the runbook"
hypotenuse memory promote facts/deploys.md --bot ada --channel 3 --to runbooks/deploys.md
```

- `search` and `list` look in channel memory when given `--bot` and `--channel`, and in project memory otherwise;
  `--scope both` looks in the two at once. `--path <prefix>` keeps only documents under a path. `search` shows each
  hit's score, its decay (1 is fresh; `pinned` never fades), and a snippet, and says when it ranked by keyword alone.
- `list` ends with which model embeds memory and how many pieces are not embedded yet; `--forgotten` includes
  forgotten documents.
- `write` saves a new version and keeps the old ones. `--text -` reads the document from standard input;
  `--description` and `--note` say what it is and why it changed; `--base <versionId>` refuses the write if someone
  changed the document since the version you read, so two people editing at once do not overwrite each other.
- `forget` hides a document from search and lists and keeps its history; `--reason` says why.
- `promote` copies a channel document into project memory, at the same path or at `--to <path>`. The copy cites
  where it came from, and the channel document stays.
- `reindex` re-embeds what the current embedding model has not embedded, in the background. Run it after changing
  the `embedding` alias; until it finishes, search ranks those memories by keyword.

Anyone who can read a bot can read its channel memory, and anyone who can change the bot can change it. Every
member reads project memory; only an admin changes it, promotes into it, or reindexes.

## Scripting

Everything a person reads goes to standard error; standard output carries only data. Add `--json` (or `-j`) and
standard output is exactly what the API answered — `{ projects, pagination }`, `{ project }`, and so on — with no
color:

```bash
hypotenuse --json project list | jq '.projects[].slug'
hypotenuse --json audit list --since 7d --action member:remove | jq '.pagination.total'
```

Every listing answers one page at a time: `--page` and `--limit` (25 by default, at most 100) choose it, and the
`pagination` object says `page`, `limit`, `total`, and `pages`. A command that fails exits non-zero and says why on
standard error.

`--no-color` (or `NO_COLOR=1`) turns color off; `--verbose` prints each request it makes.

## Upgrading

`hypotenuse upgrade` installs the newest release the same way you installed this one — npm, bun, or the binary. On
Windows, a binary cannot replace itself while it runs, so `upgrade` prints the install command to run instead.

A new **major** version can remove commands, so `upgrade` will not cross one by itself: it says a new major version
is out and stops. Read its release notes, then run `hypotenuse upgrade --major`.

`hypotenuse check-update` says whether a newer release exists and what changed. The CLI also checks once a day in the
background and mentions a new release after a command finishes; `HYPOTENUSE_NO_UPDATE_CHECK=1` turns that off.

Coming from the old `hypotenuse` (0.x)? Version 2 is a different product: the runner daemon, `config`, and
`worktrees` are gone. The 0.x CLI and its docs live on the
[v1 branch](https://github.com/arcadeai-labs/hypotenuse/tree/v1).
