---
name: hypotenuse
description: Operate a Hypotenuse server from the terminal with the `hypotenuse` CLI — sign in, choose an organization and a project, manage organizations and their members, projects, project members, invites, permission tags, model connections and aliases, and bots, and read the audit log. Use when asked to administer Hypotenuse, script it, or check who changed what.
---

# hypotenuse

`hypotenuse` is the command-line client for a [Hypotenuse](https://github.com/arcadeai-labs/hypotenuse)
server. It calls the same HTTP actions the dashboard does, as the person who signed it in.

## Conventions

- **stdout is data, stderr is for people.** Pass `--json` (`-j`) to get the action's named object
  (`{ projects, pagination }`, `{ project }`, …) on stdout with no color. Parse that, never the
  tables.
- A non-zero exit code means the command failed; the reason is on stderr.
- Lists take `--page` and `--limit` (default 25) and answer a
  `pagination: { page, limit, total, pages }` envelope.
- Organization-scoped commands act on `--org <id|slug>`, else `HYPOTENUSE_ORG`, else the organization
  chosen with `hypotenuse org use`, else the person's only organization.
- Project-scoped commands act on `--project <id|slug>`, else `HYPOTENUSE_PROJECT`, else the project
  chosen with `hypotenuse project use`, else the person's only project.
- An explicit `--org` widens `project list`, `invite list`, and `audit list` to the whole organization.
- The server is `--url`, else `HYPOTENUSE_URL`, else wherever `login` last signed in.
- `HYPOTENUSE_NO_UPDATE_CHECK=1` turns off the background update notice.

## Commands

| Command | Does |
|---|---|
| `hypotenuse login [--device] [--name <name>]` | Sign in through the dashboard. A person must approve in a browser; `--device` prints a code to type at `/cli/activate` on any device. Never ask for a password. |
| `hypotenuse logout` | Revoke this CLI's sign-in on the server and forget it locally. |
| `hypotenuse whoami` | Who this CLI is signed in as, on which server. |
| `hypotenuse org list\|view\|use\|create\|edit\|delete\|members\|member` | The caller's organizations. `use <id\|slug>` selects one. `create --name`; `edit [org] --name --slug` and `delete <org> --yes` (owner). `members` lists the selected organization's members and roles; `member set-role <userId> owner\|member` and `member remove <userId>` (owner; your own id to leave). |
| `hypotenuse project list\|view\|use\|create\|edit\|delete` | The caller's projects. `create --name` makes one in the selected organization. `edit [project] --name` and `delete <project> --yes` (admin). `use <id\|slug>` selects the project later commands act on. |
| `hypotenuse member list\|add\|remove` | The selected project's members. `add --email` adds a member of the project's organization; `remove <userId>` (admin). |
| `hypotenuse invite list\|pending\|create\|accept\|reject` | Invitations. `create --email [--tag <id>]` invites into the selected project (admin); `--organization-only` invites into the organization (owner). `pending` lists invites addressed to you; `accept`/`reject <inviteId>`. |
| `hypotenuse tag list\|create\|edit\|delete\|assign\|remove` | Permission tags. `create <name>`, `edit <tagId> --name`, `delete <tagId>`, `assign <tagId> --user <userId>`, `remove <tagId> --user <userId>` (admin). The `admin` tag is reserved. |
| `hypotenuse model connection list\|view\|add\|edit\|rotate\|test\|models\|remove` | The project's model providers (admin to change). `add --name --provider anthropic\|openai\|gateway\|openai-compatible [--base-url]` and `rotate <connection>` read the key from `--api-key-stdin` or `--api-key-env <NAME>` (or a hidden prompt on a terminal) — never put a key on the command line. `test <connection>` probes it and exits 1 when the probe fails; `models <connection>` lists model ids. A connection is named by id or name. The key is never shown, only its last four. |
| `hypotenuse model alias list\|set\|remove` | The model names bots use. `default` and `fast` are required before any bot runs; `list` reports `missingRequired`. `set <name> --connection <id\|name> --model <modelId> [--max-output-tokens <n>] [--temperature <t>]` creates the alias or changes the one of that name (admin). `remove` is refused while a bot names it. |
| `hypotenuse bot list\|view\|create\|edit\|delete` | The project's bots. `create --name <name> --persona-file <persona.md>` plus any of `--slug`, `--description`, `--display-name`, `--avatar-file <png\|jpeg>`, `--model <alias>`, `--fast-model <alias>`, `--read <tags>`, `--write <tags>` (comma-separated tag names; `""` or `*` is every member), `--help-tag <tag>` / `--no-help-tag`, `--budget <usd>` / `--no-budget`, `--enable` / `--disable`. `edit <bot>` changes only the flags given (`--no-avatar` removes the avatar); `delete <bot> --yes`. A bot is named by id or slug; `view` says whether you can change it (`standing.canWrite`). |
| `hypotenuse audit list [--since 7d] [--until <time>] [--action tag:edit] [--actor-type user] [--target-type tag]` | Who changed what, newest first: the selected project's log (admin), or with `--org` the organization's (owner), narrowed by an explicit `--project`. Times are ISO-8601, epoch ms, or `7d` / `12h` / `30m`. |
| `hypotenuse check-update` | Whether a newer release exists, and its changelog. |
| `hypotenuse upgrade [--major]` | Upgrade by whichever method installed it. A new major version needs `--major`. |
