import { afterAll, beforeAll } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildSchema, type GraphQLSchema, parse, validate } from "graphql";
import { config } from "keryx";
import { LINEAR_SCOPES } from "../../config/linear";
import { linearCallbackUrl, linearWebhookUrl } from "../../ops/LinearOps";
import { cookieHeader, HOOK_TIMEOUT, serverUrl } from "../setup";

/**
 * finear's in-process application, fetched at a pinned commit by
 * `scripts/fetch-finear.ts` (run by `bun run test`). Imported by path rather
 * than as a package: see that script for why.
 */
const FINEAR_APPLICATION = join(
  import.meta.dir,
  "..",
  "..",
  ".finear",
  "src",
  "application.ts",
);

/**
 * The slice of finear's in-process API these tests use. Declared here rather
 * than imported, because `tsc` would otherwise type-check finear's own sources
 * under this repository's stricter settings.
 */
interface FinearApplication {
  readonly url: URL;
  readonly runtime: {
    database: {
      transaction<T>(
        work: (tx: { run(sql: string, ...params: unknown[]): unknown }) => T,
      ): T;
    };
  };
  drain(): Promise<void>;
  advance(milliseconds: number): Promise<number>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** An OAuth client finear registers at boot (with an optional app webhook). */
export interface FinearClientConfig {
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

/** finear's `createApplication`, as far as these tests call it. */
interface FinearModule {
  createApplication(options: {
    databasePath: string;
    port?: number;
    controlToken?: string;
    clients?: readonly FinearClientConfig[];
  }): Promise<FinearApplication>;
}

/** The fixture API key finear seeds for "Human 1", an admin in workspace `eng`. */
export const FINEAR_PRIMARY_KEY = "finear-fixture-primary-key";

/** The fixture API key for "Human 2", an admin in the second workspace. */
export const FINEAR_SECONDARY_KEY = "finear-fixture-secondary-key";

/** finear's fixture ids (`src/workspace/fixtures.ts` at the pinned commit). */
export const FINEAR_FIXTURES = {
  primary: {
    organization: "10000000-0000-4000-8000-000000000001",
    user: "10000000-0000-4000-8000-000000000002",
    team: "10000000-0000-4000-8000-000000000003",
    privateTeam: "10000000-0000-4000-8000-000000000004",
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

/** Which fixture workspace a consent approves into. */
export type FinearFixture = "primary" | "secondary";

/** One request the proxy in front of finear saw. */
export interface ProxiedRequest {
  method: string;
  path: string;
  /** The GraphQL `operationName`, for `/graphql`. */
  operationName: string | null;
  /** The form's `grant_type`, for `/oauth/token`. */
  grantType: string | null;
  /** The GraphQL variables, as sent (before any gap stand-in rewrote them). */
  variables: Record<string, unknown> | null;
}

/** A Linear document, as the proxy's stand-in for finear's missing ones holds it. */
export interface StandInDocument {
  id: string;
  title: string;
  content: string;
  url: string;
  projectId: string | null;
  issueId: string | null;
}

/**
 * Something the proxy does to one matching request instead of passing it
 * through untouched:
 *
 * - `drop` — forward it to finear, let finear act on it, then answer 502 as if
 *   the response had been lost on the way back.
 * - `ratelimit` — answer it with Linear's documented `RATELIMITED` refusal
 *   (HTTP 400, `extensions.code`, and the reset headers) without forwarding.
 */
export interface ProxyFault {
  kind: "drop" | "ratelimit";
  /** Which request it applies to. */
  match: (request: ProxiedRequest) => boolean;
  /** For `ratelimit`: the reset time to report, epoch ms. */
  resetAt?: number;
}

/**
 * Boot finear in-process for the current test file, behind a small proxy, with
 * this server's OAuth client registered — and point the server under test at
 * it. Call **after** the file's `buildTestUniverse()` `beforeAll`, because the
 * client's redirect URI and webhook are this server's real URLs.
 *
 * The proxy exists for what finear does not do and Linear does: it records
 * every request (so a test can assert a cache was hit, or a refresh sent once),
 * stamps Linear's `X-RateLimit-*` headers on GraphQL responses, and can answer
 * one request with `RATELIMITED` or lose one response. It also stands in for
 * two things finear lacks, each a gap recorded in `docs/LINEAR_COVERAGE.md`:
 * it takes `createAsUser` / `displayIconUrl` off an `issueCreate` (finear
 * refuses them; the request log keeps them for the test to assert), and it
 * answers the document operations (`documentCreate`, `documentUpdate`,
 * `document`, `project.documents`) from a small store of its own. Everything
 * else is finear's own behaviour, byte for byte. finear lacks rate-limit
 * headers and `RATELIMITED` entirely — a gap recorded there too.
 * @returns Accessors for the running fake and its control operations.
 */
export function useFinear() {
  let app: FinearApplication | undefined;
  let proxy: ReturnType<typeof Bun.serve> | undefined;
  const controlToken = crypto.randomUUID();
  const log: ProxiedRequest[] = [];
  const faults: ProxyFault[] = [];
  let injectedHeaders: Record<string, string> = {};
  const documents = new Map<string, StandInDocument>();
  const saved = {
    linear: { ...config.linear },
    applicationUrl: config.server.web.applicationUrl,
  };

  beforeAll(async () => {
    if (!existsSync(FINEAR_APPLICATION)) {
      throw new Error(
        "finear is not fetched — run `bun run finear:fetch` in backend/ (or use `bun run test`)",
      );
    }
    const server = serverUrl();
    if (!server) {
      throw new Error("useFinear() must run after the server has started");
    }
    // The redirect URI and webhook URL are derived from APPLICATION_URL, so
    // they must name the port this file's server actually bound.
    config.server.web.applicationUrl = server;
    if (!config.linear.clientId || !config.linear.clientSecret) {
      throw new Error(
        "LINEAR_CLIENT_ID_TEST and LINEAR_CLIENT_SECRET_TEST are unset — copy them from backend/.env.example",
      );
    }

    const { createApplication } = (await import(
      FINEAR_APPLICATION
    )) as FinearModule;
    app = await createApplication({
      databasePath: ":memory:",
      port: 0,
      controlToken,
      clients: [
        {
          id: config.linear.clientId,
          name: "Hypotenuse",
          secret: config.linear.clientSecret,
          redirectUris: [linearCallbackUrl()],
          scopes: [...LINEAR_SCOPES],
          webhook: {
            url: linearWebhookUrl(),
            secret: config.linear.webhookSecret,
            resourceTypes: ["Issue", "Comment"],
            agentSessionEvents: true,
          },
        },
      ],
    });
    const upstream = app.url.toString().replace(/\/$/, "");

    proxy = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        const url = new URL(request.url);
        // Read the body here, inside the handler: a body read after the
        // handler returns can hang under `bun test`.
        const body =
          request.method === "GET" || request.method === "HEAD"
            ? undefined
            : await request.arrayBuffer();
        let text = body ? new TextDecoder().decode(body) : "";
        const gql = url.pathname === "/graphql" ? parseGraphQLBody(text) : null;
        const seen: ProxiedRequest = {
          method: request.method,
          path: url.pathname,
          operationName:
            url.pathname === "/graphql" ? graphQLOperationName(text) : null,
          grantType:
            url.pathname === "/oauth/token"
              ? new URLSearchParams(text).get("grant_type")
              : null,
          variables: gql?.variables ?? null,
        };
        log.push(seen);

        const faultIndex = faults.findIndex((f) => f.match(seen));
        const fault = faultIndex >= 0 ? faults[faultIndex] : undefined;
        if (fault) faults.splice(faultIndex, 1);

        if (fault?.kind === "ratelimit") {
          const resetAt = fault.resetAt ?? Date.now() + 60_000;
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
                "X-RateLimit-Requests-Reset": String(resetAt),
              },
            },
          );
        }

        if (gql && STAND_IN_OPERATIONS.has(seen.operationName ?? "")) {
          // finear's schema has no documents at all: check the document
          // against Linear's full schema (which finear ships), then answer.
          const invalid = await upstreamErrors(String(gql.body.query ?? ""));
          if (invalid.length > 0)
            return Response.json({ errors: invalid }, { status: 400 });
          const standIn = documentStandIn(gql, documents);
          if (standIn) return Response.json(standIn);
        }
        if (gql && seen.operationName === "CreateIssue") {
          // finear refuses the attribution fields; Linear takes them.
          const input = (gql.variables?.input ?? {}) as Record<string, unknown>;
          const { createAsUser: _a, displayIconUrl: _b, ...rest } = input;
          text = JSON.stringify({
            ...gql.body,
            variables: { ...gql.variables, input: rest },
          });
        }

        const headers = new Headers(request.headers);
        headers.delete("host");
        headers.delete("content-length");
        const answer = await fetch(`${upstream}${url.pathname}${url.search}`, {
          method: request.method,
          headers,
          body: body === undefined ? undefined : text,
          redirect: "manual",
        });
        const payload = await answer.arrayBuffer();
        if (fault?.kind === "drop") {
          return new Response("upstream response lost", { status: 502 });
        }

        const out = new Headers(answer.headers);
        out.delete("content-encoding");
        out.delete("content-length");
        if (url.pathname === "/graphql") {
          for (const [k, v] of Object.entries(injectedHeaders)) out.set(k, v);
        }
        return new Response(payload, { status: answer.status, headers: out });
      },
    });
    const proxied = `http://127.0.0.1:${proxy.port}`;
    config.linear.apiUrl = proxied;
    config.linear.oauthUrl = proxied;
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    Object.assign(config.linear, saved.linear);
    config.server.web.applicationUrl = saved.applicationUrl;
    proxy?.stop(true);
    await app?.close();
  }, HOOK_TIMEOUT);

  /** The running application; throws if called before `beforeAll` ran. */
  const running = (): FinearApplication => {
    if (!app) throw new Error("finear has not started yet");
    return app;
  };

  /** The proxy's base URL — what the server under test calls Linear. */
  const linearUrl = () => config.linear.apiUrl;

  /**
   * Run a GraphQL document against finear (through the proxy) with a raw
   * credential: a fixture API key, or `Bearer <oauth token>`.
   * @param authorization - The `Authorization` header value.
   * @param query - The document.
   * @param variables - Its variables.
   * @returns The parsed body.
   */
  async function graphql<T = Record<string, unknown>>(
    authorization: string,
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<{ data?: T; errors?: { message: string }[]; status: number }> {
    const res = await fetch(`${linearUrl()}/graphql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authorization,
      },
      body: JSON.stringify({ query, variables }),
    });
    return { ...((await res.json()) as object), status: res.status };
  }

  /**
   * Drive `integration:connect` and finear's consent screen, and answer the URL
   * Linear would send the browser back to — without following it, so a test
   * can follow it as whoever it likes.
   * @param projectId - The project being connected.
   * @param sessionId - The admin starting it.
   * @param options.decision - Approve or decline on the consent screen.
   * @param options.fixture - Which fixture workspace to install into.
   * @returns The callback URL with its `code` (or `error`) and `state`.
   */
  async function authorize(
    projectId: number,
    sessionId: string,
    options: { decision?: "allow" | "deny"; fixture?: FinearFixture } = {},
  ): Promise<string> {
    const connect = await fetch(
      `${serverUrl()}/api/integration/connect?projectId=${projectId}&type=linear`,
      { headers: cookieHeader(sessionId) },
    );
    const started = (await connect.json()) as {
      authorizeUrl?: string;
      error?: unknown;
    };
    if (!started.authorizeUrl) {
      throw new Error(`integration:connect failed: ${JSON.stringify(started)}`);
    }
    return consent(started.authorizeUrl, options);
  }

  /**
   * Approve (or decline) finear's consent screen for an authorize URL, as the
   * chosen fixture admin with every team offered. finear's consent is an HTML
   * form, so this scrapes it: the fragility lives in this one function.
   * Ported from `approveFixtureConsent` in finear's `examples/agent.ts`.
   * @param authorizeUrl - The URL `integration:connect` answered.
   * @param options - As {@link authorize}.
   * @returns The callback URL.
   */
  async function consent(
    authorizeUrl: string,
    options: { decision?: "allow" | "deny"; fixture?: FinearFixture } = {},
  ): Promise<string> {
    const page = await fetch(authorizeUrl);
    const html = await page.text();
    if (page.status !== 200) {
      throw new Error(`finear consent refused (${page.status}): ${html}`);
    }
    const workspace = FINEAR_FIXTURES[options.fixture ?? "primary"];
    const form = html
      .split("<form")
      .find((f) => f.includes(`value="${workspace.organization}"`));
    if (!form) throw new Error("finear consent offered no such workspace");
    const field = (name: string) =>
      [...form.matchAll(new RegExp(`name="${name}" value="([^"]*)"`, "g"))].map(
        (m) => m[1],
      );
    const fields = new URLSearchParams({
      consent: field("consent")[0],
      decision: options.decision ?? "allow",
      user_id: field("user_id")[0],
      workspace_id: field("workspace_id")[0],
    });
    for (const team of field("team_id")) fields.append("team_id", team);

    const approved = await fetch(`${linearUrl()}/oauth/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
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
  }

  /**
   * Follow a callback URL as a browser signed in with `sessionId`.
   * @param callbackUrl - What {@link authorize} answered.
   * @param sessionId - The browser's session, or null for a signed-out one.
   * @returns Where the server redirected, parsed.
   */
  async function callback(
    callbackUrl: string,
    sessionId: string | null,
  ): Promise<URL> {
    const res = await fetch(callbackUrl, {
      headers: sessionId ? cookieHeader(sessionId) : {},
      redirect: "manual",
    });
    const location = res.headers.get("location");
    if (res.status !== 302 || !location) {
      throw new Error(
        `linear:callback did not redirect (${res.status}): ${await res.text()}`,
      );
    }
    return new URL(location);
  }

  /**
   * Connect a project end to end, as one admin in one browser.
   * @param projectId - The project.
   * @param sessionId - The admin.
   * @param options - As {@link authorize}.
   * @returns Where the dashboard was sent.
   */
  async function install(
    projectId: number,
    sessionId: string,
    options: { fixture?: FinearFixture } = {},
  ): Promise<URL> {
    return callback(await authorize(projectId, sessionId, options), sessionId);
  }

  /**
   * Call one of finear's `/__test/*` control routes directly (not through the
   * proxy, so the request log stays the server's own traffic).
   * @param path - The route, e.g. `/__test/agents/delegate`.
   * @param body - The JSON body, or undefined for a GET.
   * @returns The parsed answer; throws on a non-2xx.
   */
  async function control<T = Record<string, unknown>>(
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const res = await fetch(
      `${running().url.toString().replace(/\/$/, "")}${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${controlToken}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    const answer = (await res.json()) as T;
    if (!res.ok) {
      throw new Error(
        `finear ${path} answered ${res.status}: ${JSON.stringify(answer)}`,
      );
    }
    return answer;
  }

  return {
    /** finear's own base URL (not the proxy). */
    finearUrl: () => running().url.toString().replace(/\/$/, ""),
    /** The proxy's base URL, which the server under test calls Linear. */
    url: linearUrl,
    controlToken,
    graphql,
    authorize,
    consent,
    callback,
    install,
    /** Every request the proxy has seen, oldest first. */
    requests: () => [...log],
    /** Forget the request log. */
    clearRequests: () => {
      log.length = 0;
    },
    /** Apply a fault to the next request it matches. */
    fault: (fault: ProxyFault) => {
      faults.push(fault);
    },
    /** The documents the stand-in holds (finear has none), by id. */
    documents,
    /** Stamp these headers on every GraphQL response from now on. */
    injectHeaders: (headers: Record<string, string>) => {
      injectedHeaders = headers;
    },
    /**
     * Make Human 1 a member of one of its workspace's teams, so finear's
     * consent screen offers it — finear has no API to add a member (a gap in
     * `docs/LINEAR_COVERAGE.md`), so this writes its fixture table. Call
     * before `install`.
     * @param teamId - The team.
     */
    joinTeam: (teamId: string) => {
      running().runtime.database.transaction((tx) =>
        tx.run(
          "INSERT OR IGNORE INTO team_memberships (organization_id, team_id, user_id) VALUES (?, ?, ?)",
          FINEAR_FIXTURES.primary.organization,
          teamId,
          FINEAR_FIXTURES.primary.user,
        ),
      );
    },
    /** Flush the webhook outbox now. */
    drain: () => running().drain(),
    /** Advance finear's virtual clock (OAuth lifetimes included). */
    advance: (ms: number) => running().advance(ms),
    /** Reset finear to its fixtures; every OAuth token becomes invalid. */
    reset: () => running().reset(),
    control,
    /** finear's virtual clock, epoch ms. */
    now: async () => (await control<{ now: number }>("/__test/clock")).now,
  };
}

/**
 * The `operationName` of a GraphQL request body, or the name in its document.
 * @param body - The request body text.
 * @returns The name, or null.
 */
function graphQLOperationName(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as {
      operationName?: string;
      query?: string;
    };
    if (parsed.operationName) return parsed.operationName;
    return /(?:query|mutation)\s+(\w+)/.exec(parsed.query ?? "")?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The operations the document stand-in answers. */
const STAND_IN_OPERATIONS = new Set([
  "CreateDocument",
  "UpdateDocument",
  "GetDocument",
  "ListProjectDocuments",
]);

let upstreamSchema: Promise<GraphQLSchema> | null = null;

/**
 * Validate a document against Linear's own schema, as finear pins it.
 * @param query - The GraphQL document.
 * @returns The validation errors, as GraphQL error objects.
 */
async function upstreamErrors(query: string): Promise<{ message: string }[]> {
  upstreamSchema ??= Bun.file(
    join(dirname(FINEAR_APPLICATION), "..", "contracts", "upstream.graphql"),
  )
    .text()
    .then((sdl) => buildSchema(sdl, { assumeValidSDL: true }));
  try {
    return validate(await upstreamSchema, parse(query)).map((e) => ({
      message: e.message,
    }));
  } catch (e) {
    return [{ message: e instanceof Error ? e.message : String(e) }];
  }
}

/** A GraphQL request body, parsed. */
interface GraphQLBody {
  body: Record<string, unknown>;
  variables: Record<string, unknown> | null;
  operationName: string | null;
}

/**
 * Parse a GraphQL request body.
 * @param text - The body text.
 * @returns The parsed body, or null when it is not JSON.
 */
function parseGraphQLBody(text: string): GraphQLBody | null {
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    return {
      body,
      variables: (body.variables as Record<string, unknown>) ?? null,
      operationName: graphQLOperationName(text),
    };
  } catch {
    return null;
  }
}

/**
 * Answer a document operation from the stand-in store — finear has no
 * documents (a gap in `docs/LINEAR_COVERAGE.md`). Only the operations
 * Hypotenuse sends, by name, in Linear's response shape.
 * @param gql - The request.
 * @param store - The documents.
 * @returns The response body, or null for any other operation.
 */
function documentStandIn(
  gql: GraphQLBody,
  store: Map<string, StandInDocument>,
): Record<string, unknown> | null {
  const v = gql.variables ?? {};
  const shape = (d: StandInDocument) => ({
    id: d.id,
    title: d.title,
    url: d.url,
    project: d.projectId ? { id: d.projectId } : null,
    issue: d.issueId ? { id: d.issueId } : null,
  });
  const missing = {
    data: null,
    errors: [
      { message: "Entity not found", extensions: { code: "NOT_FOUND" } },
    ],
  };
  switch (gql.operationName) {
    case "CreateDocument": {
      const input = v.input as Record<string, string>;
      const id = crypto.randomUUID();
      const doc: StandInDocument = {
        id,
        title: input.title,
        content: input.content,
        url: `https://linear.app/document/${id}`,
        projectId: input.projectId ?? null,
        issueId: input.issueId ?? null,
      };
      store.set(id, doc);
      return {
        data: { documentCreate: { success: true, document: shape(doc) } },
      };
    }
    case "UpdateDocument": {
      const doc = store.get(String(v.id));
      if (!doc) return missing;
      const input = v.input as Record<string, string>;
      if (input.content !== undefined) doc.content = input.content;
      if (input.title !== undefined) doc.title = input.title;
      return {
        data: { documentUpdate: { success: true, document: shape(doc) } },
      };
    }
    case "GetDocument": {
      const doc = store.get(String(v.id));
      return doc ? { data: { document: shape(doc) } } : missing;
    }
    case "ListProjectDocuments":
      return {
        data: {
          project: {
            documents: {
              nodes: [...store.values()]
                .filter((d) => d.projectId === v.id)
                .map(shape),
            },
          },
        },
      };
    default:
      return null;
  }
}
