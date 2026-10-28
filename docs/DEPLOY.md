# Deploying Hypotenuse

> **Nothing is deployed yet.** This runbook describes the intended deployment. It is a live document (rule 14 in
> [`AGENTS.md`](../AGENTS.md)): the first person to deploy corrects whatever turns out to be wrong, in the same
> commit as the fix. The reasoning behind the blueprint is in
> [`plans/phase-02-deployment.md`](./plans/phase-02-deployment.md).

One `render.yaml` blueprint, one **staging** environment, auto-deployed on merge to `main`. Production comes later.
The `hypotenuse` CLI is not deployed here; it ships through npm and GitHub Releases.

## Topology

```
┌──────────────────────────┐  ┌──────────────────────────┐  ┌──────────────────────┐
│ hypotenuse-api           │  │ hypotenuse-worker        │  │ hypotenuse-frontend  │
│ api.hypotenuse.cloud     │  │ type: worker, 1c-2g      │  │ www.hypotenuse.cloud │
│ type: web, 1c-2g         │  │ TASKS on (4 processors)  │  │ type: web, starter   │
│ TASKS off, MIGRATE off   │  │ MIGRATE on ◀── owns the  │  │ nginx :10000         │
│ health /api/status       │  │   schema; no HTTP        │  │ health /             │
└────────────┬─────────────┘  └────────────┬─────────────┘  └──────────────────────┘
             └──────────────┬──────────────┘
          ┌─────────────────▼───┐   ┌────────────────────────────┐
          │ hypotenuse-redis    │   │ hypotenuse-db              │
          │ keyvalue, noeviction│   │ postgres 18 + `vector`     │
          └─────────────────────┘   └────────────────────────────┘
```

- **Web and worker are the same image**, differing only by `WEB_SERVER_ENABLED`, `TASKS_ENABLED`, and
  `DATABASE_AUTO_MIGRATE`. Nothing branches on "am I a worker".
- **The worker owns migrations.** Only `hypotenuse-worker` sets `DATABASE_AUTO_MIGRATE=true`.
- **The api runs no tasks.** Slack gives a webhook 3 seconds and Linear 5; an agent tick on the web process would
  compete with ingress for its event loop.
- **Queues** drain left to right: `ingress`, `outbox`, `agents`, `orchestrator`, `default`
  (`backend/config/tasks.ts`).
- **Redis is `noeviction`**: an evicted queue key is a conversation that never wakes.

Structural invariants are asserted by `backend/__tests__/deployment/render-blueprint.test.ts`, which parses the
real file. If you change `render.yaml`, run `cd backend && bun test __tests__/deployment`.

## Environment

Shared values live on the **`hypotenuse-shared`** env group, which both backend services pull with `fromGroup`.
Secrets are added to the group **in the dashboard**, never in `render.yaml`: Render ignores `sync: false` inside an
env group, and ignores it on a service during Blueprint updates.

| Key | api | worker | Notes |
|---|---|---|---|
| `SECRETS_ENCRYPTION_KEY` | group | group | `generateValue: true` **once, in the group**: one key on per-service `generateValue` would be two keys, and the worker could not decrypt what the api wrote. 32 bytes, base64 |
| `FRONTEND_URL` | group | group | `https://www.hypotenuse.cloud` — every dashboard link; `/api/status` `dashboardUrl` |
| `NODE_ENV`, `LOG_LEVEL`, `LOG_FORMAT` | group | group | `production`, `info`, `json` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | group, dashboard | group, dashboard | optional; read once accounts exist |
| `APPLICATION_URL` | `https://api.hypotenuse.cloud` | same | the base of every webhook URL; the worker writes links too |
| `WEB_SERVER_ALLOWED_ORIGINS` | `https://www.hypotenuse.cloud` | — | CORS |
| `SESSION_COOKIE_SECURE` / `SESSION_COOKIE_SAME_SITE` | `true` / `None` | — | cross-origin frontend |
| `MCP_SERVER_ENABLED`, `MCP_OAUTH_TRUST_PROXY` | `true` | — | otherwise the OAuth issuer is Render's internal origin |
| `DATABASE_AUTO_MIGRATE` | `false` | `true` | |
| `TASKS_ENABLED` / `TASK_PROCESSORS` | `false` / `0` | `true` / `4` | |
| `VITE_API_URL` | — | — | the frontend's build arg, `https://api.hypotenuse.cloud` |

**Platform secrets are not environment variables.** Each bot is its own Slack app and its own Linear app, so its
signing secrets and tokens are stored encrypted with that bot's installation. The blueprint test refuses any
`SLACK_*`, `LINEAR_*`, or `PYLON_*` key.

## First deploy

1. **Merge to `main`** once **CI Complete** is green.
2. **Create the Blueprint**: Render dashboard → *New* → *Blueprint* → this repository. Apply all five resources and
   the `hypotenuse-shared` group. `SECRETS_ENCRYPTION_KEY` is generated there, once.
3. **Point DNS at Render.** `api.hypotenuse.cloud` is the backend, `www.hypotenuse.cloud` the frontend, and the apex
   is attached only to redirect to `www`. `render.yaml` already declares all three; add the DNS records the
   dashboard names for each and wait for their certificates.
4. **Watch the worker's first boot.** Its log shows `database migrated successfully` — migration 0000 creates the
   `vector` extension — before the api reports healthy. Until then the api's health check fails and Render holds
   the deploy.
5. **Record who deployed and when** in the learnings of
   [`plans/phase-02-deployment.md`](./plans/phase-02-deployment.md#learnings-from-the-build).

## Verify

```bash
curl -s https://api.hypotenuse.cloud/api/status | jq '{healthy, checks, database, webhooks, dashboardUrl}'
curl -s https://api.hypotenuse.cloud/.well-known/oauth-authorization-server | jq -r .issuer   # https://api.hypotenuse.cloud
curl -sI https://www.hypotenuse.cloud/status | head -1                                         # 200, never a 301
```

`healthy` is `true` only with `database.extensions.vector` true.

## Verifying pgvector

Render's managed Postgres ships the `vector` extension; migration 0000 runs `CREATE EXTENSION IF NOT EXISTS vector`.
If the worker's first migration fails, connect with the dashboard's `psql` command and check:

```sql
SELECT name, default_version, installed_version FROM pg_available_extensions WHERE name = 'vector';
```

No row means the database cannot host Hypotenuse; a row with no `installed_version` means migrations have not run.

## Rotating `SECRETS_ENCRYPTION_KEY`

**Not supported.** Every stored credential is encrypted with it, and there is no re-encryption task yet. Changing
it makes every stored credential unreadable. A rotation needs a task that decrypts with the old key and re-encrypts
with the new one; until that exists, leave the key alone.

## Where each platform's URLs come from

Every platform app Hypotenuse generates for a bot embeds this deployment's webhook URL, derived from
`APPLICATION_URL` plus a fixed route in `backend/ops/WebhookUrlOps.ts`, and printed by `GET /api/status`:

| Platform | Webhook URL |
|---|---|
| Slack | `https://api.hypotenuse.cloud/api/webhooks/slack` |
| Linear | `https://api.hypotenuse.cloud/api/webhooks/linear` |
| Pylon | `https://api.hypotenuse.cloud/api/webhooks/pylon` |

Moving the API's origin means editing every installed app on every platform, so pick the origin once.

**Developing a platform app locally.** No platform delivers to `localhost`. Run `bun run ngrok`, which opens the
reserved tunnels in `ngrok.yml` (it merges your own `ngrok config add-authtoken` config in front; the token never
lives in the repository), then set `APPLICATION_URL` in `backend/.env` to the backend tunnel's origin and restart:
every manifest generated while developing then embeds a URL the platform can reach. Set the frontend's
`VITE_DEV_TUNNEL_HOST` to the frontend tunnel's host so Vite accepts it.

## Rehearse locally

The CI Docker jobs prove the images build, not that the blueprint's environment is right. Run the real image with
the blueprint's literal env against local Postgres and Redis:

```bash
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
curl -s http://localhost:18081/api/status | jq -c '{healthy, database, webhooks}'
docker logs $CID 2>&1 | grep -iE "migrat|resque|server"
docker rm -f $CID
```

| Role | Expected |
|---|---|
| `hypotenuse-api` | `/api/status` healthy once the database is migrated; **no** migration lines; **no** `resque:worker` lines |
| `hypotenuse-worker` | `database migrated successfully`; resque workers started; nothing listening on HTTP |

**The nginx rehearsal.** Render forwards to a port the outside cannot reach, so `frontend/nginx.conf` sets
`absolute_redirect off` and drops `$uri/` from `try_files`: nginx's own trailing-slash 301 once sent a reload to
`http://<host>:10000/…`. Nothing in `frontend/public/` may share a name with a top-level route
(`frontend/src/__tests__/nginx.test.ts`). To check it:

```bash
CID=$(docker run -d -p 18080:10000 $(docker build -q -f frontend/Dockerfile --build-arg VITE_API_URL=https://example.invalid .))
for u in / /status /status/ /no/such/route; do
  curl -s -o /dev/null -w "%{http_code} %{content_type} $u\n" http://localhost:18080$u
done   # every line 200 text/html
docker rm -f $CID
```
