-- Hand-written: drizzle-kit does not manage extensions. Every migration after
-- this one is generated. `vector` comes first so that the database every
-- developer, CI job, and deployment runs on can store embeddings before
-- anything writes one; `/api/status` reports unhealthy without it.
CREATE EXTENSION IF NOT EXISTS vector;
