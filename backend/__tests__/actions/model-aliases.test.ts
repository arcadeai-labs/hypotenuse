import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ActionResponse, api } from "keryx";
import type { BotCreate } from "../../actions/bot/bot-create";
import type { ModelAliasCreate } from "../../actions/model-alias/model-alias-create";
import type { ModelAliasEdit } from "../../actions/model-alias/model-alias-edit";
import type { ModelAliasList } from "../../actions/model-alias/model-alias-list";
import type { ModelConnectionCreate } from "../../actions/model-connection/model-connection-create";
import {
  buildTestUniverse,
  call,
  HOOK_TIMEOUT,
  type TestUniverse,
} from "../setup";

let u: TestUniverse;
let connectionId: number;
let otherConnectionId: number;

beforeAll(async () => {
  u = await buildTestUniverse();
  for (const name of ["primary", "secondary"]) {
    const res = await call<ActionResponse<ModelConnectionCreate>>(
      u.url,
      u.peach,
      "PUT",
      `/project/${u.projectId}/model-connection`,
      {
        name,
        provider: "openai-compatible",
        baseUrl: "http://127.0.0.1:9/v1",
        apiKey: "sk-alias-suite-key-0000",
      },
    );
    if (res.status !== 200) throw new Error(JSON.stringify(res.body));
    if (name === "primary") connectionId = res.body.modelConnection.id;
    else otherConnectionId = res.body.modelConnection.id;
  }
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * Create an alias in Castle as Peach.
 * @param name - The alias name.
 * @param extra - Other fields.
 * @returns The status and body.
 */
async function createAlias(name: string, extra: Record<string, unknown> = {}) {
  return call<ActionResponse<ModelAliasCreate>>(
    u.url,
    u.peach,
    "PUT",
    `/project/${u.projectId}/model-alias`,
    { name, connectionId, modelId: "scripted-large", ...extra },
  );
}

/**
 * Castle's aliases as Toad (a member with no tags) sees them.
 * @returns The list body.
 */
async function listAliases() {
  const res = await call<ActionResponse<ModelAliasList>>(
    u.url,
    u.toad,
    "GET",
    `/project/${u.projectId}/model-aliases`,
  );
  expect(res.status).toBe(200);
  return res.body;
}

describe("the required names", () => {
  test("a new project is missing both, and every member can see it", async () => {
    const list = await listAliases();
    expect(list.modelAliases).toEqual([]);
    expect(list.missingRequired).toEqual(["default", "fast"]);
  });

  test("once defined, they sort first and are marked reserved", async () => {
    expect((await createAlias("reasoning")).status).toBe(200);
    expect(
      (await createAlias("fast", { modelId: "scripted-small" })).status,
    ).toBe(200);
    expect(
      (
        await createAlias("default", {
          options: { maxOutputTokens: 4096, temperature: 0.3 },
        })
      ).status,
    ).toBe(200);
    const list = await listAliases();
    expect(list.missingRequired).toEqual([]);
    expect(list.modelAliases.map((a) => [a.name, a.reserved])).toEqual([
      ["default", true],
      ["fast", true],
      ["reasoning", false],
    ]);
    expect(list.modelAliases[0]).toMatchObject({
      connectionName: "primary",
      provider: "openai-compatible",
      modelId: "scripted-large",
      options: { maxOutputTokens: 4096, temperature: 0.3 },
    });
  });

  test("a required name cannot be renamed away", async () => {
    const list = await listAliases();
    const fast = list.modelAliases.find((a) => a.name === "fast")!;
    const res = await call(
      u.url,
      u.peach,
      "POST",
      `/project/${u.projectId}/model-alias/${fast.id}`,
      { name: "quick" },
    );
    expect(res.status).toBe(406);
    expect(res.body.error?.message).toContain("required");
  });
});

describe("names", () => {
  test("are unique per project", async () => {
    const res = await createAlias("default");
    expect(res.status).toBe(406);
    expect(res.body.error?.key).toBe("name");
  });

  test("are lowercase letters, digits, and dashes", async () => {
    for (const name of ["Default", "has space", "under_score", ""]) {
      expect((await createAlias(name)).status, name).toBe(406);
    }
  });

  test("another project may reuse them", async () => {
    const own = await call<ActionResponse<ModelConnectionCreate>>(
      u.url,
      u.bowser,
      "PUT",
      `/project/${u.bowser.projectId}/model-connection`,
      {
        name: "koopa",
        provider: "openai",
        baseUrl: "http://127.0.0.1:9/v1",
        apiKey: "sk-koopa-key-00000000",
      },
    );
    const res = await call(
      u.url,
      u.bowser,
      "PUT",
      `/project/${u.bowser.projectId}/model-alias`,
      {
        name: "default",
        connectionId: own.body.modelConnection.id,
        modelId: "m",
      },
    );
    expect(res.status).toBe(200);
  });

  test("a connection of another project cannot be named", async () => {
    const res = await call(
      u.url,
      u.bowser,
      "PUT",
      `/project/${u.bowser.projectId}/model-alias`,
      { name: "stolen", connectionId, modelId: "m" },
    );
    expect(res.status).toBe(404);
  });
});

describe("options", () => {
  test("are validated", async () => {
    for (const options of [
      { temperature: 3 },
      { maxOutputTokens: -1 },
      { unknownOption: true },
    ]) {
      expect((await createAlias("tuned", { options })).status).toBe(406);
    }
  });
});

describe("model-alias:edit", () => {
  test("repoints an alias at another connection and model", async () => {
    const list = await listAliases();
    const reasoning = list.modelAliases.find((a) => a.name === "reasoning")!;
    const res = await call<ActionResponse<ModelAliasEdit>>(
      u.url,
      u.peach,
      "POST",
      `/project/${u.projectId}/model-alias/${reasoning.id}`,
      { connectionId: otherConnectionId, modelId: "scripted-small" },
    );
    expect(res.status).toBe(200);
    expect(res.body.modelAlias).toMatchObject({
      connectionName: "secondary",
      modelId: "scripted-small",
    });
  });

  test("is admin-only", async () => {
    const list = await listAliases();
    const res = await call(
      u.url,
      u.mario,
      "POST",
      `/project/${u.projectId}/model-alias/${list.modelAliases[0].id}`,
      { modelId: "cheaper" },
    );
    expect(res.status).toBe(403);
  });
});

describe("an alias a bot names", () => {
  test("cannot be deleted or renamed, and the refusal lists the bots", async () => {
    const bot = await call<ActionResponse<BotCreate>>(
      u.url,
      u.mario,
      "PUT",
      `/project/${u.projectId}/bot`,
      {
        name: "Thinker",
        persona: "You think hard.",
        modelAlias: "reasoning",
      },
    );
    expect(bot.status, JSON.stringify(bot.body)).toBe(200);

    const list = await listAliases();
    const reasoning = list.modelAliases.find((a) => a.name === "reasoning")!;
    const deleted = await call(
      u.url,
      u.peach,
      "DELETE",
      `/project/${u.projectId}/model-alias/${reasoning.id}`,
    );
    expect(deleted.status).toBe(406);
    expect(deleted.body.error?.message).toContain('"Thinker"');

    const renamed = await call(
      u.url,
      u.peach,
      "POST",
      `/project/${u.projectId}/model-alias/${reasoning.id}`,
      { name: "deep" },
    );
    expect(renamed.status).toBe(406);
    expect(renamed.body.error?.message).toContain('"Thinker"');

    // Every bot names `default` and `fast` unless told otherwise.
    const fast = list.modelAliases.find((a) => a.name === "fast")!;
    const fastDeleted = await call(
      u.url,
      u.peach,
      "DELETE",
      `/project/${u.projectId}/model-alias/${fast.id}`,
    );
    expect(fastDeleted.status).toBe(406);
  });

  test("can be deleted once no bot names it", async () => {
    const created = await createAlias("spare");
    const res = await call(
      u.url,
      u.peach,
      "DELETE",
      `/project/${u.projectId}/model-alias/${created.body.modelAlias.id}`,
    );
    expect(res.status).toBe(200);
  });
});
