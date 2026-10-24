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

Each of these is handled in `triggers:process-event` ([phase 7](./phase-07-webhook-ingress-and-session-mirror.md))
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

- [x] One worktree per session at `<root>/<repo>/<ISSUE>`, on `<prefix>/<issue>-<slug>`, from a fresh fetch of
      `origin/<base_branch>`; reused for follow-ups; collision-safe; mutex per repository
- [x] Setup commands with timeouts, action events, and the per-session environment; failures keep the worktree
- [x] Scratch directories for repository-less turns
- [x] `worktrees = "never"` with a lock, no stash/reset/clean ever, and a validation warning
- [x] Turn, idle, keepalive, setup, and stop timers per the table; ordering validated
- [x] Four cleanup policies; four safety rules; `-d` only; `--force` semantics; 30-minute sweep; the merge check
- [x] `agents list|kill` and `worktrees list|cleanup` with `--json`; offline fallback for `worktrees`
- [x] Disk guard reports capacity 0 and fails a turn with a helpful error
- [x] PR detection limited to the session's repository; `addedExternalUrls`, never the whole list; a dashboard
      link at claim
- [x] Server-side issue hygiene per the table; the assignee is never touched; disengagement cancels silently
- [x] User docs: `/docs/worktrees` (layout, policies, safety rules, commands) and an issue-hygiene section in
      `/docs/linear`

## Commands

```bash
hypotenuse worktrees cleanup --older-than 14d --dry-run
touch ~/.hypotenuse/worktrees/web/ENG-101/.hypotenuse-keep     # never auto-remove this one
hypotenuse agents kill ENG-123 --reason "wrong approach, re-scoping"
git -C ~/.hypotenuse/worktrees/web/ENG-123 config --worktree --get hypotenuse.session
```

## Learnings from the build

### The agent's commits carry a co-author trailer

A coding agent commits as the person, with their identity and credentials, and on a developer machine nothing can make
it push as anyone else — so a bot identity could be offered but never enforced. What can be said honestly is that an
agent wrote it: `sessions.co_author` (default `Hypotenuse <noreply@hypotenuse.cloud>`) is appended as a
`Co-Authored-By` trailer by a `commit-msg` hook (`cli/src/worktree/co-author.ts`). The hook reaches only the agent:
`core.hooksPath` arrives as `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` in its environment, appended
after any entries already there, so the person's checkout and config are never written. Because that hides the
repository's own hooks, every hook name is a shim that asks git for the hooks directory again without our entry and
runs the repository's hook — `commit-msg` first, then the trailer, so a commit-message linter sees what the agent wrote.

**Built.** Everything in the Definition of done, at CLI 0.8.0, with the departures below. Every real-daemon suite
(`backend/__tests__/daemon/`) now runs its turns in real git worktrees of a clone whose origin is a local bare
repository. No real coding agent has opened a real pull request through it yet, and the `on-merge` policy has been
checked against a scripted `gh` and a real `git ls-remote`, not against GitHub.

### A session's pull request link is not the issue's

`addedExternalUrls` puts a pull request on the agent **session**; Linear's pull request automations read the
**issue's** attachments and its GitHub integration, so a worker's issue never followed its pull request. Linear's
GitHub integration links a pull request by branch name or title on its own only where the integration reaches the
repository; in the one Hypotenuse is built in, nothing linked (its GitHub organization has Linear's "Linear Code" app
installed, but not the "Linear" app). The server now attaches each linked pull request to the issue itself (`ops/IssueAttachmentOps.ts`):
`attachmentLinkGitHubPR`, so the integration takes over where it is installed, else `attachmentLinkURL`; and since the
second path drives no automation, the issue's first pull request moves it to the team's review state. The attachment
is an outbox row in the session's sequence, so it shares the session's lease, budget, and retry, and the row's client
id doubles as the attachment's id. A manager's dispatch counts as a delegation for the started-state move too: the
session it starts has no creator, so it read as an automation's and the issue sat in Backlog while it was worked.

### Where the pieces live

- **`cli/src/worktree/`** — `manager.ts` (`WorktreeManager.acquire`: reuse, fetch, disk guard, branch choice,
  `worktree add`, setup; `worktrees = "never"`; scratch directories), `cleanup.ts` (`WorktreeCleaner`: policies,
  the four safety rules, removal, adoption of worktrees `state.db` forgot), `merge-state.ts`, `setup.ts`,
  `branch.ts`, `lock.ts` (the per-repository `KeyedMutex` and the checkout lock file), `disk.ts`, `git.ts`, and
  `list.ts` (what `worktrees list` prints, shared by the daemon and the offline fallback).
- **The daemon** — the supervisor owns one manager and one cleaner over one mutex, hands each turn
  `prepareWorkspace`, cleans up after each turn and every 30 minutes, and heartbeats `draining` while the disk guard
  is tripped. `state.db` migration 2 adds the worktree's kind, clone, setup state, and kept reason, and each
  session's last answer, end time, and pull requests.
- **The host** — `acp/host.ts` prepares the workspace before it spawns the agent and releases it after;
  `acp/pr-detect.ts` and the mapper turn pull request URLs into `external_url` events.
- **Commands** — `cli/src/commands/worktrees.ts` (`list`, `cleanup`, with the offline fallback); `agents list`
  gained `for` and `worktree`, and `agents kill --reason` says the reason in Linear.
- **Server** — `ops/IssueHygieneOps.ts` (run by `daemon:claim`), `work_items.hygiene` (migration `0008`),
  `addDashboardLink` in `ops/WorkItemOps.ts`, `issue_closed` in `ops/LinearWebhookOps.ts`, and
  `DISENGAGED_CANCEL_REASONS`, which `finishWorkItem` and `applyEvents` read.
- **Tests** — `cli/__tests__/worktree/` (against real temporary repositories), `cli/__tests__/acp/pr-detect.test.ts`,
  `cli/__tests__/commands/worktrees.test.ts`, `cli/__tests__/daemon/disk-guard.test.ts`,
  `backend/__tests__/ops/issue-hygiene.test.ts`, `backend/__tests__/linear/disengagement.test.ts`, and
  `backend/__tests__/daemon/worktree-lifecycle.test.ts` (the fake agent's new `ship` scenario and `shell` step).

### Where the build departs from the plan

| Plan | Built | Why |
|---|---|---|
| Hygiene runs "before the assignment is returned" | **after the claim commits, before it is answered** | the claim holds the session and runner row locks; a Linear round trip inside it would hold them for seconds |
| Move to started when "the session's creator is a person" | **only when a person delegated** (`humanDelegated`); a mention leaves the state alone | a question in a comment is not implementing, and Linear's guideline speaks of delegation |
| `payload.hygiene` | **`work_items.hygiene`** (jsonb) | work items have no payload column |
| Cancels with reason `disengaged` | **`delegate_removed`** (as before) and the new **`issue_closed`**, which also covers an issue being deleted (`remove`). `Cancel.reason` now also accepts a string a daemon does not know, which stops the turn quietly | the reasons say which disengagement it was. Additive: no daemon has been released with the strict enum |
| "Disengagement cancels silently" — the daemon posts nothing | **enforced on the server too**: once a disengagement cancel is requested, every event is dropped and the turn's end posts no fallback | the daemon was quiet, but its `daemon:complete` (`cancelled`, unanswered) made the server post *"Stopped."* after an un-delegation |
| `worktrees = "never"`: "heartbeat capacity for roles that need that repository drops" | **a second session waits for the checkout lock**, with one thought | an offer does not name its repository, and the protocol has no per-repository capacity |
| `on-complete`: "Linear reports the session complete" | **the last turn's answering event was a `response`**, recorded by the daemon | the daemon cannot read Linear; a `response` is what makes Linear mark the session complete |
| The disk guard "reports capacity 0" | **`draining: true`** | `maxParallelJobs` is at least 1; the daemon's drain already used `draining` (phase 10) |
| Reuse when `rev-parse --abbrev-ref HEAD` equals the branch | the same; otherwise a new worktree at `<ISSUE>-2`, **on the session's own branch** when it is free | a session's branch is recorded as `branch.<name>.hypotenuseSession` in git config, so a follow-up whose worktree was removed — or moved off its branch — gets its branch back rather than a sibling |
| — | **`originOf` reads `remote.origin.url`**, not `git remote get-url origin` | `get-url` applies `url.*.insteadOf`, so a person with a mirror rewrite would have a remote that no longer matched routing. The test homes rely on it: their origin reads `github.com/acme/web` and `insteadOf` sends git to a local bare repository |
| — | **`HYPOTENUSE_SESSION_URL` is the dashboard URL** | the plan's table said so; the ACP host had passed Linear's session URL |
| A failing setup command keeps the worktree | the same, and **the next turn runs setup again** (`setup_done`) | otherwise a fixed `setup` would never run in a worktree that failed once |
| `backend/__tests__/e2e/worktree-lifecycle.test.ts` with a 0 s grace | **`backend/__tests__/daemon/worktree-lifecycle.test.ts`**; the grace is lowered by `daemon reload` after the follow-up | beside the other real-daemon suites. With no grace from the start, the first turn's worktree would be gone before the follow-up could reuse it |
| An issue-hygiene section in `/docs/linear` | **"Keeping the issue tidy" in `/docs/agent-sessions`** | there is no `/docs/linear` page; agent sessions is where a person reads what happens to their issue |
| A stopped turn says "(n files changed, not pushed)" | **"(n files changed, not committed)"**, or "(nothing uncommitted)" | `git status` counts uncommitted files; it says nothing about pushing |

### Decisions the plan left open

| Question | Answer |
|---|---|
| A follow-up after its worktree was removed | a new worktree on the session's own branch: the local branch if it survived, else `origin/<branch>`, else a fresh one from the base |
| A worktree deleted by hand | the next cleanup prunes it and marks the row `removed` |
| A stop during fetch or setup | the setup command's process group is killed; nothing is said about setup, only the stop's own activity |
| `active` rows a crashed daemon left | marked `idle` when the daemon starts; their sessions were already marked `interrupted` |
| `worktrees list` / `cleanup` with no daemon | nothing counts as in use (no daemon, no agent). A daemon that holds its lock but does not answer is *not* "not running": the command exits 3 rather than racing its turns |
| What `gh` answers | `MERGED` and `CLOSED` count; `OPEN` does not; anything else (no `gh`, not logged in, no pull request) falls back to `ls-remote`; an `unknown` answer is not cached |
| Worktrees `state.db` does not know | adopted `idle` on every `list` and full `cleanup`, from `git worktree list` and each one's `hypotenuse.session` |
| `pr_url_patterns` | regexes; a match counts when its named group `repo` equals the remote's `owner/name`, or, without one, the URL's path holds it as whole segments |
| Labels of later pull requests | `Pull Request (2)`, … counted per session across turns (`local_sessions.pull_requests`) |
| An automation's session in tests | finear cannot start one (a gap, recorded); the test clears the mirror row's creator columns |

### Traps found while building

- **`git remote get-url` applies `insteadOf`; `git config --get remote.origin.url` does not.** And two local
  `insteadOf` rules with the same value are ambiguous — the test helper removes the clone's own before adding one,
  and only `--local` ones: the sandbox's global git config has its own `url.https://github.com/.insteadof`.
- **`git status --porcelain` lists the `.hypotenuse-keep` file** as untracked, so rule 2 fired before rule 4; the
  status excludes it (`:(exclude).hypotenuse-keep`).
- **A setup command runs `sh -c`**, whose children outlive a kill of `sh` alone; each command gets its own process
  group (`detached`) and the timeout kills the group.
- **`git branch -d` refuses a pushed branch with no upstream** that is not merged into the clone's `HEAD`. That is
  `-d` doing its job: the worktree goes, the branch stays, and the report says `branchDeleted: false`.
- **finear's mention control route without a `commentId` mirrors as a delegation** (the origin comes from the
  comment), so a hygiene test of a mention creates a real comment first.
- **The CLI logger's `warn` is silent when stderr is not a terminal**, so the offline fallback's warning is visible
  only interactively; the tests assert the behaviour, not the line.
- **Two full backend runs at once share `hypotenuse_test`** and fail each other — as the parallel-forks note in
  `AGENTS.md` says; it bit a single session that started a second run before the first was done.
