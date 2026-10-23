# Phase 20 — Project planning

> **Goal:** A team plans a whole Linear project with `@hypotenuse`, in Linear, the way it already plans: the manager
> writes the project's plans into its content and documents, people and reviewer agents critique them in document
> comments, the manager revises and answers, and once a person approves, it cuts and dispatches the tickets.

> **Status: planned, not built.**

Today a manager works from an issue. Linear starts an agent session when the app is delegated an issue or mentioned
in one, and every part of Hypotenuse assumes that issue: `agent_sessions.external_issue_id` is `NOT NULL`, routing
reads the issue's team, labels, and project, the agent tools derive their scope from it, and a worktree's branch is
named for it. A team that plans by project (status columns such as *Product planning* and *Implementation
planning*, a plan in the project's content, an implementation plan as a project document) has to invent a planning
issue to hold the conversation.

Linear's schema does not require one. In `@linear/sdk` 97.1.0, `AgentSession.issue` is optional and the session's
`url` is *"Null when no issue is associated"*; `agentSessionCreateOnComment` starts a session on a root comment; and
a `Comment` belongs to an issue, a **project**, a project update, a **document**, an initiative, or an initiative
update. The app is already granted `app:mentionable` (LC-OAUTH-06), which covers documents, and Linear already sends
a `documentMention` inbox notification, which `ops/LinearNotificationOps.ts` records as `ignored`.

## Decisions so far

| Question | Decision |
|---|---|
| Where a project's agent work lives | **A comment thread on the Linear project.** No synthetic planning issue. The session is scoped to the project, not to an issue |
| Where the team's process lives | **In the role's prompt**, through `[roles.manager] prompt_file` and `docs` (paths or URLs). The manager reads the project's status with `linear_get_project` and follows the matching section of its instructions; Hypotenuse adds no stage concept of its own |
| Where plans are written | the project's content and project documents, as today (`linear_update_project`, `linear_create_document`, `linear_update_document`) |
| How plans are reviewed | **Linear comments on the plan documents**, from people and from reviewer agents alike |
| When a document comment reaches the manager | **both**: an `@hypotenuse` mention in a document comment wakes the project's session, and every turn reads the plan documents' open threads |
| Who passes a gate | a person. Reviewer agents comment; they never move a project's status |

## Scope

**In:**

1. **Find out what Linear sends**, before anything else is built. Against a real workspace, mention `@hypotenuse`
   in a project comment and in a document comment, and record what arrives: an `AgentSessionEvent` `created` (with
   which of `issue`, `comment`, `context` set), an `AppUserNotification` (`documentMention`, a project comment
   type), or nothing. Each behaviour finear lacks is filed upstream (rule 5 of `AGENTS.md`) and driven through
   finear's control routes or `__tests__/linear/inject.ts` meanwhile. The answer decides step 2's ingress.
2. **Sessions scoped to a project.** `agent_sessions` gains the project as a scope (`external_project_id`, and the
   root comment's id), and `external_issue_id` becomes nullable, with a check that a session has an issue or a
   project. Ingress accepts a session with no issue; routing matches rules on the project (team keys from the
   project's teams; no labels, no sub-issue match); the agent tools re-derive scope from the project; the daemon
   names a project session's directory and branch for the project.
3. **Document comment tools** in `hypotenuse mcp`: read a document's comment threads, comment on a document, and
   reply in a thread. Each re-derives its scope from the session, like every `daemon:linear-*` action, and each
   gets a row in `LINEAR_COVERAGE.md`.
4. **A mention in a document comment wakes the project's session.** Through whichever ingress step 1 finds: a
   `prompted` event on the session, a new session that is joined to the project's, or the `documentMention`
   notification gaining an outcome other than `ignored` in `ops/LinearNotificationOps.ts`'s table.
5. **Reviewer agents.** The manager dispatches a read-only review of a plan document to a reviewer persona, whose
   instructions come from the dispatch and the role's `docs`. A reviewer comments on the document and ends; its turn
   comes back to the manager as a review, as a worker's does today. Dispatch stays one level deep.
6. **Initiative context.** A read-only tool for the project's initiative (its description, documents, and other
   projects), so a plan can link what it depends on.
7. User docs (`manager-and-worker.md`, `routing.md`, `agent-tools.md`), `ARCHITECTURE.md`, `RUNNER_PROTOCOL.md` for
   the assignment's project scope, `LINEAR_COVERAGE.md`, and this plan.

**Out:**

- **Moving a project between statuses on its own.** The manager may move one only after a person approves in the
  thread, as `linear_update_project` allows today; nothing here moves one automatically.
- **Reviewers that approve.** They comment. A person approves.
- **Milestones and WIP limits per team.** Worth having for a team that plans this way, and separable from this plan.
- **A stage table in Hypotenuse.** The prompt carries the stages; if two teams' processes differ, their runners'
  `docs` differ.

## Design

- **The project is the session's scope, not its issue.** Everything that today reads "the session's issue" reads
  "the session's issue, else its project": the scope rules of the agent tools, the routing rule match, the
  acknowledgement thought, the event log's summary. A project session can still create and dispatch issues in its
  project; those children are ordinary issue sessions.
- **A document's threads are read every turn, and a mention wakes one.** Reading the threads every turn makes the
  manager answer feedback left while it was idle; the mention wake makes it answer now. A comment that does not
  mention the app never starts a turn, so people can discuss a plan among themselves.
- **A reviewer is a role, not a prompt trick.** It is read-only like the manager, cannot dispatch, and has its own
  `docs`, so a team writes "how our Tech Lead reviews a plan" once, in the place it already keeps its process.
- **Nothing is faked for finear.** Where finear cannot start a session on a project comment or deliver a comment on
  a document, the gap is filed and the test drives the documented payload through the harness.

## Definition of done

- [ ] What Linear sends for a project-comment mention and a document-comment mention, recorded in this plan's
      learnings, with each finear gap filed.
- [ ] A session with no issue, scoped to a project: ingress, routing, tools, and the daemon, end to end against
      finear and a real daemon with the fake agent.
- [ ] Document comment tools, each with a coverage row and a test over real HTTP.
- [ ] A document-comment mention wakes the project's session; a comment without one does not.
- [ ] A reviewer dispatch: the reviewer comments on the document, and its review turn reaches the manager.
- [ ] The docs listed in Scope.

## Learnings from the build

**Step 1 done.** What a real workspace sent, what it refused, and the ingress built on that.

### What Linear sends for a mention on a project

Recorded from a real workspace's event log, mentioning `@hypotenuse` on a project:

| Where the mention was | Deliveries | An `AgentSessionEvent`? |
|---|---|---|
| a comment on the project | `Comment` `create` (with `projectId`, no `issueId`, `isArtificialAgentSessionRoot: false`); `AppUserNotification` `projectCommentMention` (the comment's id and body, and the project's id, name, and URL) | **no** |
| the project's own content | `Project` `update` (the new `content`); `AppUserNotification` `projectMention` (the project only) | **no** |
| a comment on an issue, for comparison | `Comment` `create`; `issueCommentMention`; `AgentSessionEvent` `created` | yes |

So Linear starts sessions for mentions on issues only. `Project` and `Comment` data-change webhooks arrive without
being asked for in the manifest, and `projectCommentMention` carries everything needed to ask for a session.

### Linear refuses a session on a project comment

Asked with `agentSessionCreateOnComment` on a person's project comment, real Linear answered **"comment must be on
an issue"**. A project's comment thread cannot anchor a session, and the decision above — a project comment thread,
no planning issue — does not hold. `agentSessionCreate` takes an optional `issueId`, but a session with no issue has
no `url`, so nobody in Linear could see it. Comments on documents were not tried; the same refusal is expected.

### What was built instead: a mention on the project files the planning issue

- **The mention stays the trigger; an issue Hypotenuse files is the anchor.** A person's `projectCommentMention`
  makes the `triggers:check-notifications` clock (`ops/ProjectPlanningOps.ts`, outside any transaction) read the
  project's teams, file **`[hypotenuse] Plan: <project>`** in the project on its first public team with the
  comment's text as the description, start a session on it (`agentSessionCreateOnIssue`), and reply on the comment
  with the link. The event's summary says what was filed, or Linear's refusal; the outcome stays `noted`, because
  `mention_without_session` tells the integration card to reconnect Linear.
- **The session is a manager because a Redis intent says so**, as a dispatch's does: written under the issue before
  the session is asked for (Linear's `created` can arrive first), and applied once by `adoptPlanningSession` on
  `created` — the role, the rule name `project mention`, the comment's text without the mention or a role prefix as
  the instruction, and the commenter as the session's creator, so their runners are preferred. Routing then decides
  no other role.
- **A retry files no second issue.** The filed issue is remembered per notification in Redis, so a lost answer to a
  later call retries from there. A lost answer to the `issueCreate` itself can still file two.
- **The reply on the project comment is best-effort**: planning goes ahead without it, and the summary says it failed.
- **A session with no issue is still answered, not worked** (`NO_ISSUE_RESPONSE`), in case Linear ever starts one.
- **finear has no comments on projects**, so its reply is refused; the test asserts the request and the summary.
