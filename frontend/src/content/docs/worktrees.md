# Worktrees

A coding agent that works in your checkout fights you for it. So every agent session gets its own **git worktree**:
a second working directory of your clone, on its own branch, sharing the clone's history. A runner with three slots
can work three issues in the same repository at once, and your own checkout is never touched.

## Where they live

```
~/.hypotenuse/worktrees/                 sessions.worktree_root
  web/                                   the repository's name
    ENG-123/                             the session on ENG-123
    ENG-123-2/                           a second session on the same issue, rarely
  _scratch/
    92/                                  a session with no repository (a manager writing tickets)
```

Each worktree is on its own branch, `hypotenuse/eng-123-fix-checkout-total-rounding`: the repository's
`branch_prefix`, the issue, and its title. If that branch already exists and belongs to something else, the name
gets `-2`, `-3`, … — an existing branch is never reused silently.

## What happens on a turn

1. **The first turn** fetches the base branch from origin and creates the worktree from `origin/<base_branch>`. If
   origin cannot be reached, it works from the last fetch and says so in the session; if there has never been one,
   the turn fails with git's own error.
2. **Setup.** The repository's `setup` commands run in the new worktree, one by one, each shown in the session
   (*Running setup: `bun install`*) and limited by `setup_timeout`. A command that fails ends the turn with its
   last 20 lines of output, and keeps the worktree so you can look. The next turn tries setup again.
3. **The agent runs** with the worktree as its working directory and these variables set, for setup commands too:

   | Variable | Value |
   |---|---|
   | `HYPOTENUSE_SESSION_ID` | the Hypotenuse session |
   | `HYPOTENUSE_LINEAR_SESSION_ID` | Linear's session |
   | `HYPOTENUSE_ISSUE`, `HYPOTENUSE_ISSUE_URL` | `ENG-123`, and its URL |
   | `HYPOTENUSE_BRANCH`, `HYPOTENUSE_BASE_BRANCH` | the worktree's branch, and the branch it started from |
   | `HYPOTENUSE_ROLE` | `worker` or `manager` |
   | `HYPOTENUSE_SESSION_URL` | the session's page in the dashboard |
   | `GIT_TERMINAL_PROMPT` | `0`, so git never waits for a password nobody will type |

4. **Follow-ups** reuse the worktree, with whatever the last turn left in it, committed or not. That holds even when the daemon was killed while it was making the worktree: the next turn finds the session's own worktree through git and carries on in it.

The agent opens pull requests itself, with your git and forge credentials (`git push`, `gh pr create`). Hypotenuse
never merges. Its commits are yours, with a `Co-Authored-By: Hypotenuse <noreply@hypotenuse.cloud>` trailer saying an
agent wrote them — set `sessions.co_author` to name it differently, or to `""` for none. The trailer comes from a hook
only the agent's git sees: your checkout's config and your own commits are untouched, and your repository's hooks still
run. When a pull request of the session's own repository appears in what the agent ran or said, the session
links it as **Pull Request** in Linear — a link to someone else's pull request is ignored. Every session also links
its page in the dashboard as **Hypotenuse**.

## Cleanup

A worktree is removed when its **cleanup policy** says it may be, and only when the **safety rules** say it is
safe. `sessions.cleanup` sets the policy; a repository's own `cleanup` overrides it.

| Policy | Removable when |
|---|---|
| `on-complete` (the default) | the session's last turn finished with an answer, and nobody has replied for `cleanup_grace` (1 hour) |
| `on-merge` | its pull request is merged or closed (asked of `gh` when it is installed), or its branch is gone from origin |
| `ttl` | it has not been used for `cleanup_ttl` |
| `never` | only when you run `hypotenuse worktrees cleanup --all` or `--older-than` |

Whatever the policy, a worktree is **kept** when:

1. a turn is running in it — *in use*;
2. it has uncommitted changes;
3. its branch has commits that are on no remote — *unpushed commits*;
4. it has a `.hypotenuse-keep` file — *kept by request*.

Removing one runs `git worktree remove`, then deletes its local branch with `git branch -d` — never `-D` — only when
nothing would be lost. Pushed branches stay on origin. The daemon cleans up after each turn and every 30 minutes, and
before a new worktree when the disk is short.

```bash
touch ~/.hypotenuse/worktrees/web/ENG-101/.hypotenuse-keep     # never remove this one
```

## Commands

```bash
hypotenuse worktrees list
#  PATH                             REPO  BRANCH                          ISSUE    STATE  LAST USED  SIZE   SAFE TO REMOVE
#  ~/.hypotenuse/worktrees/web/...  web   hypotenuse/eng-123-fix-total    ENG-123  active now        412MB  no (in use)

hypotenuse worktrees cleanup --dry-run      # what the policy would remove, and why the rest stay
hypotenuse worktrees cleanup --all          # every worktree not in use, whatever the policy
hypotenuse worktrees cleanup --older-than 14d
hypotenuse worktrees cleanup --force        # also discard uncommitted or unpushed work — never one in use
```

Every kept worktree is printed with its reason. Both commands work without a running daemon: they read its state
and scan `worktree_root` themselves, so you can still clean up after uninstalling the service.

`hypotenuse agents list` shows each running session's worktree, and `hypotenuse agents kill ENG-123 --reason "…"`
stops it; the reason is said in Linear.

## Disk space

A new worktree needs `sessions.min_free_disk` (2 GB) free on the volume of `worktree_root`. Short of that, the
daemon runs cleanup first; if that is not enough, the turn ends with an error saying how much is free, and the
runner takes no new work until space recovers, so routing sends it elsewhere.

## Working in your checkout instead

`worktrees = "never"` on a repository (or in `[sessions]` for all of them) runs the agent in the clone itself. It is
discouraged, and `hypotenuse config validate` warns about it:

- one session at a time works in that repository, and the next one waits;
- the agent's branch is created and checked out only if your working tree is clean — with uncommitted changes the
  turn fails, and Hypotenuse never stashes, resets, or cleans your checkout;
- at the end of the turn it switches back to the branch you were on, if the tree is clean;
- cleanup never removes anything in this mode.

The runner's disk is the sandbox: worktrees are ordinary directories on your machine, and the agent can do there
whatever your account can.
