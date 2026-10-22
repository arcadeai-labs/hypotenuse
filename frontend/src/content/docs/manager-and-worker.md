# Managers and workers

`@hypotenuse` is one Linear app that plays two roles. Which one answers a session is decided once, when the session
starts, by the project's [routing rules](/docs/routing), and stays the same for the session's life.

| | Manager | Worker |
|---|---|---|
| Does | writes PRDs, breaks work into tickets, hands them to workers, reviews what comes back | implements one issue: code, tests, a pull request |
| Works in | Linear, and a read-only checkout of the repository when there is one | a repository, in its own git worktree |
| Needs a repository | no — it can work in Linear alone | yes — it waits for a runner that has one checked out |
| Changes code | never | yes |
| Started by default | when a mention starts with `/manage`, or the issue is labelled `hypotenuse:manager` | otherwise, and whenever a manager dispatches an issue |

## Choosing the role

Out of the box, a mention starting with `/manage` gets a manager, one starting with `/work` gets a worker, and an
issue labelled `hypotenuse:manager` gets a manager however it was started. Anything else — including a plain
delegation, which has no text — gets a worker. A fourth rule, off until an admin turns it on, sends a top-level issue
in a Linear project with no PRD yet to a manager. See [routing](/docs/routing).

```
@hypotenuse /manage write a PRD for usage-based billing and split it into tickets
@hypotenuse /work fix the rounding in checkout
```

Admins can add rules that decide by label, team, Linear project, whether the issue is a sub-issue, or whether the
session came from a delegation or a mention — say, every issue labelled `PRD` goes to a manager. The first rule that
matches decides, and the session's first note names it:

> Routing as **manager** (rule: /manage).

To check which role an issue would get before delegating it, use the preview on the **Routing** page, or
`hypotenuse routing preview ENG-123 --prompt "/manage plan it"`.

## Changing your mind

The role cannot change mid-session, because the agent's context, tools, and working copy all follow from it. To get
the other role, mention `@hypotenuse` again with the other prefix: that starts a new session. Typing `/manage` in a
reply to a worker session is answered with a note saying so, and the rest of the reply is read as usual.

## What a manager does

Give a manager a whole piece of work — "saved carts in checkout" — and it:

1. **Writes the PRD** into the Linear project's content, or as a document on the project when the content is
   already someone's. It reads the code to make it fit, but it cannot change a file or run a command: its runner
   checks the repository out read-only and refuses edits.
2. **Asks what it needs** in one go, as choices when the answer is one.
3. **Breaks the work into issues** — sub-issues of yours, each with acceptance criteria, labels your workspace
   already has, and *blocks* relations where order matters.
4. **Dispatches** issues to workers. Each dispatched issue is delegated to `@hypotenuse` — never assigned: you stay
   the owner — and a worker session starts on it, opening with *Dispatched by the planning session on* your issue.
   A dispatched worker prefers the runners of the person who started the plan.
5. **Reviews** what each worker produced. When a worker finishes, the planning session wakes with *Reviewing ENG-124
   (round 1)…* and checks the result against the acceptance criteria. Then it **accepts** (a comment on the issue,
   and a move to a review state if your team has one), **requests changes** (the same worker session takes it up
   again on the same branch, and shows *The planning agent requested changes: …*), or **files follow-ups**.

### The limits

| Limit | Default | Changed with |
|---|---|---|
| Dispatched workers under way per planning session | 3 | `hypotenuse routing settings --max-parallel-dispatch` |
| Times one issue is sent back for changes | 3 | `--max-review-rounds`; past it, the manager asks you instead |
| A manager may move issues to Done or Canceled | no | `--manager-can-complete yes` |

A worker never dispatches, a manager never dispatches its own issue or one already under way, and no agent merges a
pull request in any configuration: people do. A worker can never move an issue to a completed or canceled state.
Stopping or un-delegating a worker ends its part: the manager is not woken to send it back.

## Runners and roles

A runner says which roles it plays, and which of its agents plays each. A machine can run both, and can limit how
many of each run at once — say, at most one manager. Hypotenuse counts those limits itself before offering work. See
[runners](/docs/runners).
