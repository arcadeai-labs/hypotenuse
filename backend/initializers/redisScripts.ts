import { Initializer, logger } from "keryx";
import { loadRedisScripts } from "../ops/RedisScriptOps";

const namespace = "redisScripts";

/**
 * `SCRIPT LOAD` every `backend/lua/*.lua` file before the server takes traffic.
 *
 * The scripts could be sent with `EVAL` on first use instead, and then a Lua
 * syntax error would surface as a 500 to whoever happened to exercise that path
 * — which for a script guarding a race is a path nobody exercises on purpose.
 * Loading here makes a broken script a failed boot, visible in the deploy log,
 * and gives every call site a sha to send instead of a program.
 *
 * The work is in `start`, not `initialize`: Keryx's redis initializer builds
 * `api.redis.redis` in its own `start`, so there is no connection to load
 * against a phase earlier. `dependsOn` orders both phases, so this runs after
 * that client answers.
 *
 * `declaresAPIProperty = false`: nothing is attached to `api`, because the
 * loaded scripts are reached through `ops/RedisScriptOps.ts` like any other
 * ops module.
 */
export class RedisScripts extends Initializer {
  constructor() {
    super(namespace);
    this.dependsOn = ["redis"];
    this.declaresAPIProperty = false;
  }

  /**
   * Read the Lua directory and register every script with Redis.
   * @throws {Error} If Redis refuses a script.
   */
  async start(): Promise<void> {
    const names = await loadRedisScripts();
    logger.debug(
      names.length > 0
        ? `loaded ${names.length} redis lua script(s): ${names.join(", ")}`
        : "no redis lua scripts found",
    );
  }
}
