import { createHash, randomBytes } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * A real MCP server for tests, on the SDK's server half, over Streamable HTTP
 * (stateless, one SDK `Server` per request), with scripted tools, optional
 * auth — static headers, a bearer token, or OAuth with its own authorization
 * server (protected-resource and authorization-server metadata, dynamic
 * registration, PKCE, refresh) — and a record of every call. Hypotenuse
 * reaches it exactly as it reaches a real one.
 */

/** One scripted tool. */
export interface FixtureTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  /** What a call answers. */
  handler: (
    args: Record<string, unknown>,
    headers: Record<string, string>,
  ) => Promise<FixtureToolAnswer> | FixtureToolAnswer;
}

/** What a scripted tool answers. */
export interface FixtureToolAnswer {
  text?: string;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

/** One recorded call. */
export interface FixtureCall {
  tool: string;
  args: Record<string, unknown>;
  headers: Record<string, string>;
}

/** How the fixture authenticates requests to `/mcp`. */
export type FixtureAuth =
  | { mode: "none" }
  | { mode: "bearer"; token: string }
  | { mode: "headers"; name: string; value: string }
  | { mode: "oauth"; accessTtlSeconds?: number };

/** A running fixture. */
export interface McpFixture {
  /** `http://127.0.0.1:<port>`. */
  origin: string;
  /** The MCP endpoint, `<origin>/mcp`. */
  url: string;
  /** Every tool call, oldest first. */
  calls: FixtureCall[];
  /** Every request's headers to `/mcp`, oldest first. */
  requestHeaders: Record<string, string>[];
  /** Replace the tools. */
  setTools(tools: FixtureTool[]): void;
  /** Change how requests are authenticated. */
  setAuth(auth: FixtureAuth): void;
  /** OAuth: forget every access token, so the next request is a 401. */
  revokeAccessTokens(): void;
  /** OAuth: how many tokens the token endpoint issued, by grant. */
  tokenGrants: { authorization_code: number; refresh_token: number };
  /** OAuth: the clients registered. */
  registeredClients: string[];
  /** Release every `slow` call now. */
  release(): void;
  /** Forget calls and counters. */
  reset(): void;
  stop(): Promise<void>;
}

/** The default tools: one read-only, one side effect, slow, huge, failing, and an echo. */
export function defaultTools(): FixtureTool[] {
  return [
    {
      name: "read_inbox",
      description:
        "Read the newest messages in the mailbox.\nReturns sender, subject, and a snippet for each.",
      inputSchema: {
        type: "object",
        properties: { limit: { type: "number" } },
      },
      annotations: { readOnlyHint: true, title: "Read inbox" },
      handler: () => ({ text: "1. From Toad: the cake is ready" }),
    },
    {
      name: "send_email",
      description: "Send an email message to a recipient.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string" },
          subject: { type: "string" },
          body: { type: "string" },
        },
        required: ["to", "subject"],
      },
      annotations: { destructiveHint: false, openWorldHint: true },
      handler: (args) => ({ text: `sent to ${String(args.to)}` }),
    },
    {
      name: "list_calendar_events",
      description: "List upcoming calendar events and meetings.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
      handler: () => ({ text: "Tea with Peach at 4" }),
    },
    {
      name: "create_pull_request",
      description: "Open a GitHub pull request from a branch.",
      inputSchema: {
        type: "object",
        properties: { branch: { type: "string" } },
      },
      handler: (args) => ({ text: `opened PR for ${String(args.branch)}` }),
    },
    {
      name: "huge_report",
      description: "Produce a very long report.",
      inputSchema: {
        type: "object",
        properties: { chars: { type: "number" } },
      },
      annotations: { readOnlyHint: true },
      handler: (args) => {
        const n = Number(args.chars ?? 30_000);
        const line = "row of the long report, ";
        return { text: line.repeat(Math.ceil(n / line.length)).slice(0, n) };
      },
    },
    {
      name: "always_fails",
      description: "A tool that reports an error.",
      inputSchema: { type: "object", properties: {} },
      handler: () => ({ text: "the mailbox is on fire", isError: true }),
    },
    {
      name: "echo_headers",
      description: "Echo the request's headers back.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
      handler: (_args, headers) => ({ text: JSON.stringify(headers) }),
    },
  ];
}

/**
 * Base64url without padding.
 * @param b - The bytes.
 * @returns The encoding.
 */
function b64u(b: Buffer): string {
  return b.toString("base64url");
}

/**
 * Start a fixture on a free port.
 * @param options.auth - How `/mcp` is authenticated (default none).
 * @param options.tools - The tools (default {@link defaultTools}).
 * @returns The fixture.
 */
export function startMcpFixture(
  options: { auth?: FixtureAuth; tools?: FixtureTool[] } = {},
): McpFixture {
  let tools = options.tools ?? defaultTools();
  let auth: FixtureAuth = options.auth ?? { mode: "none" };
  const calls: FixtureCall[] = [];
  const requestHeaders: Record<string, string>[] = [];
  const tokenGrants = { authorization_code: 0, refresh_token: 0 };
  const registeredClients: string[] = [];
  const codes = new Map<
    string,
    { clientId: string; challenge: string; redirectUri: string }
  >();
  const access = new Map<string, number>();
  const refresh = new Set<string>();
  let releases: (() => void)[] = [];

  /**
   * Issue a token pair.
   * @returns The token response.
   */
  const issue = () => {
    const accessToken = `at-${b64u(randomBytes(12))}`;
    const refreshToken = `rt-${b64u(randomBytes(12))}`;
    const ttl = auth.mode === "oauth" ? (auth.accessTtlSeconds ?? 3600) : 3600;
    access.set(accessToken, Date.now() + ttl * 1000);
    refresh.add(refreshToken);
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "Bearer",
      expires_in: ttl,
    };
  };

  /**
   * Whether a request to `/mcp` is allowed.
   * @param req - The request.
   * @returns `true` if so.
   */
  const authorized = (req: Request): boolean => {
    const header = req.headers.get("authorization") ?? "";
    switch (auth.mode) {
      case "none":
        return true;
      case "bearer":
        return header === `Bearer ${auth.token}`;
      case "headers":
        return req.headers.get(auth.name) === auth.value;
      case "oauth": {
        const token = header.replace(/^Bearer /, "");
        const until = access.get(token);
        return until !== undefined && until > Date.now();
      }
    }
  };

  /**
   * One SDK server, wired to the current tools.
   * @param headers - The request's headers, for `echo_headers`.
   * @returns The server.
   */
  const buildServer = (headers: Record<string, string>) => {
    const server = new Server(
      { name: "fixture", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: (t.inputSchema ?? { type: "object" }) as {
          type: "object";
        },
        ...(t.annotations ? { annotations: t.annotations } : {}),
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name;
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      calls.push({ tool: name, args, headers });
      if (name === "slow") {
        await new Promise<void>((resolve) => {
          releases.push(resolve);
          setTimeout(resolve, Number(args.ms ?? 30_000));
        });
        return { content: [{ type: "text", text: "slow done" }] };
      }
      const tool = tools.find((t) => t.name === name);
      if (!tool) {
        return {
          content: [{ type: "text", text: `no tool ${name}` }],
          isError: true,
        };
      }
      const answer = await tool.handler(args, headers);
      return {
        content:
          answer.text !== undefined
            ? [{ type: "text", text: answer.text }]
            : [],
        ...(answer.isError ? { isError: true } : {}),
        ...(answer.structuredContent
          ? { structuredContent: answer.structuredContent }
          : {}),
      };
    });
    return server;
  };

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 120,
    fetch: async (req) => {
      const url = new URL(req.url);
      const origin = url.origin;
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        if (auth.mode !== "oauth") return new Response("no", { status: 404 });
        return Response.json({
          resource: `${origin}/mcp`,
          authorization_servers: [`${origin}/auth`],
          scopes_supported: ["mail"],
        });
      }
      if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
        if (auth.mode !== "oauth") return new Response("no", { status: 404 });
        return Response.json({
          issuer: `${origin}/auth`,
          authorization_endpoint: `${origin}/auth/authorize`,
          token_endpoint: `${origin}/auth/token`,
          registration_endpoint: `${origin}/auth/register`,
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (url.pathname === "/auth/register" && req.method === "POST") {
        const body = (await req.json()) as { redirect_uris?: string[] };
        const clientId = `client-${registeredClients.length + 1}`;
        registeredClients.push(clientId);
        return Response.json({
          client_id: clientId,
          redirect_uris: body.redirect_uris,
        });
      }
      if (url.pathname === "/auth/authorize") {
        // Approves at once: the person's consent is not what is under test.
        const code = `code-${b64u(randomBytes(9))}`;
        codes.set(code, {
          clientId: url.searchParams.get("client_id") ?? "",
          challenge: url.searchParams.get("code_challenge") ?? "",
          redirectUri: url.searchParams.get("redirect_uri") ?? "",
        });
        const back = new URL(url.searchParams.get("redirect_uri") ?? "");
        back.searchParams.set("code", code);
        back.searchParams.set("state", url.searchParams.get("state") ?? "");
        return new Response(null, {
          status: 302,
          headers: { location: back.toString() },
        });
      }
      if (url.pathname === "/auth/token" && req.method === "POST") {
        const form = new URLSearchParams(await req.text());
        if (form.get("grant_type") === "authorization_code") {
          const pending = codes.get(form.get("code") ?? "");
          codes.delete(form.get("code") ?? "");
          const verifier = form.get("code_verifier") ?? "";
          const challenge = b64u(
            createHash("sha256").update(verifier).digest(),
          );
          if (
            !pending ||
            pending.challenge !== challenge ||
            pending.clientId !== form.get("client_id") ||
            pending.redirectUri !== form.get("redirect_uri")
          ) {
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          }
          tokenGrants.authorization_code++;
          return Response.json(issue());
        }
        if (form.get("grant_type") === "refresh_token") {
          const token = form.get("refresh_token") ?? "";
          if (!refresh.has(token))
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          refresh.delete(token);
          tokenGrants.refresh_token++;
          return Response.json(issue());
        }
        return Response.json(
          { error: "unsupported_grant_type" },
          { status: 400 },
        );
      }
      if (url.pathname === "/mcp") {
        const headers = Object.fromEntries(req.headers.entries());
        requestHeaders.push(headers);
        if (!authorized(req)) {
          return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: {
              "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
            },
          });
        }
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        const mcp = buildServer(headers);
        await mcp.connect(transport);
        return transport.handleRequest(req);
      }
      return new Response("not found", { status: 404 });
    },
  });

  const origin = `http://127.0.0.1:${server.port}`;
  return {
    origin,
    url: `${origin}/mcp`,
    calls,
    requestHeaders,
    tokenGrants,
    registeredClients,
    setTools(next) {
      tools = next;
    },
    setAuth(next) {
      auth = next;
    },
    revokeAccessTokens() {
      access.clear();
    },
    release() {
      for (const r of releases) r();
      releases = [];
    },
    reset() {
      calls.length = 0;
      requestHeaders.length = 0;
      tokenGrants.authorization_code = 0;
      tokenGrants.refresh_token = 0;
    },
    async stop() {
      for (const r of releases) r();
      server.stop(true);
    },
  };
}
