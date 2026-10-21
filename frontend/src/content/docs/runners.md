# Runners

A **runner** is a machine that runs coding agents for a project — your laptop, a desktop, a build box. The
`hypotenuse` daemon on that machine runs the agent with *your* model login and *your* git credentials; the hosted
service only decides what it should work on. The **Runners** page lists every runner in the project, who owns it,
whether it is online, how many of its slots are busy, and which agents it can run. It updates live.

## Registering a machine

Sign the CLI in, select the project, and register:

```bash
hypotenuse login
hypotenuse project use acme
hypotenuse runner register --name evan-mbp
```

`register` makes you the runner's owner and writes its **runner token** to
`~/.config/hypotenuse/credentials.json` (readable only by you). The token is shown to nothing else and is never
displayed again; the dashboard shows only its last four characters. The name defaults to the machine's host name
and is unique among the project's runners.

Any member can register their own runners, and a person can have several. `hypotenuse runner list`,
`hypotenuse runner view <name>`, and `hypotenuse runner revoke <name>` manage them from the terminal.

## What a runner can and cannot do

A runner token is deliberately narrow:

| A runner can | A runner cannot |
|---|---|
| report its capabilities and heartbeat to **one** project | act in any other project |
| take work routed to it, and report what its agent did | call any action a person can — list members, change settings, register runners |
| reach Linear through Hypotenuse, scoped to the session it is working on | hold a Linear token: Linear credentials never leave the server |

Its authority is its **owner's membership**. If the owner leaves the project or is removed from it, every runner
they registered there is revoked in the same moment.

## Status

| Status | Means |
|---|---|
| **Online** | heartbeating — every 15 seconds |
| **Draining** | heartbeating, finishing what it holds, taking nothing new (the daemon is stopping or upgrading) |
| **Offline** | no heartbeat for 45 seconds — a closed lid, a stopped daemon, no network |
| **Revoked** | permanently: its token no longer works |

A **paused** runner stays connected and heartbeating, but is offered no work. Its owner or an admin pauses and
resumes it from the terminal with `hypotenuse runner edit`.

Presence comes from heartbeats, not from the live connection: a daemon behind a network that blocks WebSockets
still works, a few seconds slower.

## One daemon per machine

A machine runs one daemon. If a second runner starts on a machine where another is already online or draining —
a second OS user on a shared box, or a second project on one laptop — it is refused and told which runner holds
the machine. Stop the first one, or wait for it to go offline.

## Revoking

Its owner or a project admin can revoke a runner from the Runners page or with `hypotenuse runner revoke`.
Revocation is immediate: the token stops working on its next request, the daemon's live connection loses its
authority, and the daemon is told to stop. It cannot be undone; register the machine again for a new token.

To replace a machine's token — say it leaked — register again with the same name:

```bash
hypotenuse runner register --name evan-mbp --replace
```

That revokes the old runner and registers a new one in one step, so the leaked token is dead the moment the new one
exists.
