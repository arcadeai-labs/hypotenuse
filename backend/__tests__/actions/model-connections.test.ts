import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateText } from "ai";
import { eq } from "drizzle-orm";
import { type ActionResponse, api, config } from "keryx";
import type { ModelAliasCreate } from "../../actions/model-alias/model-alias-create";
import type { ModelConnectionCreate } from "../../actions/model-connection/model-connection-create";
import type { ModelConnectionList } from "../../actions/model-connection/model-connection-list";
import type { ModelConnectionModels } from "../../actions/model-connection/model-connection-models";
import type { ModelConnectionTest } from "../../actions/model-connection/model-connection-test";
import { languageModel } from "../../ops/ModelOps";
import { auditLogs } from "../../schema/audit_logs";
import { modelConnections } from "../../schema/model_connections";
import {
  type ModelServer,
  SCRIPTED_MODELS,
  startModelServer,
} from "../fixtures/model-server";
import {
  buildTestUniverse,
  call,
  HOOK_TIMEOUT,
  type TestUniverse,
  type TestUser,
} from "../setup";

const KEY = "sk-scripted-0123456789-SECRET-abcd";
const ROTATED = "sk-scripted-rotated-9876543210-wxyz";

let u: TestUniverse;
let models: ModelServer;
/** Every response body any request in this file received. */
const bodies: string[] = [];
/** Every log line written while this file ran. */
const logLines: string[] = [];
let restoreLogger: () => void;

beforeAll(async () => {
  u = await buildTestUniverse();
  models = startModelServer({ apiKey: KEY });
  const original = api.logger.log.bind(api.logger);
  api.logger.log = (level, message, data) => {
    logLines.push(`${message} ${JSON.stringify(data ?? null)}`);
    original(level, message, data);
  };
  restoreLogger = () => {
    api.logger.log = original;
  };
}, HOOK_TIMEOUT);

afterAll(async () => {
  restoreLogger();
  await models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * {@link call}, keeping every response body for the whole-file key scan.
 * @param user - Who is asking.
 * @param method - The verb.
 * @param path - The route beneath `/api`.
 * @param body - A JSON body.
 * @returns The status and parsed body.
 */
async function request<T = Record<string, unknown>>(
  user: TestUser | null,
  method: "GET" | "PUT" | "POST" | "DELETE",
  path: string,
  body?: Record<string, unknown>,
) {
  const res = await call<T>(u.url, user, method, path, body);
  bodies.push(JSON.stringify(res.body));
  return res;
}

/**
 * Create a connection in the Castle project as Peach.
 * @param fields - Name, provider, base URL, key.
 * @returns The connection's id.
 */
async function createConnection(fields: {
  name: string;
  provider: string;
  baseUrl?: string;
  apiKey?: string;
}): Promise<number> {
  const res = await request<ActionResponse<ModelConnectionCreate>>(
    u.peach,
    "PUT",
    `/project/${u.projectId}/model-connection`,
    { apiKey: KEY, ...fields },
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.modelConnection.id;
}

/**
 * Test a connection as Peach.
 * @param id - The connection.
 * @returns The connection after its probe.
 */
async function testConnection(id: number) {
  const res = await request<ActionResponse<ModelConnectionTest>>(
    u.peach,
    "POST",
    `/project/${u.projectId}/model-connection/${id}/test`,
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.modelConnection;
}

describe("model-connection:create and :test", () => {
  test("an Anthropic key is sealed, probed through the fixture, and arrives as x-api-key", async () => {
    const id = await createConnection({
      name: "anthropic",
      provider: "anthropic",
      baseUrl: models.baseUrl("anthropic"),
    });
    const [row] = await api.db.db
      .select()
      .from(modelConnections)
      .where(eq(modelConnections.id, id));
    expect(row.status).toBe("unverified");
    expect(row.lastFour).toBe("abcd");
    expect(JSON.stringify(row.secret)).not.toContain(KEY);

    models.reset();
    const tested = await testConnection(id);
    expect(tested.status).toBe("ok");
    expect(tested.lastError).toBeNull();
    expect(tested.lastCheckedAt).toBeNumber();
    const probe = models.requests.find(
      (r) => r.path === "/anthropic/v1/models",
    );
    expect(probe?.headers["x-api-key"]).toBe(KEY);
    expect(probe?.headers["anthropic-version"]).toBeString();
    expect(probe?.headers.authorization).toBeUndefined();
  });

  test("an OpenAI key arrives as a bearer token", async () => {
    const id = await createConnection({
      name: "openai",
      provider: "openai",
      baseUrl: models.baseUrl("openai"),
    });
    models.reset();
    expect((await testConnection(id)).status).toBe("ok");
    const probe = models.requests.find((r) => r.path === "/openai/v1/models");
    expect(probe?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(probe?.headers["x-api-key"]).toBeUndefined();
  });

  test("an OpenAI-compatible connection needs a base URL", async () => {
    const missing = await request(
      u.peach,
      "PUT",
      `/project/${u.projectId}/model-connection`,
      { name: "local", provider: "openai-compatible", apiKey: KEY },
    );
    expect(missing.status).toBe(406);
    expect(missing.body.error?.key).toBe("baseUrl");

    const id = await createConnection({
      name: "compatible",
      provider: "openai-compatible",
      baseUrl: models.baseUrl("openai-compatible"),
    });
    expect((await testConnection(id)).status).toBe("ok");
  });

  test("a gateway key is proven by a call that needs it, and its catalog lists", async () => {
    const id = await createConnection({
      name: "gateway",
      provider: "gateway",
      baseUrl: models.baseUrl("gateway"),
    });
    models.reset();
    expect((await testConnection(id)).status).toBe("ok");
    const credits = models.requests.find((r) => r.path === "/v1/credits");
    expect(credits?.headers.authorization).toBe(`Bearer ${KEY}`);

    const listed = await request<ActionResponse<ModelConnectionModels>>(
      u.peach,
      "GET",
      `/project/${u.projectId}/model-connection/${id}/models`,
    );
    expect(listed.status).toBe(200);
    expect(listed.body.models.map((m) => m.id)).toEqual(
      SCRIPTED_MODELS.map((m) => `scripted/${m.id}`),
    );
  });

  test("a refused key is a status with a reason, not a failed request", async () => {
    const id = await createConnection({
      name: "wrong key",
      provider: "openai",
      baseUrl: models.baseUrl("openai"),
      apiKey: "sk-not-the-right-key-0000",
    });
    const tested = await testConnection(id);
    expect(tested.status).toBe("error");
    expect(tested.lastError).toContain("401");
  });

  test("a provider that echoes the key into its error has it redacted", async () => {
    const id = await createConnection({
      name: "leaky",
      provider: "openai-compatible",
      baseUrl: models.baseUrl("leaky"),
    });
    const tested = await testConnection(id);
    expect(tested.status).toBe("error");
    expect(tested.lastError).toContain("Bearer [redacted]");
    expect(tested.lastError).not.toContain(KEY);
    const listed = await request(
      u.peach,
      "GET",
      `/project/${u.projectId}/model-connection/${id}/models`,
    );
    expect(listed.status).toBe(500);
    expect(listed.body.error?.message).toContain("[redacted]");
    expect(listed.body.error?.message).toContain("Type the model id instead.");
  });

  test("a taken name is refused", async () => {
    const res = await request(
      u.peach,
      "PUT",
      `/project/${u.projectId}/model-connection`,
      {
        name: "anthropic",
        provider: "anthropic",
        baseUrl: models.baseUrl("anthropic"),
        apiKey: KEY,
      },
    );
    expect(res.status).toBe(406);
    expect(res.body.error?.key).toBe("name");
  });
});

describe("model-connection:models", () => {
  test("lists what the endpoint reports, live", async () => {
    const id = await connectionId("anthropic");
    const res = await request<ActionResponse<ModelConnectionModels>>(
      u.peach,
      "GET",
      `/project/${u.projectId}/model-connection/${id}/models`,
    );
    expect(res.status).toBe(200);
    expect(res.body.models).toEqual(
      SCRIPTED_MODELS.map((m) => ({ id: m.id, name: m.name })),
    );
  });

  test("a member may not spend the key on it", async () => {
    const id = await connectionId("anthropic");
    const res = await request(
      u.mario,
      "GET",
      `/project/${u.projectId}/model-connection/${id}/models`,
    );
    expect(res.status).toBe(403);
  });
});

describe("the real AI SDK providers talk to the scripted server", () => {
  for (const [name, provider] of [
    ["anthropic", "anthropic"],
    ["openai", "openai"],
    ["compatible", "openai-compatible"],
  ] as const) {
    test(`${provider}: generateText through an alias`, async () => {
      const alias = `talk-${name}`;
      const created = await request<ActionResponse<ModelAliasCreate>>(
        u.peach,
        "PUT",
        `/project/${u.projectId}/model-alias`,
        {
          name: alias,
          connectionId: await connectionId(name),
          modelId: "scripted-large",
          options: { maxOutputTokens: 64 },
        },
      );
      expect(created.status, JSON.stringify(created.body)).toBe(200);

      models.script(`hello from ${provider}`);
      models.reset();
      const resolved = await languageModel(u.projectId, alias);
      const result = await generateText({
        model: resolved.model,
        prompt: "Say hello.",
        maxOutputTokens: resolved.options.maxOutputTokens,
      });
      expect(result.text).toBe(`hello from ${provider}`);
      const sent = models.requests.at(-1);
      expect(sent?.method).toBe("POST");
      expect(JSON.parse(sent?.body ?? "{}").model).toBe("scripted-large");
    });
  }

  test("an alias the project lacks is a sentence an admin can act on", async () => {
    await expect(languageModel(u.projectId, "nope")).rejects.toThrow(
      /Settings → Models/,
    );
  });
});

describe("model-connection:edit", () => {
  test("rotating the key resets the status, and the new key is the one sent", async () => {
    const id = await connectionId("anthropic");
    const res = await request(
      u.peach,
      "POST",
      `/project/${u.projectId}/model-connection/${id}`,
      { apiKey: ROTATED },
    );
    expect(res.status).toBe(200);
    const rotated = res.body as unknown as {
      modelConnection: { lastFour: string; status: string };
    };
    expect(rotated.modelConnection.lastFour).toBe("wxyz");
    expect(rotated.modelConnection.status).toBe("unverified");

    models.acceptKey(ROTATED);
    models.reset();
    expect((await testConnection(id)).status).toBe("ok");
    expect(models.requests[0].headers["x-api-key"]).toBe(ROTATED);
    models.acceptKey(KEY);
  });

  test("a member may list connections but not change them", async () => {
    const list = await request<ActionResponse<ModelConnectionList>>(
      u.toad,
      "GET",
      `/project/${u.projectId}/model-connections`,
    );
    expect(list.status).toBe(200);
    expect(list.body.pagination.total).toBeGreaterThanOrEqual(5);
    const id = await connectionId("anthropic");
    const edit = await request(
      u.toad,
      "POST",
      `/project/${u.projectId}/model-connection/${id}`,
      { name: "mine now" },
    );
    expect(edit.status).toBe(403);
  });

  test("a connection of another project is not found", async () => {
    const id = await connectionId("anthropic");
    const res = await request(
      u.bowser,
      "GET",
      `/project/${u.bowser.projectId}/model-connection/${id}`,
    );
    expect(res.status).toBe(404);
  });
});

describe("model-connection:delete", () => {
  test("is refused while an alias uses the connection, naming it", async () => {
    const id = await connectionId("anthropic");
    const refused = await request(
      u.peach,
      "DELETE",
      `/project/${u.projectId}/model-connection/${id}`,
    );
    expect(refused.status).toBe(406);
    expect(refused.body.error?.message).toContain('"talk-anthropic"');
  });

  test("succeeds once nothing uses it", async () => {
    await request(
      u.peach,
      "DELETE",
      `/project/${u.projectId}/model-connection/${await connectionId("leaky")}`,
    );
    const id = await connectionId("wrong key");
    const res = await request(
      u.peach,
      "DELETE",
      `/project/${u.projectId}/model-connection/${id}`,
    );
    expect(res.status).toBe(200);
  });
});

describe("the SSRF guard", () => {
  test("refuses private, loopback, and plain-http base URLs when private hosts are not allowed", async () => {
    config.network.allowPrivateHosts = false;
    try {
      for (const baseUrl of [
        models.baseUrl("openai"),
        "http://api.example.com/v1",
        "https://10.0.0.5/v1",
        "https://169.254.169.254/latest",
        "https://[::1]/v1",
        "https://metadata.internal/v1",
        "https://user:pass@api.example.com/v1",
      ]) {
        const res = await request(
          u.peach,
          "PUT",
          `/project/${u.projectId}/model-connection`,
          { name: "ssrf", provider: "openai", baseUrl, apiKey: KEY },
        );
        expect(res.status, baseUrl).toBe(406);
        expect(res.body.error?.key, baseUrl).toBe("baseUrl");
      }
    } finally {
      config.network.allowPrivateHosts = true;
    }
  });

  test("refuses a stored loopback URL at the call, too", async () => {
    const id = await connectionId("openai");
    config.network.allowPrivateHosts = false;
    try {
      const tested = await testConnection(id);
      expect(tested.status).toBe("error");
      expect(tested.lastError).toBe("The base URL must use https.");
    } finally {
      config.network.allowPrivateHosts = true;
    }
  });
});

describe("the key never leaves the server", () => {
  test("in no response body, audit row, or log line", async () => {
    expect(bodies.length).toBeGreaterThan(20);
    for (const body of bodies) {
      expect(body).not.toContain(KEY);
      expect(body).not.toContain(ROTATED);
    }
    const rows = await api.db.db.select().from(auditLogs);
    const audited = JSON.stringify(rows);
    expect(audited).toContain("model-connection:create");
    expect(audited).not.toContain(KEY);
    expect(audited).not.toContain(ROTATED);
    for (const line of logLines) {
      expect(line).not.toContain(KEY);
      expect(line).not.toContain(ROTATED);
    }
  });
});

/**
 * A Castle connection's id by name.
 * @param name - The connection name.
 * @returns Its id.
 */
async function connectionId(name: string): Promise<number> {
  const [row] = await api.db.db
    .select({ id: modelConnections.id })
    .from(modelConnections)
    .where(eq(modelConnections.name, name));
  if (!row) throw new Error(`No connection named ${name}`);
  return row.id;
}
