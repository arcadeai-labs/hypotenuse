# Repositories

Bots work on code in GitHub repositories your project grants them. A grant lets a bot read a repository — its files,
code search, pull requests, and issues — and, if you allow it, push a branch and open a pull request from a
[sandbox](/docs/sandboxes). Nothing reaches GitHub without a grant, and no bot ever holds a GitHub token of its own.

**Repositories** in the sidebar (`g r`) is where it is all set. Everyone in the project can see what is attached and
granted; installing, granting, changing, and revoking take [admin](/docs/tags) standing.

## Installing the GitHub App

Bots reach GitHub through one GitHub App that belongs to the Hypotenuse deployment. An admin installs it on a GitHub
organization or account and attaches that installation to the project:

1. On **Repositories**, choose **Install the GitHub App**. GitHub asks which organization or account to install it on,
   and which of its repositories the App may see.
2. GitHub sends you back to **Repositories**, which says the installation is attached. It is attached only if your
   own GitHub account can see that installation, and the link is good for ten minutes.

The **GitHub App** card lists every attached installation: the account it is on, and whether it is **Active**,
**Suspended on GitHub**, or **Removed from GitHub** — GitHub tells Hypotenuse when an account's owner suspends or
uninstalls it, and its repositories stop working at once. **Detach** removes an installation from the project and
revokes every grant made through it. The App stays installed on GitHub, where the account's owners remove it.

### What the operator configures

Whoever runs Hypotenuse creates the GitHub App once, for every project, and sets `GITHUB_APP_ID`, `GITHUB_APP_SLUG`,
`GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, and `GITHUB_APP_WEBHOOK_SECRET`. The
App's webhook goes to the deployment's `/api/webhooks/github` and subscribes to **Pull request**, **Pull request
review**, **Pull request review comment**, and **Check suite**. Until it is configured, **Install the GitHub App**
names the settings that are missing.

## Granting a repository

A grant names one repository, `owner/name`, reached through an attached installation on that owner. Under **Grant a
repository**, choose the installation, write the repository, and decide:

| Setting | What it decides |
|---|---|
| **Jobs may push** | Off, bots read the repository and run its code but push nothing. On, a sandbox job may push a branch and open a pull request |
| **Branch prefix** | The branch namespace jobs push into. Blank, each bot is asked to use its own, `hypotenuse/<bot-slug>/` |
| **Which bots** | Every bot in the project — including ones made later — or only the bots you tick |

The repository must belong to the installation's account, and GitHub must let the App see it; otherwise the grant
is refused, saying to add the repository to the App's installation on GitHub. A grant's **Edit** changes the push
setting, the prefix, and the bots; **Revoke** removes it, and bots can no longer read the repository or start jobs on
it.

A bot's page lists, under **Repositories**, every repository it can reach and whether it may push.

## What push means, and why rulesets matter

GitHub has no permission for "only these branches". A token that may push holds `contents: write`, and that reaches
every branch in the repository — the default branch included. So Hypotenuse treats the branch prefix as an
instruction to the coding agent, and a **repository ruleset** on GitHub is what enforces it. A grant that may push
without a branch prefix saves with a warning saying exactly this.

For every grant with a branch prefix, **Repositories** shows a recommended ruleset as JSON to copy. Add it under the
repository's **Settings → Rules → Rulesets** on GitHub (or `POST /repos/{owner}/{name}/rulesets`), and make the App the
only actor it applies to. For the prefix `hypotenuse/ada/`:

```json
{
  "name": "Hypotenuse branches",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": { "include": ["~ALL"], "exclude": ["refs/heads/hypotenuse/ada/**"] }
  },
  "rules": [{ "type": "update" }, { "type": "deletion" }, { "type": "creation" }],
  "bypass_actors": []
}
```

It blocks creating, updating, and deleting every branch outside the prefix, so the App can only touch its own.

## Read jobs and write jobs

A bot starts a [sandbox](/docs/sandboxes#working-on-a-repository) job on a granted repository by naming it. The job
clones it before the coding agent starts, and is one of two kinds:

| Job | For | What it may do |
|---|---|---|
| **write** | changing the code | push a branch under the prefix and open a pull request. Needs a grant that allows pushes, and follows the bot's **Sandboxes** setting (by default, a person approves it first) |
| **read** | questions about the code | read and run it, never push. Runs without approval, for at most 15 minutes |

Each `git` or `gh` command in the sandbox gets a token for one repository, good for that command, and every token is
revoked when the job ends. A job's page lists them under **Git** — handed out, reused, or refused with the reason —
next to the job's repository and mode.

## Reading without a sandbox

A bot granted a repository can also read it directly, with four tools that need no approval:

| Tool | Reads |
|---|---|
| `github_file_read` | a file as text, or a directory listing |
| `github_search_code` | code search in the repository |
| `github_pr_view` | a pull request: its description, whether it is open or merged, and its branches |
| `github_issue_view` | an issue: its description, status, and labels |

They reach only repositories granted to that bot, each call through a read-only token revoked when it ends. A bot
with no grant is not offered them.

## How pull requests come back

When a job opens a pull request, it comes back to the conversation that asked for it, as each platform shows a link
best:

| Where the conversation is | What people see |
|---|---|
| [Slack](/docs/slack) | a message in the thread with the link |
| [Linear](/docs/linear) | a **Pull Request** link on the agent session |
| [Pylon](/docs/pylon) | an internal note on the issue — never a reply to the customer |
| The dashboard [chat](/docs/chat) | a **Pull Request** card with the link |

The job's page lists every pull request it opened under **Pull requests**: its number, title, state (open, merged, or
closed), and branch.

### Which events wake the bot

After that, what happens on the pull request is told to the bot. Some events **wake** it, so it acts — for example
by starting a job to address a review; the rest are recorded and it reads them at its next turn. By default a bot
wakes for **changes requested** in a review and **a failed check**. On its page, under **Repositories**, anyone who
may change the bot picks from: changes requested, approved, commented on, a review comment, a check failed, checks
passed, closed without merging, and merged.

A conversation someone **stopped** stays silent: nothing on its pull requests wakes it or writes into it again. A
conversation waiting on a person — an answer or an approval — keeps waiting; an event never stands in for a person.
