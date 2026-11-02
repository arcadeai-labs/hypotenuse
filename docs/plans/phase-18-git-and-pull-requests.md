# Phase 18 — Git and pull requests

> **Goal:** A bot can read any repository its project has granted, and contribute back to it. Asked in Slack to "fix the flaky test in `acme/api`", the bot starts a sandbox job. The sandbox clones the repository with a credential good for that one repository and nothing else, makes the change, pushes a branch, and opens a pull request. The PR link lands in the Slack thread, on the Linear session as its "Pull Request", or in the Pylon note. Review comments and CI results on that PR can wake the conversation again.

> **Status: built.** Builds on [sandboxes](./phase-17-sandboxes.md) (jobs, job token, the egress allowlist, the supervisor) and [the channel framework](./phase-13-channel-framework.md). Uses [Linear](./phase-15-linear.md)'s `externalUrls` when the conversation is a Linear session.

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

- [x] Projects attach GitHub App installations and grant repositories per bot, read or push
- [x] Sandboxes clone and push with one-repository, one-job installation tokens via `sandbox:git-credential`
- [x] The managed `gh` wrapper works in a login shell; the credential helper survives pretty-printed JSON
- [x] PRs opened by jobs are relayed to Slack, Linear (`externalUrls`), and Pylon
- [x] Review and CI events on those PRs wake the originating conversation, unless it was disengaged
- [x] Server-side read tools answer code questions without a sandbox
- [x] Repositories page, CLI, and `repositories.md` ship in the same PR

## Open questions

- **One platform App or one App per project?** ToolExec supports both (platform app plus `resolveGitHubApp`). A per-bot App would match "one platform app per bot" for Slack and Linear, but GitHub App creation is heavier. Proposed: one Hypotenuse App, with commits signed off as the bot by name.
- **Wake on PR events by default?** Every review comment waking a bot could be noisy. The default proposed above is changes-requested reviews plus failed checks only.
- **Forks.** Should a bot with read-only access be able to open PRs from a fork the App owns? Default: no.

## Learnings from the build

### What is built

| Piece | Where |
|---|---|
| Config: one GitHub App for the deployment (`GITHUB_APP_ID`, `_SLUG`, `_PRIVATE_KEY`, `_CLIENT_ID`, `_CLIENT_SECRET`, `_WEBHOOK_SECRET`; `GITHUB_API_URL` / `GITHUB_WEB_URL` for the fake) | `backend/config/github.ts`, `render.yaml` (the shared group's comment) |
| Schema (migration `0017`): `github_installations`, `repository_grants`, `sandbox_job_git_tokens` (the handout ledger), `sandbox_job_pull_requests`, `bots.githubWakeEvents` | `backend/schema/*` |
| Ported from ToolExec: App JWT, scoped mint, revoke, the install's user check; credential issuance keyed by job; the helper, the gh wrapper, the PATH persist script, git config | `backend/ops/{GitHubAppOps,GitCredentialOps,GitAccessOps}.ts` |
| Install and grants: `github:install-url`, `github:install-callback`, `github:installation-list` / `-detach`, `repository-grant:*`, `bot:repositories`, `bot:edit --githubWakeEvents` | `backend/actions/{github,repository-grant}/*`, `backend/ops/{GitHubInstallOps,RepositoryGrantOps,RepositoryOps}.ts` |
| The sandbox's git: `sandbox:git-credential`, the clone prologue, the managed `gh` (`gh-real` off PATH in `Dockerfile.dev`, image 1.1.0), `sandbox_start({ repository, mode, ref })` | `backend/actions/sandbox/sandbox-git-credential.ts`, `backend/ops/SandboxProvisionOps.ts`, `backend/tools/sandbox-start.ts`, `backend/sandbox/{briefing.md,images/*}` |
| Pull requests and events: `PullRequestOps` (artifact and transcript detection), the `link` surface kind on every adapter, `webhooks:github` and `GitHubEventOps` | `backend/ops/{PullRequestOps,GitHubEventOps}.ts`, `backend/platforms/*`, `backend/actions/webhooks/webhooks-github.ts` |
| Read tools: `github_file_read`, `github_search_code`, `github_pr_view`, `github_issue_view` | `backend/tools/github-*.ts` |
| The GitHub fake: the App's key pair and JWT check, scoped installation tokens, revocation, user OAuth, git smart HTTP (`git http-backend`) over private bare repositories enforcing a token's repository list, the REST slice, signed webhooks | `backend/__tests__/fakes/github/server.ts` |
| Proof | `backend/__tests__/git/*` (App, install, grants, credentials and the helper against the live endpoint, `sandbox_start`, a real container's clone and push), `backend/__tests__/github/*` (webhooks, pull requests on every platform, read tools), `backend/__tests__/e2e/pr-from-slack.test.ts`, `docs/platform-coverage/github.md` |
| Frontend, CLI 2.13.0, docs | the Repositories page, the bot page's Repositories section, the job page's pull requests and git handouts; `hypotenuse repo …`, `bot repos`, `bot edit --github-wake`; `repositories.md` |

### Where the build differs from the plan

| The plan says | The build does, and why |
|---|---|
| `sandbox_jobs.pullRequest jsonb` | A table, `sandbox_job_pull_requests`, unique on (project, host, owner, name, number). A job can open more than one, and a webhook event must find its conversation with one indexed read; a later job that pushes to the same branch leaves the pull request with the job that opened it |
| `sandbox_job_git_tokens { tokenHash, expiresAt }` | The same table carries every request: `outcome` `issued` / `reused` / `refused` and the refusal's `reason`, so the job page shows what git asked for and why it was told no. The plan's "a `sandbox_job_events` row per handout" would have collided with the supervisor's own `seq` |
| A token's permission is the grant's level | `write` only when the grant allows a push **and** the job was started in `write` mode on that repository. A job may read any repository its bot is granted (a submodule, a library) and write only the one it was started to change |
| `contents`, `pull_requests`, `issues`, `checks:read` at the grant's level | An allowlist (`SANDBOX_GITHUB_PERMISSIONS`): `contents`, `pull_requests`, `issues` at the job's level, `checks`, `statuses`, `actions` at `read`, and `metadata: read` — each only when the installation holds it, never above its level. Nothing else is ever asked for. The read tools mint narrower still: `metadata` plus the one permission the call needs, because asking for `issues` on an installation without it 422s the mint |
| The PR relayed as "a Slack link block / Linear `addedExternalUrls` / a Pylon note" | One new surface kind, `link` (`{ label, url, text }`), that each adapter renders its way. It is exempt from "nothing follows a question": it is not part of a turn (on Linear it is `externalUrls`, not an activity), and a pull request must reach a conversation that waits on a person |
| `webhooks:github` records "the event" | One `trigger_events` row per project that attached the installation (`botInstallationId` holds the `github_installations` row id for this type, answered as `githubInstallationId` with `botInstallationId: null`); an installation no project attached is one row, `projectId: null`, `ignored: unknown_installation` |
| Open question: one App or one per project | One App for the deployment. Commits are authored as the bot by name (`<bot> (Hypotenuse)`), with a `Co-authored-by:` line for the requester only when they are a linked user with an email |
| Open question: wake on PR events by default | Changes requested and failed checks wake; everything else waits in the inbox for the next turn. Per bot, `githubWakeEvents` widens it — merged and closed included, though neither is in the default. A conversation a person stopped hears nothing |
| Open question: forks | No. A read-only grant cannot open a pull request |
| `sandbox_start` `mode: "read"` "no approval by default" | Under the `approve` policy a read job parks for approval like a write job — it still runs the repository's code; `off` refuses it, `allow` runs it. A read job runs at most 15 minutes |

### Decisions the plan left open

- **The grant is re-checked at provisioning**, so a grant revoked between `sandbox_start` and the job's start fails the
  job before a sandbox exists.
- **The install callback peeks the state before consuming it**, so a signed-out browser or the wrong person sees an
  error without spending the state of the person who started the install. Every outcome is a redirect to
  `/projects/:projectId/repositories`, which selects the project; a failure writes no audit row.
- **A grant is proven before it is saved**: `repository-grant:create` mints a `metadata: read` token for the
  repository and revokes it at once, so a repository the installation cannot see is refused where a person can fix it,
  not in a sandbox later.
- **Pull requests are detected two ways**: the `pull_request` artifact the briefing asks for, and the result of a
  `gh pr create` call in the transcript (paired to its call by Claude Code's `tool_use_id`, or Codex's `command`), a
  line that is nothing but a pull request URL. Either way, GitHub must confirm the job opened it before it is recorded
  (see below).
- **Merges and closes update the row's `state`** whether or not they wake the bot.

### Traps found while building

- **`state` is in `SENSITIVE_KEYS`**, and `scrubToolOutput` applies that list to tool results: a tool output key named
  `state` never reaches the model. The read tools answer `status`. `linear_issue_view` answers `state` today and loses
  it — a fix for that tool, outside this change.
- **Keryx logs an action's params, never its response**, so `sandbox:git-credential`'s `password` is not logged
  without any workaround (checked in Keryx 0.48.2's `logAction`).
- **Two suites that each call `destroyManagedContainers` kill each other's containers.** The end-to-end suite failed
  once while the lifecycle suites ran beside it; alone it passed every time. Container suites run one at a time.
- **Docker Hub rate-limits the test image's base** (`429` on `oven/bun:1`); a rebuild in the middle of a full run fails
  every container suite at once. `pr-from-slack.test.ts` falls back to a local image when the rebuild fails.
- **A fake `gh-real` cannot be dropped into the test image at run time** (its directory is root's). The end-to-end
  opens its pull request the way `gh` would — a token from the real credential helper for one command, then the REST
  call — and reports it with the `pull_request` artifact.

### Not run here

- **`Dockerfile.dev` as committed**: the GitHub CLI tarball download fails behind this environment's TLS-re-signing
  proxy (curl exit 60), as `npm install` did for the sandbox image. Both tarball URLs answer 200 from the host and the
  archive layout was checked; CI's **Sandbox Image** job builds it.
- **A real GitHub App and a real repository**: every suite runs against the GitHub fake. The by-hand verification in
  this plan — install on a test org, a one-line README change from Slack, a review — waits for staging's App.
- **The docs illustrations** do not include the Repositories page: they seed over the API, and an installation cannot
  be attached without a real App. The screenshots under `docs/screenshots/repositories/` were taken from seeded rows.

### What the review found, and what changed

- **Attaching took visibility, not ownership.** `GET /user/installations` lists every installation the person can
  read anything in. `assertUserAdministersInstallation` now also requires `GET /user` to *be* a user account (by id) or
  `GET /user/memberships/orgs/{org}` to answer `active` / `admin`. Whether a user token needs the App's **Members:
  read** for that call is unverified until staging's App.
- **Token permissions are an allowlist** (`SANDBOX_GITHUB_PERMISSIONS`). The denylist it replaced handed a job every
  repository permission GitHub added after it was written — `repository_hooks`, `dependabot_secrets`, and so on.
- **A mint can outlive its job.** `issueJobGitCredential` re-reads the job after the token joins the job's set; an
  ending that read the set first has committed by then, so the token is revoked at once and the request refused.
  `holdNextMint` on the fake is how the suite puts the ending inside the mint.
- **The ledger stamps only what GitHub confirmed**, by token hash, so an unrevoked token does not read as revoked.
- **A suspended installation was found by `grantForBot`**, so `sandbox_start` accepted a job that failed at clone.
  `installationUnavailableReason` is the one wording; `sandbox_start` and provisioning refuse with it up front.
- **Narrowing a grant now reaches running jobs.** Push turned off, bots removed, a grant deleted, or an installation
  detached revokes those repositories' tokens in live jobs after commit (`revokeLiveJobRepositoryTokens`, via a
  token → repository hash per job in Redis).
- **Read jobs park for approval** under `approve`: they push nothing, but they run untrusted repository code with a
  credential and egress.
- **The clone prologue validates `ref`** (`gitRefProblem`; a leading `-` is an option to git) and passes `--`; a
  repository named `.hypotenuse`, `.`, or `..` clones into `/work/repo`. Deny-all egress applies only to repository
  jobs (`sandboxEgressPolicy`); other jobs keep the provider's default.
- **The install callback's inputs are all optional**: GitHub's `setup_action=update` redirect has no `state`, and a
  missing input failed validation as a raw 406 before `run` could redirect.
- **`github_file_read` refuses `.`, `..`, and empty segments** before minting: `fetch` resolves `..`, so a path could
  leave `contents` and reach another endpoint with the call's token.
- **The recommended ruleset bypasses the admin (5), maintain (2), and write (4) roles**, so it binds the App, which
  has no role, without blocking the team.
- **Redaction is best-effort.** `redactGitHubTokens` catches tokens an agent prints in events and artifacts, but
  not an encoded or split one. The bound on a leaked token is the revocation when the job ends, not the redaction.
- **A job could claim any pull request.** A URL proved nothing, GitHub unreadable recorded anyway, and the first
  claim won forever, so a read-only job could squat `…/pull/N` before it existed and take its reviews and CI.
  `recordJobPullRequest` now records only for a job holding write on the repository, after GitHub confirms the pull
  request exists, is authored by `<appSlug>[bot]`, has its head on that repository, and sits under a configured
  branch prefix; GitHub unreachable refuses. Transcript detection reads only `gh pr create` results.
  `pull-requests.test.ts` ("only a pull request GitHub says the job opened is recorded").
- **An untrusted fence could be closed from inside.** Text carrying `<<<end of …>>>` ended the fence and spoke
  outside it. One helper, `UntrustedTextOps.fenceUntrusted`, rewrites every run of three `<` or `>` to `‹`/`›` before
  wrapping — deterministic, so redelivery dedupe and scripted expectations hold. The wake message now fences the
  title, branch, file path, and a check suite's app name too. `pull-requests.test.ts` ("untrusted text stays fenced").
- **A GitHub event queued mid-turn answered the bot's question.** `pendingInbox(…, answering)` excluded only
  `metadata.sandboxJobId`. `receiveMessage` now writes `metadata.answers: false` for every `answers: false` message,
  and the answering check excludes those rows — sandbox, GitHub, and an untrusted customer's alike. No migration.
  `pull-requests.test.ts` ("a GitHub event mid-turn is never the person's answer").
- **A `link` broke an open Slack stream**: `sendFinal` stopped the stream, but `previousStreamOrFinal` does not count
  `link`, so the next stream row appended to a stopped message (`message_not_in_streaming_state`). A link no longer
  closes the stream. `slack/thread.test.ts` ("a link mid-stream …").
- **Cancelled or superseded CI woke "CI failed".** `cancelled`, `stale`, `skipped`, and `neutral` are ignored; a
  suite whose `head_sha` is not the listed pull request's `head.sha` is `check:superseded`. That compares against the
  payload, not a stored head or a REST read: processing runs inside the event's transaction and must not call GitHub,
  and a `headSha` column would have been a migration for one comparison GitHub already makes in the payload.
  `pull-requests.test.ts` ("a cancelled, skipped, or neutral suite …").
- **`trigger-event:list?botInstallationId=N` mixed in GitHub events** whose column holds a `github_installations` id.
  That filter now excludes `type: github`; `githubInstallationId` and `type` filters were added, and the serializer
  answers a GitHub event's id as `githubInstallationId`. `github/webhooks.test.ts` ("trigger-event:list …").
- **The detach notice read "revoked [object Object] grants"**: the page typed `removedGrants` as a number. It now uses
  `ActionResponse<GithubInstallationDetach>` and `detachNotice` counts the list. `frontend/src/__tests__/repositories.test.ts`.
