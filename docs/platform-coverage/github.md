# GitHub platform coverage

Every interaction Hypotenuse has with GitHub, the module that handles it, and the test that proves it (AGENTS.md
rule 10). `backend/__tests__/docs/coverage.test.ts` asserts each row's test file exists and mentions the row's id.
The tests talk to the GitHub fake, `backend/__tests__/fakes/github/server.ts`: GitHub as the deployment's one GitHub
App sees it, in process — the App's JWT verified against its public key, installation tokens scoped to repositories
and permissions as GitHub intersects them, every repository a real bare repository served by `git http-backend`
under those tokens, the REST slice the read tools and the pull-request relay call, the install's user OAuth, and
webhooks signed with `X-Hub-Signature-256` and posted with `X-GitHub-Event` and `X-GitHub-Delivery` in GitHub's
documented payload shapes.

| Id | Interaction | Module | Test |
|---|---|---|---|
| `github.app.jwt` | the App's RS256 JWT — `iss` the App id, backdated a minute, under ten minutes — from a private key however it was pasted | `backend/ops/GitHubAppOps.ts` | `backend/__tests__/git/github-app.test.ts` |
| `github.out.installation` | `GET /app/installations/{id}` for the installation's live permission map | `backend/ops/GitHubAppOps.ts` | `backend/__tests__/git/github-app.test.ts` |
| `github.out.access-token` | `POST /app/installations/{id}/access_tokens` with an explicit `repositories` and `permissions` scope, never empty | `backend/ops/GitHubAppOps.ts` | `backend/__tests__/git/github-app.test.ts` |
| `github.out.revoke` | `DELETE /installation/token` with the token itself; 401 counts as revoked | `backend/ops/GitHubAppOps.ts` | `backend/__tests__/git/github-app.test.ts` |
| `github.out.user-installations` | `GET /user/installations` with the installing person's token: can they see the installation the callback names | `backend/ops/GitHubAppOps.ts` | `backend/__tests__/git/github-app.test.ts` |
| `github.oauth.code` | `POST /login/oauth/access_token` exchanging the install callback's `code` for a user token | `backend/ops/GitHubAppOps.ts` | `backend/__tests__/git/github-app.test.ts` |
| `github.install.callback` | the App's Setup URL: the installation attached to the project that started the install, by a person GitHub says can see it | `backend/actions/github/github-install-callback.ts` | `backend/__tests__/git/install.test.ts` |
| `github.install.spoofed` | a callback naming an installation the person cannot see attaches nothing | `backend/actions/github/github-install-callback.ts` | `backend/__tests__/git/install.test.ts` |
| `github.git.clone` | git's smart HTTP fetch with a token from `sandbox:git-credential`, through the credential helper | `backend/actions/sandbox/sandbox-git-credential.ts` | `backend/__tests__/git/credential.test.ts` |
| `github.git.push` | git's smart HTTP push with a `contents: write` token, only under a grant with push and a job started to write | `backend/actions/sandbox/sandbox-git-credential.ts` | `backend/__tests__/git/credential.test.ts` |
| `github.git.scope` | a token names one repository: another repository is refused by GitHub | `backend/actions/sandbox/sandbox-git-credential.ts` | `backend/__tests__/git/credential.test.ts` |
| `github.cli.wrapper` | the managed `gh` wrapper: a token per command, `--repo` required outside a checkout | `backend/ops/GitAccessOps.ts` | `backend/__tests__/git/credential.test.ts` |
| `github.out.contents` | `GET /repos/{owner}/{repo}/contents/{path}` for `github_file_read` | `backend/tools/github-file-read.ts` | `backend/__tests__/github/read-tools.test.ts` |
| `github.out.search-code` | `GET /search/code` for `github_search_code`, limited to granted repositories | `backend/tools/github-search-code.ts` | `backend/__tests__/github/read-tools.test.ts` |
| `github.out.pull` | `GET /repos/{owner}/{repo}/pulls/{number}` for `github_pr_view` | `backend/tools/github-pr-view.ts` | `backend/__tests__/github/read-tools.test.ts` |
| `github.out.issue` | `GET /repos/{owner}/{repo}/issues/{number}` for `github_issue_view` | `backend/tools/github-issue-view.ts` | `backend/__tests__/github/read-tools.test.ts` |
| `github.out.pr-details` | `GET /repos/{owner}/{repo}/pulls/{number}` for a recorded pull request's title and head branch, with a token minted for that one repository at `pull_requests: read` and revoked after; best effort | `backend/ops/PullRequestOps.ts` | `backend/__tests__/github/pull-requests.test.ts` |
| `github.pr.record` | a job's `pull_request` artifact recorded once against the job and its link relayed to the conversation; a URL that is not a pull request, or an ungranted repository, refused with a sentence | `backend/ops/PullRequestOps.ts` | `backend/__tests__/github/pull-requests.test.ts` |
| `github.pr.detect` | a tool result line that is only a pull request URL — what `gh pr create` prints — recorded the same way; a URL in prose is not | `backend/ops/PullRequestOps.ts` | `backend/__tests__/github/pull-requests.test.ts` |
| `github.in.signature` | `X-Hub-Signature-256` (`sha256=` hex HMAC-SHA256 of the raw body under the App's webhook secret), constant time; a bad or missing signature, a wrong secret, and an unset secret the same 404 | `backend/ops/GitHubEventOps.ts` | `backend/__tests__/github/webhooks.test.ts` |
| `github.in.body-cap` | a body past `PLATFORM_MAX_BODY_BYTES` is a 413, unrecorded | `backend/ops/GitHubEventOps.ts` | `backend/__tests__/github/webhooks.test.ts` |
| `github.in.ping` | `ping` (the App's webhook saved) answered 200, nothing recorded | `backend/ops/GitHubEventOps.ts` | `backend/__tests__/github/webhooks.test.ts` |
| `github.in.dedupe` | a redelivery with the same `X-GitHub-Delivery` is the same row, processed once | `backend/ops/GitHubEventOps.ts` | `backend/__tests__/github/webhooks.test.ts` |
| `github.in.projects` | one delivery for an installation two projects attached is one `trigger_events` row per project | `backend/ops/GitHubEventOps.ts` | `backend/__tests__/github/webhooks.test.ts` |
| `github.in.unknown-installation` | an installation no project attached: 200, recorded once as `ignored: unknown_installation` | `backend/ops/GitHubEventOps.ts` | `backend/__tests__/github/webhooks.test.ts` |
| `github.in.installation` | `installation` `suspend` / `unsuspend` / `deleted` set `suspendedAt` / `revokedAt` on every project's row for it | `backend/ops/GitHubEventOps.ts` | `backend/__tests__/github/webhooks.test.ts` |
| `github.in.review` | `pull_request_review` `submitted`: `changes_requested` wakes the conversation whose job opened the pull request (by default), with the review fenced as untrusted text | `backend/ops/GitHubEventOps.ts` | `backend/__tests__/github/pull-requests.test.ts` |
| `github.in.review-comment` | `pull_request_review_comment` `created`, and a `commented` review: in the inbox for the next turn, waking only a bot that asked | `backend/ops/GitHubEventOps.ts` | `backend/__tests__/github/pull-requests.test.ts` |
| `github.in.check-suite` | `check_suite` `completed`, matched through `check_suite.pull_requests`: a failure wakes (by default), a success only a bot that asked | `backend/ops/GitHubEventOps.ts` | `backend/__tests__/github/pull-requests.test.ts` |
| `github.in.closed` | `pull_request` `closed`: the row's state becomes `merged` or `closed`, and the bot hears at its next turn | `backend/ops/GitHubEventOps.ts` | `backend/__tests__/github/pull-requests.test.ts` |
| `github.in.disengaged` | an event on a pull request whose conversation a person stopped: recorded `ignored: disengaged`, nothing in its inbox or on its surface | `backend/ops/GitHubEventOps.ts` | `backend/__tests__/github/pull-requests.test.ts` |
