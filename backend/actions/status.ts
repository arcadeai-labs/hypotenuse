import { Action, api, config, HTTP_METHOD } from "keryx";
import { z } from "zod";
// Brings `config.frontend` along wherever this file is type-checked, including
// the frontend's program, which never sees `config/index.ts`.
import type {} from "../config/frontend";
import { checkDependencies } from "../ops/HealthOps";
import { webhookUrls } from "../ops/WebhookUrlOps";
import packageJSON from "../package.json";

export class Status implements Action {
  name = "status";
  description =
    "Returns server health and runtime information including the server name, process ID, package version, uptime in milliseconds, memory consumption in MB, dependency health checks for the database and Redis, and which required Postgres extensions the database has (`database.extensions.vector`), the dashboard's URL (`dashboardUrl`), and the absolute URLs Slack, Linear, and Pylon deliver webhooks to (`webhooks`), derived from this deployment's public origin. A check is `null` when that dependency is disabled (e.g. no `DATABASE_URL`), and disabled checks do not affect `healthy`; a database missing a required extension is unhealthy. Always answers 200 with the verdict in `healthy`; a load balancer reads `health` instead. Does not require authentication.";
  inputs = z.object({});
  web = { route: "/status", method: HTTP_METHOD.GET };
  tracing = false;

  /**
   * Report runtime information and whether this process can serve.
   * @returns Runtime information, each dependency's check, and the verdict.
   */
  async run() {
    const consumedMemoryMB =
      Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100;

    const { healthy, checks, database } = await checkDependencies();

    return {
      name: api.process.name,
      pid: api.process.pid,
      version: packageJSON.version,
      uptime: Date.now() - api.bootTime,
      consumedMemoryMB,
      healthy,
      checks,
      database,
      // Where the dashboard lives: the API and the dashboard are different
      // origins in a deployment, and only the server knows both.
      dashboardUrl: config.frontend.url,
      // What every platform app's manifest embeds. Reported, never part of
      // `healthy`: a deployment with no bot installed anywhere is healthy.
      webhooks: webhookUrls(),
    };
  }
}
