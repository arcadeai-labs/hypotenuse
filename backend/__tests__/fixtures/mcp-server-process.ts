/**
 * The browser suite's MCP servers, run as their own process (the frontend may
 * not import backend code, so `frontend/scripts/e2e-backend.ts` and
 * `frontend/scripts/capture-doc-illustrations.ts` start this by path, as they
 * do the scripted model). Two fixtures from `mcp-server.ts`, each on a port
 * of its own choosing — one that takes requests without credentials, and one
 * behind OAuth with its own authorization server, which approves every
 * sign-in at once — plus a control server on `MCP_SERVER_CONTROL_PORT` that a
 * spec or script reads over HTTP:
 *
 * | Route | Does |
 * |---|---|
 * | `GET /urls` | `{ url, oauthUrl }`: the two servers' MCP endpoints |
 * | `GET /calls` | `{ calls, oauthCalls }`: every tool call each received, oldest first |
 * | `POST /reset` | forget the recorded calls |
 *
 * A dashboard reaches them exactly as it reaches a real server, which needs
 * the backend's `NETWORK_ALLOW_PRIVATE_HOSTS=true`: they listen on loopback.
 *
 * The open server lists `defaultTools()`, which the browser suite counts on.
 * With `MCP_FIXTURE_TOOLSET=illustration` it lists {@link illustrationTools}
 * instead — a mailbox, as the docs' screenshots show it.
 */
import { type FixtureTool, startMcpFixture } from "./mcp-server";

/**
 * A mailbox's tools, each with the annotations a real one would claim: two
 * read-only reads, a send, an idempotent archive, and a destructive delete.
 * @returns The tools.
 */
function illustrationTools(): FixtureTool[] {
  const text = (body: string) => () => ({ text: body });
  return [
    {
      name: "read_inbox",
      description:
        "Read the newest messages in the shared support mailbox: sender, subject, and a snippet of each.",
      inputSchema: {
        type: "object",
        properties: { limit: { type: "number" } },
      },
      annotations: { readOnlyHint: true, title: "Read inbox" },
      handler: text("1. From Globex billing: duplicate charge on INV-2291"),
    },
    {
      name: "search_messages",
      description:
        "Search every message in the mailbox by sender, subject, or words in the body.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      annotations: { readOnlyHint: true, title: "Search messages" },
      handler: text("2 messages match"),
    },
    {
      name: "send_email",
      description: "Send an email from the support address to a recipient.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string" },
          subject: { type: "string" },
          body: { type: "string" },
        },
        required: ["to", "subject"],
      },
      annotations: { openWorldHint: true, title: "Send email" },
      handler: text("sent"),
    },
    {
      name: "archive_thread",
      description:
        "Move a thread out of the inbox. Archiving twice is harmless.",
      inputSchema: {
        type: "object",
        properties: { threadId: { type: "string" } },
        required: ["threadId"],
      },
      annotations: { idempotentHint: true },
      handler: text("archived"),
    },
    {
      name: "delete_message",
      description: "Delete a message for good. It cannot be recovered.",
      inputSchema: {
        type: "object",
        properties: { messageId: { type: "string" } },
        required: ["messageId"],
      },
      annotations: { destructiveHint: true },
      handler: text("deleted"),
    },
  ];
}

const open = startMcpFixture(
  process.env.MCP_FIXTURE_TOOLSET === "illustration"
    ? { tools: illustrationTools() }
    : {},
);
const oauth = startMcpFixture({ auth: { mode: "oauth" } });

const control = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.MCP_SERVER_CONTROL_PORT),
  fetch(request) {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    if (route === "GET /urls") {
      return Response.json({ url: open.url, oauthUrl: oauth.url });
    }
    if (route === "GET /calls") {
      return Response.json({ calls: open.calls, oauthCalls: oauth.calls });
    }
    if (route === "POST /reset") {
      open.reset();
      oauth.reset();
      return Response.json({ reset: true });
    }
    return Response.json({ error: `No route for ${route}` }, { status: 404 });
  },
});
console.log(
  `MCP fixtures on ${open.url} and ${oauth.url} (OAuth), control on ${control.url}`,
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await open.stop();
    await oauth.stop();
    control.stop(true);
    process.exit(0);
  });
}
