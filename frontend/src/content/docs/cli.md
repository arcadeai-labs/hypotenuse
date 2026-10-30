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
| `hypotenuse bot list`, `bot view <bot>` | The bots you can read, and one bot's settings and persona |
| `hypotenuse bot create --name --persona-file`, `bot edit <bot>`, `bot delete <bot> --yes` | Make a bot, change it, or delete it. See **Bots from the command line** below |
| `hypotenuse bot callback-secret <bot>` | Create the secret a bot signs its API callbacks with, and print it once. See **Talking to a bot** below |
| `hypotenuse conversation create --bot --text`, `conversation message <id> --text` | Start a conversation with a bot, or send one a message. See **Talking to a bot** below |
| `hypotenuse conversation list`, `conversation view <id>`, `conversation follow <id>`, `conversation cancel <id>` | The conversations with bots you can read (`--bot`, `--state` narrow the list); one conversation's state; its transcript as the bot works; stopping it |
| `hypotenuse memory search <query>`, `memory list`, `memory view <path>`, `memory versions <path>`, `memory channels --bot` | Search what bots [remember](/docs/memory) the way a bot does, list documents with how much each has faded, read one (`--version-id` for an earlier version) and its history, and list the channels a bot remembers. See **Memory from the command line** below |
| `hypotenuse memory write <path> --text`, `memory forget <path>`, `memory pin <path>`, `memory promote <path> --bot --channel`, `memory reindex` | Correct or add a memory, forget one, pin one so it never fades (`--unpin` to undo), copy a bot's channel memory into project memory, and re-embed after the embedding model changes |
| `hypotenuse audit list` | The project's [audit log](/docs/audit), newest first, or with `--org` the organization's (`--org-only` for its own rows, no project's) |
| `hypotenuse check-update`, `hypotenuse upgrade` | See whether a newer release exists, and install it |

`audit list` reads the last 30 days unless told otherwise. `--since` and `--until` take a date (`2026-10-01`), epoch
milliseconds, or a span back from now (`7d`, `12h`, `30m`); `--action tag:edit`, `--actor-type user`, and
`--target-type tag` narrow it further.

Deleting an organization, a project, or a bot cannot be undone, so those commands refuse to run without `--yes`.

A model connection is named by its id or its name, a bot by its id or its slug, an alias by its name, and a channel
by its id.

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
- `--enable` and `--disable` decide whether the bot accepts new conversations.

`bot edit` changes only what its flags name.

### Talking to a bot

A conversation started from the command line lives in the bot's API channel. Start one, and follow the bot as it
works:

```bash
hypotenuse conversation create --bot ada --text "Why did invoice 1042 go out twice?" --follow
hypotenuse conversation message 12 --text "It was the March run" --follow
git diff | hypotenuse conversation create --bot ada --text - --title "Review this diff"
```

- `--follow` (or `conversation follow <id>` later) prints the transcript — what you and the bot said, one line per
  tool call, and each change of state — and keeps polling until the bot stops working. Then it prints where the
  conversation rests: hibernating until someone writes, waiting for an answer, or ended. It exits non-zero when the
  conversation failed. `follow --since <seq>` skips what you have read.
- `--text -` reads the message from standard input.
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
