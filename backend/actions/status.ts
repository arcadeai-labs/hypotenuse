import { sql } from "drizzle-orm";
import { Action, api, HTTP_METHOD } from "keryx";
import { z } from "zod";
import packageJSON from "../package.json";

export class Status implements Action {
  name = "status";
  description =
    "Returns server health and runtime information including the server name, process ID, package version, uptime in milliseconds, memory consumption in MB, dependency health checks for the database and Redis, and which required Postgres extensions the database has (`database.extensions.vector`). A check is `null` when that dependency is disabled (e.g. no `DATABASE_URL`), and disabled checks do not affect `healthy`; a database missing a required extension is unhealthy. Does not require authentication.";
  inputs = z.object({});
  web = { route: "/status", method: HTTP_METHOD.GET };
  tracing = false;

  /**
   * Probe Postgres and Redis and report whether this process can serve.
   * @returns Runtime information, each dependency's check, and the verdict.
   */
  async run() {
    const consumedMemoryMB =
      Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100;

    // `null` = the database is disabled, so it is not part of the health verdict.
    let databaseHealthy: boolean | null = null;
    let database: { extensions: { vector: boolean } } | null = null;
    if (api.db?.enabled) {
      databaseHealthy = false;
      database = { extensions: { vector: false } };
      try {
        // Read the extension the first migration creates, not just
        // `SELECT NOW()`. The web server binds before `DATABASE_AUTO_MIGRATE`
        // finishes, so a bare clock query would report healthy against an
        // unmigrated database. Once tables exist, probe a column from the
        // newest migration instead.
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

    // Memory stores embeddings in a `vector` column, so a database without
    // the extension cannot serve, however reachable it is.
    const healthy =
      databaseHealthy !== false &&
      (database === null || database.extensions.vector) &&
      redisHealthy;

    return {
      name: api.process.name,
      pid: api.process.pid,
      version: packageJSON.version,
      uptime: Date.now() - api.bootTime,
      consumedMemoryMB,
      healthy,
      checks: {
        database: databaseHealthy,
        redis: redisHealthy,
      },
      database,
    };
  }
}
