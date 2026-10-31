import { afterAll, describe, expect, test } from "bun:test";
import { ApiClient, ApiError } from "../src/api/client";

/**
 * A server that answers whatever a test tells it to, recording what it was
 * sent. It stands in for "any HTTP server", to pin the client's reading of
 * the wire; the real Hypotenuse server is exercised by the backend's spawn test.
 */
const seen: { url: string; headers: Headers; body: string }[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    seen.push({ url: req.url, headers: req.headers, body: await req.text() });
    const url = new URL(req.url);
    switch (url.pathname) {
      case "/api/ok":
        return Response.json({ thing: { id: 1 } });
      case "/api/error-on-200":
        return Response.json({ error: { message: "nope", type: "X" } });
      case "/api/probe-failed":
        return Response.json({ ok: false, error: "HTTP 500" });
      case "/api/string-error":
        return Response.json({ error: "gone" }, { status: 410 });
      case "/api/forbidden":
        return Response.json(
          { error: { message: "not a member", type: "Y" } },
          { status: 403 },
        );
      case "/api/html":
        return new Response("<h1>Bad gateway</h1>", { status: 502 });
      default:
        return new Response("", { status: 404 });
    }
  },
});
const origin = `http://127.0.0.1:${server.port}`;

afterAll(() => {
  server.stop(true);
});

describe("ApiClient", () => {
  test("a 200 whose own `error` field is a string is an answer, not an error", async () => {
    const body = await new ApiClient(origin).request<{
      ok: boolean;
      error: string;
    }>("GET", "/probe-failed");
    expect(body).toEqual({ ok: false, error: "HTTP 500" });
  });

  test("a string error on a failed status is still an error", async () => {
    const error = await new ApiClient(origin)
      .request("GET", "/string-error")
      .then(
        () => {
          throw new Error("expected a failure");
        },
        (e: ApiError) => e,
      );
    expect(error).toMatchObject({ message: "gone", status: 410 });
  });

  test("a 200 carrying an error envelope is an error", async () => {
    const client = new ApiClient(origin);
    const error = await client.request("GET", "/error-on-200").then(
      () => {
        throw new Error("expected a failure");
      },
      (e: ApiError) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe("nope");
    expect(error.status).toBe(200);
    expect(error.type).toBe("X");
  });

  test("a refusal carries the server's message and status", async () => {
    const error = await new ApiClient(origin).request("GET", "/forbidden").then(
      () => {
        throw new Error("expected a failure");
      },
      (e: ApiError) => e,
    );
    expect(error).toMatchObject({ message: "not a member", status: 403 });
  });

  test("a non-JSON failure is still an ApiError", async () => {
    const error = await new ApiClient(origin).request("GET", "/html").then(
      () => {
        throw new Error("expected a failure");
      },
      (e: ApiError) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(502);
  });

  test("sends the bearer token, query, and JSON body; anonymous sends no token", async () => {
    const client = new ApiClient(origin, "hyp_cli_abc");
    await client.request("PUT", "/ok", {
      query: { projectId: 3, page: undefined },
      body: { name: "x" },
    });
    const sent = seen.at(-1)!;
    expect(sent.headers.get("authorization")).toBe("Bearer hyp_cli_abc");
    expect(sent.headers.get("content-type")).toBe("application/json");
    expect(new URL(sent.url).search).toBe("?projectId=3");
    expect(JSON.parse(sent.body)).toEqual({ name: "x" });

    await client.request("GET", "/ok", { anonymous: true });
    const anon = seen.at(-1)!;
    expect(anon.headers.get("authorization")).toBeNull();
    // No body, no JSON content type: the server will not parse an empty one.
    expect(anon.headers.get("content-type")).toBeNull();
  });

  test("an unreachable server is an ApiError naming it", async () => {
    const gone = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(),
    });
    const closed = `http://127.0.0.1:${gone.port}`;
    gone.stop(true);
    const error = await new ApiClient(closed).request("GET", "/ok").then(
      () => {
        throw new Error("expected a failure");
      },
      (e: ApiError) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toContain(`Could not reach ${closed}`);
  });
});
