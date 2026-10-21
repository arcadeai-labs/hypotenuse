# Agent sessions

Every time someone **delegates** an issue to `@hypotenuse`, or **mentions** it in an issue or a comment, Linear
opens an *agent session*: the conversation between that person and the agent, shown in the issue's activity.
Hypotenuse keeps a copy of every session in the connected project, and of everything said in it, in both
directions.

## What you see in Linear

Linear expects an agent to answer within ten seconds, or it shows the session as unresponsive. Hypotenuse answers
for the agent straight away, before any runner is involved, so the first thing anyone sees is:

> Received.

Until a runner is connected to the project, there is nobody to do the work, and the session says so honestly
rather than waiting forever:

> No runner is connected for this project yet.

The session then shows as ended with an error. Nothing is lost: replying in the session's thread opens it again,
and the reply is recorded.

| You do this in Linear | Hypotenuse |
|---|---|
| Delegate an issue to `@hypotenuse` | records a session, answers "Received.", then says no runner is connected |
| Mention `@hypotenuse` in a comment | the same, in that comment's thread; a mention in a reply keeps the earlier comments as context |
| Reply in the session's thread | records your message and answers again |
| Press **Stop** | records the stop and answers "Stopped. Nothing was running." |
| Remove `@hypotenuse` as the delegate, or dismiss the session | records that the agent was let go |

Hypotenuse never says anything in a session that implies a person wrote it, and never names a model: the badge
on `@hypotenuse` already says it is an app.

## Workspace changes Hypotenuse follows

- **Team access.** When a Linear admin changes which teams `@hypotenuse` can see, Hypotenuse picks the change up
  at once. A session on a team it can no longer see ends, because the agent can no longer write there.
- **Uninstalling.** If someone uninstalls `@hypotenuse` from the workspace in Linear, the project is disconnected
  at once, anything not yet sent to Linear is dropped, and every project admin gets a notification. An admin can
  [connect it again](/docs/connecting-linear).

## Seeing sessions

Any member of the project can list its sessions and read each one's conversation, including whether each thing
Hypotenuse wrote has reached Linear yet (`pending`, `sent`, `failed`, or `superseded` — replaced by something
newer before it was sent). People outside the project cannot.

```bash
hypotenuse session list                  # newest first; --status, --role, --issue ENG-123 to narrow
hypotenuse session view 42               # one session and its conversation, in order
```

See [the CLI](/docs/cli) for signing it in and choosing a project.
