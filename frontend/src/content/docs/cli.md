# Command line

`hypotenuse` is the command line for Hypotenuse. It signs in through your browser and then does what the
dashboard does — organizations, projects, members, invites, tags, and the audit log — over the same API, as you.
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
| `hypotenuse audit list` | The project's [audit log](/docs/audit), newest first, or with `--org` the organization's |
| `hypotenuse check-update`, `hypotenuse upgrade` | See whether a newer release exists, and install it |

`audit list` reads the last 30 days unless told otherwise. `--since` and `--until` take a date (`2026-10-01`), epoch
milliseconds, or a span back from now (`7d`, `12h`, `30m`); `--action tag:edit`, `--actor-type user`, and
`--target-type tag` narrow it further.

Deleting an organization or a project cannot be undone, so those commands refuse to run without `--yes`.

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
