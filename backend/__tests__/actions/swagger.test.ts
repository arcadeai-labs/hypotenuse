import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api } from "keryx";
import { HOOK_TIMEOUT, serverUrl } from "../setup";

let url: string;

beforeAll(async () => {
  await api.start();
  url = serverUrl();
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

/** The slice of an OpenAPI document these tests read. */
interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, { operationId: string }>>;
}

describe("swagger", () => {
  test("serves an OpenAPI 3.0.0 document for this package over HTTP", async () => {
    const res = await fetch(`${url}/api/swagger`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as OpenApiDocument;
    expect(doc.openapi).toBe("3.0.0");
    expect(doc.info.title).toBe("hypotenuse-backend");
  });

  test("documents every action with a web route", async () => {
    const doc = (await (
      await fetch(`${url}/api/swagger`)
    ).json()) as OpenApiDocument;
    expect(doc.paths["/status"]?.get?.operationId).toBe("status");
    expect(doc.paths["/swagger"]?.get?.operationId).toBe("swagger");
    // A route with a path parameter, documented under OpenAPI's own spelling.
    const project = Object.entries(doc.paths).find(([path]) =>
      /^\/project\/[{:]projectId}?$/.test(path),
    );
    expect(project?.[1].get?.operationId).toBe("project:view");
  });
});

describe("the web server", () => {
  test("an unknown route answers 404, not 500", async () => {
    const res = await fetch(`${url}/api/no-such-action`);
    expect(res.status).toBe(404);
  });
});
