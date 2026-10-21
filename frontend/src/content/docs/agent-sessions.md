# Agent sessions

Every time someone **delegates** an issue to `@hypotenuse`, or **mentions** it in an issue or a comment, Linear
opens an *agent session*: the conversation between that person and the agent, shown in the issue's activity.
Hypotenuse keeps a copy of every session in the connected project, and of everything said in it, in both
directions. Each copy is marked with the integration it came from — today always `linear`, the first kind of
[integration](/docs/connecting-linear).

## What you see in Linear

Linear expects an agent to answer within ten seconds, or it shows the session as unresponsive. Hypotenuse answers
for the agent straight away, before any runner is involved, so the first thing anyone sees is:

> On it — finding a runner for ENG-123.

Hypotenuse then decides which role answers, which repository the work happens in, and which runner does it, and says
what it decided — see [routing](/docs/routing). From the moment a runner takes the work, what follows is the agent's
own: its thoughts, the actions it takes, its plan, and its answer.

| You do this in Linear | Hypotenuse |
|---|---|
| Delegate an issue to `@hypotenuse` | records a session, answers at once, and routes the work to a runner |
| Mention `@hypotenuse` in a comment | the same, in that comment's thread; a mention in a reply keeps the earlier comments as context, and a role prefix such as `/manage` chooses the role |
| Reply in the session's thread | records your message and sends it to the runner holding the session — *Got it — I'll read this when the current step finishes.* if it is busy |
| Answer the repository question | takes your answer as the repository and starts |
| Press **Stop** | stops the work: *Stopped before starting.*, the agent's own account of where it stopped, or *Stopped. Nothing was running.* |
| Remove `@hypotenuse` as the delegate, or dismiss the session | stops the work quietly |

When no runner can take the work, the session says why and keeps waiting; after the project's queue timeout (30
minutes by default) it ends with an error naming the reason — no runner takes that team's work, they are all
offline, none has the repository, or all are busy. Replying in the session's thread opens it again.

Hypotenuse never says anything in a session that implies a person wrote it, and never names a model: the badge
on `@hypotenuse` already says it is an app.

## Workspace changes Hypotenuse follows

- **Team access.** When a Linear admin changes which teams `@hypotenuse` can see, Hypotenuse picks the change up
  at once. A session on a team it can no longer see ends, and its work stops, because the agent can no longer write
  there.
- **Uninstalling.** If someone uninstalls `@hypotenuse` from the workspace in Linear, the project is disconnected
  at once, its work stops, anything not yet sent to Linear is dropped, and every project admin gets a notification. An admin can
  [connect it again](/docs/connecting-linear).

## Seeing sessions

Any member of the project can list its sessions and read each one's conversation, including whether each thing
Hypotenuse wrote has reached Linear yet (`pending`, `sent`, `failed`, or `superseded` — replaced by something
newer before it was sent). People outside the project cannot.

```bash
hypotenuse session list                  # newest first; --type, --status, --role, --issue ENG-123 to narrow
hypotenuse session view 42               # one session and its conversation, in order
hypotenuse session cancel 42             # stop its work, as Stop in Linear does
```

See [the CLI](/docs/cli) for signing it in and choosing a project.
