# Routing

When someone delegates an issue to `@hypotenuse` or mentions it, Hypotenuse decides four things before any work
starts, in this order, each from the cheapest source that can decide it:

1. **Which role** answers — a [manager or a worker](/docs/manager-and-worker). The project's routing rules decide.
2. **Which repository** the work happens in. The runners' checkouts bound the choice, Linear ranks it, and a
   person is asked only when Linear is unsure.
3. **Which runners could** take it.
4. **Which one** does — the runner already holding the session, then one of yours, then the least busy.

Every reply in the session after that is a new piece of work that follows the same path, except that the role and
the repository are already settled.

## Routing rules

Settings → **Routing** lists the project's rules in the order they are checked. The first enabled rule that
matches a new session decides its role; when none matches, a **worker** answers. A rule can also pin a repository,
which skips the repository choice below.

A rule matches when **every** field it sets holds. Fields left empty match anything.

| Field | Matches when |
|---|---|
| Prompt prefix | the mention starts with this word, e.g. `/manage` |
| Labels | the issue carries **any** of these labels (case does not matter) |
| Team keys | the issue is in one of these teams, e.g. `ENG` |
| Linear project ids | the issue is in one of these Linear projects |
| Sub-issues | the issue is (or is not) a sub-issue |
| Project content | the issue's Linear project has (or has no) content — its PRD — yet; an issue in no project matches neither |
| Started by | the session came from a delegation, or from a mention |

A delegation has no text, so a prefix rule never matches one. A matched prefix is removed before the agent reads
the mention: `@hypotenuse /manage plan the launch` reaches a manager as *plan the launch*.

When a project first connects Linear it gets four rules, which an admin can edit, disable, reorder, or delete:

| Rule | Matches | Role | Enabled |
|---|---|---|---|
| `/manage` | a mention starting with `/manage` | manager | yes |
| `/work` | a mention starting with `/work` | worker | yes |
| `hypotenuse:manager label` | an issue labelled `hypotenuse:manager` | manager | yes |
| `plan an empty project` | a top-level issue in a Linear project with no content yet | manager | no |

The last one is a guess — "nobody has written this project's PRD, so plan it" — and a guess that quietly changes
which kind of agent answers is worse than none, so it starts off. Sessions a manager dispatches are always workers,
and a session started from a mention on a project is always a manager, whatever the rules say.

**The role is fixed for a session's life.** Typing `/manage` in a reply to a worker session does not switch it; the
session says so, and the next mention starts a manager session. Changing a rule never changes a session that was
already routed.

Any member can read the rules. Adding, editing, reordering, and deleting them, and changing the timers below, need
the project's `admin` tag. From the terminal: `hypotenuse routing list`, `routing add`, `routing edit`,
`routing remove`, and `routing reorder` — see [the CLI](/docs/cli).

## Choosing the repository

1. A matched rule's pinned repository wins.
2. Otherwise the candidates are the repositories checked out on the runners that could take the work.
3. One candidate is chosen at once.
4. Several are passed to Linear, which ranks them from the issue and its own signals. Its top pick is taken when it
   is at least as sure as the project's **repository confidence** (0.7 by default).
5. Otherwise the session asks:

   > Which repository should I work in for ENG-123? Pick one, or reply with its name.

   with up to eight choices, best first. Pick one, or type `acme/web` (or just `web`, when only one choice has
   that name). An answer that matches nothing is asked once more; a second miss ends the session with an error
   naming the repositories it can work in. Hypotenuse never guesses what you meant.

With no runner that has any repository checked out, a worker waits for one (and says so). A manager can work
without a repository.

## Choosing the runner

A runner could take the work when it is online, not paused or draining, plays the role, has an available agent for
it, has the repository checked out, and its subscriptions accept the issue's team, project, and labels. It must also
have room — counted by Hypotenuse itself across the whole machine, per role, and per agent, from the limits the
runner reports.

Of those, the work is offered to:

1. **The runner holding the session.** A follow-up goes back to the machine with the session's worktree. If that
   runner is offline, full, or draining, the follow-up waits for it — up to the **sticky timeout** (10 minutes by
   default). After that, any runner may take it, starting from a fresh worktree and the session's history.
2. **Your own runners**, when Hypotenuse knows who started the session (below), least busy first.
3. **Everyone else's**, least busy first.

The offer stands for the **offer** time (10 seconds). A runner that does not claim it in time is passed over for
that work for a while, and the next runner gets the offer. A runner that claims work keeps it for as long as it
keeps reporting in; if it goes quiet for a minute, the work goes back to the queue — to the same runner first — and
after the fourth time it is given up with an error.

### Who started the session

Hypotenuse prefers the runners of the person who started a session. It knows who that is when their Linear
account is linked to their Hypotenuse account:

- **By e-mail**, automatically: a project member whose e-mail matches the Linear user's is linked the first time
  that Linear user starts a session.
- **By an admin**, for anyone: `hypotenuse identity link`.

Your links are on your **Account** page, where you can remove them. A link only reorders runners that could already
take the work; it never lets anyone's work reach a runner that otherwise could not. Linking yourself by signing in
to Linear is not available yet.

A session started by an automation or another agent has no person behind it, so no runner is preferred.

## Previewing a route

The **Routing** page's preview answers "what would happen if this issue were delegated now?". Give it an issue
(`ENG-123`) and, optionally, the text of a mention (`/manage plan the launch`), and it shows:

- the rule that matched, and the role it chose;
- **every runner** in the project, whether it could take the work, and if not, every reason why (below);
- the repository: pinned by a rule, the only candidate, Linear's suggestion, or a question a person would be asked.

The preview runs the same rules and the same runner checks as real routing, against the issue as Linear has it now
and the runners as they are now. It changes nothing, and any member may run it. Ranking repositories asks Linear,
which spends the workspace's API budget, so the preview does it only when you ask ("Ask Linear to rank
repositories", or `--with-repository`). From the terminal:

```bash
hypotenuse routing preview ENG-123
hypotenuse routing preview ENG-123 --prompt "/manage plan the launch" --with-repository
```

## Why work waits

When no runner can take a piece of work, the reason is recorded on it as a code. The session page's **Turns**, the
project home's queue, `hypotenuse session view`, and the preview all use the same codes.

A runner is ruled out for any of these, and the preview lists every one that applies:

| Code | The runner |
|---|---|
| `role_not_served` | does not play this role, or has no available agent for it |
| `subscription_mismatch` | subscribes to teams, projects, or labels the issue is not in |
| `offline` | has not heartbeated recently |
| `draining` | is finishing its work and taking no more |
| `paused` | was paused by its owner or an admin |
| `repository_missing` | does not have the repository checked out |
| `no_capacity` | has every slot for this work taken — on the machine, for the role, or for the agent |

A waiting piece of work carries one code: the reason of the runner that came closest, in the order above (a busy
runner is closer than an offline one). Three more are about the work, not a runner:

| Code | Means |
|---|---|
| `no_runners` | the project has no runners at all |
| `sticky_runner` | a follow-up is waiting for the runner that holds the session's worktree (up to the sticky timeout) |
| `offer_lapsed` | every runner that could take it just let an offer lapse; it is offered again shortly |

## What you see in Linear

| When | The session shows |
|---|---|
| Straight away | *On it — finding a runner for ENG-123.* |
| The role is chosen | *Routing as **worker** (rule: /work).* — or *(no rule matched; worker is the default)* |
| The repository is chosen | *Working in **acme/web**.* |
| Linear is unsure of the repository | the repository question, with choices |
| No runner can take it yet | why, e.g. *Waiting for a runner: 2 runners take worker work to ENG; all are offline.* |
| The session's runner is away | *Waiting for **evan-mbp**, which has this session's worktree.* |
| A runner has it | the agent's own thoughts, actions, plan, and answer |
| You reply while it works | *Got it — I'll read this when the current step finishes.* Several replies sent while it works become one follow-up. |
| Nobody took it within the queue timeout | an error saying why |

While work waits for a runner, Hypotenuse posts a short note every 25 minutes so Linear does not mark the session
stale. A session waiting on *you* — the repository question — is left alone.

## Stopping

Press **Stop** in Linear and:

| If the work | The session shows |
|---|---|
| had not started | *Stopped before starting.* |
| was running | the agent stops and says what state it left things in |
| was running, and the runner does not confirm within the **stop grace** (30 seconds) | *Stopped. The runner didn't confirm; its last state is unknown.* |
| there was nothing to stop | *Stopped. Nothing was running.* |

**Cancel** on a session's page in the dashboard (or `hypotenuse session cancel <id>`) stops work the same way, and
names you:

| If the work | The session shows |
|---|---|
| had not started | *Stopped from the Hypotenuse dashboard by Mario before starting.* |
| was running | *Cancelled from the Hypotenuse dashboard by Mario.*, and where the changes so far are |
| was waiting on a question the agent asked | *Stopped from the Hypotenuse dashboard by Mario.* — which also takes the session out of "awaiting input" |
| there was nothing to stop | nothing: Cancel is refused |

Replies waiting behind the stopped work are dropped too: a stop means stop. Nothing starts again until someone
prompts the session or delegates the issue anew. Removing `@hypotenuse` as the delegate, dismissing the session,
and uninstalling the app stop work the same way, without a message.

## Timers

| Setting | Default | Means |
|---|---|---|
| Queue timeout | 30 minutes | work no runner takes within this long ends with an error saying why |
| Sticky timeout | 10 minutes | how long a follow-up waits for the runner holding its worktree; 0 never waits |
| Offer | 10 seconds | how long a runner has to claim work offered to it |
| Stop grace | 30 seconds | how long a stopped run's runner has to confirm |
| Repository confidence | 0.7 | how sure Linear must be of a repository to skip asking |

An admin changes them under Settings → Routing, or with `hypotenuse routing settings`.
