import { loadFromEnvIfSet } from "keryx";

/**
 * Audit-log configuration. `retentionDays` bounds how long audit rows are kept
 * before `audit:sweep` deletes them; override with `AUDIT_RETENTION_DAYS`.
 *
 * 90 days: the audit log is the record of who connected Linear, revoked a
 * runner, or changed a routing rule — the kind of question that gets asked a
 * quarter after the fact, when work starts landing somewhere unexpected.
 */
export const configAudit = {
  retentionDays: await loadFromEnvIfSet("AUDIT_RETENTION_DAYS", 90),
};

declare module "keryx" {
  interface KeryxConfig {
    audit: typeof configAudit;
  }
}
