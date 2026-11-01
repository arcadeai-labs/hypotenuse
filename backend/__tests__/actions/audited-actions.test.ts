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
  "cli-token:list",
  "model-connection:view",
  "model-connection:list",
  "model-connection:models",
  "model-alias:list",
  "bot:view",
  "bot:list",
  "bot:avatar",
  "conversation:list",
  "conversation:view",
  "conversation:entries",
  "memory:list",
  "memory:search",
  "memory:view",
  "memory:versions",
  "memory:channels",
  "mcp-server:list",
  "mcp-server:view",
  "mcp-server:match-tools",
  "bot-mcp-server:list",
  "approval:list",
  "approval:view",
  "large-result:view",
  "code-run:list",
  "code-run:view",
  "prompt-section:list",
  "prompt-section:view",
  "prompt-section:versions",
  "prompt:preview",
  "goal:list",
  "goal:view",
  "skill:list",
  "skill:view",
  "skill:versions",
  "bot-skill:list",
  "bot-installation:list",
  "bot-installation:view",
  // Mints a ten-minute OAuth state in Redis and answers the install URL; no row.
  "bot-installation:oauth-start",
  "channel:list",
  "channel:view",
  "channel-binding:list",
  "participant:list",
  "participant:view",
  "trigger-event:list",
  "trigger-event:view",
  "help:list",
  "help:view",
  "conversation:live",
  "sandbox-job:list",
  "sandbox-job:view",
  "sandbox-job:events",
  // Mints a ten-minute install state in Redis and answers the install URL; no row.
  "github:install-url",
  "github:installation-list",
  "repository-grant:list",
  "repository-grant:view",
  "bot:repositories",
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
  // The CLI's sign-in ingress: the person's decision was the audited
  // approve or activate; these redeem it.
  "cli-auth:device",
  "cli-auth:exchange",
  // A per-person reading habit, recorded on the notification itself.
  "notification:mark-read",
  // The agent loop's machine work: the transcript, the summary it writes,
  // and the outbox rows are the record.
  "agent:tick",
  "conversation:compact",
  "outbox:deliver",
  // Machine ingress and its processing: the trigger event, the inbox row,
  // and the participant are the record (an approval a participant decides
  // is audited inside, as a participant row).
  "webhooks:webhook",
  "webhooks:slack",
  "webhooks:linear",
  "webhooks:pylon",
  "webhooks:github",
  "triggers:process-event",
  // Memory's machine work: each version's source and provenance, and each
  // chunk's embedding revision, are the record.
  "memory:embed",
  "memory:consolidate",
  "memory:decay-project",
  // The MCP catalog's machine work: the server row's catalog and status,
  // and the bot's generated capabilities, are the record.
  "mcp-server:refresh-catalog",
  "bot:capabilities",
  // Clocks and sweeps: the clock acting, not a person.
  "notifications:dispatch",
  "notifications:sweep",
  "invites:sweep",
  "audit:sweep",
  "agents:reap",
  "agents:wake-due",
  "outbox:deliver-due",
  "memory:decay",
  "memory:consolidate-due",
  "mcp-servers:refresh",
  "installations:refresh-tokens",
  "approvals:expire",
  "large-results:sweep",
  "triggers:process-pending",
  "help:expire",
  // The sandbox's machine half: the supervisor's three, the in-sandbox
  // tools, and the proxies, recorded in `sandbox_jobs`,
  // `sandbox_job_events`, its questions, and the job's usage.
  "sandbox:events",
  "sandbox:heartbeat",
  "sandbox:complete",
  "sandbox:report-status",
  "sandbox:ask",
  "sandbox:check-answer",
  "sandbox:request-help",
  "sandbox:submit-artifact",
  "sandbox:memory-search",
  "proxy:model",
  "proxy:mcp",
  // The git credential hop: one ledger row per handout or refusal, in
  // `sandbox_job_git_tokens`.
  "sandbox:git-credential",
  // A job's provisioning and the sandbox clocks: recorded on `sandbox_jobs`
  // and the `sandboxes` ledger.
  "sandbox-job:start",
  "sandbox-jobs:dispatch",
  "sandbox-jobs:reap",
  "sandbox:orphan-sweep",
]);

/**
 * Audited browser hops: a person's browser is sent through a third party's
 * page and back, which arrives as a GET.
 */
const AUDITED_BROWSER_HOPS = new Set([
  "mcp-server:oauth-start",
  "mcp-server:oauth-callback",
  "bot-installation:oauth-callback",
  "github:install-callback",
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
      if (
        action instanceof AuditedAction &&
        !AUDITED_BROWSER_HOPS.has(action.name)
      ) {
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
