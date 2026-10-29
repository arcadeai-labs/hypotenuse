import { loadFromEnvIfSet } from "keryx";

/**
 * Signing in the `hypotenuse` CLI through the dashboard.
 *
 * - `codeTtlSeconds` — how long the one-time code the approve page hands the
 *   CLI's loopback listener stays redeemable. A minute: the browser redirects to
 *   the listener immediately, so the code only has to survive one hop.
 * - `deviceCodeTtlSeconds` — how long a `--device` code waits for a person to
 *   type its user code into `/cli/activate`.
 * - `pollIntervalSeconds` — how often the CLI polls `cli-auth:exchange` with a
 *   device code. Five seconds, RFC 8628's default, keeps one polling CLI inside
 *   the unauthenticated per-IP rate limit.
 * - `tokenTtlDays` — a CLI token's lifetime, extended on use (at most once a day).
 *
 * The dashboard origin `/cli/activate` lives under is `config.frontend.url`.
 */
export const configCliAuth = {
  codeTtlSeconds: await loadFromEnvIfSet("CLI_AUTH_CODE_TTL_SECONDS", 60),
  deviceCodeTtlSeconds: await loadFromEnvIfSet(
    "CLI_AUTH_DEVICE_CODE_TTL_SECONDS",
    600,
  ),
  pollIntervalSeconds: await loadFromEnvIfSet(
    "CLI_AUTH_POLL_INTERVAL_SECONDS",
    5,
  ),
  tokenTtlDays: await loadFromEnvIfSet("CLI_TOKEN_TTL_DAYS", 90),
};

declare module "keryx" {
  interface KeryxConfig {
    cliAuth: typeof configCliAuth;
  }
}
