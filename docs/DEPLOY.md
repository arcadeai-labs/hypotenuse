# Deploying Hypotenuse

> **This runbook describes the intended deployment. Nothing is deployed yet.** It is a live document
> (rule 14 in [`AGENTS.md`](../AGENTS.md)): the first person to deploy corrects whatever turns out to be wrong,
> in the same commit as the fix. The reasoning behind the blueprint is in
> [`plans/phase-02-deployment.md`](./plans/phase-02-deployment.md).

One `render.yaml` blueprint, one **staging** environment, auto-deployed on merge to `main`. A production
blueprint comes once the phases land. The `hypotenuse` CLI and daemon are **not** deployed here — they ship
through npm and GitHub Releases ([`plans/phase-05-cli-and-distribution.md`](./plans/phase-05-cli-and-distribution.md)).

## Topology

```
┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
│ hypotenuse-api       │  │ hypotenuse-worker    │  │ hypotenuse-frontend  │
│ api.hypotenuse.cloud         │  │                      │  │ www.hypotenuse.cloud         │
│ type: web, 1c-2g     │  │ type: worker, 1c-2g  │  │ type: web, starter   │
│ TASKS       off      │  │ TASKS       on       │  │ nginx :10000         │
│ MIGRATE     off      │  │ MIGRATE     on ◀─────┼── owns the schema     │
│ health /api/status   │  │ (no HTTP)            │  │ health /             │
└──────────┬───────────┘  └──────────┬───────────┘  └──────────────────────┘
           └───────────────┬─────────┘
            ┌──────────────▼───────┐  ┌──────────────────────┐
            │ hypotenuse-redis     │  │ hypotenuse-db        │
            │ keyvalue, noeviction │  │ postgres 18          │
            └──────────────────────┘  └──────────────────────┘
```

- **Web and worker are the same image**, differing only by `WEB_SERVER_ENABLED`, `TASKS_ENABLED`, and
  `DATABASE_AUTO_MIGRATE`.
- **The worker owns migrations.** Only `hypotenuse-worker` sets `DATABASE_AUTO_MIGRATE=true`.
- **Linear talks only to `hypotenuse-api`**: webhooks arrive at `https://api.hypotenuse.cloud/api/webhooks/linear`, and
  the OAuth callback is `https://api.hypotenuse.cloud/api/linear/callback`. Both are derived from `APPLICATION_URL` and
  printed by `GET /api/status` under `linear`.
- **Runner daemons hold WebSockets to `hypotenuse-api`.** A deploy drains them with close code 1001; daemons
  reconnect, and their HTTP heartbeat covers the gap.

Structural invariants are asserted by `backend/__tests__/deployment/render-blueprint.test.ts`, which parses the
real file. If you change `render.yaml`, run `cd backend && bun test __tests__/deployment`.

## Environment

All shared values live on the **`hypotenuse-shared`** env group, which both backend services pull with
`fromGroup`. Secrets are added to the group **in the dashboard**, never in `render.yaml`: Render ignores
`sync: false` inside an env group, and ignores it on a service during Blueprint updates.

| Key | Where | Notes |
|---|---|---|
| `SECRETS_ENCRYPTION_KEY` | group, `generateValue: true` once | AES-256-GCM key for stored Linear tokens. Must be identical on api and worker. Never rotate without a re-encryption migration |
| `LINEAR_CLIENT_ID` | group, dashboard | **required — api and worker refuse to boot without it**; from the Linear OAuth app |
| `LINEAR_CLIENT_SECRET` | group, dashboard | **required**; from the Linear OAuth app |
| `LINEAR_WEBHOOK_SECRET` | group, dashboard | **required**; the app's webhook signing secret |
| `LINEAR_WEBHOOK_SECRET_PREVIOUS` | group, dashboard | only while rotating the webhook secret (below); unset otherwise |
| `LINEAR_WEBHOOK_IP_ALLOWLIST`, `LINEAR_WEBHOOK_TRUST_FORWARDED` | api, dashboard | optional; off by default. Comma-separated addresses or IPv4 CIDRs Linear delivers from (Linear publishes them); others get the unverified 401. Behind Render's proxy set `LINEAR_WEBHOOK_TRUST_FORWARDED=true`, so the sender is the last `X-Forwarded-For` hop Render appended — and keep the list current, or every delivery is refused |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | group, dashboard | optional; without `SMTP_HOST`, mail is logged, not sent |
| `FRONTEND_URL` | group | `https://www.hypotenuse.cloud` — the worker writes it into e-mail, Linear `externalUrls`, and the runner auth pages `auth` prompts link; the api answers it as `/api/status` `dashboardUrl`, which `hypotenuse login` opens, and as the device flow's `/cli/activate` URL |
| `NODE_ENV`, `LOG_LEVEL`, `LOG_FORMAT` | group | `production`, `info`, `json` |
| `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE=0`, `SENTRY_ENABLE_METRICS=false`, `SENTRY_ENABLE_LOGS=false` | group | errors only |
| `APPLICATION_URL` | api + worker | `https://api.hypotenuse.cloud` |
| `WEB_SERVER_ALLOWED_ORIGINS` | api | `https://www.hypotenuse.cloud` |
| `SESSION_COOKIE_SECURE` / `SESSION_COOKIE_SAME_SITE` | api | `true` / `None` |
| `MCP_OAUTH_TRUST_PROXY` | api | `true` — otherwise the OAuth issuer is Render's internal origin and human MCP clients cannot sign in |
| `DATABASE_AUTO_MIGRATE` | api `false`, worker `true` | |
| `TASKS_ENABLED` / `TASK_PROCESSORS` | api `false`/`0`, worker `true`/`1` | |
| `PROCESS_NAME`, `OTEL_SERVICE_NAME` | per service | `hypotenuse-api` / `hypotenuse-worker` |
| `VITE_API_URL` | frontend build arg | `https://api.hypotenuse.cloud` |

The telemetry relay's keys are not set in production either. `TELEMETRY_ALLOW_PRIVATE_ENDPOINTS` must stay unset
(`false`): exporter endpoints are tenant-chosen URLs the worker POSTs to from inside Render's network, so only public
`https` hosts are allowed, re-resolved before every export. `TELEMETRY_LATE_WINDOW` (5 minutes) is how long a
finished turn's telemetry is still accepted; `TELEMETRY_PROJECT_BYTES_PER_SECOND` (1 MiB/s, bursting to
`TELEMETRY_PROJECT_BURST_BYTES`, 16 MiB) is each project's ingress budget. Telemetry waits in Redis for at most an
hour (`TELEMETRY_STREAM_TTL_MS`); `redis-cli XLEN telemetry:stream:<projectId>` shows how much.

`LINEAR_API_URL` and `LINEAR_OAUTH_URL` are **not** set in production; they default to `https://api.linear.app`
and `https://linear.app`, and exist so tests can point the server at finear. The webhook and outbox tuning keys
in `backend/.env.example` (`LINEAR_WEBHOOK_MAX_BODY_BYTES`, `LINEAR_WEBHOOK_TOLERANCE_MS`,
`LINEAR_EVENT_RETENTION_DAYS`, `LINEAR_REQUESTS_PER_HOUR`, `LINEAR_BUCKET_BURST`, `LINEAR_BUCKET_RESERVE`,
`LINEAR_DELIVER_MAX_ATTEMPTS`, and the agent tools' waits on that budget, `LINEAR_TOOL_READ_WAIT_MS` and
`LINEAR_TOOL_WRITE_WAIT_MS`) are not set either; their defaults are Linear's documented limits.
`LINEAR_REQUESTS_PER_HOUR` is the one to raise if Linear grants a workspace a higher limit.

## Rehearse locally

Both `docker build` CI jobs prove the images build, not that the blueprint's environment is right. Run the real
image with the blueprint's own literal env against local Postgres and Redis (ToolExec's recipe, renamed):

```bash
docker build -f backend/Dockerfile .
docker build -f frontend/Dockerfile --build-arg VITE_API_URL=https://example.invalid .

role=hypotenuse-api   # or hypotenuse-worker
bun -e '
const bp = Bun.YAML.parse(await Bun.file("render.yaml").text());
const group = Object.fromEntries(bp.envVarGroups[0].envVars.filter(e => "value" in e).map(e => [e.key, e.value]));
const svc = bp.services.find(s => s.name === process.env.role);
const own = Object.fromEntries(svc.envVars.filter(e => "value" in e).map(e => [e.key, e.value]));
console.log(Object.entries({...group, ...own}).map(([k, v]) => `-e ${k}=${JSON.stringify(v)}`).join(" "));
' > /tmp/env.txt

IMG=$(docker build -q -f backend/Dockerfile .)
CID=$(eval docker run -d -p 18081:10000 $(cat /tmp/env.txt) \
  -e SECRETS_ENCRYPTION_KEY=$(openssl rand -base64 32) \
  -e DATABASE_URL="postgres://$(whoami)@host.docker.internal:5432/hypotenuse" \
  -e REDIS_URL="redis://host.docker.internal:6379/0" $IMG)
curl -s http://localhost:18081/api/status | jq -c '{healthy, checks, linear}'
docker logs $CID 2>&1 | grep -iE "migrat|resque|app server"
docker rm -f $CID
```

| Role | Expected |
|---|---|
| `hypotenuse-api` | `/api/status` healthy; OAuth issuer is the public origin; **no** migration lines; **no** `resque:worker` lines |
| `hypotenuse-worker` | `database migrated successfully`; `resque:worker:0 started`; nothing listening on HTTP |

The frontend is nginx serving the Vite build on `:10000` (`frontend/nginx.conf`), and every path that is not a real
file answers `index.html`, so a reload of any client route works. Render forwards to a port the outside cannot
reach, so the config sets `absolute_redirect off` and drops `$uri/` from `try_files`: nginx's own trailing-slash 301
once sent `/docs` to `http://www.hypotenuse.cloud:10000/docs/`. Static files the docs use live under
`public/doc-assets/`, and nothing in `public/` may share a name with a top-level route
(`frontend/src/__tests__/nginx.test.ts`). To check it:

```bash
CID=$(docker run -d -p 18080:10000 $(docker build -q -f frontend/Dockerfile --build-arg VITE_API_URL=https://example.invalid .))
for u in /docs /docs/ /docs/config /doc-assets/illustrations/home-light.png /social.png; do
  curl -s -o /dev/null -w "%{http_code} %{content_type} $u\n" http://localhost:18080$u
done   # every line 200; the routes text/html, the files their own type
docker rm -f $CID
```

## Create the Linear OAuth app

Hypotenuse is **one Linear OAuth application per deployment**, installed into each Linear workspace with
`actor=app`. Create it once per environment (staging, and later production), and one more per developer for
local work pointed at their ngrok tunnel.

The quickest way is Linear's app manifest link, which pre-fills the creation form with a JSON manifest that
validates against Linear's published schema. The deployment prints its own, with the callback and webhook URLs
derived from `APPLICATION_URL`:

```bash
cd backend
APPLICATION_URL=https://api.hypotenuse.cloud FRONTEND_URL=https://www.hypotenuse.cloud \
  bun keryx.ts linear:manifest-url                      # --name "Hypotenuse Staging" for a second app
```

It answers `{ url, manifest }`; open `url`. It refuses a name containing "Linear" (Linear would), and refuses a
webhook URL that is not public HTTPS — loopback, private-network, and `linear.app` hosts included — so locally it
needs the tunnel's URL (below). The manifest sets:

- `oauth.client_name` — "Hypotenuse" unless `--name` says otherwise; `oauth.client_uri` — the dashboard;
- `oauth.redirect_uris` — `${APPLICATION_URL}/api/linear/callback`; `oauth.grant_types` — `authorization_code` only;
- `webhook.url` — `${APPLICATION_URL}/api/webhooks/linear`, with `AgentSessionEvent`, `AppUserNotification`,
  `PermissionChange`, `Issue`, and `Comment`;
- `distribution` — `public`, so any Linear workspace can install it: every project connects its own workspace to
  this one app. Public is not listed — the app appears in Linear's integration directory only if you submit it.

The command runs without the three Linear secrets, so it works before the app exists. **The api and worker do
not**: in production they refuse to boot until `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, and
`LINEAR_WEBHOOK_SECRET` are all set, because a deployment without them looks healthy until somebody tries Linear.

Then, in the app's settings:

1. Confirm **Agent session events**, **Inbox notifications**, and **Permission changes** are enabled, and enable
   **OAuth app revoked** if it is offered as a separate toggle (it is not in the manifest's resource-type enum).
   **Enabling agent session events turns on the agent-session UI for every workspace that installs the app.**
   Upload [`design/app-icon.png`](../design/app-icon.png) as the icon here too; the manifest carries none.
2. The name and icon are how `@hypotenuse` appears in Linear's mention, assignee, and filter menus. If the name
   collides with a workspace member, Linear appends a number.
3. Copy the **client ID**, **client secret**, and **webhook signing secret** into `hypotenuse-shared` as
   `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET`, then restart both backend services.
4. `client_credentials` stays **off**. Hypotenuse uses per-workspace `actor=app` tokens with refresh; it never
   needs an app-wide 30-day token (see [`LINEAR_COVERAGE.md`](./LINEAR_COVERAGE.md)).

The scopes are requested at install time, not configured on the app:
`read,write,app:assignable,app:mentionable,issues:create,comments:create`. `admin` cannot be combined with
`actor=app`, and Hypotenuse never asks for it. Installing requires a **Linear workspace admin**, who also chooses
which teams the agent can access.

An app created from an older manifest is `private`, and only the workspace that created it can install it —
another project's Connect fails at Linear's consent screen. Turn on **Public** in the app's settings; nothing in
the deployment changes. Listing Hypotenuse in Linear's integration directory is a separate submission.

## First deploy

1. **Merge to `main`** once **CI Complete** is green.
2. **Create the Blueprint**: Render dashboard → *New* → *Blueprint* → this repository. Apply all five resources
   and the `hypotenuse-shared` group.
3. **Point DNS at Render.** The project owns `hypotenuse.cloud`: `api.hypotenuse.cloud` is the backend,
   `www.hypotenuse.cloud` the frontend, and the apex is attached only to redirect to `www`. `render.yaml` already
   declares all three; add the DNS records the Render dashboard names for each and wait for their certificates.
4. **Create the Linear OAuth app** (above) and add its three secrets to `hypotenuse-shared`. Until they are there
   the api and worker fail their boot by design, so redeploy both once they are.
5. **The CLI's first npm release is by hand**, because npm accepts a trusted publisher only for a package that
   already exists. Merging the version bump runs `auto-release.yml`: CI passes, the draft `v<version>` release is
   created with its six binaries, and `publish-npm` fails. Then:
   1. publish from the merge commit — `git checkout main && git pull && cd cli && npm publish --access public`
      (`prepack` builds `dist/hypotenuse.js`, so Bun must be on `PATH`; `--provenance` works only inside Actions);
   2. on npmjs.com, add a trusted publisher for `@arcadeai/hypotenuse` pointing at `arcadeai-labs/hypotenuse` and
      `.github/workflows/auto-release.yml` — the repository field is `hypotenuse`, not the organization again. A
      publisher that names the wrong repository is not refused by name: every publish fails `ENEEDAUTH`, and npm
      shows it "Pending validation" until one succeeds;
   3. **re-run the failed jobs of that same workflow run.** `publish-npm` finds the version on npm and skips, and
      `finalize` un-drafts the release. A run from a later commit instead refuses, because npm's copy was built from
      the draft's commit — bump the version, or un-draft by hand.

   Every later version bump publishes npm and the binaries by itself, with provenance. `--provenance` requires
   the repository to be public; if it is ever private, drop the flag.
6. Confirm the worker's logs show migrations applied **before** the api reports healthy.

## Verify

```bash
curl -s https://api.hypotenuse.cloud/api/status | jq '{healthy, checks, linear, dashboardUrl}'
curl -s https://api.hypotenuse.cloud/.well-known/oauth-authorization-server | jq -r .issuer    # https://api.hypotenuse.cloud
# an unsigned webhook must be refused, and refused identically to a bad signature
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://api.hypotenuse.cloud/api/webhooks/linear -d '{}'
```

Then, in the browser: sign up → Settings → **Integrations** → **Linear** → *Connect* → approve as a Linear workspace admin →
the connection shows the workspace name and the teams granted. In Linear, delegate a test issue to
`@hypotenuse`: within ten seconds the agent session shows an acknowledgement thought, and — with no runner
registered — ends with an error saying no runner is available. That one round trip proves the webhook URL, the
signing secret, token storage and decryption across api and worker, and the activity outbox.

Finally: `hypotenuse login --url https://api.hypotenuse.cloud` completes in a browser, and `hypotenuse whoami` answers.

## Release check against real Linear

CI drives every Linear interaction through finear, which cannot produce a few of Linear's own behaviours
([known finear gaps](./LINEAR_COVERAGE.md#known-finear-gaps)). Before announcing a release that touched Linear
handling, run this on staging, with staging's own Linear app installed into a test workspace and one runner
registered on a machine with a coding agent. Each step names the [coverage rows](./LINEAR_COVERAGE.md) it
exercises; a step that fails is a release blocker and a missing test.

| # | Do | Expect | Rows |
|---|---|---|---|
| 1 | Connect the workspace as a workspace admin, granting one team | the integration shows the workspace and that team | LC-OAUTH-01, LC-OAUTH-02, LC-OAUTH-03 |
| 2 | Try the same as a non-admin member | Linear refuses; the dashboard says why | LC-OAUTH-03 |
| 3 | Delegate a backlog issue to `@hypotenuse` | a thought within 10 s; the issue moves to the team's first started state; the delegate is set and the assignee untouched; a plan, actions, a pull request link, and a response | LC-SES-01, LC-WH-12, LC-BP-01, LC-DEL-01, LC-DEL-02, LC-SES-12, LC-SES-16 |
| 4 | Mention `@hypotenuse` in a comment on another issue | a session starts from the comment, with the thread's earlier comments in its context | LC-SES-01, LC-WH-16, LC-CTX-03 |
| 5 | Set workspace and team guidance in Linear, then delegate | the turn's prompt carries the structured `promptContext` and the team's guidance before the workspace's | LC-CTX-01, LC-CTX-02, LC-CTX-05 |
| 6 | Reply in a session's thread | a `prompted` follow-up on the same runner | LC-WH-13, LC-BP-10 |
| 7 | Press Stop during a turn | the turn halts; a final response says where it stopped; nothing follows it | LC-SIG-01, LC-BP-11 |
| 8 | Dismiss a session | the turn is cancelled silently; nothing re-engages until a new prompt | LC-SES-20 |
| 9 | Change the app's team access in Settings → AI & Agents | the integration's teams update; live sessions on a removed team are cancelled | LC-WH-20, LC-OAUTH-25 |
| 10 | Label an issue `hypotenuse:manager` and let it dispatch two sub-issues | each worker session opens by linking the planning issue; when a worker finishes, its review turn shows on the manager's already-complete session ("Reviewing ENG-n…"), and a requested change shows on the worker's. If Linear refuses these activities, the review loop is a product bug, not a finear gap | LC-SES-08, LC-SES-11 |
| 11 | Revoke the app from the workspace | the integration shows disconnected; no further calls to Linear | LC-WH-21 |

## Rollback

Render's *Rollback to this deploy* on the failing service. Because the worker owns migrations, a rollback that
needs a schema revert requires a **new forward migration**, never an edit to an applied one. Roll back the
worker last: an older api against a newer schema is safe when migrations are additive, which is the convention.

The CLI is rolled back by publishing a higher version that reverts the change; npm and GitHub Releases are never
edited after the fact, because `hypotenuse upgrade` trusts npm's `latest`.

## Rotating secrets

| Secret | How | Effect |
|---|---|---|
| `LINEAR_WEBHOOK_SECRET` | copy the current value into `LINEAR_WEBHOOK_SECRET_PREVIOUS`; rotate in Linear app settings; paste the new one into `LINEAR_WEBHOOK_SECRET`; restart api; a day later, delete `LINEAR_WEBHOOK_SECRET_PREVIOUS` and restart | **Rotation is immediate in Linear.** While both are set, a delivery signed with either verifies, so nothing in flight is refused. Without the overlap, deliveries between the rotation and the restart fail verification and are retried by Linear (1 min, 1 h, 6 h) |
| `LINEAR_CLIENT_SECRET` | Linear app settings → rotate secret; paste; restart api and worker | Existing per-workspace access and refresh tokens keep working; only the next refresh and new installs use the new secret |
| `SECRETS_ENCRYPTION_KEY` | do not, without a re-encryption migration | Every stored Linear token becomes undecryptable; every workspace would have to reconnect |
| A runner token | `hypotenuse runner revoke <id>` or Settings → Runners | That daemon is disconnected at once; register again to replace it |

## Local development against real Linear

Linear will not deliver webhooks to `localhost`. Use the reserved tunnel:

```bash
bun run ngrok          # prints https://<you>-api.ngrok.app/api/webhooks/linear and …/api/linear/callback
```

Create a personal development Linear app from `APPLICATION_URL=https://<you>-api.ngrok.app bun keryx.ts
linear:manifest-url` (in `backend/`), and put its three secrets in `backend/.env`. Tests never need this: finear runs
in-process with a test OAuth client (the `LINEAR_*_TEST` values in `.env.example`) and delivers to the test server
directly.
