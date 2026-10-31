# Build from the REPO ROOT, not from backend/:
#   docker build -f backend/Dockerfile .
# The root lockfile governs the whole Bun workspace, so the build context has to
# include it.

# ---- Build stage ----
FROM oven/bun:1 AS build
WORKDIR /app

# Root lockfile + every workspace manifest, copied before the sources so this
# layer caches across source-only changes.
COPY bun.lock package.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
COPY cli/package.json cli/package.json

RUN bun install --frozen-lockfile

COPY backend/ backend/

# Pre-generate the OpenAPI response schemas into backend/.cache/. Not an
# optimization: without it the server generates them on first boot, which peaks
# around 1.4 GB RSS and gets a small container killed before it finishes
# starting. Needs no Postgres or Redis, so it is safe in a build.
RUN cd backend && bun keryx.ts build

# ---- Runtime stage ----
FROM oven/bun:1-slim
WORKDIR /app/backend

COPY --from=build /app/backend /app/backend
COPY --from=build /app/node_modules /app/node_modules

# Code mode runs programs in Run's QuickJS sandbox, in a worker thread with its
# WebAssembly loaded at run time. Prove it works in this exact image, or fail
# the build: a missing asset would otherwise surface on a bot's first program.
RUN bun scripts/code-self-test.ts

EXPOSE 10000

CMD ["bun", "keryx.ts", "start"]
