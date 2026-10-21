# Phase 17 — Coverage conformance and end-to-end

> **Goal:** "100% coverage of the Linear agent docs" stops being a claim and becomes a test. Every row of
> [`LINEAR_COVERAGE.md`](../LINEAR_COVERAGE.md) names a test that exists and asserts it, and a CI test fails the day
> a row loses its test. And the whole system — finear standing in for Linear, the real backend, the real
> `hypotenuse daemon`, a scripted ACP agent, and a real git repository — is driven end to end through every
> interaction a person has with `@hypotenuse`.

> **Status: planned, not built.** The last phase. Every earlier phase ships its own backend and CLI suites; this
> one adds the cross-process suite none of them can, closes the coverage matrix, files the finear gaps upstream, and
> adds an optional nightly run against a real coding agent.

Each earlier suite proves its own piece against a real server with real Postgres and Redis (rule 1 of
[`AGENTS.md`](../../AGENTS.md)). What none of them can prove is that the pieces agree with each other across the three
process boundaries the product has: Linear → server (webhooks), server ⇄ daemon (HTTP and the ping socket), daemon ⇄
agent (ACP over stdio). A daemon that maps `tool_call_update` slightly wrong and a server that validates it slightly
loosely will both pass their own tests. The end-to-end suite runs all of them as separate processes and judges the
outcome where a person would see it: the activities finear recorded for the Linear session.

## Scope

**In:**

- `backend/__tests__/docs/linear-coverage.test.ts`: the matrix is parsed and enforced.
- An **end-to-end harness** in `backend/__tests__/e2e/`: finear in-process, the backend booted on a random port, a
  temp HOME with a generated config and credentials, a bare-origin git repository and a clone, and a real
  `hypotenuse daemon` child process running the fake ACP agent.
- **Scenarios**, one file each (listed below).
- A CI job, `E2E Daemon`, inside the `complete` gate.
- An optional **nightly** workflow, `.github/workflows/nightly-real-agent.yml`, with a real `claude-agent-acp`.
- **finear upstream issues** for every gap, filed and linked from [`LINEAR_COVERAGE.md`](../LINEAR_COVERAGE.md).

**Out:**

- Testing against production Linear in CI. A Linear sandbox workspace is a manual release check (below), not a gate:
  it needs a real OAuth app, a public webhook URL, and a human in the loop for consent.
- Browser e2e — Playwright already covers the dashboard ([phase 15](./phase-15-dashboard.md)).
- Load testing beyond the concurrency tests each phase already has.

## Design

### The coverage matrix as a test

[`LINEAR_COVERAGE.md`](../LINEAR_COVERAGE.md) is a Markdown table with columns ID, Feature, Source, Handling, Phase,
Test, Status. `linear-coverage.test.ts`:

1. parses every table row whose first cell matches `/^LC-[A-Z]+-\d{2}$/`;
2. asserts IDs are unique;
3. for every row with `Status` other than `not applicable`: the `Test` cell names one or more repository paths,
   each **exists**, and each file **contains the row's ID** as a string (in a `describe` / `test` name or a comment
   `// LC-OAUTH-03`) — which is what ties a row to an assertion rather than to a file that happens to exist;
4. asserts no row is `planned` once this phase is done (status must be `covered`, `covered (finear gap)`, or
   `not applicable` with a reason);
5. asserts every `Phase` link resolves (the general links test also does this).

Rows marked `covered (finear gap)` are proven by a test that injects the missing Linear behaviour **at the HTTP
boundary** — posting a correctly signed webhook body built from Linear's documented payload — because finear cannot
produce it. Each such row links its finear issue. When finear fixes the gap, the test switches to finear and the
status to `covered`.

Rule 5 applies: finear gets the same discipline as Keryx ([`AGENTS.md`](../../AGENTS.md)): a finear gap is filed
upstream with a minimal reproduction; the test does not grow a private fake of Linear to work around it beyond the one
signed-webhook injection above, which exercises *our* code, not a pretend Linear.

### The harness

`backend/__tests__/e2e/harness.ts` exports `useE2E()` for `beforeAll`/`afterAll`, returning a handle:

```ts
const e2e = useE2E({ runners: 1, agentScript: "plan-edit-pr" });
// e2e.finear       — finear app (control API, LinearClient for "Human 1")
// e2e.server       — backend URL; Peach's session cookie; the project with the integration
// e2e.daemons[i]   — child process handle: stdout/stderr ring buffer, control-socket client, kill()
// e2e.repo         — { origin: bare repo path, clone: path }
// e2e.waitForActivities(sessionId, predicate, timeoutMs)
// e2e.delegate(issueId) / e2e.prompt(sessionId, body) / e2e.stop(sessionId)
```

Boot order, and why:

1. **finear in-process** with `createApplication({ databasePath: ":memory:", port: 0, controlToken, clients: [...] })`
   — the OAuth client gets a `webhook` whose URL is not known yet, so finear is created with a placeholder and the
   backend's URL is patched into the client after step 2 (if finear does not support patching, the backend is booted
   first on a port chosen in advance; either way the shared helper hides it).
2. **The backend**, via the ToolExec-style `buildTestUniverse()` (Peach, Mario, Luigi, Toad, Bowser), with
   `LINEAR_API_URL` and `LINEAR_OAUTH_URL` pointing at finear and the injectable webhook clock aligned to finear's
   virtual clock.
3. **Linear install**: the scripted consent flow (`approveFixtureConsent`, copied from finear's `examples/agent.ts`)
   through the real `integration:connect` → finear authorize → `linear:callback`.
4. **Git**: `git init --bare origin.git`; a clone with one commit on `main`; the clone's remote is the bare repo, so
   `git push` from a worktree works offline. A fake `gh` on `PATH` (a script that prints a PR URL for
   `gh pr create`) stands in for GitHub — the PR URL it prints is what the daemon must report.
5. **The daemon**: `runner:register` over HTTP as Mario; a temp `HOME` containing `config.toml` (server URL, one
   repository pointing at the clone, `[agents.fake]` with `command = ["bun", "<repo>/cli/__tests__/fixtures/fake-acp-agent.ts"]`,
   both roles) and `credentials.json`; then `bun cli/src/cli.ts daemon start --foreground` as a child process. The
   harness waits for `daemon status --json` over the control socket to report `connected`.

Teardown kills daemons (and asserts no child agent processes survive — `pgrep -P`), stops the backend, closes finear,
and removes the temp tree. A suite that leaves a process behind fails, like ToolExec's Docker-label check.

### The fake ACP agent

`cli/__tests__/fixtures/fake-acp-agent.ts` ([phase 11](./phase-11-acp-agent-host.md)) speaks real ACP over stdio with
`@agentclientprotocol/sdk`'s agent side and plays a **script** chosen by an env var or by a directive in the prompt
(`[[script:plan-edit-pr]]`), so one binary covers every scenario:

| Script | Emits |
|---|---|
| `plan-edit-pr` | thought chunks; a `plan` of three entries; `tool_call` read → completed; `tool_call` edit (requests permission under `ask`) → writes a file via `fs/write_text_file` → completed; `tool_call` execute `git commit && git push && gh pr create` via `terminal/create` → completed with the PR URL in output; plan updates; message chunks; `end_turn` |
| `slow` | like the above with a 60 s sleep inside a tool call, honouring `session/cancel` |
| `ignore-cancel` | never answers `session/cancel` (forces the kill path) |
| `needs-auth` | `initialize` advertises an auth method; `session/new` fails `-32000` until a marker file exists |
| `ask-choice` | `elicitation/create` form with an enum |
| `manager-dispatch` | calls the MCP tools `linear_create_sub_issue` twice and `hypotenuse_dispatch` twice, then ends; on a review turn, accepts one and requests changes on the other |
| `refuse` | `stopReason: refusal` |
| `crash` | exits 1 mid-turn |

The fake agent uses the real stdio MCP server the daemon hands it (`hypotenuse mcp --session …`) — it connects as an
MCP client — so the manager scenario exercises the real tool proxy end to end.

### Scenarios

Each is one test file under `backend/__tests__/e2e/`, and each asserts on finear's recorded activities (the person's
view), the backend's rows, and the daemon's local state:

| File | Scenario | Key assertions |
|---|---|---|
| `delegate-to-response.test.ts` | delegate an issue → full turn | an acknowledgement `thought` within 10 s of the `created` webhook (measured on finear's clock); the issue moved to the first `started` state; plan set and updated, ending all `completed`; `action` activities with results; an `externalUrls` entry labelled "Pull Request" with the fake `gh` URL; a final `response`; session `complete`; worktree on `hypotenuse/eng-1-…` exists, cleaned per policy |
| `follow-up-sticky.test.ts` | prompt the completed session | the follow-up is claimed by the same runner and runs in the **same worktree** (same path, the earlier file still there); history in the agent's prompt rebuilt from activities |
| `stop-mid-turn.test.ts` | `slow` script; stop during the tool call | `session/cancel` sent; final response mentions the branch; **no activity after it**; work item `cancelled`; with `ignore-cancel`, the agent process is killed after `stop_grace` |
| `permission-select.test.ts` | worker policy `ask`; edit permission | a `select` elicitation with the four ACP options; session `awaitingInput`; prompting `allow_once` resumes and the file is written; a free-text reply instead cancels the permission and is delivered as a prompt |
| `repository-select.test.ts` | two repositories; confidence threshold above finear's suggestion | a `select` elicitation whose values are GitHub URLs; answering one routes to a runner with that repository |
| `auth-elicitation.test.ts` | `needs-auth` | an `auth` elicitation with `providerName` and the runner auth URL; create the marker, prompt "done" → a "continuing" thought and a normal turn |
| `manager-dispatch-review.test.ts` | label `hypotenuse:manager`; `manager-dispatch` | two sub-issues created in finear; two worker sessions whose first thought links the parent; both complete; two review turns on the manager session; one acceptance comment, one change request → a second worker turn on the same branch with the "requested changes" thought; round counters |
| `runner-offline-reassign.test.ts` | two runners; kill the sticky runner; prompt | "waiting for <runner>" thought; after `stickyTimeout` (set by writing the column), the second runner claims with a fresh worktree and history replayed |
| `issuer-preference.test.ts` | Mario's and Luigi's runners both eligible; Luigi delegates | Luigi's runner claims (identity matched by e-mail) |
| `token-revoke.test.ts` | revoke the runner mid-turn | the daemon's next call is 401, it stops the agent and exits its loop (`revoked` frame); the session gets the server's deadline response; the work item is reassigned or expires |
| `webhook-duplicates.test.ts` | finear redelivers (via its retry path) and the harness replays a captured delivery | one session, one work item, one acknowledgement |
| `undelegate.test.ts` | remove the delegate mid-turn | work stops with the disengagement response; no review or keepalive afterwards |
| `daemon-restart-resume.test.ts` | restart the daemon between turns | `session/load` (or `resume`) used for the follow-up; local state survives; no duplicate worktree |
| `refusal-and-crash.test.ts` | `refuse`, then `crash` | each ends in an `error` activity with a readable body; the slot is freed |
| `no-runner.test.ts` | zero runners | acknowledgement, then "waiting for a runner", then an `error` after `queueTimeout` |

Timing: wherever a timeout matters (`stickyTimeout`, `queueTimeout`, `cancelRequestedAt`, lease expiry), the test
writes the column and triggers the clock action (`runAction("work:reap")`) rather than waiting — ToolExec's rule.
The only real-time assertion is the 10-second acknowledgement, because that one *is* about wall time.

### CI

A new job in `.github/workflows/ci.yml`, `E2E Daemon`: Postgres and Redis service containers, `bun install`, `git`
available, then `cd backend && bun test __tests__/e2e`. It is listed in the `complete` gate's `needs`. Expected
duration a few minutes; if it grows past ten, the scenarios are split across a matrix by file.

### Nightly with a real agent

`.github/workflows/nightly-real-agent.yml`, `schedule: cron "17 6 * * *"` plus `workflow_dispatch`, **outside** the
`complete` gate (a nightly is not a check). It runs `delegate-to-response.test.ts` and `stop-mid-turn.test.ts` with
`HYPOTENUSE_E2E_AGENT=claude`, which swaps the fake agent for the `claude` preset
(`npx -y @agentclientprotocol/claude-agent-acp`) with `ANTHROPIC_API_KEY` from repository secrets and a prompt asking
for a one-line change to a fixture README. Assertions are loosened to shape (a plan exists, at least one action, a
response, no error) rather than content. It is skipped when the secret is absent, and opens an issue on failure.

The point is not to test Claude; it is to catch the ACP adapter changing under us — `@agentclientprotocol/sdk` 2.0
removed `ClientSideConnection` the day before this plan was written, and adapter packages were renamed from
`@zed-industries/*` to `@agentclientprotocol/*`. A nightly against the current adapter is where that shows up first.

### Manual release check against real Linear

Recorded as a checklist in [`DEPLOY.md`](../DEPLOY.md), run on staging before announcing a release that touched Linear
handling: install the staging app into a test workspace; delegate an issue; mention the agent in a comment thread
(finear cannot); reply in the session thread (finear cannot); send a stop; dismiss a session; change team access
(PermissionChange); revoke the app (OAuthApp revoked). Each step names the `LINEAR_COVERAGE.md` rows it exercises.

### finear upstream issues

Filed at [pmdroid/finear](https://github.com/pmdroid/finear/issues), each with a minimal reproduction, and linked from
the "Known finear gaps" section of [`LINEAR_COVERAGE.md`](../LINEAR_COVERAGE.md#known-finear-gaps):

1. The standalone server (`bun run start`) cannot register an OAuth client with a webhook, so agent-session webhooks
   need the in-process API.
2. An `@`-mention in a comment body does not create an agent session or send `created`.
3. A human reply in a session's comment thread does not produce `prompted`.
4. `promptContext` is the issue description or title, not Linear's structured `<issue>…<primary-directive-thread>…<guidance>` document.
5. `guidance` is never populated, and there is no way to set workspace or team guidance.
6. `client_credentials` grant unsupported.
7. Advancing the virtual clock stamps `webhookTimestamp` in virtual time, which real verifiers reject beyond ±60 s.
8. Only three workflow states per team (no `unstarted`, `triage`, `canceled` types).
9. `commentUpdate` / `commentDelete` have no resolvers.
10. `AppUserNotification` and `PermissionChange` deliveries are not produced.
11. `select` / `auth` signals are stored without validating `signalMetadata` shape.

Where we can, we offer the fix upstream as a pull request rather than only an issue.

## Steps

### 1. Matrix test — `backend/__tests__/docs/linear-coverage.test.ts`

As designed. Pure file reads; runs in the ordinary backend suite.

### 2. Harness — `backend/__tests__/e2e/harness.ts`, `backend/__tests__/e2e/git.ts`, `backend/__tests__/e2e/fake-gh.sh`

`useE2E`, git fixture, fake `gh`, daemon child management, the activity wait helper polling finear's
`agentSession.activities` (polling is fine in a test helper; it is the product that must not poll).

### 3. Fake agent scripts — `cli/__tests__/fixtures/fake-acp-agent.ts`, `cli/__tests__/fixtures/scripts/*.ts`

The scripts in the table, each a small async function over the SDK's agent-side API.

### 4. Scenarios — `backend/__tests__/e2e/*.test.ts`

The fifteen files above, each tagged with the coverage IDs it proves.

### 5. Signed-webhook injection helper — `backend/__tests__/linear/inject.ts`

`injectWebhook(type, action, body)` signs with the test webhook secret and posts to `/api/webhooks/linear`, for
`covered (finear gap)` rows. Payloads are built from types exported by `@linear/sdk` (`AgentSessionEventWebhookPayload`,
`AppUserNotificationWebhookPayloadWithNotification`, `PermissionChangeWebhookPayload`, …) so a shape we invent fails to
type-check.

### 6. CI — `.github/workflows/ci.yml`, `.github/workflows/nightly-real-agent.yml`

The `E2E Daemon` job in the gate; the nightly outside it. `backend/__tests__/deployment/workflows.test.ts` asserts the
e2e job is in the gate's `needs` and the nightly is not.

### 7. Docs — `docs/LINEAR_COVERAGE.md`, `docs/DEPLOY.md`

Flip every row to its final status with its test path; add the manual release checklist.

### 8. Upstream — finear issues

File, link, and where possible send pull requests.

## Verification

```bash
cd backend && bun test __tests__/docs/linear-coverage.test.ts
cd backend && bun test __tests__/e2e                      # the whole cross-process suite
HYPOTENUSE_E2E_AGENT=claude ANTHROPIC_API_KEY=… bun test __tests__/e2e/delegate-to-response.test.ts
grep -c '| planned |' ../docs/LINEAR_COVERAGE.md          # must print 0
```

## Definition of done

- [ ] `linear-coverage.test.ts` enforces unique IDs, existing test files containing each ID, no `planned` rows
- [ ] `useE2E` harness boots finear, backend, git fixture, fake `gh`, and real daemons; teardown leaves no process
- [ ] Fake ACP agent with all eight scripts
- [ ] All fifteen scenario files green, twice in a row, in CI
- [ ] `E2E Daemon` job in the `complete` gate; nightly real-agent workflow outside it
- [ ] Every finear gap filed upstream and linked; injected-webhook tests for each `covered (finear gap)` row
- [ ] Manual real-Linear release checklist in `DEPLOY.md`
- [ ] Every row in `LINEAR_COVERAGE.md` is `covered`, `covered (finear gap)`, or `not applicable` with a reason

## Learnings from the build

_Nothing yet — this phase has not been built._
