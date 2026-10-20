import { sql } from "drizzle-orm";
import { Action, api, HTTP_METHOD } from "keryx";
import { z } from "zod";
import {
  linearCallbackUrl,
  linearConfigured,
  linearWebhookUrl,
} from "../ops/LinearOps";
import packageJSON from "../package.json";

export class Status implements Action {
  name = "status";
  description =
    "Returns server health and runtime information including the server name, process ID, package version, uptime in milliseconds, memory consumption in MB, and dependency health checks for the database and Redis, and the Linear webhook and OAuth callback URLs this deployment expects (with whether Linear credentials are configured). A check is `null` when that dependency is disabled (e.g. no `DATABASE_URL`), and disabled checks do not affect `healthy`. Does not require authentication.";
  inputs = z.object({});
  web = { route: "/status", method: HTTP_METHOD.GET };
  tracing = false;

  async run() {
    const consumedMemoryMB =
      Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100;

    // `null` = the database is disabled, so it is not part of the health verdict.
    let databaseHealthy: boolean | null = null;
    if (api.db?.enabled) {
      databaseHealthy = false;
      try {
        // Touch a column from the newest migration, not just `SELECT NOW()`.
        // The web server binds before `DATABASE_AUTO_MIGRATE` finishes, so a
        // bare clock query would report healthy against an empty schema —
        // exactly the race e2e global-setup and load balancers must not trust.
        // Move this to the newest migration's column when one is added.
        await api.db.db.execute(
          sql`SELECT link_path FROM notifications LIMIT 0`,
        );
        databaseHealthy = true;
      } catch {}
    }

    let redisHealthy = false;
    try {
      if (api.redis?.redis) {
        await api.redis.redis.ping();
        redisHealthy = true;
      }
    } catch {}

    const healthy = databaseHealthy !== false && redisHealthy;

    return {
      name: api.process.name,
      pid: api.process.pid,
      version: packageJSON.version,
      uptime: new Date().getTime() - api.bootTime,
      consumedMemoryMB,
      healthy,
      checks: {
        database: databaseHealthy,
        redis: redisHealthy,
      },
      // What an operator pastes into the Linear OAuth app's settings, derived
      // from APPLICATION_URL so nobody has to guess. Not part of `healthy`.
      linear: {
        configured: linearConfigured(),
        webhookUrl: linearWebhookUrl(),
        callbackUrl: linearCallbackUrl(),
      },
    };
  }
}
