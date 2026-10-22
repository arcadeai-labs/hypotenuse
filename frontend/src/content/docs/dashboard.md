# The dashboard

Linear is where people *use* Hypotenuse: they delegate, read the agent's thoughts in the session panel, and answer
its questions. The dashboard is the other half — what Linear cannot show: which runner a session is on, why it has
been waiting, which rule chose its role, the turns behind it, and what the fleet of runners looks like right now.

Every page updates live. When something changes — a new session, an activity sent, a runner going offline — the
page re-reads it; nothing needs a reload. Any member of the project sees every page; what you may *change* follows
your role, and a button you may not use is not shown.

Talking to the agent stays in Linear. The dashboard links to each session in Linear rather than offering a second
place to reply, so a conversation never forks.

## Home

The project at a glance, over the last day (or the last week):

| Card | Shows |
|---|---|
| Linear | the connected workspace, when its last webhook arrived, and deliveries that failed |
| Runners | how many are online, draining, and offline, and how many of their slots are busy |
| Sessions | sessions started, by status and role; the median time to the first acknowledgement (which should stay under ten seconds) and to a runner taking the work |
| Queue | every piece of work waiting right now, how long it has waited, and why — as a [reason code](/docs/routing#why-work-waits) |

`hypotenuse project overview` prints the same in the terminal.

## Sessions

Every agent session in the project, newest first, narrowed by status, role, or runner. Open one to see its page:

- **The transcript** — everything said in the session, both ways, in order: what people typed, and the agent's
  thoughts, actions (with long results collapsed), questions, answers, and errors. Short-lived progress notes that
  Linear has since replaced stay in the log, struck through and collapsed, so the dashboard never shows less than
  the agent said.
- **The plan** — the agent's latest checklist.
- **Links** — the pull requests it opened first, then the session and the issue in Linear.
- **Turns** — each piece of work the session took: what it was for, its status, the runner, when it was offered,
  taken, and finished, how many times it was retried, and for one that waits or failed, why. This is what answers
  "why is it still pending?".
- For a manager, the issues it **dispatched**; for a worker a manager dispatched, the session that **dispatched**
  it.

**Cancel** stops the session's work, as Stop in Linear does, and what Linear shows names you. It is disabled when
there is nothing to stop. See [routing](/docs/routing#stopping) for exactly what the session says.

## Runners

The machines that take the project's work, grouped by owner: whether each is online, its slots in use, the agents
and repositories it reports, its version, and its last heartbeat. A runner that goes offline in the middle of work
is the one thing drawn loudly.

`hypotenuse runner register` on the machine is the usual way to add one. Registering from the dashboard instead
shows the new token **once**, with the `credentials.json` entry to put on the machine; after that, only its last
four characters are ever shown. Its owner or an admin can rename or pause a runner, and
revoke it — see [runners](/docs/runners) and [security](/docs/security).

## Routing

The project's routing rules in the order they are checked: move each up or down, switch it on or off, and see what it
matches and which role it picks. Changing rules is for admins; reading them is for everyone. Saving an order sends
the whole list, so a stale tab cannot drop a rule someone else added.

**Preview** answers "what would happen if this issue were delegated now?" for any issue, with every runner's
eligibility and reasons. See [routing](/docs/routing#previewing-a-route).

## Identities

Hypotenuse prefers the runners of the person who started a session; it knows who that is through a link between
their Linear account and their Hypotenuse account. The Identities page (from the project menu) shows your own links,
which you can remove; admins also see every link in the project, link a Linear user to a member, and unlink any. See [routing](/docs/routing#who-started-the-session).

## Settings → Integrations

One card per kind of integration — today, Linear: connect, reconnect, or disconnect, and the connection's health,
including recent webhook deliveries. See [Connecting Linear](/docs/connecting-linear).
