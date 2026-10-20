import { loadFromEnvIfSet } from "keryx";

/**
 * Notifications: how mail is sent and how hard the dispatcher tries.
 *
 * **`appUrl` is the frontend's origin and is deliberately not
 * `APPLICATION_URL`.** That one is the backend, which is where the API lives and
 * where nothing a person clicks lives. Getting the two confused produces mail
 * whose button 404s — a bug that works perfectly in every test that does not
 * open the link, which is all of them.
 */
export const configNotifications = {
  /** The SMTP host. **Empty means log-only mode** — see {@link getTransport}. */
  smtpHost: await loadFromEnvIfSet("SMTP_HOST", ""),
  smtpPort: await loadFromEnvIfSet("SMTP_PORT", 587),
  smtpSecure: await loadFromEnvIfSet("SMTP_SECURE", false),
  smtpUser: await loadFromEnvIfSet("SMTP_USER", ""),
  smtpPassword: await loadFromEnvIfSet("SMTP_PASSWORD", ""),
  /** The `From:` header on every message. */
  from: await loadFromEnvIfSet(
    "SMTP_FROM",
    "Hypotenuse <noreply@example.invalid>",
  ),
  /**
   * The **frontend's** public origin, which every link in an email is built
   * from. Not the API's.
   */
  appUrl: await loadFromEnvIfSet("FRONTEND_URL", "http://localhost:3000"),
  /** How often `notifications:dispatch` claims due rows. */
  dispatchFrequencyMs: await loadFromEnvIfSet(
    "NOTIFICATION_DISPATCH_FREQUENCY_MS",
    30_000,
  ),
  /** How many delivery attempts a row gets before it is `failed` for good. */
  maxAttempts: await loadFromEnvIfSet("NOTIFICATION_MAX_ATTEMPTS", 5),
  /** How many rows one dispatch tick claims, so a backlog cannot monopolize it. */
  dispatchBatchSize: await loadFromEnvIfSet("NOTIFICATION_DISPATCH_BATCH", 100),
  /** How long a delivered notification is kept before the daily purge. */
  retentionDays: await loadFromEnvIfSet("NOTIFICATION_RETENTION_DAYS", 30),
};

declare module "keryx" {
  interface KeryxConfig {
    notifications: typeof configNotifications;
  }
}
