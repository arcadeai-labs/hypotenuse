import { loadFromEnvIfSet } from "keryx";

/**
 * The deployment's one Linear OAuth application, and where Linear lives. The
 * URLs are overridable so tests can point at an in-process finear.
 */
export const configLinear = {
  clientId: await loadFromEnvIfSet("LINEAR_CLIENT_ID", ""),
  clientSecret: await loadFromEnvIfSet("LINEAR_CLIENT_SECRET", ""),
  webhookSecret: await loadFromEnvIfSet("LINEAR_WEBHOOK_SECRET", ""),
  apiUrl: await loadFromEnvIfSet("LINEAR_API_URL", "https://api.linear.app"),
  oauthUrl: await loadFromEnvIfSet("LINEAR_OAUTH_URL", "https://linear.app"),
};

declare module "keryx" {
  interface KeryxConfig {
    linear: typeof configLinear;
  }
}
