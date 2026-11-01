import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * **finear, the test Linear** — a Linear-compatible server (real GraphQL
 * against Linear's pinned schema, OAuth with PKCE and refresh rotation,
 * agent sessions and activities, signed durable webhooks), fetched at a
 * pinned commit by `scripts/fetch-finear.ts` (`bun run finear:fetch`, run by
 * `bun run test`) and booted in process here.
 *
 * It sits behind a small proxy, which records every request (so a test can
 * assert what was sent, and that no literal mention of the bot ever was) and
 * can answer one request with Linear's documented `RATELIMITED` refusal or
 * lose one response — two things Linear does and finear does not (gaps in
 * `docs/platform-coverage/linear.md`).
 *
 * One app per bot: each bot fixture registers its own OAuth client, with its
 * own webhook URL and secret, through finear's own `registerClient` — the
 * same function `createApplication({ clients })` uses at boot.
 */

/** Where the fetched finear lives. */
const FINEAR_DIR = join(import.meta.dir, "..", "..", ".finear", "src");

/**
 * The slice of finear's in-process API these tests use, declared here rather
 * than imported, so `tsc` does not type-check finear's own sources.
 */
interface FinearApplication {
  readonly url: URL;
  readonly runtime: {
    database: {
      transaction<T>(work: (tx: unknown) => T): T;
    };
  };
  drain(): Promise<void>;
  advance(milliseconds: number): Promise<number>;
  close(): Promise<void>;
}

/** An OAuth client, as finear registers one. */
export interface FinearClient {
  id: string;
  name: string;
  secret: string;
  redirectUris: string[];
  scopes: string[];
  webhook?: {
    url: string;
    secret: string;
    resourceTypes: string[];
    agentSessionEvents?: boolean;
  };
}

/** finear's fixture ids (`src/workspace/fixtures.ts` at the pinned commit). */
export const FINEAR = {
  primaryKey: "finear-fixture-primary-key",
  secondaryKey: "finear-fixture-secondary-key",
  primary: {
    organization: "10000000-0000-4000-8000-000000000001",
    user: "10000000-0000-4000-8000-000000000002",
    team: "10000000-0000-4000-8000-000000000003",
    backlog: "10000000-0000-4000-8000-000000000005",
    started: "10000000-0000-4000-8000-000000000006",
    completed: "10000000-0000-4000-8000-000000000007",
  },
  secondary: {
    organization: "20000000-0000-4000-8000-000000000001",
    user: "20000000-0000-4000-8000-000000000002",
    team: "20000000-0000-4000-8000-000000000003",
  },
} as const;

/** One request the proxy saw. */
export interface SeenRequest {
  path: string;
  /** The GraphQL operation's name, for `/graphql`. */
  operation: string | null;
  /** The form's `grant_type`, for `/oauth/token`. */
  grantType: string | null;
  /** The form's field names (never their values), for `/oauth/token`. */
  formKeys: string[];
  variables: Record<string, unknown> | null;
  authorization: string | null;
}

/** Something the proxy does to the next request it matches. */
export interface Fault {
  kind: "ratelimit" | "drop";
  match: (r: SeenRequest) => boolean;
  /** For `ratelimit`: the reset time to report, epoch ms. */
  resetAt?: number;
}

/** A running finear, behind its proxy. */
export interface Finear {
  /** The proxy's origin: what the server under test calls Linear. */
  url: string;
  /** finear's own origin (control routes go here, unlogged). */
  finearUrl: string;
  controlToken: string;
  register(client: FinearClient): void;
  requests(): SeenRequest[];
  clearRequests(): void;
  fault(f: Fault): void;
  graphql<T = Record<string, unknown>>(
    authorization: string,
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<{ data?: T; errors?: { message: string }[] }>;
  control<T = Record<string, unknown>>(
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T>;
  consent(authorizeUrl: string, decision?: "allow" | "deny"): Promise<string>;
  drain(): Promise<void>;
  advance(ms: number): Promise<number>;
  stop(): Promise<void>;
}

/**
 * The GraphQL operation name of a request body.
 * @param text - The body.
 * @returns The name, or `null`.
 */
function operationOf(text: string): {
  operation: string | null;
  variables: Record<string, unknown> | null;
} {
  try {
    const body = JSON.parse(text) as {
      operationName?: string;
      query?: string;
      variables?: Record<string, unknown>;
    };
    return {
      operation:
        body.operationName ??
        /(?:query|mutation)\s+(\w+)/.exec(body.query ?? "")?.[1] ??
        null,
      variables: body.variables ?? null,
    };
  } catch {
    return { operation: null, variables: null };
  }
}

/**
 * **Boot finear**, in memory, behind its proxy.
 * @returns The running fake.
 */
export async function startFinear(): Promise<Finear> {
  if (!existsSync(join(FINEAR_DIR, "application.ts"))) {
    throw new Error(
      "finear is not fetched — run `bun run finear:fetch` in backend/ (or use `bun run test`)",
    );
  }
  const { createApplication } = (await import(
    join(FINEAR_DIR, "application.ts")
  )) as {
    createApplication(o: {
      databasePath: string;
      hostname?: string;
      port?: number;
      controlToken?: string;
    }): Promise<FinearApplication>;
  };
  const { registerClient } = (await import(
    join(FINEAR_DIR, "identity", "index.ts")
  )) as { registerClient(tx: unknown, client: FinearClient): void };
  const controlToken = crypto.randomUUID();
  const app = await createApplication({
    databasePath: ":memory:",
    hostname: "127.0.0.1",
    port: 0,
    controlToken,
  });
  const upstream = app.url.toString().replace(/\/$/, "");
  const log: SeenRequest[] = [];
  const faults: Fault[] = [];

  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      // Read the body inside the handler: a body read later can hang.
      const body =
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.text();
      const gql =
        url.pathname === "/graphql"
          ? operationOf(body ?? "")
          : { operation: null, variables: null };
      const seen: SeenRequest = {
        path: url.pathname,
        operation: gql.operation,
        grantType:
          url.pathname === "/oauth/token"
            ? new URLSearchParams(body ?? "").get("grant_type")
            : null,
        formKeys:
          url.pathname === "/oauth/token"
            ? [...new URLSearchParams(body ?? "").keys()]
            : [],
        variables: gql.variables,
        authorization: request.headers.get("authorization"),
      };
      log.push(seen);
      const at = faults.findIndex((f) => f.match(seen));
      const fault = at >= 0 ? faults.splice(at, 1)[0] : undefined;
      if (fault?.kind === "ratelimit") {
        return Response.json(
          {
            errors: [
              {
                message: "Rate limit exceeded",
                extensions: { code: "RATELIMITED" },
              },
            ],
          },
          {
            status: 400,
            headers: {
              "X-RateLimit-Requests-Limit": "5000",
              "X-RateLimit-Requests-Remaining": "0",
              "X-RateLimit-Requests-Reset": String(
                fault.resetAt ?? Date.now() + 60_000,
              ),
            },
          },
        );
      }
      const headers = new Headers(request.headers);
      headers.delete("host");
      headers.delete("content-length");
      const answer = await fetch(`${upstream}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body,
        redirect: "manual",
      });
      const payload = await answer.arrayBuffer();
      if (fault?.kind === "drop") {
        return new Response("upstream response lost", { status: 502 });
      }
      const out = new Headers(answer.headers);
      out.delete("content-encoding");
      out.delete("content-length");
      return new Response(payload, { status: answer.status, headers: out });
    },
  });
  const proxied = `http://127.0.0.1:${proxy.port}`;

  /**
   * Call a control route on finear itself.
   * @param path - The route.
   * @param body - A JSON body, or nothing for a GET.
   * @returns The answer.
   */
  async function control<T>(
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const res = await fetch(`${upstream}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${controlToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const answer = (await res.json()) as T;
    if (!res.ok) {
      throw new Error(
        `finear ${path}: ${res.status} ${JSON.stringify(answer)}`,
      );
    }
    return answer;
  }

  return {
    url: proxied,
    finearUrl: upstream,
    controlToken,
    register(client) {
      app.runtime.database.transaction((tx) => registerClient(tx, client));
    },
    requests: () => [...log],
    clearRequests: () => {
      log.length = 0;
    },
    fault: (f) => {
      faults.push(f);
    },
    async graphql(authorization, query, variables = {}) {
      const res = await fetch(`${upstream}/graphql`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization },
        body: JSON.stringify({ query, variables }),
      });
      return (await res.json()) as {
        data?: never;
        errors?: { message: string }[];
      };
    },
    control,
    async consent(authorizeUrl, decision = "allow") {
      // The person on finear's consent screen: the primary fixture admin,
      // its workspace, and every team offered.
      const page = await fetch(
        authorizeUrl.replace(/^https?:\/\/[^/]+/, upstream),
      );
      const html = await page.text();
      if (page.status !== 200) {
        throw new Error(`finear consent refused (${page.status}): ${html}`);
      }
      const form = html
        .split("<form")
        .find((f) => f.includes(`value="${FINEAR.primary.organization}"`));
      if (!form) throw new Error("finear offered no primary workspace");
      const field = (name: string) =>
        [
          ...form.matchAll(new RegExp(`name="${name}" value="([^"]*)"`, "g")),
        ].map((m) => m[1]);
      const fields = new URLSearchParams({
        consent: field("consent")[0],
        decision,
        user_id: field("user_id")[0],
        workspace_id: field("workspace_id")[0],
      });
      for (const team of field("team_id")) fields.append("team_id", team);
      const approved = await fetch(`${upstream}/oauth/authorize`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: fields.toString(),
        redirect: "manual",
      });
      const location = approved.headers.get("location");
      if (approved.status !== 302 || !location) {
        throw new Error(
          `finear consent did not redirect (${approved.status}): ${await approved.text()}`,
        );
      }
      return location;
    },
    drain: () => app.drain(),
    advance: (ms) => app.advance(ms),
    async stop() {
      proxy.stop(true);
      await app.close();
    },
  };
}
