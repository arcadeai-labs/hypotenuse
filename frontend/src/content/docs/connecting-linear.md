# Connecting Linear

A Hypotenuse project connects to **one Linear workspace**. Once it is connected, the workspace has a new member,
`@hypotenuse` — an app user, not a person — that people can delegate issues to or mention, and the agents your
team runs pick that work up.

## Who can connect

Two people have to agree, and they may be the same person:

- a **project admin** in Hypotenuse starts it, from **Settings → Linear → Connect Linear**;
- a **Linear workspace admin** approves it on Linear's consent screen, and chooses which teams `@hypotenuse` can
  see.

Members can open Settings → Linear and see what is connected, but the Connect and Disconnect buttons are for
admins. If the button is greyed out with "no Linear app configured", the deployment itself has not been set up
with a Linear app yet; whoever runs your Hypotenuse server needs to do that first.

## What the consent screen asks for

Linear shows the app's name, says it will act **as an app**, and lists six permissions. Each one is there for a
reason, and Hypotenuse asks for nothing else:

| Permission | Why Hypotenuse needs it |
|---|---|
| `read` | Read issues, comments, teams, workflow states, and agent sessions — the context an agent works from |
| `write` | Move an issue's state, update an agent session's plan and links, and keep the delegate right |
| `app:assignable` | Let people **delegate** issues to `@hypotenuse` — the main way work starts |
| `app:mentionable` | Let people **mention** `@hypotenuse` in an issue or a comment — the other way |
| `issues:create` | Let the manager role file issues and sub-issues when it breaks work down |
| `comments:create` | Let agents comment on an issue outside the session thread |

Hypotenuse never asks for Linear's `admin` scope (Linear does not allow it for apps) or for customers,
initiatives, or time schedules.

The teams the Linear admin ticks are the teams the agent can see. Issues in other teams — private ones included —
are invisible to it. A Linear admin can change the team list later in Linear, under the installed agent's settings;
Hypotenuse picks the change up at once (see [agent sessions](/docs/agent-sessions)).

## One workspace, one project

A Linear workspace can be connected to only one Hypotenuse project at a time, because Linear tells Hypotenuse which
*workspace* something happened in, and nothing finer. If your team wants to split work inside one workspace, do it
inside one project, with runners and routing.

If you try to connect a workspace that another project already holds, Linear's approval goes through but Hypotenuse
refuses to attach it, and you come back to Settings with a message saying so. It does not tell you which project
holds it — you may not be a member there. Someone who is needs to disconnect it first.

## When connecting does not work

After Linear's consent screen you always land back on **Settings → Linear**, with a message saying what happened:

| Message says | What happened | What to do |
|---|---|---|
| The link expired or was already used | More than ten minutes passed, or the page was reloaded after it finished | Click **Connect Linear** again |
| The approval finished in a browser signed in as somebody else | The Linear page was finished in a browser signed in to Hypotenuse as a different person | Connect again from the browser you started in |
| The Linear admin declined | Someone clicked **Deny** on Linear's screen | Ask a Linear admin to approve it |
| Linear did not complete the install | Linear refused the hand-back, or could not be reached | Try again; if it keeps failing, the deployment's Linear app may be misconfigured |
| You no longer hold the admin tag | Your admin tag was removed while you were on Linear's screen | Ask a project admin |
| Already connected to another Hypotenuse project | See above | Disconnect it there first |
| Connected to a different Linear workspace | This project already holds another workspace | Disconnect, then connect the new one |

## What Settings → Linear shows

Once connected: the workspace and its address, the name `@hypotenuse` has there (Linear adds a number if it
clashes with a member's name), the permissions granted, how many teams it can see, when its access token expires
and was last renewed, and — once Hypotenuse has talked to Linear — how much of Linear's rate limit is left.

## Staying connected

Linear's access tokens last a day. Hypotenuse renews them by itself, well before they expire, so a connection
stays up with nobody doing anything.

If someone uninstalls `@hypotenuse` from the workspace in Linear, Linear tells Hypotenuse, and the project is
disconnected at once — exactly as if an admin had clicked **Disconnect** — and every project admin gets a
notification. Anything the agent had not yet sent to Linear is dropped. An admin connects again to bring it back.

If Linear ever refuses to renew the token — because its access was revoked some other way — the connection turns
to **Needs reconnecting**, every project admin gets a notification, and the agent stops acting in that workspace.
An admin clicks **Reconnect Linear** and approves again; nothing else is lost.

**Reconnect Linear** is also how you pick up new permissions after Hypotenuse starts asking for more: Linear always
shows the consent screen again, rather than reusing the last approval.

## Disconnecting

**Disconnect** (admins, after a confirmation) revokes Hypotenuse's access in Linear immediately: `@hypotenuse` is
removed from the workspace and stops answering there at once. Hypotenuse forgets the credentials but keeps the
record that the connection existed, so the audit log still makes sense. The workspace is then free to connect to
this project again, or to a different one.

Connecting, reconnecting, and disconnecting each appear in the project's [audit log](/docs/audit) with who did it.

## From the terminal

The `hypotenuse` CLI does the same things:

```bash
hypotenuse linear status        # what is connected, and how healthy it is
hypotenuse linear connect       # opens Linear's consent screen in your browser, waits until it is connected
hypotenuse linear disconnect    # asks first, unless you pass --yes
```

See [the CLI](/docs/cli) for signing it in and choosing a project.
