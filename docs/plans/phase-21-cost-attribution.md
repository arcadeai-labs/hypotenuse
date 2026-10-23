# Phase 21 — Cost attribution

> **Goal:** Every turn a runner runs leaves a durable record of what it cost and who it is attributable to — the
> project, the session and its issue, the manager that dispatched it, the runner and the person who owns it, the
> person who asked, the role, the agent, and the repository — and a project member can total those records by any
> of them.

> **Status: built.**

A daemon already reports a `usage` event (tokens, cost, context window), and the server keeps the latest one on the
work item, for the dashboard and for the turn's telemetry span. Three things stop that from being cost attribution:

- **It is the wrong number.** ACP's `usage_update.cost` is *"total cumulative cost for session"*. A follow-up that
  resumes or loads the agent's session reports everything the session has ever spent, so summing turns
  double-counts every turn before the last.
- **It is overwritten.** A claim whose lease lapses goes back to the queue, and the next claim's usage replaces the
  first one's — on another runner, whose owner did not spend it. What the first claim spent is lost.
- **It is not attributed.** `work_items` names the runner by id (`set null` when it is revoked and deleted) and
  carries no issue or manager; nothing totals it.

## Scope

**In:**

1. **The daemon reports what a turn spent.** The mapper keeps the agent's cumulative cost at the turn's start (a
   baseline) and reports `costUsd` as the turn's share. The baseline is `0` for a new ACP session; for a resumed or
   loaded one it is the cumulative cost the daemon recorded at the previous turn's end (`local_sessions.acp_cost_usd`),
   or what the agent replays on `session/load`. Token counts come from the prompt response's `usage`. Every `usage`
   event carries the whole snapshot.
2. **`daemon:complete` carries the turn's `usage`** (additive), so the final figure lands even after a stop, when the
   server drops a turn's ordinary events.
3. **`cost_records`, one row per claim that ended** — completed, failed, cancelled, or requeued (a lapsed lease, a
   revoked runner). Written in the transaction that ends the claim, from `finishWorkItem` and the two requeue paths.
   Each row snapshots its attribution: project, session, root session (the manager a worker was dispatched by, or the
   session itself), issue id and identifier, kind, role, repository, runner id and name, runner owner, issuer, agent,
   how the claim ended, tokens, cost, and when it was claimed and ended. Unique on `(work_item_id, claimed_at)`.
4. **`cost:list`** (member, paginated; filters: session, root session, runner, owner, issuer, role, since, until) and
   **`cost:summary`** (member, paginated groups by session, root session, issue, runner, owner, issuer, role, agent,
   repository, or day, most expensive first, with a project total).
5. **`agent-session:view` answers the session's `cost`**, and a manager's `treeCost` including the workers it
   dispatched. The session page shows them.
6. **`hypotenuse cost list` / `cost summary --by <dimension>`.**
7. User docs (agent sessions, CLI, a costs page), `RUNNER_PROTOCOL.md`, `ARCHITECTURE.md`, `AGENTS.md`, this plan.

**Out:**

- **Pricing.** Hypotenuse records what the agent reports and never multiplies tokens by a price list. An agent that
  reports no cost leaves `cost_usd` null, and the summary counts such turns (`unpricedTurns`) instead of guessing.
- **Currencies other than USD.** ACP's `cost` carries a currency; a non-USD figure is not converted and is not
  recorded.
- **Budgets and limits.** Stopping or refusing work over a spend is a later decision; the records are what it would
  read.
- **A dashboard Costs page.** The summary is reachable from the CLI and as an MCP tool; the session page shows a
  session's cost.

## Design

- **The daemon computes the turn's share, not the server.** Only the daemon knows whether a turn opened a new ACP
  session, resumed one, or loaded one and what the replay said. The server would have to infer it from the
  `acpSessionId` of the previous completion, which a lapsed or late turn does not send.
- **A record per claim, not per turn.** A turn that ran twice cost twice, on two runners, possibly owned by two
  people. A queued item that was never claimed spent nothing and gets no record.
- **The attribution is copied, not joined.** Runners are deleted, rules renamed, and sessions re-routed; a cost
  record is a ledger line and says who it was attributable to *when it was spent*. Ids are kept too (`set null`),
  so a live join is still possible.
- **Not audited.** A cost record is the daemon half's bookkeeping, written with the work item it describes in the
  transaction that ends the claim — no person decided it (rule 6 of `AGENTS.md`).
- **No Linear interaction changes**, so `LINEAR_COVERAGE.md` gains no row.

## Definition of done

- [x] The mapper's baseline: a new session, a resumed one with a recorded baseline, a loaded one whose replay
      reports cost, an agent whose cumulative figure restarts, and a non-USD cost.
- [x] The fake agent reports a prompt response's `usage`; an end-to-end test sees a turn's and its resumed
      follow-up's tokens and cost recorded.
- [x] Server tests over real HTTP: a completed claim, a stopped one whose usage arrives only on completion, a lapsed
      lease requeued and claimed again (two records, one per claim), a revoked runner, a never-claimed item (none), the
      list's filters and pagination, every summary dimension, the session's and manager's totals, and an outsider
      refused.
- [x] RBAC levels in `rbac.test.ts`, published as MCP tools; the CLI commands; the docs.

## Learnings from the build

**Built.** The Definition of done, at CLI 0.21.0.

- **An agent's "cumulative" cost may restart with its process.** ACP says `cost` is the session's total, but every
  turn is a new agent process, and an agent that keeps the figure in memory starts again from zero after
  `session/resume`. The mapper treats a first figure below the baseline as a restart and takes the baseline as `0`
  for the rest of the turn. A restarted agent whose first figure already exceeds the old baseline is
  indistinguishable from one that did not restart, and is undercounted; nothing in ACP tells them apart.
- **A late completion of a requeued claim is refused (`NOT_YOUR_WORK`)**, and the usage it carries with it. The
  requeued record keeps the last `usage` event that claim sent. A late completion of a turn the server already
  stopped is still the same claim, and fills in its record's usage when the record has none.
- **ACP v2's `PromptResponse` declares no `usage`.** The token counts are the unstable v1 field an agent sends
  anyway; the SDK passes it through and the host reads it by cast. If a later SDK strips unknown keys, tokens go
  quietly to null — the `costed` scenario in `host.test.ts` is what would notice.
- **`complete.usage` is additive for the server, not for an older one.** A daemon that sends it to a server that
  predates it is refused as an unknown key, so the server deploys first, as it does for every wire addition.
