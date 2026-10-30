---
name: local-stack
description: Get the Hypotenuse stack (Postgres + pgvector, Redis, backend :8080, frontend :3000) running locally and verified, with exact commands. Use when asked to run, start, boot, or set up the app or its tests in a fresh checkout or container.
---

# Run the Hypotenuse stack locally

Postgres (with `pgvector`) and Redis run as **system services — never Docker** (AGENTS.md, "Local development").
Every block below is idempotent: rerun it safely. Run from the repository root.

## 1. Postgres + pgvector, and Redis

**Linux (Ubuntu/Debian — the Claude Code cloud container, Postgres 16 preinstalled):**

```bash
apt-get install -y postgresql-16-pgvector || (apt-get update && apt-get install -y postgresql-16-pgvector)
service postgresql start
service redis-server start          # the "ulimit: Operation not permitted" warning is harmless
pg_isready -h localhost && redis-cli ping
```

TCP auth stays `scram-sha-256` (do not switch `pg_hba.conf` to `trust`); a password role is used instead:

```bash
su postgres -c "psql -c \"DO \\\$\\\$BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='hypotenuse') THEN CREATE ROLE hypotenuse SUPERUSER LOGIN PASSWORD 'hypotenuse'; END IF; END\\\$\\\$;\""
for db in hypotenuse hypotenuse_test; do
  su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='$db'\"" | grep -q 1 \
    || su postgres -c "createdb -O hypotenuse $db"
done
PGPASSWORD=hypotenuse psql -h localhost -U hypotenuse -d hypotenuse -tAc "select current_user"   # → hypotenuse
```

The role is a superuser because migration 0000 runs `CREATE EXTENSION vector`. The browser suite creates
`hypotenuse_e2e` itself on first run.

**macOS:** `brew install postgresql@18 pgvector redis && brew services start postgresql@18 redis && createdb hypotenuse && createdb hypotenuse_test`
— Homebrew trusts local connections, so the stock `.env` URLs work and step 2's `sed` is skipped.

## 2. Dependencies and env

```bash
bun install
cp --update=none backend/.env.example backend/.env
cp --update=none frontend/.env.example frontend/.env
# Linux only: point both URLs at the password role (both .env files are gitignored).
sed -i 's#^DATABASE_URL=.*#DATABASE_URL="postgres://hypotenuse:hypotenuse@localhost:5432/hypotenuse"#; s#^DATABASE_URL_TEST=.*#DATABASE_URL_TEST="postgres://hypotenuse:hypotenuse@localhost:5432/hypotenuse_test"#' backend/.env
grep ^DATABASE_URL backend/.env
```

`bun install` reports "Blocked 1 postinstall"; leave it — nothing needs it. In a second checkout of the same
machine (a worktree), also run `bun run workspace:setup` so the test databases don't collide.

## 3. Boot and verify

```bash
LOG=/tmp/hypotenuse-dev.log
nohup bun dev > "$LOG" 2>&1 &
for i in $(seq 1 40); do curl -sf localhost:8080/api/status >/dev/null && break; sleep 2; done
curl -s localhost:8080/api/status        # expect "healthy": true, database/redis true, extensions.vector true
curl -s -o /dev/null -w "frontend %{http_code}\n" localhost:3000/   # expect 200
```

`DATABASE_AUTO_MIGRATE=true` applies migrations on boot. Backend `:8080` (MCP at `/mcp`), frontend `:3000`.
Stop it with `pkill -f '^bun dev'; pkill -f '^bun --watch keryx'; pkill -f '^node .*/vite'` (anchored, so the
patterns don't match the shell running them).

## 4. Lint and tests

```bash
bun run lint        # tsc + biome in backend, frontend, cli
bun run test        # never `bun test` — it skips each workspace's bunfig preload
```

Last verified (2026-10-30, Ubuntu 24.04, Postgres 16, Bun 1.4.4): lint clean; backend 511 pass, frontend 249 pass,
cli 95 pass. A logged `error: scripted drop` during the backend suite is test output, not a failure.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `password authentication failed for user "root"` | `backend/.env` still has the stock passwordless URL — rerun the `sed` in step 2 |
| `/api/status` unhealthy, `vector: false` | `postgresql-16-pgvector` not installed, or the role is not a superuser |
| `EADDRINUSE :8080` / `:3000` | a previous `bun dev` is still up — stop it (step 3) |
| Redis `ECONNREFUSED 6379` | `service redis-server start` (containers don't keep services across restarts) |
