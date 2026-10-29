import { sql } from "drizzle-orm";
import { api } from "keryx";

/**
 * A query that fails until the newest migration has run: it reads a column that
 * migration added. Every migration that adds a table or column moves it.
 */
export const NEWEST_MIGRATION_PROBE = sql.raw(
  "SELECT organization_name FROM project_invites LIMIT 0",
);

/** What the probes found: each dependency, and whether this process can serve. */
export interface DependencyHealth {
  /** Whether everything this process needs answered. */
  healthy: boolean;
  /** `null` when a dependency is disabled; disabled checks do not affect `healthy`. */
  checks: { database: boolean | null; redis: boolean };
  /** The required Postgres extensions, or `null` when there is no database. */
  database: { extensions: { vector: boolean } } | null;
}

/**
 * Probe Postgres and Redis. The one implementation of "can this process
 * serve", read by both `status` (the report) and `health` (the probe a load
 * balancer reads).
 * @returns Each check and the verdict.
 */
export async function checkDependencies(): Promise<DependencyHealth> {
  // `null` = the database is disabled, so it is not part of the health verdict.
  let databaseHealthy: boolean | null = null;
  let database: { extensions: { vector: boolean } } | null = null;
  if (api.db?.enabled) {
    databaseHealthy = false;
    database = { extensions: { vector: false } };
    try {
      // Not just `SELECT NOW()`: the web server binds before
      // `DATABASE_AUTO_MIGRATE` finishes (and in a deployment another process
      // migrates), so a bare clock query would report healthy against an
      // unmigrated database. Probe a column the newest migration added — bump
      // it with every migration — and the extension the first one created.
      await api.db.db.execute(NEWEST_MIGRATION_PROBE);
      const rows = await api.db.db.execute(
        sql`SELECT 1 FROM pg_extension WHERE extname = 'vector'`,
      );
      databaseHealthy = true;
      database.extensions.vector = rows.rows.length > 0;
    } catch {}
  }

  let redisHealthy = false;
  try {
    if (api.redis?.redis) {
      await api.redis.redis.ping();
      redisHealthy = true;
    }
  } catch {}

  // Memory stores embeddings in a `vector` column, so a database without the
  // extension cannot serve, however reachable it is.
  const healthy =
    databaseHealthy !== false &&
    (database === null || database.extensions.vector) &&
    redisHealthy;

  return {
    healthy,
    checks: { database: databaseHealthy, redis: redisHealthy },
    database,
  };
}

/**
 * Name every failing check, for a refusal a person reads in a deploy log.
 * @param health - What {@link checkDependencies} found.
 * @returns The failing checks, e.g. `["database extension vector"]`.
 */
export function failingChecks(health: DependencyHealth): string[] {
  const failing: string[] = [];
  if (health.checks.database === false) failing.push("database");
  if (health.checks.database && !health.database?.extensions.vector) {
    failing.push("database extension vector");
  }
  if (!health.checks.redis) failing.push("redis");
  return failing;
}
