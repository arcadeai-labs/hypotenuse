import { afterAll, beforeAll } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
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
 * one request with `RATELIMITED` or lose one response. Everything else is
 * finear's own behaviour, byte for byte. finear lacks rate-limit headers and
 * `RATELIMITED` entirely — a gap recorded in `docs/LINEAR_COVERAGE.md`.
 * @returns Accessors for the running fake and its control operations.
 */
export function useFinear() {
  let app: FinearApplication | undefined;
  let proxy: ReturnType<typeof Bun.serve> | undefined;
  const controlToken = crypto.randomUUID();
  const log: ProxiedRequest[] = [];
  const faults: ProxyFault[] = [];
  let injectedHeaders: Record<string, string> = {};
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
        const text = body ? new TextDecoder().decode(body) : "";
        const seen: ProxiedRequest = {
          method: request.method,
          path: url.pathname,
          operationName:
            url.pathname === "/graphql" ? graphQLOperationName(text) : null,
          grantType:
            url.pathname === "/oauth/token"
              ? new URLSearchParams(text).get("grant_type")
              : null,
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

        const headers = new Headers(request.headers);
        headers.delete("host");
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
   * Drive `linear:connect` and finear's consent screen, and answer the URL
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
      `${serverUrl()}/api/linear/connect?projectId=${projectId}`,
      { headers: cookieHeader(sessionId) },
    );
    const started = (await connect.json()) as {
      authorizeUrl?: string;
      error?: unknown;
    };
    if (!started.authorizeUrl) {
      throw new Error(`linear:connect failed: ${JSON.stringify(started)}`);
    }
    return consent(started.authorizeUrl, options);
  }

  /**
   * Approve (or decline) finear's consent screen for an authorize URL, as the
   * chosen fixture admin with every team offered. finear's consent is an HTML
   * form, so this scrapes it: the fragility lives in this one function.
   * Ported from `approveFixtureConsent` in finear's `examples/agent.ts`.
   * @param authorizeUrl - The URL `linear:connect` answered.
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
    /** Stamp these headers on every GraphQL response from now on. */
    injectHeaders: (headers: Record<string, string>) => {
      injectedHeaders = headers;
    },
    /** Flush the webhook outbox now. */
    drain: () => running().drain(),
    /** Advance finear's virtual clock (OAuth lifetimes included). */
    advance: (ms: number) => running().advance(ms),
    /** Reset finear to its fixtures; every OAuth token becomes invalid. */
    reset: () => running().reset(),
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
