import { loadFromEnvIfSet } from "keryx";

/** The audit log: how long a row is kept. */
export const configAudit = {
  /**
   * How many days `audit:sweep` keeps a row. A year, because a shared bot's
   * history outlives a sprint.
   */
  retentionDays: await loadFromEnvIfSet("AUDIT_RETENTION_DAYS", 365),
};

declare module "keryx" {
  interface KeryxConfig {
    audit: typeof configAudit;
  }
}
