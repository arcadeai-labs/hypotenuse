# Phase 12 — Worktrees and the session lifecycle

> **Goal:** Every Linear agent session gets its own git worktree on its own branch, created from a fresh fetch
> of the base branch, prepared by the repository's setup commands, reused by every follow-up turn, and removed
> by a policy the person chose — never while it holds unpushed work. The issue itself is kept tidy the way
> Linear asks agents to: moved to started when a person delegates it, left in triage when an automation does,
> and linked to its pull request as soon as one exists. The CLI can list, kill, and clean up all of it.

> **Status: planned, not built.** It builds on the [daemon](./phase-10-daemon-and-config.md) (whose `worktrees`
> table and control socket it fills in) and the [ACP host](./phase-11-acp-agent-host.md) (which until now ran
> agents in a temporary directory). The server-side half — issue state and delegate hygiene, the dashboard
> link — extends [work routing](./phase-09-work-routing.md)'s `daemon:claim` and `daemon:events`.

A coding agent that works in a person's checkout is a coding agent that fights them for it. Worktrees solve
that cheaply, because git shares the object store and checkout is a hardlink-speed operation. They also solve
the concurrency problem: a runner with three slots can work three issues in the same repository, each on its own
branch, with nothing to coordinate. The cost is lifecycle. Worktrees pile up, branches pile up, and a careless
cleanup deletes the one commit somebody wanted. This phase is mostly that lifecycle, written down as rules the
code enforces.

## Scope

**In:**

- **The worktree manager:** fetch, create, reuse, lock, setup commands, and per-session environment.
- **`worktrees = "never"`** as a discouraged escape hatch.
- **Timeouts:** turn, idle, and keepalive, as they interact with worktrees and Linear's stale window.
- **Cleanup policies** (`on-complete`, `on-merge`, `ttl`, `never`) and the safety rules that override them.
- **The CLI:** `worktrees list|cleanup` and `agents list|kill`.
- **PR detection** → the `external_url` event → a "Pull Request" link on the session.
- **The session's dashboard link**, added at claim time.
- **Issue hygiene on the server:** the started-state move, delegate rules, never touching the assignee, and
  stopping on dismissal or un-delegation.
- **A disk-space guard.**
- **Tests.**

**Out:**

- Opening pull requests. The agent opens them with its own tools (`gh pr create`, `git push`), using the
  person's credentials. We detect them; we do not create them. A daemon-side "open a PR" helper is a candidate
  for a later plan if agents prove unreliable at it.
- Merging. Never.
- Remote worktrees or sandboxes. The runner's disk is the sandbox, and the docs say so.
- Non-git version control.

## Design

### 1. Where things live

```
<sessions.worktree_root>/                      default ~/.hypotenuse/worktrees
  <repository.name>/
    <ISSUE-IDENTIFIER>/                        e.g. ENG-123 — the worktree for that issue's session
    <ISSUE-IDENTIFIER>-<n>/                    a second concurrent session on the same issue (rare: a
                                               manager review and a worker on one issue), n = 2, 3, …
```

- **Branch:** `<repositories[].branch_prefix>/<issue-identifier-lowercase>-<slug>`. The default prefix is
  `hypotenuse`, giving `hypotenuse/eng-123-fix-checkout-total-rounding`. The slug is the issue title,
  lowercased, ASCII-folded, with non-alphanumerics collapsed to `-`, and truncated to 40 characters on a word
  boundary.
- **Branch collisions.** If the branch exists locally or on origin and does **not** belong to a known
  `worktrees` row, a numeric suffix is appended (`…-2`). An existing branch is never reused silently.
- **Why one directory per issue, not per session.** Linear sessions are per thread, and a person reading
  `worktrees list` thinks in issues. The rare second session on one issue gets a suffix rather than sharing a
  directory, because sharing would let two agents write the same files.

### 2. Creating a worktree

`cli/src/worktree/manager.ts` `acquire(assignment)` runs under a **per-repository mutex**: git's own lock on
`.git/worktrees` and `packed-refs` does not survive two concurrent `worktree add`s gracefully.

1. **Reuse** — if `local_sessions` has a worktree for this `agentSessionId` and it still exists and is clean of
   foreign changes (`git -C <wt> rev-parse --abbrev-ref HEAD` equals the recorded branch), use it. A follow-up
   turn continues on top of whatever the last turn left, committed or not. That is the point of stickiness.
2. **Fetch** — run `git -C <repo.path> fetch origin <base_branch> --prune`, with a 120 s timeout. A failure is
   not fatal when a local `origin/<base_branch>` exists: the session gets a thought, "Could not fetch acme/web;
   working from the last fetched origin/main (3 hours old)". Without a local ref it is fatal: an `error` with
   git's stderr tail.
3. **Disk guard** — require `sessions.min_free_disk` (default 2 GB) free on the volume of `worktree_root`.
   Below it, run cleanup with the current policy first. If space is still short, fail the turn with an `error`
   that says how much is free and how to clean up (`hypotenuse worktrees cleanup`). The heartbeat reports
   capacity 0 until space recovers, so routing sends the work elsewhere.
4. **Add** — `git -C <repo.path> worktree add -b <branch> <path> origin/<base_branch>`. Then, in the worktree,
   `git config --worktree` sets `hypotenuse.session <agentSessionId>` and `hypotenuse.issue <identifier>`
   (enabling `extensions.worktreeConfig` once per repo). Those two keys let `worktrees cleanup --all` recognise
   our worktrees from git alone if `state.db` is lost.
5. **Setup** — run each `repositories[].setup` command in order, in the worktree, with the per-session
   environment.
   - Each command has `repositories[].setup_timeout` (default 10 min).
   - Output goes to the session log.
   - The session gets an ephemeral `action` per command: "Running setup: `bun install`" → "Ran setup: `bun
     install` (12 s)".
   - A failing command fails the turn with an `error` quoting the last 20 lines, and the worktree is kept for
     inspection.
6. **Record** — insert the `worktrees` row (`state = active`) and link it from `local_sessions`.

**Per-session environment**, passed to setup commands and to the agent process:

| Variable | Value |
|---|---|
| `HYPOTENUSE_SESSION_ID` | the Hypotenuse `agentSessionId` |
| `HYPOTENUSE_LINEAR_SESSION_ID` | Linear's agent session id |
| `HYPOTENUSE_ISSUE` | the issue identifier, e.g. `ENG-123` |
| `HYPOTENUSE_ISSUE_URL` | the Linear issue URL |
| `HYPOTENUSE_BRANCH` | the worktree branch |
| `HYPOTENUSE_BASE_BRANCH` | the base branch |
| `HYPOTENUSE_ROLE` | `worker` or `manager` |
| `HYPOTENUSE_SESSION_URL` | the Hypotenuse dashboard URL for the session |
| `GIT_TERMINAL_PROMPT` | `0`, so git never blocks a non-interactive agent waiting for a password |

**Roles without a repository.** A manager turn may have no repository: it writes tickets, not code
([phase 14](./phase-14-manager-and-dispatch.md)). Such turns get a **scratch directory**,
`<worktree_root>/_scratch/<agentSessionId>`, removed by the same cleanup policies. ACP still requires an
absolute `cwd`.

### 3. `worktrees = "never"`

For people who insist on the agent working in their checkout, a repository may set `worktrees = "never"`, or
`[sessions] worktrees = "never"` can apply it globally.

- **The agent runs in `repositories[].path` itself.** A per-repository lock file
  (`<repo>/.git/hypotenuse.lock`, containing the pid and session) allows **one** session at a time in that
  repository. Heartbeat capacity for roles that need that repository drops accordingly.
- **The branch is still created and checked out**, with `git switch -c`, and only if the working tree is
  clean. With a dirty tree the turn fails and the person's changes are untouched. Hypotenuse never stashes,
  resets, or cleans a person's checkout.
- **Cleanup never removes anything in this mode.** It only switches back to the previous branch at turn end,
  and only when the tree is clean.
- **`config validate` warns** on this mode, and the docs say why: it serializes the runner and it shares
  state with a human.

### 4. Timeouts

All are configured in `[sessions]` (see [`CONFIG.md`](../CONFIG.md)). Roles may override `turn_timeout`.

| Timer | Default | Starts | Fires → |
|---|---|---|---|
| `setup_timeout` (per repository) | 10 min | each setup command | `error`, turn fails |
| `turn_timeout` | 60 min | `session/prompt` sent | cancel path, reason `timeout` ([phase 11](./phase-11-acp-agent-host.md#9-cancel-stop-and-kill)) |
| `idle_timeout` | 15 min | last ACP traffic, or the elicitation sent | cancel path, reason `timeout` |
| `keepalive_interval` | 10 min | last emitted event | ephemeral "Still working…" thought |
| `stop_grace` | 10 s | `session/cancel` | SIGTERM, then SIGKILL 5 s later |

**Ordering is validated:** `keepalive_interval` < 30 min (Linear's stale window) ≤ … and
`keepalive_interval` ≤ `idle_timeout` ≤ `turn_timeout`.

**Waiting on a person** (an `ask` permission, or a form elicitation) pauses `turn_timeout` and keeps
`idle_timeout` running. A person who goes to lunch costs one idle timeout, not a whole turn, and the session
says so ([phase 11](./phase-11-acp-agent-host.md#7-permissions-elicitations-and-the-round-trip)).

**Turns that end by asking.** A turn that ends with `linear_ask_user` ([phase 13](./phase-13-hypotenuse-mcp.md))
leaves Linear in `awaitingInput` and holds nothing. No process and no slot are held; the worktree stays.
Linear's stale clock does not apply to `awaitingInput`, so no keepalive is needed.

### 5. Cleanup policies and the rules that override them

`sessions.cleanup` (overridable per repository) decides **when** a worktree is eligible for removal.
`cli/src/worktree/cleanup.ts` decides **whether** it is safe.

| Policy | Eligible when |
|---|---|
| `on-complete` (default) | the session's last turn ended `completed` **and** Linear reports the session `complete`, and no follow-up has been claimed for `sessions.cleanup_grace` (default 1 h — people often reply to a response within minutes) |
| `on-merge` | the branch's pull request is merged or closed, or the branch is gone from origin |
| `ttl` | `last_used_at` older than `cleanup_ttl` (e.g. `"7d"`) |
| `never` | only by `worktrees cleanup --all` or `--older-than` |

**Safety rules**, checked at removal time in this order, each of which **keeps** the worktree and records why:

1. A session in `local_sessions` is `claimed` or `running` in it → `in use`.
2. `git status --porcelain` is non-empty → `uncommitted changes`.
3. The branch has commits not on any remote ref (`git rev-list <branch> --not --remotes` non-empty) →
   `unpushed commits`.
4. A `.hypotenuse-keep` file exists in the worktree root (a person's opt-out) → `kept by request`.

`--force` on `worktrees cleanup` overrides rules 2–4 and never rule 1. It still prints what it is discarding.

**Removal** runs `git worktree remove <path>`, which fails safely if git disagrees about rule 2. Then
`git worktree prune`. The local branch is deleted with `git branch -d`, never `-D`, and only when it was pushed
or has no commits beyond its base. The `worktrees` row goes to `removed`, and `local_sessions` keeps the history.

**When it runs:**

- after every turn, for that session's worktree, against `on-complete`
- every 30 minutes for all worktrees, against every policy
- before every `acquire` that fails the disk guard
- on demand

`on-merge` checks merge state as follows:

1. If `gh` is installed and authenticated: `gh pr view <branch> --json state,mergedAt`.
2. Otherwise: `git ls-remote --heads origin <branch>`; an empty answer counts as merged or closed.

It caches each answer for 10 minutes so the 30-minute sweep stays cheap on a runner with 40 worktrees.

### 6. `agents` and `worktrees` commands

All four commands talk to the daemon's control socket ([phase 10](./phase-10-daemon-and-config.md#10-the-control-socket)).
`--json` is available everywhere.

```
hypotenuse agents list [--all]
  SESSION  ISSUE    ROLE    AGENT   STATE     FOR    PID    WORKTREE
  as_81f2  ENG-123  worker  codex   running   12m    48211  ~/.hypotenuse/worktrees/web/ENG-123
  as_77c0  ENG-118  worker  claude  awaiting  1h04m  —      ~/.hypotenuse/worktrees/web/ENG-118
  (--all adds idle/done/interrupted sessions from state.db)

hypotenuse agents kill <agentSessionId|ISSUE-ID> [--reason "…"]
  → cancel path, reason `killed`; Linear gets: error "Cancelled by evan on runner evan-mbp: <reason>"
  → exits non-zero if nothing matched

hypotenuse worktrees list
  PATH                                   REPO  BRANCH                          STATE   LAST USED  SIZE  SAFE TO REMOVE
  ~/.hypotenuse/worktrees/web/ENG-123    web   hypotenuse/eng-123-fix-total    active  now        412M  no (in use)
  ~/.hypotenuse/worktrees/web/ENG-101    web   hypotenuse/eng-101-add-banner   idle    3d         380M  yes

hypotenuse worktrees cleanup [--dry-run] [--all] [--older-than 7d] [--force]
  default: apply the configured policy; --all: consider every non-active worktree regardless of policy;
  --older-than: restrict to last_used_at older than the duration; always prints kept items with reasons
```

`agents kill` resolves an issue identifier to every live session on that issue on this runner. It never kills a
session on another runner; the dashboard's `agent-session:cancel` does that
([phase 15](./phase-15-dashboard.md)).

`worktrees list` computes `SIZE` lazily with `du -sk` under a 2 s budget per worktree, and prints `?` past that.

If the daemon is not running, `worktrees list` and `worktrees cleanup` fall back to reading `state.db` and
scanning `worktree_root` directly (with a warning), so a person can still clean up after uninstalling the
service. `agents` commands need the daemon.

### 7. Pull requests and external links

The session should link its pull request as soon as one exists. Linear says adding a PR URL to `externalUrls`
"unlocks additional features related to pull requests".

**Detection.** The mapper ([phase 11](./phase-11-acp-agent-host.md#6-mapping-acp-to-protocol-events)) scans:

- every completed `execute` tool result and every agent message for URLs matching:
  - GitHub: `https://github.com/<owner>/<repo>/pull/<n>`
  - GitLab: `https://<host>/<group>/<project>/-/merge_requests/<n>`
  - Bitbucket: `https://bitbucket.org/<ws>/<repo>/pull-requests/<n>`
  - any host listed in `repositories[].pr_url_patterns`
- explicit reports through `linear_report_pr` ([phase 13](./phase-13-hypotenuse-mcp.md)), which is the
  reliable path that the default worker prompt asks agents to use.

A URL counts only if its `<owner>/<repo>` matches the session's repository remote. An agent citing someone
else's PR in passing must not link it. A match emits `external_url { label: "Pull Request", url }` once per URL.
The server translates it into `agentSessionUpdate(addedExternalUrls)`, never into the whole-list
`externalUrls` form, so links added by others survive. It also stores the URL on
`agent_sessions.externalUrls` for the dashboard. A second PR in the same session is labelled
`Pull Request (2)`.

**The dashboard link.** At `daemon:claim`, the server adds `{ label: "Hypotenuse", url: <dashboard session
URL> }` to the session's external URLs **if it is not already present**. Setting an external URL also counts as
acknowledging the session, a useful second guarantee alongside the server's acknowledgement thought.

### 8. Issue hygiene (server-side)

Linear's best practices describe how an implementing agent treats the issue. The rules are enforced **on the
server** in `backend/ops/IssueHygieneOps.ts`, so the daemon never needs `issueUpdate` rights it could misuse,
and a misbehaving agent cannot skip them. They run at `daemon:claim` for `session_created` and `dispatch`
work items, before the assignment is returned:

| Condition | Action |
|---|---|
| Role is `worker`, the session's creator is a **person** (Linear `creator` present), and the issue's state type is not `started`, `completed`, or `canceled` | move the issue to the team's first `started` state (lowest `position`), via `team.states(filter: { type: { eq: "started" } })` and `issueUpdate(stateId)` |
| The session was created by an **automation** (no `creator`) | leave the state alone; triage stays with a person |
| Role is `worker` and the issue has **no delegate** | set `delegateId` to the app user |
| Always | **never** change `assigneeId`; the person keeps ownership |
| Role is `manager` | no state change; a manager working on a PRD issue is not "implementing" it |

Each rule's outcome is recorded on the work item's `payload.hygiene` and visible on the dashboard. A failure
(for example, a permission change removing team access) is logged and posted as a thought ("Could not move
ENG-123 to In Progress: …"). It does **not** fail the claim: the work is more important than the status.

**Disengagement stops work.** These server-side cancels reach the daemon as `cancel` frames with reason
`disengaged`. The daemon then posts nothing more, because the person has said they don't want the agent
(AIG principle 5).

| Linear signal | Cancel |
|---|---|
| `Issue` webhook where `delegateId` changed away from the app user | every live work item for sessions on that issue |
| Session dismissed (`dismissedAt` set; Linear removes the delegate, which arrives as above) | that session |
| `Issue` webhook moving the issue to a `completed` or `canceled` state type | every live work item for sessions on that issue |
| `PermissionChange` removing the issue's team | every live work item on that team |

Each of these is handled in `linear:process-event` ([phase 7](./phase-07-webhook-ingress-and-session-mirror.md))
by a `cancelWorkForIssue(issueId, reason)` op added here.

## Steps

### 1. Worktree manager — `cli/src/worktree/{manager.ts,git.ts,branch.ts,lock.ts}`

- `acquire` and `release`.
- A git wrapper with timeouts and stderr capture.
- Branch naming, slugging, and collision suffixes.
- The per-repository mutex and the `never`-mode lock file.
- The scratch directories.

### 2. Setup runner — `cli/src/worktree/setup.ts`

Sequential commands with timeouts, the per-session environment, action events, and log capture.

### 3. Disk guard — `cli/src/worktree/disk.ts`

Uses `statfs`. Reports into heartbeat capacity.

### 4. Cleanup — `cli/src/worktree/cleanup.ts`, `cli/src/worktree/merge-state.ts`

Policies, the four safety rules, removal, branch deletion, the 30-minute sweep, and the `gh` /
`ls-remote` merge check with caching.

### 5. Control socket methods — `cli/src/daemon/control-socket.ts`

Implement `agents.list`, `agents.kill`, `worktrees.list`, and `worktrees.cleanup`.

### 6. Commands — `cli/src/commands/agents.ts`, `cli/src/commands/worktrees.ts`

Tables, `--json`, and the offline fallback for `worktrees`.

### 7. PR detection — `cli/src/acp/pr-detect.ts`

URL patterns, the repository match, de-duplication, and `external_url` events. Server side: translate
`external_url` into `addedExternalUrls` in the outbox (`backend/ops/ActivityOutboxOps.ts`) and persist it to
`agent_sessions.externalUrls`.

### 8. Issue hygiene and disengagement — `backend/ops/IssueHygieneOps.ts`, `backend/actions/daemon/daemon-claim.ts`, `backend/actions/linear/linear-process-event.ts`

The rules table, the started-state lookup (cached per team for 10 minutes), `cancelWorkForIssue`, and the
dashboard external URL at claim.

### 9. Tests

**CLI unit tests (`cli/__tests__/worktree/`), against real temporary git repositories:**

- `manager.test.ts` covers branch naming (golden slugs, including unicode and long titles), the collision
  suffix, reuse on a follow-up, the second-session suffix, and two concurrent `acquire`s on one repository
  both succeeding (mutex).
- `fetch-fallback.test.ts` covers an unreachable origin with a local ref (a warning thought) and without one
  (an error).
- `setup.test.ts` covers the env vars present, timeout kill, a failing command keeping the worktree, and action
  events.
- `cleanup.test.ts` gives each safety rule a fixture: dirty, unpushed, keep file, in use. It covers each policy;
  `-d` never deleting an unmerged branch; and `--force` never overriding in-use.
- `never-mode.test.ts` covers the lock, refusal on a dirty tree, the person's changes untouched, and switching
  back.
- `disk.test.ts` uses an injected `statfs` to drive the cleanup-then-refuse path and capacity 0.
- `pr-detect.test.ts` covers the patterns for all three hosts, the repository mismatch being ignored, and
  de-duplication.

**Backend (`backend/__tests__/`):**

- `ops/issue-hygiene.test.ts` (finear-backed) covers:
  - person delegation from backlog moving to the team's `started` state
  - automation-created sessions (finear `/__test/agents/delegate` without a creator fixture) left alone
  - an already-started issue untouched
  - the delegate set when absent
  - the assignee never changed
  - manager sessions untouched
- `linear/disengagement.test.ts` covers un-delegating in finear (`issueUpdate { delegateId: null }`) and
  completing the issue. Both put the live work item in `cancelled` with reason `disengaged`, and no further
  activity reaches finear.
- `e2e/worktree-lifecycle.test.ts` uses a real daemon, the fake agent, and a temporary bare origin:
  - delegation creates `~/…/web/ENG-1` on `hypotenuse/eng-1-…`
  - the `happy` scenario commits and pushes, and prints a fake PR URL matching the origin
  - the session gets a "Pull Request" external URL and the "Hypotenuse" one
  - a follow-up reuses the same worktree
  - after `complete` plus a 0 s grace in config, the worktree is removed and the pushed branch survives on
    origin

## Verification

```bash
bun run --cwd cli lint && bun run --cwd cli test
cd backend && bun test __tests__/ops/issue-hygiene.test.ts __tests__/linear/disengagement.test.ts __tests__/e2e/worktree-lifecycle.test.ts

hypotenuse worktrees list
hypotenuse worktrees cleanup --dry-run --all
hypotenuse agents list --all --json | jq '.[] | {issue: .issueIdentifier, state}'
git -C ~/code/web worktree list
```

## Definition of done

- [ ] One worktree per session at `<root>/<repo>/<ISSUE>`, on `<prefix>/<issue>-<slug>`, from a fresh fetch of
      `origin/<base_branch>`; reused for follow-ups; collision-safe; mutex per repository
- [ ] Setup commands with timeouts, action events, and the per-session environment; failures keep the worktree
- [ ] Scratch directories for repository-less turns
- [ ] `worktrees = "never"` with a lock, no stash/reset/clean ever, and a validation warning
- [ ] Turn, idle, keepalive, setup, and stop timers per the table; ordering validated
- [ ] Four cleanup policies; four safety rules; `-d` only; `--force` semantics; 30-minute sweep; the merge check
- [ ] `agents list|kill` and `worktrees list|cleanup` with `--json`; offline fallback for `worktrees`
- [ ] Disk guard reports capacity 0 and fails a turn with a helpful error
- [ ] PR detection limited to the session's repository; `addedExternalUrls`, never the whole list; a dashboard
      link at claim
- [ ] Server-side issue hygiene per the table; the assignee is never touched; disengagement cancels silently
- [ ] User docs: `/docs/worktrees` (layout, policies, safety rules, commands) and an issue-hygiene section in
      `/docs/linear`

## Commands

```bash
hypotenuse worktrees cleanup --older-than 14d --dry-run
touch ~/.hypotenuse/worktrees/web/ENG-101/.hypotenuse-keep     # never auto-remove this one
hypotenuse agents kill ENG-123 --reason "wrong approach, re-scoping"
git -C ~/.hypotenuse/worktrees/web/ENG-123 config --worktree --get hypotenuse.session
```

## Learnings from the build

_Nothing yet — this phase has not been built._
