import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { desc, eq } from "drizzle-orm";
import { api } from "keryx";
import { auditLogs } from "../../schema/audit_logs";
import {
  buildTestUniverse,
  call,
  HOOK_TIMEOUT,
  type TestUniverse,
} from "../setup";

/**
 * The prompt-section actions over HTTP: who may change a bot's sections and
 * the project's, the Identity section's rules, the budget refused at save,
 * deleting as archiving, and pagination.
 */
let u: TestUniverse;
let botId: number;
let base: string;

/** One section as answered. */
interface Section {
  id: number;
  key: string;
  scope: string;
  loading: string;
  agentEditable: boolean;
  currentVersion: number;
  body: string;
  archived: boolean;
}

beforeAll(async () => {
  u = await buildTestUniverse();
  base = `/project/${u.projectId}`;
  const bot = await call<{ bot: { id: number; persona: string } }>(
    u.url,
    u.peach,
    "PUT",
    `${base}/bot`,
    {
      name: "Guarded",
      persona: "You guard the gate.",
      accessRead: ["operators", "viewers"],
      accessWrite: ["operators"],
    },
  );
  if (bot.status !== 200) throw new Error(JSON.stringify(bot.body));
  botId = bot.body.bot.id;
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * List a bot's sections.
 * @param user - Who asks.
 * @returns The status and body.
 */
function listBot(user = u.peach) {
  return call<{ promptSections: Section[]; pagination: { total: number } }>(
    u.url,
    user,
    "GET",
    `${base}/prompt-sections?botId=${botId}`,
  );
}

describe("a new bot's seed sections", () => {
  test("Identity holds the persona; two empty sections are the bot's to edit", async () => {
    const res = await listBot();
    expect(res.status).toBe(200);
    expect(
      res.body.promptSections.map((s) => [
        s.key,
        s.loading,
        s.agentEditable,
        s.body,
      ]),
    ).toEqual([
      ["identity", "always", false, "You guard the gate."],
      ["how-i-work", "always", true, ""],
      ["things-i-have-learned", "always", true, ""],
    ]);
    // bot:edit's persona writes a new Identity version.
    const edited = await call<{ bot: { persona: string } }>(
      u.url,
      u.mario,
      "POST",
      `${base}/bot/${botId}`,
      { persona: "You guard both gates." },
    );
    expect(edited.body.bot.persona).toBe("You guard both gates.");
    const identity = (await listBot()).body.promptSections[0];
    expect(identity).toMatchObject({
      currentVersion: 2,
      body: "You guard both gates.",
    });
  });
});

describe("who may change what", () => {
  test("a bot's writers change its sections; readers only read; others see nothing", async () => {
    const created = await call<{ promptSection: Section }>(
      u.url,
      u.mario,
      "PUT",
      `${base}/prompt-section`,
      {
        botId,
        title: "Gate hours",
        body: "Open at dawn.",
        loading: "contextual",
      },
    );
    expect(created.status).toBe(200);
    expect(created.body.promptSection).toMatchObject({
      key: "gate-hours",
      scope: "bot",
      loading: "contextual",
      currentVersion: 1,
    });
    const id = created.body.promptSection.id;
    const [audit] = await api.db.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "prompt-section:create"))
      .orderBy(desc(auditLogs.id))
      .limit(1);
    expect(audit).toMatchObject({
      targetType: "prompt-section",
      targetPath: "guarded/gate-hours",
    });

    expect(
      (await call(u.url, u.luigi, "GET", `${base}/prompt-section/${id}`))
        .status,
    ).toBe(200);
    expect(
      (
        await call(u.url, u.luigi, "POST", `${base}/prompt-section/${id}`, {
          body: "x",
        })
      ).status,
    ).toBe(403);
    expect(
      (await call(u.url, u.toad, "GET", `${base}/prompt-section/${id}`)).status,
    ).toBe(404);
    expect((await listBot(u.toad)).status).toBe(404);
    expect(
      (
        await call(u.url, u.toad, "PUT", `${base}/prompt-section`, {
          botId,
          title: "x",
        })
      ).status,
    ).toBe(404);

    const edited = await call<{ promptSection: Section }>(
      u.url,
      u.mario,
      "POST",
      `${base}/prompt-section/${id}`,
      {
        body: "Open at dawn, close at dusk.",
        baseVersion: 1,
        changeNote: "Hours",
      },
    );
    expect(edited.body.promptSection).toMatchObject({ currentVersion: 2 });
    const stale = await call(
      u.url,
      u.mario,
      "POST",
      `${base}/prompt-section/${id}`,
      {
        body: "Never open.",
        baseVersion: 1,
      },
    );
    expect(stale.status).toBe(406);
    // Settings alone change no version.
    const settings = await call<{ promptSection: Section }>(
      u.url,
      u.mario,
      "POST",
      `${base}/prompt-section/${id}`,
      { agentEditable: true, keywords: ["gate"] },
    );
    expect(settings.body.promptSection).toMatchObject({
      currentVersion: 2,
      agentEditable: true,
    });
  });

  test("project sections: any member reads, only an admin writes, and no bot may edit one", async () => {
    const byMember = await call(
      u.url,
      u.mario,
      "PUT",
      `${base}/prompt-section`,
      {
        title: "House style",
        body: "Plain words.",
      },
    );
    expect(byMember.status).toBe(403);
    const editable = await call(
      u.url,
      u.peach,
      "PUT",
      `${base}/prompt-section`,
      {
        title: "House style",
        body: "Plain words.",
        agentEditable: true,
      },
    );
    expect(editable.status).toBe(406);
    const created = await call<{ promptSection: Section }>(
      u.url,
      u.peach,
      "PUT",
      `${base}/prompt-section`,
      { title: "House style", body: "Plain words." },
    );
    expect(created.status).toBe(200);
    expect(created.body.promptSection.scope).toBe("project");
    const list = await call<{ promptSections: Section[] }>(
      u.url,
      u.toad,
      "GET",
      `${base}/prompt-sections`,
    );
    expect(list.body.promptSections.map((s) => s.key)).toEqual(["house-style"]);
    expect(
      (
        await call(
          u.url,
          u.mario,
          "DELETE",
          `${base}/prompt-section/${created.body.promptSection.id}`,
        )
      ).status,
    ).toBe(403);
  });
});

describe("the Identity section", () => {
  test("is never editable by its bot, always loads, and cannot be deleted", async () => {
    const identity = (await listBot()).body.promptSections.find(
      (s) => s.key === "identity",
    )!;
    for (const body of [{ agentEditable: true }, { loading: "contextual" }]) {
      const res = await call(
        u.url,
        u.peach,
        "POST",
        `${base}/prompt-section/${identity.id}`,
        body,
      );
      expect(res.status, JSON.stringify(body)).toBe(406);
    }
    expect(
      (
        await call(
          u.url,
          u.peach,
          "DELETE",
          `${base}/prompt-section/${identity.id}`,
        )
      ).status,
    ).toBe(406);
    expect(
      (
        await call(u.url, u.peach, "PUT", `${base}/prompt-section`, {
          botId,
          key: "identity",
          title: "Me",
        })
      ).status,
    ).toBe(406);
  });
});

describe("the budget", () => {
  test("an always section that pushes the prompt over the budget is refused at save; a contextual one is not", async () => {
    await call(u.url, u.peach, "POST", `${base}/bot/${botId}`, {
      promptBudgetTokens: 2_000,
    });
    const huge = "Remember this. ".repeat(700);
    const always = await call<{ error: { message: string } }>(
      u.url,
      u.peach,
      "PUT",
      `${base}/prompt-section`,
      { botId, title: "Everything", body: huge },
    );
    expect(always.status).toBe(406);
    expect(always.body.error.message).toContain("over its budget of 2000");
    const contextual = await call<{ promptSection: Section }>(
      u.url,
      u.peach,
      "PUT",
      `${base}/prompt-section`,
      { botId, title: "Everything", body: huge, loading: "contextual" },
    );
    expect(contextual.status).toBe(200);
    // Making it always is the same refusal.
    const flip = await call(
      u.url,
      u.peach,
      "POST",
      `${base}/prompt-section/${contextual.body.promptSection.id}`,
      { loading: "always" },
    );
    expect(flip.status).toBe(406);
    // A lower budget that still holds the always-included parts is taken,
    // and the contextual section is dropped to fit it.
    const lower = await call(u.url, u.peach, "POST", `${base}/bot/${botId}`, {
      promptBudgetTokens: 1_000,
    });
    expect(lower.status).toBe(200);
    const preview = await call<{
      prompt: { overBudget: boolean; dropped: { key: string }[] };
    }>(
      u.url,
      u.peach,
      "GET",
      `${base}/bot/${botId}/prompt-preview?message=${encodeURIComponent("tell me everything")}`,
    );
    expect(preview.body.prompt.dropped.map((d) => d.key)).toEqual([
      "everything",
    ]);
    await call(u.url, u.peach, "POST", `${base}/bot/${botId}`, {
      promptBudgetTokens: 8_000,
    });
  });
});

describe("delete and list", () => {
  test("delete archives, frees the key, and keeps the versions; lists paginate", async () => {
    const created = await call<{ promptSection: Section }>(
      u.url,
      u.peach,
      "PUT",
      `${base}/prompt-section`,
      { botId, key: "drills", title: "Drills", body: "Weekly." },
    );
    const id = created.body.promptSection.id;
    expect(
      (await call(u.url, u.peach, "DELETE", `${base}/prompt-section/${id}`))
        .status,
    ).toBe(200);
    expect(
      (await listBot()).body.promptSections.map((s) => s.key),
    ).not.toContain("drills");
    const again = await call(u.url, u.peach, "PUT", `${base}/prompt-section`, {
      botId,
      key: "drills",
      title: "Drills",
      body: "Daily.",
    });
    expect(again.status).toBe(200);
    const versions = await call<{ versions: { body: string }[] }>(
      u.url,
      u.peach,
      "GET",
      `${base}/prompt-section/${id}/versions`,
    );
    expect(versions.body.versions.map((v) => v.body)).toEqual(["Weekly."]);
    const archived = await call<{ promptSections: Section[] }>(
      u.url,
      u.peach,
      "GET",
      `${base}/prompt-sections?botId=${botId}&includeArchived=true`,
    );
    expect(
      archived.body.promptSections.find((s) => s.id === id)?.archived,
    ).toBe(true);

    const page = await call<{
      promptSections: Section[];
      pagination: { page: number; limit: number; total: number; pages: number };
    }>(
      u.url,
      u.peach,
      "GET",
      `${base}/prompt-sections?botId=${botId}&limit=2&page=1`,
    );
    expect(page.body.promptSections).toHaveLength(2);
    expect(page.body.pagination).toMatchObject({ page: 1, limit: 2 });
    expect(page.body.pagination.total).toBeGreaterThanOrEqual(5);
  });
});
