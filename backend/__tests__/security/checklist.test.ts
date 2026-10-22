import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api, HTTP_METHOD } from "keryx";
import { SENSITIVE_KEYS } from "../../ops/AuditOps";
import { auditLogs } from "../../schema/audit_logs";
import { useFinear } from "../linear/finear";
import { appToken, integrationRow, refreshTokenOf } from "../linear/helpers";
import { deliver } from "../linear/inject";
import { registerRunner } from "../runners/helpers";
import {
  authHeaders,
  buildTestUniverse,
  HOOK_TIMEOUT,
  type TestUniverse,
} from "../setup";

/**
 * The security review checklist, row by row where no other suite already
 * holds the row (the daemon/human wall and the audit closed list are
 * `rbac.test.ts`; runner tokens are `runner-token-middleware.test.ts`; a
 * runner reaching another project's session is `daemon-linear-proxy.test.ts`;
 * auth links are `ops/auth-signal.test.ts`).
 */

let universe: TestUniverse;
beforeAll(async () => {
  universe = await buildTestUniverse();
}, HOOK_TIMEOUT);
afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

const linear = useFinear();

let secrets: string[];
let runnerToken: string;
beforeAll(async () => {
  await linear.install(universe.projectId, universe.peach.sessionId);
  runnerToken = (
    await registerRunner(
      universe.url,
      universe.peach,
      universe.projectId,
      "security-box",
    )
  ).token;
  secrets = [
    await appToken(universe.projectId),
    await refreshTokenOf(universe.projectId),
    runnerToken,
  ];
}, HOOK_TIMEOUT);

describe("security checklist", () => {
  test("no read action answers with a Linear token or a runner token", async () => {
    const reads = api.actions.actions.filter(
      (a) =>
        a.web?.method === HTTP_METHOD.GET &&
        typeof a.web.route === "string" &&
        !a.name.startsWith("daemon:"),
    );
    expect(reads.length).toBeGreaterThan(10);
    const integration = await integrationRow(universe.projectId);
    let answered = 0;
    for (const action of reads) {
      const path = String(action.web?.route)
        .replace(":id", String(integration.id))
        .replace(/:[a-zA-Z]+/g, "1");
      const res = await fetch(
        `${universe.url}/api${path}?projectId=${universe.projectId}&type=linear`,
        {
          headers: authHeaders(universe.peach.sessionId),
          redirect: "manual",
        },
      );
      const text = await res.text();
      if (res.status === 200) answered++;
      for (const secret of secrets) {
        expect(text.includes(secret), action.name).toBe(false);
      }
    }
    expect(answered).toBeGreaterThan(10);
  });

  test("SENSITIVE_KEYS covers every credential name, and no audit row holds a secret", async () => {
    for (const key of [
      "accessToken",
      "refreshToken",
      "token",
      "runnerToken",
      "code",
      "client_secret",
    ]) {
      expect(SENSITIVE_KEYS as readonly string[]).toContain(key);
    }
    const rows = await api.db.db.select().from(auditLogs);
    expect(rows.some((r) => r.action === "runner:register")).toBe(true);
    const dump = JSON.stringify(rows);
    for (const secret of secrets) expect(dump.includes(secret)).toBe(false);
  });

  test("the webhook parses nothing before the signature: a malformed body with a bad signature is 401, not 400", async () => {
    const res = await deliver(
      universe.url,
      {},
      { raw: "{not json", signature: "0".repeat(64) },
    );
    expect(res.status).toBe(401);
    const missing = await deliver(
      universe.url,
      {},
      { raw: "{not json", signature: null },
    );
    expect(missing.status).toBe(401);
    expect(missing.text).toBe(res.text);
  });
});
