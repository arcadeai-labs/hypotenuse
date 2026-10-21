import { configActions } from "./actions";
import { configAudit } from "./audit";
import { configChannels } from "./channels";
import { configCliAuth } from "./cliAuth";
import { configDatabase } from "./database";
import { configLinear } from "./linear";
import { configLogger } from "./logger";
import { configNotifications } from "./notifications";
import { configObservability } from "./observability";
import { configPlugins } from "./plugins";
import { configProcess } from "./process";
import { configRateLimit } from "./rateLimit";
import { configRedis } from "./redis";
import { configRunners } from "./runners";
import { configSecrets } from "./secrets";
import { configServerCli } from "./server/cli";
import { configServerMcp } from "./server/mcp";
import { configServerWeb } from "./server/web";
import { configSession } from "./session";
import { configTasks } from "./tasks";

export default {
  plugins: configPlugins,
  actions: configActions,
  channels: configChannels,
  process: configProcess,
  logger: configLogger,
  database: configDatabase,
  observability: configObservability,
  redis: configRedis,
  rateLimit: configRateLimit,
  session: configSession,
  server: { cli: configServerCli, web: configServerWeb, mcp: configServerMcp },
  tasks: configTasks,
  linear: configLinear,
  audit: configAudit,
  secrets: configSecrets,
  notifications: configNotifications,
  cliAuth: configCliAuth,
  runners: configRunners,
};

/**
 * The type of the merged configuration object. Applications can extend this
 * via module augmentation to add custom config sections:
 *
 * ```typescript
 * declare module "keryx" {
 *   interface KeryxConfig {
 *     audit: { retentionDays: number };
 *   }
 * }
 * ```
 */
