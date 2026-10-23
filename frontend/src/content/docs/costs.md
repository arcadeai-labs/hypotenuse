# What sessions cost

Every time a runner works a turn of an agent session, Hypotenuse keeps a **cost record**: what the coding agent
said that turn spent, and whom it is attributable to. The records are kept for as long as the project's sessions
are, and any member of the project can read them.

## What a record says

One record is written each time a runner's hold on a turn ends — the turn finished, failed, or was stopped, or the
runner lost it (its daemon went quiet past the lease, or the runner was revoked) and the turn went back in the
queue for another runner. A turn that ran twice therefore has two records, one per runner. A turn that no runner
ever started has none.

Each record holds:

| Field | Meaning |
|---|---|
| tokens | input and output tokens, from the agent's answer to the turn's prompt |
| cost | US dollars, as the agent reported them, for **this turn only** |
| session, issue | the agent session and its Linear issue |
| root session | the manager session that dispatched the worker, or the session itself — so a manager's total includes its workers |
| runner, owner | the runner that ran it (by name, as it was then) and the person who owns it — whose machine and whose agent account did the work |
| issuer | the person who asked, when their Linear user is [linked to a member](/docs/members) |
| role, agent, repository | what kind of turn it was and which coding agent ran it, where |
| ending | `completed`, `failed`, `cancelled`, or `requeued` |

## Where the numbers come from

Hypotenuse never prices tokens itself. The cost is what the coding agent reports through ACP's `usage_update`, in
US dollars; an agent that reports none, or reports another currency, leaves the cost empty, and totals count such
turns as **unpriced** rather than guessing. Agents report a running total for their own session, so the daemon
subtracts what the session had cost when the turn began and reports only the turn's share. It keeps that figure
between turns in its local state; a runner whose state was lost reports tokens but no cost for the next follow-up.

A turn you stop still records what it spent: the daemon's final report travels with its answer that it stopped.

## Seeing costs

A session's page in the dashboard shows its **Cost** — dollars, tokens, and any unpriced turns — and, for a
manager, the total with every worker it dispatched. In the terminal:

```bash
hypotenuse cost list                         # each turn's record, newest first, with the total
hypotenuse cost list --session 42            # one session's turns; --root-session 42 adds its workers
hypotenuse cost summary --by owner           # totals per runner owner, most expensive first
hypotenuse cost summary --by day --since 30d # per UTC day for the last month
hypotenuse session view ENG-123              # includes the session's cost
```

`cost summary --by` takes `session`, `root-session`, `issue`, `runner`, `owner`, `issuer`, `role`, `agent`,
`repository`, or `day`. Both commands narrow with `--session`, `--root-session`, `--runner`, `--owner <userId>`,
`--issuer <userId>`, `--role`, `--since`, and `--until`. They are also the `cost:list` and `cost:summary` tools of
the project's [MCP endpoint](/docs/projects#the-mcp-endpoint), so an assistant can answer "what did our agents
spend this week, and on whose runners?".
