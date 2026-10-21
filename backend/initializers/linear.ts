import { Initializer, logger, RUN_MODE } from "keryx";
import { linearConfigured } from "../ops/LinearOps";

const namespace = "linearApp";

/**
 * Refuse to serve in production without the Linear OAuth app's three secrets.
 *
 * A deployment missing them answers every webhook with a signature failure and
 * every Connect click with a refusal, which looks healthy until somebody tries
 * Linear. A failed boot says what is wrong where an operator looks. Elsewhere a
 * missing app only logs: development and CI run without one, and
 * `integration:view` answers `configured: false` so the dashboard can say
 * why Connect is off.
 *
 * Server mode only, so `bun keryx.ts linear:manifest-url` — which an operator
 * runs to *create* the app — works before the secrets exist.
 */
export class LinearApp extends Initializer {
  constructor() {
    super(namespace);
    this.declaresAPIProperty = false;
    this.runModes = [RUN_MODE.SERVER];
  }

  /**
   * Check the configuration.
   * @throws {Error} In production, when a Linear secret is missing.
   */
  async start(): Promise<void> {
    if (linearConfigured()) return;
    const message =
      "LINEAR_CLIENT_ID, LINEAR_CLIENT_SECRET, and LINEAR_WEBHOOK_SECRET must all be set; create the Linear app with `bun keryx.ts linear:manifest-url` (docs/DEPLOY.md)";
    if (Bun.env.NODE_ENV === "production") throw new Error(message);
    logger.info(`Linear is not configured: ${message}`);
  }
}
