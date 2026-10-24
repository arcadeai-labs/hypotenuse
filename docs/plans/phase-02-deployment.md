# Phase 2 — Deployment

> **Goal:** One `render.yaml` blueprint that deploys the API, a worker, and the frontend — plus Redis and
> Postgres — to a single staging environment, auto-deploying on merge to `main`, with a **public HTTPS
> origin Linear can deliver webhooks to**. A local developer gets the same property through a reserved
> ngrok tunnel, because Linear refuses to deliver to `localhost`.

> **Status: built (not yet deployed).** Nothing is deployed. The blueprint is ToolExec's, renamed and pruned, plus
> the Linear keys and the public webhook URL every later phase assumes.

Hypotenuse's reason for having a hosted half at all is that **Linear webhooks need a public URL**. A daemon on a
laptop cannot receive them, and a tunnel per laptop would mean one Linear app per person. So the hosted
service is the only Linear-facing endpoint, and it has to exist — at a stable hostname — before
[phase 6](./phase-06-linear-connection.md) can register a Linear OAuth app against it. That is why deployment
comes second, before any domain model: the callback URL and the webhook URL are inputs to creating the
Linear app, and changing them later means editing the app in Linear and re-consenting every workspace.

Copy `toolexec/render.yaml` and `toolexec/docs/DEPLOY.md`, rename `toolexec` → `hypotenuse`, and delete the
sandbox, GitHub-App, model-proxy, and Vercel material. Read ToolExec's
[phase 2 learnings](https://github.com/arcadeai-labs/toolexec/blob/main/docs/plans/phase-02-deployment.md#learnings-from-the-build)
first — they record two failures this blueprint must not repeat (an instance type Render accepts and then
silently does not create; `generateValue` minting two different encryption keys).

## Scope

**In:** `render.yaml` with `web` + `worker` + `frontend` + `keyvalue` + `postgres`; the env matrix including
the `LINEAR_*` keys (empty, `sync: false`); migration ownership; health checks; `buildFilter` paths; the
`hypotenuse-shared` env group; public hostnames; the reserved ngrok tunnel for local webhook development;
`backend/__tests__/deployment/render-blueprint.test.ts`; [`docs/DEPLOY.md`](../DEPLOY.md).

**Out:** creating the Linear OAuth app and filling its secrets (the runbook describes it; the code that reads
them is [phase 6](./phase-06-linear-connection.md)). A production environment — staging only until the
phases land. SMTP credentials (declared `sync: false`; read by notifications in
[phase 4](./phase-04-users-tenancy-and-audit.md)). Hosting the CLI — it ships through npm and GitHub Releases
([phase 5](./phase-05-cli-and-distribution.md)), never from Render.

## Design

```
┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
│ hypotenuse-api       │  │ hypotenuse-worker    │  │ hypotenuse-frontend  │
│ api.<domain>         │  │                      │  │ www.<domain>         │
│ type: web            │  │ type: worker         │  │ type: web            │
│ backend/Dockerfile   │  │ backend/Dockerfile   │  │ frontend/Dockerfile  │
│ TASKS        off     │  │ TASKS        on      │  │ nginx :10000         │
│ MIGRATE      off     │  │ MIGRATE      on ◀────┼── owns the schema     │
│ health /api/status   │  │ (no HTTP)            │  │ health /             │
│ POST /api/webhooks/linear  ◀── Linear          │  │                      │
│ ws:// runner + dashboard pings                 │  │                      │
└──────────┬───────────┘  └──────────┬───────────┘  └──────────────────────┘
           └───────────────┬─────────┘
            ┌──────────────▼───────┐  ┌──────────────────────┐
            │ hypotenuse-redis     │  │ hypotenuse-db        │
            │ keyvalue, noeviction │  │ postgres 18          │
            └──────────────────────┘  └──────────────────────┘
```

Three properties carry the weight, all inherited from ToolExec:

- **Web and worker are the same image**, differing only by environment (`WEB_SERVER_ENABLED`,
  `TASKS_ENABLED`, `DATABASE_AUTO_MIGRATE`). Nothing branches on "am I a worker".
- **The worker owns migrations.** Only `hypotenuse-worker` sets `DATABASE_AUTO_MIGRATE=true`.
- **Redis is `noeviction`.** Sessions, the node-resque queues, WebSocket pub/sub, and — from
  [phase 7](./phase-07-webhook-ingress-and-session-mirror.md) — the per-installation Linear token bucket all
  live there. An evicted queue key is a lost webhook; an evicted bucket key is a burst into Linear's rate
  limit. Neither may be silently dropped.

Two properties are specific to Hypotenuse:

- **The webhook endpoint lives on the API service, and the API answers it inside Linear's 5-second budget
  without doing the work.** Verification and one insert happen on the web process; processing is a
  `linear:process-event` task on the worker. That split is why the worker must have task processors and the
  web must not — a web process that ran tasks would compete with webhook ingress for its event loop.
- **Runner daemons hold long-lived WebSockets to the API service.** The blueprint test asserts nothing in
  Render's config caps request duration below a heartbeat interval, and DEPLOY.md notes that a deploy drains
  sockets with close code 1001, which the daemon treats as "reconnect", not "fail"
  ([phase 10](./phase-10-daemon-and-config.md)).

## Steps

### 1. `render.yaml` — services and plans

| Service | Type | Plan | Dockerfile | Health check | `buildFilter.paths` |
|---|---|---|---|---|---|
| `hypotenuse-api` | `web` | `1c-2g` | `backend/Dockerfile`, context `.` | `/api/status` | `backend/**`, `protocol/**`, `bun.lock`, `package.json` |
| `hypotenuse-worker` | `worker` | `1c-2g` | same | — | same |
| `hypotenuse-frontend` | `web` | `starter` | `frontend/Dockerfile`, context `.` | `/` | `frontend/**`, `backend/**`, `protocol/**`, `bun.lock`, `package.json` |
| `hypotenuse-redis` | `keyvalue` | `starter` | — | — | `maxmemoryPolicy: noeviction` |
| `hypotenuse-db` | `postgres` | `basic-256mb` | — | — | `postgresMajorVersion: "18"` |

Use **spec-based plan ids**, never marketing names. The frontend rebuilds on `backend/**` and `protocol/**`
because its type checking resolves them. `cli/**` triggers nothing on Render.

Public hostnames are declared as `domains:` on the two web services, not only in the dashboard:
`api.<domain>` on `hypotenuse-api`, `www.<domain>` (and the apex, for the redirect only) on
`hypotenuse-frontend`. The concrete domain is chosen at first deploy and written into the blueprint and the
test in the same commit.

### 2. Env matrix

| Key | api | worker | Source |
|---|---|---|---|
| `DATABASE_URL` | ✓ | ✓ | `fromDatabase: hypotenuse-db` |
| `REDIS_URL` | ✓ | ✓ | `fromService: hypotenuse-redis` |
| `NODE_ENV` | `production` | `production` | `hypotenuse-shared` |
| `PROCESS_NAME` | `hypotenuse-api` | `hypotenuse-worker` | literal |
| `OTEL_SERVICE_NAME` | `hypotenuse-api` | `hypotenuse-worker` | literal — Sentry's `serverName` |
| `WEB_SERVER_ENABLED` | (default) | `false` | literal |
| `WEB_SERVER_HOST` / `WEB_SERVER_PORT` | `0.0.0.0` / `10000` | — | literal |
| `WEB_SERVER_API_ROUTE` | `/api` | — | literal |
| `WEB_SERVER_ALLOWED_ORIGINS` | `https://www.<domain>` | — | literal |
| `APPLICATION_URL` | `https://api.<domain>` | `https://api.<domain>` | literal — the OAuth issuer, the Linear callback base, and the URL the worker writes into Linear `externalUrls` |
| `FRONTEND_URL` | — | — | `hypotenuse-shared` — the worker sends mail and writes dashboard links |
| `SESSION_COOKIE_SECURE` / `SESSION_COOKIE_SAME_SITE` | `true` / `None` | — | literal — cross-origin frontend |
| `MCP_SERVER_ENABLED` | `true` | — | literal |
| `MCP_OAUTH_TRUST_PROXY` | **`true`** | — | literal — otherwise the issuer resolves to Render's internal origin and the CLI's OAuth login breaks |
| `DATABASE_AUTO_MIGRATE` | `false` | **`true`** | literal |
| `TASKS_ENABLED` / `TASK_PROCESSORS` | `false` / `0` | `true` / `1` | literal |
| `SECRETS_ENCRYPTION_KEY` | ✓ | ✓ | `hypotenuse-shared`, `generateValue: true` **exactly once** — encrypts Linear tokens |
| `LINEAR_CLIENT_ID` / `LINEAR_CLIENT_SECRET` / `LINEAR_WEBHOOK_SECRET` | ✓ | ✓ | `hypotenuse-shared`, added in the dashboard (see below) |
| `LINEAR_API_URL` / `LINEAR_OAUTH_URL` | — | — | not set in production (defaults `https://api.linear.app` / `https://linear.app`); tests point them at finear |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_FROM` | ✓ | ✓ | `hypotenuse-shared`, dashboard |
| `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE=0`, `SENTRY_ENABLE_METRICS=false`, `SENTRY_ENABLE_LOGS=false` | ✓ | ✓ | `hypotenuse-shared` literals — errors only, as ToolExec |
| `LOG_LEVEL` / `LOG_FORMAT` | `info` / `json` | same | `hypotenuse-shared` |

Frontend: `VITE_API_URL=https://api.<domain>` as a build argument.

**Dashboard-only secrets go on the env group, not on services.** ToolExec learned that Render ignores
`sync: false` inside an `envVarGroup`, and ignores it on a service during Blueprint *updates*. So the
`LINEAR_*` and `SMTP_*` keys are not declared `sync: false` anywhere; they are added once to
`hypotenuse-shared` in the dashboard, and both backend services pull `fromGroup: hypotenuse-shared`, which
preserves keys a sync does not mention. The blueprint test asserts that no `LINEAR_*` key appears in
`render.yaml` with a `value:` — a secret in a committed file is the failure this prevents.

`SECRETS_ENCRYPTION_KEY` must be identical on api and worker: the api writes encrypted Linear tokens during
the OAuth callback and the worker decrypts them on every `activities:deliver` tick. Declared once in the
group, never per service.

### 3. The webhook URL is a fixed, documented constant

Linear's app settings take one webhook URL per OAuth app, and it must be HTTPS, non-loopback, and not a
private address. For staging it is:

```
https://api.<domain>/api/webhooks/linear
```

and the OAuth callback is `https://api.<domain>/api/linear/callback`. Both are derived from `APPLICATION_URL`
in code (`linearWebhookUrl()` / `linearCallbackUrl()` in `backend/ops/LinearOps.ts`,
[phase 6](./phase-06-linear-connection.md)) and printed by `GET /api/status` under `linear.webhookUrl` so an
operator can paste them into Linear without guessing. Changing the API hostname is therefore a three-place
change — Render, Linear's app settings, and every connected workspace's consent if the callback moved — and
[`DEPLOY.md`](../DEPLOY.md) says so.

### 4. Local webhook development — `bun run ngrok`, `ngrok.yml`, `frontend/devTunnel.ts`

Linear will not deliver to `http://localhost:8080`. Copy ToolExec's reserved-tunnel setup:

- `ngrok.yml` — two reserved `.ngrok.app` domains, one for the backend and one for the frontend.
- `backend/scripts/start-ngrok.ts` — starts both and prints the backend's webhook and callback URLs.
- `frontend/devTunnel.ts` — makes Vite accept the tunnel host.

A developer creates **their own** Linear OAuth app for development, pointed at their tunnel (the manifest
link in DEPLOY.md pre-fills it), and puts its credentials in `backend/.env`. Tests never need any of this:
finear runs in-process and delivers to the test server's loopback URL directly.

### 5. Blueprint invariants — `backend/__tests__/deployment/render-blueprint.test.ts`

Port ToolExec's test (it parses the real `render.yaml` with `Bun.YAML.parse`) and assert:

- exactly five resources with the names above, and the plan ids are members of a `COMPUTE_PLANS` enum of ids
  Render actually has; Postgres major is `18`;
- **exactly one** service sets `DATABASE_AUTO_MIGRATE=true`, and it is the worker;
- only the worker has `TASKS_ENABLED=true` and `TASK_PROCESSORS>0`; the api has `TASK_PROCESSORS=0`;
- `SECRETS_ENCRYPTION_KEY` is declared once, in `hypotenuse-shared`, and both backend services pull the group;
- no key starting `LINEAR_`, `SMTP_PASSWORD`, or `SENTRY_AUTH` has a literal `value:`;
- `APPLICATION_URL` and `WEB_SERVER_ALLOWED_ORIGINS` are `https://` and each matches a `domains:` entry on the
  service that answers on it; nothing names the apex;
- `hypotenuse-redis` is `noeviction`;
- every service's `buildFilter.paths` covers `protocol/**` where it compiles it;
- the port the Dockerfiles `EXPOSE` matches `WEB_SERVER_PORT`.

### 6. `docs/DEPLOY.md`

The runbook: topology, a local rehearsal that boots the real image with the blueprint's own env, first deploy,
creating the Linear app, verification, rollback, and secret rotation. Written in this phase as a live document
(rule 14), saying plainly that nothing is deployed until it is.

## Verification

```bash
cd backend && bun test __tests__/deployment
docker build -f backend/Dockerfile .
docker build -f frontend/Dockerfile --build-arg VITE_API_URL=https://example.invalid .

# after the blueprint deploys
curl -s https://api.<domain>/api/status | jq '{healthy, checks, linear}'
curl -s https://api.<domain>/.well-known/oauth-authorization-server | jq -r .issuer   # the public origin
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://api.<domain>/api/webhooks/linear   # route exists (refusal once phase 7 lands)
```

- Worker logs show migrations applied and `resque:worker:0 started`; api logs show neither.
- `/api/status` answers 200 with healthy database and Redis, and reports the webhook and callback URLs.
- The OAuth discovery `issuer` is `https://api.<domain>`, not an internal origin.
- The frontend loads over HTTPS and reaches the API with the session cookie (`Secure`, `SameSite=None`).
- Touching only `cli/**` triggers no Render deploy.

## Definition of done

- [x] `render.yaml` defines `hypotenuse-api`, `hypotenuse-worker`, `hypotenuse-frontend`, `hypotenuse-redis`, `hypotenuse-db`
- [x] Api and worker share `backend/Dockerfile`; only the worker migrates and runs tasks
- [x] `hypotenuse-shared` holds `SECRETS_ENCRYPTION_KEY` (generated once), `NODE_ENV`, and logging (no Sentry yet — see learnings)
- [x] `LINEAR_*` and `SMTP_*` live on the env group via the dashboard; none appears with a value in the file
- [x] `MCP_OAUTH_TRUST_PROXY=true`
- [x] Public hostnames declared as `domains:`; webhook and callback URLs derived from `APPLICATION_URL` and shown on `/api/status`
- [x] Reserved ngrok tunnel for local webhook development (ported with the foundation)
- [x] `render-blueprint.test.ts` asserts every invariant above
- [x] `docs/DEPLOY.md` covers rehearsal, first deploy, the Linear app, rollback, and rotation
- [ ] Staging deploys automatically on merge to `main` — needs the Render Blueprint created by someone with Render access

## Learnings from the build

### What is built, and what only a person with Render access can do

The blueprint, its invariant test, and the Linear URL reporting are built and tested. **Nothing is deployed**: creating
the Render Blueprint, attaching DNS, and adding the dashboard-only secrets need a Render account, which an agent
session does not have. `docs/DEPLOY.md` is the checklist for whoever does it first, and the unticked Definition of done
item above is that step.

### The domain

The project owns `hypotenuse.cloud`: `www.hypotenuse.cloud` is the frontend, `api.hypotenuse.cloud` the backend, and
the apex is attached only so Render redirects it to `www`. The blueprint test does **not** hard-code the domain: it
derives the expected hosts from `APPLICATION_URL` and `WEB_SERVER_ALLOWED_ORIGINS` and checks each is attached as a
`domains:` entry on the service that answers it, so a future domain change is an edit to `render.yaml` alone. The
example URLs across the docs (`api.hypotenuse.cloud` in configs, `www.hypotenuse.cloud` for dashboard links and the
config JSON Schema) use the same two hosts.

### nginx must never redirect, and `public/` must never shadow a route

The SPA fallback was `try_files $uri $uri/ /index.html`, and `public/docs/illustrations/` made `/docs` a real
directory in the image. A reload of `/docs` matched it through `$uri/`, and nginx answered its own trailing-slash 301
— absolute, built from the port it listens on — to `http://www.hypotenuse.cloud:10000/docs/`, which Render does not
expose; `/docs/` itself was a 403 for want of an `index.html`. In-app navigation never asked nginx, so only a reload
or a shared link broke. The fix is both halves: `absolute_redirect off` with `try_files $uri /index.html`, and the
illustrations moved to `public/doc-assets/`. `frontend/src/__tests__/nginx.test.ts` holds the directives and
asserts no top-level entry in `public/` is a route segment in `App.tsx`; `DEPLOY.md` has the `curl` rehearsal.

### Decisions that differ from the plan's table

- **`APPLICATION_URL` is set on the worker too**, not only the API. The worker writes dashboard and session links into
  Linear (`externalUrls`), and Keryx's default is `http://localhost:8080` — the ToolExec failure mode where a worker
  quietly wrote unreachable URLs. The test asserts both backends carry the same `https://` origin.
- **No Sentry keys yet.** ToolExec's blueprint commits a Sentry DSN for `@keryxjs/sentry`; Hypotenuse does not depend
  on that plugin yet, so the keys would configure nothing. They arrive with the plugin.
- **`SMTP_*` are not declared `sync: false` in the group.** Render ignores `sync: false` inside an `envVarGroup`, so
  ToolExec's declarations there were decorative. They are listed in a comment instead and set in the dashboard.

### `/api/status` reports the Linear URLs

`linear.webhookUrl` and `linear.callbackUrl` come from `ops/LinearOps.ts` (`linearWebhookUrl()`,
`linearCallbackUrl()`), derived from `config.server.web.applicationUrl` plus the API route, and `linear.configured`
says whether the three `LINEAR_*` secrets are present. They are reported, never part of `healthy`: a deployment
without a Linear app yet is still a healthy server. `config/linear.ts` is the `linear` config namespace the
connection phase reads.

### A config augmentation must travel with its readers

`config/linear.ts` declares `config.linear` by augmenting Keryx's `KeryxConfig`. The frontend type-checks
`actions/status.ts` through the `@backend/*` alias and reaches `ops/LinearOps.ts`, but not `config/index.ts` — so
`config.linear` did not exist in that program and `tsc -b` failed. Every ops file that reads an app config namespace
carries `import type {} from "../config/<namespace>"`, which costs nothing at runtime and brings the augmentation
along wherever the file is type-checked.

### The ToolExec blueprint test was not ported wholesale

ToolExec's is 800+ lines, most of it about sandboxes, GitHub App keys, and proxies Hypotenuse does not have. The port
keeps its strict Zod schema of the blueprint subset (so a typo'd key fails to parse) and the `COMPUTE_PLANS` enum (the
`starter plus` trap), and asserts only the invariants this plan lists.
