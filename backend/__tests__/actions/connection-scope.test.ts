import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, desc, eq } from "drizzle-orm";
import { api } from "keryx";
import { auditLogs } from "../../schema/audit_logs";
import {
  buildTestUniverse,
  call,
  cookieHeader,
  getMcpAccessToken,
  HOOK_TIMEOUT,
  TEST_PASSWORD,
  type TestUniverse,
} from "../setup";

/**
 * One connection, many actions: what a person's MCP client and a dashboard
 * WebSocket do.
 *
 * The RBAC middleware writes the tenant it resolved onto the connection's
 * metadata, and an audit row reads `viaOrganizationOwner` from there to record
 * whose standing a write was made under. An action with no project gate must
 * never inherit the previous action's. Nothing in Hypotenuse resets it: Keryx
 * resets `connection.metadata` at the start of every top-level `act()`, and
 * builds a fresh connection for each MCP tool call. These tests hold Keryx to
 * both, over the two transports that reuse a session.
 */
let u: TestUniverse;
let token: string;
let sessionId: string | null = null;
let nextId = 1;

/**
 * Send one JSON-RPC message to `/mcp` on the test's session.
 * @param method - The JSON-RPC method.
 * @param params - Its params.
 * @returns The HTTP status and the parsed result or error.
 */
async function mcp(method: string, params: Record<string, unknown> = {}) {
  const res = await fetch(`${u.url}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  sessionId ??= res.headers.get("mcp-session-id");
  const text = await res.text();
  const payload = text.includes("data:")
    ? (text
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice(5)
        .trim() ?? "")
    : text;
  return {
    status: res.status,
    body: (payload ? JSON.parse(payload) : null) as {
      result?: Record<string, unknown>;
      error?: unknown;
    } | null,
  };
}

/**
 * The newest audit row for an action.
 * @param action - The action name.
 * @returns The row.
 */
async function newest(action: string) {
  const [row] = await api.db.db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, action)))
    .orderBy(desc(auditLogs.id))
    .limit(1);
  return row;
}

beforeAll(async () => {
  u = await buildTestUniverse();
  // Toad owns the Mushroom Kingdom from here on, without joining Default.
  await call(
    u.url,
    u.peach,
    "POST",
    `/organization/${u.organizationId}/member/${u.toad.userId}`,
    {
      role: "owner",
    },
  );
  token = await getMcpAccessToken(u.url, u.toad.email, TEST_PASSWORD);
  const init = await mcp("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "hypotenuse-test", version: "0.0.0" },
  });
  expect(init.status).toBe(200);
  await fetch(`${u.url}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      "mcp-session-id": sessionId ?? "",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
  });
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

describe("a person's MCP client", () => {
  test("lists the published tools and not the never-list", async () => {
    const { body } = await mcp("tools/list");
    const names = ((body?.result?.tools ?? []) as { name: string }[]).map(
      (t) => t.name,
    );
    expect(names).toContain("tag-create");
    expect(names).toContain("organization-view");
    for (const never of [
      "user-create",
      "session-create",
      "actions-permissions",
    ]) {
      expect(names).not.toContain(never);
    }
  });

  test("one call's owner standing does not leak into the next call's audit row", async () => {
    const tag = await mcp("tools/call", {
      name: "tag-create",
      arguments: { projectId: u.peach.projectId, name: "via-mcp" },
    });
    expect(tag.body?.result?.isError ?? false).toBe(false);
    const tagRow = await newest("tag:create");
    expect(tagRow.userId).toBe(u.toad.userId);
    expect(tagRow.metadata.standing).toBe("organization-owner");

    // Same session, same connection: an action with no project gate.
    const edit = await mcp("tools/call", {
      name: "user-edit",
      arguments: { name: "Toad the Owner" },
    });
    expect(edit.body?.result?.isError ?? false).toBe(false);
    const editRow = await newest("user:edit");
    expect(editRow.userId).toBe(u.toad.userId);
    expect(editRow.projectId).toBeNull();
    expect(editRow.metadata.standing).toBeUndefined();
  });
});

describe("a dashboard WebSocket", () => {
  test("runs actions on one connection without carrying one's standing into the next", async () => {
    const socket = new WebSocket(u.url.replace(/^http/, "ws"), {
      headers: cookieHeader(u.toad.sessionId),
    } as never);
    const answers = new Map<number, Record<string, unknown>>();
    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (typeof frame.messageId === "number")
        answers.set(frame.messageId, frame);
    });
    await new Promise((resolve) => socket.addEventListener("open", resolve));
    const act = async (
      messageId: number,
      action: string,
      params: Record<string, unknown>,
    ) => {
      socket.send(
        JSON.stringify({ messageType: "action", messageId, action, params }),
      );
      const deadline = Date.now() + 5_000;
      while (!answers.has(messageId) && Date.now() < deadline)
        await Bun.sleep(20);
      return answers.get(messageId);
    };
    try {
      const tag = await act(1, "tag:create", {
        projectId: u.peach.projectId,
        name: "via-socket",
      });
      expect(tag?.error).toBeUndefined();
      expect((await newest("tag:create")).metadata.standing).toBe(
        "organization-owner",
      );

      const edit = await act(2, "user:edit", { name: "Toad of the Socket" });
      expect(edit?.error).toBeUndefined();
      const row = await newest("user:edit");
      expect(row.userId).toBe(u.toad.userId);
      expect(row.metadata.standing).toBeUndefined();
    } finally {
      socket.close();
    }
  }, 20_000);
});
