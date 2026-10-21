# Managers and workers

`@hypotenuse` is one Linear app that plays two roles. Which one answers a session is decided once, when the session
starts, by the project's [routing rules](/docs/routing), and stays the same for the session's life.

| | Manager | Worker |
|---|---|---|
| Does | writes PRDs, breaks work into tickets, hands them to workers, reviews what comes back | implements one issue: code, tests, a pull request |
| Works in | Linear, and a repository when there is one | a repository, in its own git worktree |
| Needs a repository | no — it can work in Linear alone | yes — it waits for a runner that has one checked out |
| Started by default | when a mention starts with `/manage` | otherwise |

## Choosing the role

Out of the box, a project has two rules: a mention starting with `/manage` gets a manager, and one starting with
`/work` gets a worker. Anything else — including every delegation, which has no text — gets a worker.

```
@hypotenuse /manage write a PRD for usage-based billing and split it into tickets
@hypotenuse /work fix the rounding in checkout
```

Admins can add rules that decide by label, team, Linear project, whether the issue is a sub-issue, or whether the
session came from a delegation or a mention — say, every issue labelled `PRD` goes to a manager. The first rule that
matches decides, and the session's first note names it:

> Routing as **manager** (rule: /manage).

## Changing your mind

The role cannot change mid-session, because the agent's context, tools, and working copy all follow from it. To get
the other role, mention `@hypotenuse` again with the other prefix: that starts a new session. Typing `/manage` in a
reply to a worker session is answered with a note saying so, and the rest of the reply is read as usual.

## Runners and roles

A runner says which roles it plays, and which of its agents plays each. A machine can run both, and can limit how
many of each run at once — say, at most one manager. Hypotenuse counts those limits itself before offering work. See
[runners](/docs/runners).
