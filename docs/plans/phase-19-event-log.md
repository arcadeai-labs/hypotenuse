# Phase 19 — Event log

> **Goal:** A project member can see every webhook the project's Linear workspace sent in the last 14 days, what
> Hypotenuse did with each, and how the work it caused was routed: the role and the rule that chose it, and where
> the turn is now (on a runner, or waiting and why).

> **Status: planned, not built.**

`trigger_events` already holds every verified delivery, its payload, and an outcome (`handled`, `ignored`,
`duplicate_of_dispatch`, `unknown_integration`, `failed`), and the integration card shows the last ten. What it does
not hold is *what handling meant*. It also cannot say how the work was routed, because routing happens after the
event, in another job: `prepareSession` picks the role by rule, then the routing pass places the turn or records a
waiting code. The rule that chose a role is written only into a thought.

## Scope

**In:**

- `trigger_events` gains `summary` (one sentence, written by the handler), `agent_session_id`, and `work_item_id`
  (both `set null`), and an index on `(integration_id, received_at)`.
- `agent_sessions` gains `routing_rule_id` (`set null`) and `routing_rule_name`, written when `prepareSession`
  decides the role.
- `HandlerResult` carries `summary`, `agentSessionId`, and `workItemId`; `processTriggerEvent` writes them with the
  outcome.
- `trigger-event:list` (member, paginated, filters: event type, outcome, hide ignored, session, since) and
  `trigger-event:view` (member; the payload for admins only). Both join the session and the turn live.
- A `project:<id>:events` channel, pinged when a delivery is recorded and when it is processed.
- The dashboard's **Events** page and an event page; the integration card links to it; `g e` in the palette.
- `hypotenuse event list` / `event view`.
- User docs (dashboard, CLI, connecting Linear), `ARCHITECTURE.md`, this plan.

**Out:**

- **Retention stays 14 days** (`LINEAR_EVENT_RETENTION_DAYS`). Seven was asked for first, then withdrawn.
- **Refused deliveries** (bad signature, stale timestamp, oversized body) stay in the server logs only. Nothing in
  an unverified body can be trusted, including which workspace it claims to be from, so it cannot be put in a
  project's log.
- **Deliveries for no connected workspace** (`unknown_integration`) are recorded and swept like the rest, but belong
  to no project and so appear in no project's log.

## Design

- **The payload is admin-only.** Linear sends every `Issue` change in the workspace to the one webhook, not just the
  issues `@hypotenuse` is delegated, so a payload can describe work a member otherwise never sees in Hypotenuse.
  The summary and routing are for every member; `trigger-event:view` returns `payload: null` to a non-admin.
- **Routing is read live, not copied.** The list joins `agent_sessions` and `work_items`, so an event from an hour ago
  shows where its work is now. Copying placement into the event row would mean writing to it from the routing pass
  and the daemon, for a view that a join already answers.
- **The rule is kept by name as well as id**, so deleting a rule does not erase which rule routed a session.
- **No Linear interaction changes**, so `LINEAR_COVERAGE.md` gains no row.

## Definition of done

- [x] Every handler path writes a summary; `created` and `prompted` link the session and the turn they queued.
- [x] The list and view, with RBAC levels in `rbac.test.ts` and published as MCP tools.
- [x] Tests over real HTTP against finear: a delegation, a follow-up, a rule-routed mention placed on a runner, an
      ignored issue change and the hide-ignored filter, pagination and `since`, an unknown workspace absent, member vs
      admin payload, another project's event not found, an outsider refused, and the channel.
- [x] The Events page, the CLI commands, and the docs.

## Learnings from the build

**Built.** The Definition of done, at CLI 0.12.0.

- **A follow-up can link a turn only when it made or joined one.** An answer to a running turn's question or to the
  repository question links the session but not a turn. Neither `answerWaitingTurn` nor `answerRepositoryChoice`
  returns the item it touched, and threading it through for a link was not worth widening their signatures.
  The same goes for an issue change that cancels several sessions: it links one session when there is one, none when
  there are several, and the summary says how many.
- **`since` takes epoch milliseconds as well as ISO-8601**, as `audit:list` does. `z.coerce.date()` alone reads
  `"1754000000000"` as an invalid date, and the CLI's `--since 12h` sends milliseconds.
- **The Events page also listens on `project:<id>:sessions`.** A turn's placement changes when it is offered,
  claimed, or finished, and those are session frames, not event frames.
- **The channel test filters Keryx's presence frames** (`join` / `leave`), which arrive on every channel a socket
  subscribes to.
- **In the e2e seed, `${JSON.stringify(x)}::jsonb` stores a JSON *string*.** Bun's SQL client sends the parameter
  as JSON text, so the cast wraps it again; `::text::jsonb` stores the object. The existing seed rows have the same
  shape and no reader that cared; the event log's `payload->'data'` did.
