# Phase 18 — Git and pull requests

> **Goal:** A bot can read any repository its project has granted, and contribute back to it. Asked in Slack to "fix the flaky test in `acme/api`", the bot starts a sandbox job. The sandbox clones the repository with a credential good for that one repository and nothing else, makes the change, pushes a branch, and opens a pull request. The PR link lands in the Slack thread, on the Linear session as its "Pull Request", or in the Pylon note. Review comments and CI results on that PR can wake the conversation again.

> **Status: planned, not built.** Builds on [sandboxes](./phase-17-sandboxes.md) (jobs, job token, the egress allowlist, the supervisor) and [the channel framework](./phase-13-channel-framework.md). Uses [Linear](./phase-15-linear.md)'s `externalUrls` when the conversation is a Linear session.

Git access is where a team agent becomes useful and where it can do the most damage. ToolExec already settled the hard parts. Its first design proxied git; its later design ([direct git](https://github.com/arcadeai-labs/toolexec/blob/main/docs/plans/phase-22-direct-git.md)) deleted the proxy. The property that mattered was a GitHub credential worth almost nothing outside one repository and one job. GitHub sells that directly: a GitHub App installation token scoped to one repository and a permission set, dead within the hour. Ref policy is something only the remote can enforce, so it belongs to GitHub rulesets. This phase ports that design, adds the pull-request round trip back to the conversation, and adds a read-only path for "go look at the code" questions that need no write access.

## Scope

**In:**

- **A GitHub App for Hypotenuse.** One platform app (`GITHUB_APP_ID`, private key, OAuth client) that projects install into their GitHub orgs. `github_installations` records which project may use which installation, and an installation is attached only after the person proves they can access it (ToolExec's install three-hop and `assertUserCanAccessInstallation`).
- **`repository_grants`** per project: `owner/name` and `push: boolean`, plus the bots allowed to use the grant. `branchPrefix` is guidance (default `hypotenuse/<bot-slug>/`), and the plan recommends a ruleset for enforcement.
- **`sandbox:git-credential`** (HTTP only, never a tool). Given the job token and `path=owner/repo` from git's credential helper, it mints an installation token:
  - scoped to that repository;
  - with `contents`, `pull_requests`, `issues`, and `checks:read` at the grant's level;
  - cached per job and repository;
  - revoked by `finalizeSandboxJob`.
- **In the sandbox** (ToolExec's `GitAccessOps`):
  - the credential helper (`credential.useHttpPath=true`, POSIX `sed`, tolerant of pretty-printed JSON);
  - the managed `gh` wrapper with `gh-real`, whose path is persisted across `sh -lc`;
  - an egress allowlist of our host, `github.com`, and `api.github.com` where the provider supports one.
- **The `repository` parameter of `sandbox_start`.** Before provisioning, the server checks that the bot holds a grant. The clone happens in the job's prologue, and the briefing names the repository, whether the job may push, and the branch convention.
- **`sandbox_start` with `mode: "read"`** clones read-only for questions about code ("how does auth work in `acme/api`?"). It uses a cheaper job profile: no push, shorter limits, and no approval by default.
- **Pull requests.**
  - `sandbox-submit-artifact { name: "pull_request", url }`, or detection of a `gh pr create` URL in the transcript, records `sandbox_jobs.pullRequest`. Each record carries the repository, PR number, URL, and head branch.
  - The server relays the PR to the conversation: a Slack link, a Linear `addedExternalUrls` "Pull Request", or a Pylon note.
- **PR events back to the conversation.** GitHub App webhooks (`webhooks:github`: `pull_request`, `pull_request_review`, `pull_request_review_comment`, `check_suite`) are verified (`X-Hub-Signature-256`) and recorded in `trigger_events`. Those on a PR a job opened become inbox rows on the originating conversation, so the bot can answer "CI failed on your PR" or start a follow-up job to address review comments. Which events wake the bot is a per-bot setting; the default is reviews requesting changes and failed checks.
- **Read tools that need no sandbox** (server-side, through the installation token):
  - `github_file_read`
  - `github_search_code`
  - `github_pr_view`
  - `github_issue_view`

  Each is scoped to the bot's grants.

**Out:**

- GitLab and Bitbucket. `repository_grants.host` keeps that door open.
- Merging pull requests. People merge; a bot may comment or request review.
- A ref-level control of our own. GitHub rulesets on the remote are the enforcement (ToolExec's finding: `contents: write` is write to every ref).
- Per-user GitHub identity (commits authored as the requester). Commits are by the App's bot user, with `Co-authored-by` naming the requester when they are linked.

## What already exists

| Piece | ToolExec path | Carry |
|---|---|---|
| GitHub App ops (`signAppJwt`, `mintInstallationToken`, `revokeInstallationToken`, `fetchInstallationPermissions`, `assertUserCanAccessInstallation`) | [`backend/ops/GitHubAppOps.ts`](https://github.com/arcadeai-labs/toolexec/blob/main/backend/ops/GitHubAppOps.ts) | Port |
| Credential issuance (`issueRunGitCredential`, `revokeRunGitTokens`, permission capping) | [`backend/ops/GitCredentialOps.ts`](https://github.com/arcadeai-labs/toolexec/blob/main/backend/ops/GitCredentialOps.ts) | Port, keyed by job |
| In-sandbox scripts (`gitCredentialHelperScript`, `githubCliWrapperScript`, `persistGithubCliPathScript`, `gitSandboxConfigCommands`, `findGrant`, `mergeGrants`) | [`backend/ops/GitAccessOps.ts`](https://github.com/arcadeai-labs/toolexec/blob/main/backend/ops/GitAccessOps.ts) | Port verbatim; these are the hard-won parts |
| `sandbox:git-credential` | [`backend/actions/sandbox/sandbox-git-credential.ts`](https://github.com/arcadeai-labs/toolexec/blob/main/backend/actions/sandbox/sandbox-git-credential.ts) | Port |
| Install three-hop | `backend/actions/connection/connection-github-install-*` | Port as `github:install-*` |
| Egress allowlist | `buildEgressAllowlist` in [`backend/ops/RunProvisionOps.ts`](https://github.com/arcadeai-labs/toolexec/blob/main/backend/ops/RunProvisionOps.ts) | Already ported in [sandboxes](./phase-17-sandboxes.md); git hosts added here |
| Learnings | [direct git](https://github.com/arcadeai-labs/toolexec/blob/main/docs/plans/phase-22-direct-git.md), [credential containment](https://github.com/arcadeai-labs/toolexec/blob/main/docs/plans/phase-13-credential-containment.md) | Read first |

## What this must not weaken

1. **The job token stays the only durable credential in the sandbox.** A GitHub token exists in the sandbox only for the length of one git or `gh` command. It is handed to that process, never exported into the shell, and revoked when the job ends.
2. **A token names one repository.** There is no token a job can use against a repository its bot was not granted, so there is nothing to refuse.
3. **Inferring a repository is never an authorization decision.** Outside a checkout, the `gh` wrapper requires `--repo`/`-R` and refuses to guess.
4. **Pushing is the grant's decision, recorded and audited.** Creating or editing a grant with `push: true` is an admin decision with a warning when no branch prefix is set.
5. **Caching is per job, never shared.** Two jobs never share a token. If they did, the first to finish would revoke the second's mid-clone.
6. **Webhook ingress rules hold for GitHub too:** verify the raw body, answer fast, byte-identical refusals, never MCP.

## Design

### 1. Who may touch which repository

```
project ── github_installations (GitHub App installation in org X, attached by a person who can see it)
        └─ repository_grants (owner/name, push, branchPrefix, botIds[] | all bots)
bot ── may use a grant iff the grant lists it (or "all bots") AND canWriteBot holders approved it
```

`GitAccessOps.findGrant(bot, owner/name)` answers `none | read | write`. The same answer drives the `sandbox_start` check, the token's permission level, and the read tools.

### 2. The token handout

```
git in sandbox ──credential helper──▶ GET /api/sandbox/git-credential?path=acme/api  (job token in body)
   server: job active? → bot grant for acme/api? → installation for acme → mint {repositories:[api],
           permissions:{contents, pull_requests, issues: grant level, checks: read}} → cache (jobId, repo, level)
   ◀── {"username":"x-access-token","password":"ghs_…"}   (pretty-printed; the helper's sed allows whitespace)
```

Every handout writes a `sandbox_job_events` row `{ kind: "git_credential", repository, permission }`. A refusal writes one too, with a sentence a model can act on: "this bot has read access to acme/api; open a PR from a fork is not available — ask an admin to grant push".

### 3. Pull requests round trip

| Step | Where | What |
|---|---|---|
| Job pushes `hypotenuse/<bot>/<slug>` and runs `gh pr create` | sandbox | The wrapper mints a write token for that one command |
| PR recorded | `sandbox-submit-artifact { name: "pull_request" }`, or the supervisor's transcript parser seeing the PR URL | `sandbox_jobs.pullRequest = { repo, number, url, headRef }` |
| PR relayed | `SandboxRelayOps` | Slack: a link block in the thread. Linear: `agentSessionUpdate(addedExternalUrls: [{ label: "Pull Request", url }])`. Pylon: a note |
| PR event arrives | `webhooks:github` → `trigger_events` → `GitHubEventOps` | Match `(repo, number)` to a job's PR, then to its parent conversation. Inbox row with `source: "github"` |
| Bot wakes | `agent:tick` | Summarises the review or failure in the channel; may call `sandbox_start` again with the PR branch to address it |

A conversation that has ended can still be woken by its PR's events while the PR is open: it reopens to `working`. Disengagement wins. A conversation cancelled by a person's Stop or by un-delegation stays silent on PR events too.

### 4. GitHub webhooks

`POST /api/webhooks/github`. GitHub App webhooks come from one app, so there is one URL.

1. Verify `X-Hub-Signature-256` (`sha256=` hex HMAC of the raw body) with the App's webhook secret, in constant time.
2. Dedupe on `X-GitHub-Delivery`.
3. Record the event, answer 200, and enqueue.

Events for installations no project has attached are recorded as `unknown_installation` and answered 200.

## Schema sketch

```ts
github_installations: { id serial, projectId, installationId text, accountLogin, accountType,
  attachedByUserId, permissions jsonb, createdAt, revokedAt? }        // unique (projectId, installationId)
repository_grants: { id serial, projectId, installationId → github_installations, host text default 'github.com',
  owner, name, push boolean, branchPrefix text?, botIds int[]? /* null = all bots */, createdAt, updatedAt }
  // unique (projectId, host, owner, name)
sandbox_jobs: + repository jsonb { host, owner, name, ref?, mode: read|write }, + pullRequest jsonb?
sandbox_job_git_tokens: { id serial, jobId, repository, permission, tokenHash, expiresAt, revokedAt? }
```

## Actions and policy sketch

| Action | Route | RBAC | MCP | Audited |
|---|---|---|---|---|
| `github:install-url` | `GET /project/:projectId/github/install-url` | admin | yes | no |
| `github:install-callback` | `GET /github/install/callback` | session (browser hop) | **never** | yes |
| `github:installation-list` | `GET /project/:projectId/github/installations` (paginated) | member | yes | no |
| `github:installation-detach` | `DELETE /project/:projectId/github/installation/:id` | admin | yes | yes |
| `repository-grant:create` / `edit` / `delete` / `list` / `view` | `PUT/POST/DELETE/GET /project/:projectId/repository-grant[s]` | admin (list/view: member) | yes | yes (writes) |
| `sandbox:git-credential` | `GET /sandbox/git-credential` | job token | **never** (not even sandbox MCP) | no (recorded per job) |
| `webhooks:github` | `POST /api/webhooks/github` | none (signed) | **never** | no (machine ingress) |

The GitHub App private key and webhook secret are server config, never stored per project. Tokens never appear in responses. `password` (in `sandbox:git-credential`'s response) is the one place a GitHub token crosses; the response is excluded from logs by the action.

## Frontend and user docs

- **Project → Repositories:** attach installations; grant repositories (push toggle, branch prefix, which bots); the recommended ruleset, with a copyable JSON.
- **Bot page:** the repositories this bot can read or write.
- **Job page:** git handouts and the PR card.
- `frontend/src/content/docs/repositories.md`:
  - installing the App;
  - granting;
  - what "push" means and why rulesets matter;
  - how PRs come back to the conversation.

## Steps

### 1. Port — `backend/ops/{GitHubAppOps,GitCredentialOps,GitAccessOps}.ts`, `backend/config/github.ts`

### 2. Schema — `backend/schema/{github_installations,repository_grants,sandbox_job_git_tokens}.ts`

### 3. Credential action and provisioning — `backend/actions/sandbox/sandbox-git-credential.ts`, `backend/ops/SandboxProvisionOps.ts` (clone prologue, helper, wrapper, egress hosts)

### 4. Grants and install — `backend/actions/github/*.ts`, `backend/actions/repository-grant/*.ts`

### 5. PR relay and events — `backend/ops/{SandboxRelayOps,GitHubEventOps}.ts`, `backend/actions/webhooks/webhooks-github.ts`

### 6. Read tools — `backend/tools/github/*.ts`

### 7. Frontend, CLI, docs — `frontend/src/pages/repositories/*`, `cli/src/commands/repo.ts`, `frontend/src/content/docs/repositories.md`

### 8. Tests — `backend/__tests__/git/*`, a GitHub fake (`backend/__tests__/github/fake-github.ts`) serving the App token endpoints, git smart-HTTP over a local bare repository, the PR REST endpoints, and signed webhook delivery

## Test plan

- **Credential helper, against the live endpoint:** pretty-printed and compact JSON, a non-executable helper, and the `sh -lc` PATH reset (ToolExec's suites, ported).
- **Scope:**
  - a token for `acme/api` cannot read `acme/other`, because the fake enforces the token's repository list as GitHub does;
  - a read grant cannot push;
  - a bot not on a grant gets a refusal sentence;
  - two concurrent jobs on one repository hold independent tokens; finishing one leaves the other cloning.
- **Revocation:** `finalizeSandboxJob` revokes every handed-out token. The fake records the revoke.
- **PR round trip end to end:** a Slack thread asks for a change → job → branch pushed to the fake → PR opened → link in the Slack fake thread → a `pull_request_review` with `changes_requested` → the conversation wakes and replies.
- **Linear:** the PR appears as `externalUrls` "Pull Request" on the finear session.
- **Webhooks:** signature, dedupe, unknown installation → 200.
- **Disengaged conversations:** after Stop, PR events record and stay silent.
- **No secrets:** the sandbox's environment holds no `ghs_` token between commands.

## Verification

```bash
cd backend && bun test __tests__/git __tests__/github
cd backend && bun test __tests__/e2e/pr-from-slack.test.ts
bun run lint
```

By hand: install the App on a test org; grant a scratch repository with push; ask a bot in Slack for a one-line README change; review the PR; request changes; watch the thread.

## Definition of done

- [ ] Projects attach GitHub App installations and grant repositories per bot, read or push
- [ ] Sandboxes clone and push with one-repository, one-job installation tokens via `sandbox:git-credential`
- [ ] The managed `gh` wrapper works in a login shell; the credential helper survives pretty-printed JSON
- [ ] PRs opened by jobs are relayed to Slack, Linear (`externalUrls`), and Pylon
- [ ] Review and CI events on those PRs wake the originating conversation, unless it was disengaged
- [ ] Server-side read tools answer code questions without a sandbox
- [ ] Repositories page, CLI, and `repositories.md` ship in the same PR

## Open questions

- **One platform App or one App per project?** ToolExec supports both (platform app plus `resolveGitHubApp`). A per-bot App would match "one platform app per bot" for Slack and Linear, but GitHub App creation is heavier. Proposed: one Hypotenuse App, with commits signed off as the bot by name.
- **Wake on PR events by default?** Every review comment waking a bot could be noisy. The default proposed above is changes-requested reviews plus failed checks only.
- **Forks.** Should a bot with read-only access be able to open PRs from a fork the App owns? Default: no.

## Learnings from the build

Not built yet.
