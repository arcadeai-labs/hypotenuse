import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import { api, HTTP_METHOD } from "keryx";
import { AuditedAction } from "../../classes/AuditedAction";
import { HOOK_TIMEOUT } from "../setup";

/**
 * Every action that changes nothing. Each one is a plain `Action`, answers
 * `GET` when it has a route, and is listed here by name, so a new read is
 * as visible in review as a new writer.
 */
const READS = new Set([
  "status",
  "health",
  "swagger",
  "actions:permissions",
  "me:view",
  "organization:list",
  "organization:view",
  "organization:invite-list",
  "organization:audit-list",
  "organization-membership:list",
  "project:list",
  "project:view",
  "project:settings-view",
  "membership:list",
  "tag:list",
  "invite:list",
  "invite:list-pending",
  "notification:list",
  "notification:unread-count",
  "audit:list",
]);

/**
 * **The closed list of unaudited writers**: every action that writes and is
 * deliberately not an `AuditedAction`. Each is argued in the audit-logging
 * plan's table and named in `AGENTS.md`'s rule 5; adding one here without
 * both is the mistake this list exists to catch.
 */
const UNAUDITED_WRITERS = new Set([
  // Login churn belongs in logs and metrics.
  "session:create",
  "session:destroy",
  // A per-person reading habit, recorded on the notification itself.
  "notification:mark-read",
  // Clocks and sweeps: the clock acting, not a person.
  "notifications:dispatch",
  "notifications:sweep",
  "invites:sweep",
  "audit:sweep",
]);

beforeAll(async () => {
  await api.start();
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

describe("every writer is audited, or on the closed list", () => {
  test("each action is exactly one of: audited, a read, an unaudited writer", () => {
    for (const action of api.actions.actions) {
      const audited = action instanceof AuditedAction;
      const kinds = [
        audited,
        READS.has(action.name),
        UNAUDITED_WRITERS.has(action.name),
      ].filter(Boolean);
      expect(kinds.length, action.name).toBe(1);
    }
  });

  test("every name on the lists is a registered action", () => {
    const registered = new Set(api.actions.actions.map((a) => a.name));
    for (const name of [...READS, ...UNAUDITED_WRITERS]) {
      expect(registered.has(name), name).toBe(true);
    }
  });

  test("reads answer GET, and audited writers never do", () => {
    for (const action of api.actions.actions) {
      const method = action.web?.method;
      if (!method) continue;
      if (READS.has(action.name)) {
        expect(method, action.name).toBe(HTTP_METHOD.GET);
      }
      if (action instanceof AuditedAction) {
        expect(method, action.name).not.toBe(HTTP_METHOD.GET);
      }
    }
  });
});

describe("the closed list is written down where it is argued", () => {
  const root = path.join(import.meta.dir, "..", "..", "..");
  const docs = {
    "AGENTS.md": path.join(root, "AGENTS.md"),
    "phase-05-audit-logging.md": path.join(
      root,
      "docs",
      "plans",
      "phase-05-audit-logging.md",
    ),
  };

  test("every unaudited writer is named in both, or is a clock both cover", async () => {
    for (const [doc, file] of Object.entries(docs)) {
      const text = await Bun.file(file).text();
      expect(/clocks and sweeps/i.test(text), doc).toBe(true);
      for (const name of UNAUDITED_WRITERS) {
        const action = api.actions.actions.find((a) => a.name === name)!;
        if ((action.task?.frequency ?? 0) > 0) continue;
        expect(text.includes(`\`${name}\``), `${name} in ${doc}`).toBe(true);
      }
    }
  });
});
