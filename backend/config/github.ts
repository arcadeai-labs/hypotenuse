import { loadFromEnvIfSet } from "keryx";

/**
 * GitHub: **one GitHub App for the deployment**, which projects install into
 * their GitHub organizations. Read at use, so a suite may point the origins at
 * its GitHub fake after boot and put them back.
 *
 * Empty strings count as unset: a checkout that has not filled `.env` boots,
 * and every surface that needs the App says it is not configured instead of
 * failing in a way nobody can read.
 *
 * - `appId`, `privateKey` — the App's id and PEM key. The key signs a JWT,
 *   the JWT buys an installation token, and only that token is ever handed
 *   on. Never stored per project.
 * - `appSlug` — the App's URL name, for the install link
 *   (`<webUrl>/apps/<slug>/installations/new`).
 * - `clientId`, `clientSecret` — the App's OAuth client. The install callback
 *   exchanges the `code` GitHub sends with `installation_id` for a user token,
 *   and asks GitHub whether that user can see the installation, because the
 *   query string's `installation_id` can be spoofed.
 * - `webhookSecret` — the App's webhook secret: `X-Hub-Signature-256` is the
 *   hex HMAC-SHA256 of the raw body under it.
 * - `apiUrl` / `webUrl` — `https://api.github.com` and `https://github.com`.
 *   `webUrl` is where git clones from, where OAuth codes are exchanged, and
 *   what a pull request's URL starts with.
 */
export const configGithub = {
  appId: await loadFromEnvIfSet("GITHUB_APP_ID", ""),
  appSlug: await loadFromEnvIfSet("GITHUB_APP_SLUG", ""),
  privateKey: await loadFromEnvIfSet("GITHUB_APP_PRIVATE_KEY", ""),
  clientId: await loadFromEnvIfSet("GITHUB_APP_CLIENT_ID", ""),
  clientSecret: await loadFromEnvIfSet("GITHUB_APP_CLIENT_SECRET", ""),
  webhookSecret: await loadFromEnvIfSet("GITHUB_APP_WEBHOOK_SECRET", ""),
  apiUrl: await loadFromEnvIfSet("GITHUB_API_URL", "https://api.github.com"),
  webUrl: await loadFromEnvIfSet("GITHUB_WEB_URL", "https://github.com"),
  /** The longest file `github_file_read` returns, in bytes. */
  maxFileBytes: await loadFromEnvIfSet("GITHUB_MAX_FILE_BYTES", 200_000),
};

declare module "keryx" {
  interface KeryxConfig {
    github: typeof configGithub;
  }
}
