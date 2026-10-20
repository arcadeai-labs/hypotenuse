import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { api } from "keryx";
import { HOOK_TIMEOUT } from "../setup";

/**
 * Indexes the schema declares for the hot read and write paths.
 *
 * Asserted against `pg_indexes` after a real boot, so a migration that forgot
 * to create one — or created it on the wrong columns — fails here rather than
 * as a sequential scan in production. The names and predicates are the
 * contract; the planner's choice of which one to use is not.
 */
const EXPECTED_INDEXES: Record<string, { table: string; def: RegExp }> = {
  // Replays and races resolve on these: a duplicate signup, membership, tag
  // name, or settings row fails the insert rather than landing twice.
  user_email_idx: { table: "users", def: /UNIQUE.*\(email\)/i },
  membership_user_project_idx: {
    table: "project_memberships",
    def: /UNIQUE.*\(user_id,\s*project_id\)/i,
  },
  tag_project_name_idx: {
    table: "tags",
    def: /UNIQUE.*\(project_id,\s*name\)/i,
  },
  user_tag_user_tag_idx: {
    table: "user_tags",
    def: /UNIQUE.*\(user_id,\s*tag_id\)/i,
  },
  project_settings_project_idx: {
    table: "project_settings",
    def: /UNIQUE.*\(project_id\)/i,
  },
  // `invite:list-pending` on every signed-in page load.
  invite_invitee_email_idx: {
    table: "project_invites",
    def: /\(invitee_email\)/i,
  },
  // `audit:list` by project and time, and the retention sweep by time.
  audit_logs_project_created_at_idx: {
    table: "audit_logs",
    def: /\(project_id,\s*created_at\)/i,
  },
  audit_logs_created_at_idx: { table: "audit_logs", def: /\(created_at\)/i },
  // The dispatcher's query every tick, and the unread badge on every page.
  notifications_dispatch_idx: {
    table: "notifications",
    def: /\(status,\s*next_attempt_at\)/i,
  },
  notifications_unread_idx: {
    table: "notifications",
    def: /\(user_id,\s*channel,\s*read_at\)/i,
  },
};

beforeAll(async () => {
  await api.start();
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

describe("hot-path indexes", () => {
  test("the booted database has every index the hot paths rely on", async () => {
    const result = await api.db.db.execute(sql`
      SELECT indexname, tablename, indexdef
        FROM pg_indexes
       WHERE schemaname = 'public'
    `);

    const byName = new Map(
      (
        result.rows as {
          indexname: string;
          tablename: string;
          indexdef: string;
        }[]
      ).map((row) => [row.indexname, row]),
    );

    for (const [name, expected] of Object.entries(EXPECTED_INDEXES)) {
      const row = byName.get(name);
      if (!row) {
        throw new Error(`missing index ${name} on ${expected.table}`);
      }
      expect(row.tablename).toBe(expected.table);
      expect(row.indexdef).toMatch(expected.def);
    }
  });
});
