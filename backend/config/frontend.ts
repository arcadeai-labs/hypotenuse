import { loadFromEnvIfSet } from "keryx";

/**
 * The dashboard, which is a different origin from the API in a deployment.
 *
 * - `url` — the frontend's public origin: the base of every dashboard link the
 *   server writes into Slack, Linear, Pylon, or an e-mail, and what
 *   `/api/status` answers as `dashboardUrl`. The worker writes those links too,
 *   so it needs this as much as the API does.
 */
export const configFrontend = {
  url: await loadFromEnvIfSet("FRONTEND_URL", "http://localhost:3000"),
};

declare module "keryx" {
  interface KeryxConfig {
    frontend: typeof configFrontend;
  }
}
