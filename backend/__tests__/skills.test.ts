import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { api } from "keryx";
import { renderSkill, SkillArgumentError } from "../ops/SkillOps";
import type { SkillArgument } from "../schema/skills";
import {
  type AgentStage,
  buildAgentStage,
  clearLoopQueues,
  readEntries,
  runTicks,
  startConversation,
} from "./agent/harness";
import { botCalls, sentSystem, toolOutputs } from "./prompt/harness";
import { call, HOOK_TIMEOUT } from "./setup";

/**
 * Skills: botholomew's substitution rules, `use_skill` for attached skills
 * only, pinned versions, and a person's `/name args…` expanded at delivery.
 */

const RELEASE_ARGS: SkillArgument[] = [
  { name: "since", description: "date or tag", required: true },
  { name: "audience", required: false, default: "customers" },
];

describe("substitution", () => {
  const body =
    "Since $since for $audience. First: $1. Second: $2. All: $ARGUMENTS.";

  test("named, positional, $ARGUMENTS, and defaults", () => {
    expect(renderSkill(body, RELEASE_ARGS, "v2.1")).toBe(
      "Since v2.1 for customers. First: v2.1. Second: customers. All: v2.1.",
    );
    expect(
      renderSkill(body, RELEASE_ARGS, { since: "v3", audience: "engineers" }),
    ).toBe(
      "Since v3 for engineers. First: v3. Second: engineers. All: v3 engineers.",
    );
    expect(renderSkill(body, RELEASE_ARGS, "audience:partners since:v4")).toBe(
      "Since v4 for partners. First: v4. Second: partners. All: audience:partners since:v4.",
    );
  });

  test("the last positional argument takes the rest; quotes group words", () => {
    expect(
      renderSkill(
        "[$since] [$audience]",
        RELEASE_ARGS,
        "v2.1 the whole sales team",
      ),
    ).toBe("[v2.1] [the whole sales team]");
    expect(
      renderSkill("[$since] [$audience]", RELEASE_ARGS, '"last tuesday" ops'),
    ).toBe("[last tuesday] [ops]");
  });

  test("with no declared arguments, $N is the Nth word; unknown $names are left alone", () => {
    expect(
      renderSkill("$1 and $2; $HOME stays; $9 too", [], "alpha beta"),
    ).toBe("alpha and beta; $HOME stays; $9 too");
  });

  test("a missing required argument, or an unknown named one, is an error", () => {
    expect(() => renderSkill(body, RELEASE_ARGS, "")).toThrow(
      SkillArgumentError,
    );
    expect(() => renderSkill(body, RELEASE_ARGS, "")).toThrow(
      '"since" is required',
    );
    expect(() => renderSkill(body, RELEASE_ARGS, { sincee: "v2" })).toThrow(
      'no argument "sincee"',
    );
  });
});

let stage: AgentStage;
let skillId: number;
const base = () => `/project/${stage.u.projectId}`;

beforeAll(async () => {
  stage = await buildAgentStage("anthropic");
  const res = await call<{ skill: { id: number } }>(
    stage.u.url,
    stage.u.peach,
    "PUT",
    `${base()}/skill`,
    {
      name: "release-notes",
      description: "Write release notes from merged pull requests",
      arguments: RELEASE_ARGS,
      body: "Write release notes for everything merged since $since, for $audience.",
    },
  );
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  skillId = res.body.skill.id;
}, HOOK_TIMEOUT);

afterEach(async () => {
  await clearLoopQueues();
  expect(stage.models.expectationFailures).toEqual([]);
  stage.models.reset();
});

afterAll(async () => {
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

describe("use_skill", () => {
  test("only an attached skill can be used", async () => {
    const id = await botCalls(stage, [
      [
        {
          name: "use_skill",
          input: { name: "release-notes", arguments: "v2" },
        },
      ],
    ]);
    const [out] = await toolOutputs(stage, id, "use_skill");
    expect(out).toMatchObject({ is_error: true, error_type: "not_found" });
  });

  test("an attached skill renders, is in the prompt's index, and reports bad arguments", async () => {
    const attached = await call(
      stage.u.url,
      stage.u.peach,
      "PUT",
      `${base()}/bot/${stage.botId}/skill`,
      {
        skillId,
      },
    );
    expect(attached.status).toBe(200);
    const id = await botCalls(stage, [
      [{ name: "skill_list", input: {} }],
      [
        {
          name: "use_skill",
          input: { name: "release-notes", arguments: { since: "v2.0" } },
        },
      ],
      [{ name: "use_skill", input: { name: "release-notes" } }],
    ]);
    expect(sentSystem(stage)).toContain(
      "- `release-notes` — Write release notes from merged pull requests (arguments: since, audience?)",
    );
    const [listed] = await toolOutputs(stage, id, "skill_list");
    expect((listed.skills as { name: string }[]).map((s) => s.name)).toEqual([
      "release-notes",
    ]);
    const [ok, missing] = await toolOutputs(stage, id, "use_skill");
    expect(ok).toEqual({
      name: "release-notes",
      version: 1,
      instructions:
        "Write release notes for everything merged since v2.0, for customers.",
    });
    expect(missing).toMatchObject({
      is_error: true,
      error_type: "invalid_arguments",
    });
    expect(String(missing.message)).toContain('"since" is required');
  });

  test("a pinned version keeps its text after the skill changes", async () => {
    const edited = await call<{ skill: { currentVersion: number } }>(
      stage.u.url,
      stage.u.peach,
      "POST",
      `${base()}/skill/${skillId}`,
      {
        body: "NEW: notes since $since for $audience.",
        description: "Short release notes",
        changeNote: "Shorter",
      },
    );
    expect(edited.body.skill.currentVersion).toBe(2);
    const pin = await call<{
      botSkill: { description: string; version: number };
    }>(
      stage.u.url,
      stage.u.peach,
      "PUT",
      `${base()}/bot/${stage.botId}/skill`,
      { skillId, pinnedVersion: 1 },
    );
    // The attachment reports the version the bot uses, not the newest.
    expect(pin.body.botSkill).toMatchObject({
      version: 1,
      description: "Write release notes from merged pull requests",
    });
    const listed = await call<{ botSkills: { description: string }[] }>(
      stage.u.url,
      stage.u.peach,
      "GET",
      `${base()}/bot/${stage.botId}/skills`,
    );
    expect(listed.body.botSkills[0].description).toBe(
      "Write release notes from merged pull requests",
    );
    const pinned = await botCalls(stage, [
      [
        {
          name: "use_skill",
          input: { name: "release-notes", arguments: "v3" },
        },
      ],
    ]);
    expect((await toolOutputs(stage, pinned, "use_skill"))[0]).toMatchObject({
      version: 1,
      instructions:
        "Write release notes for everything merged since v3, for customers.",
    });

    await call(
      stage.u.url,
      stage.u.peach,
      "PUT",
      `${base()}/bot/${stage.botId}/skill`,
      {
        skillId,
        pinnedVersion: null,
      },
    );
    const latest = await botCalls(stage, [
      [
        {
          name: "use_skill",
          input: { name: "release-notes", arguments: "v3" },
        },
      ],
    ]);
    expect((await toolOutputs(stage, latest, "use_skill"))[0]).toMatchObject({
      version: 2,
      instructions: "NEW: notes since v3 for customers.",
    });

    const badPin = await call(
      stage.u.url,
      stage.u.peach,
      "PUT",
      `${base()}/bot/${stage.botId}/skill`,
      {
        skillId,
        pinnedVersion: 9,
      },
    );
    expect(badPin.status).toBe(406);
  });
});

describe("a person's /skill message", () => {
  test("/release-notes since:v2 expands at delivery: the transcript keeps the message, the model reads the expansion", async () => {
    stage.models.play([
      {
        toolCalls: [
          { name: "reply_and_wait", input: { text: "Writing them." } },
        ],
        expect: { lastMessageIncludes: "NEW: notes since v2 for customers." },
      },
    ]);
    const res = await startConversation(
      stage,
      "@toadsworth /release-notes since:v2",
    );
    await runTicks();
    const { entries } = await readEntries(stage, res.body.conversation.id);
    const message = entries.find(
      (e) => e.kind === "message" && e.role === "user",
    );
    expect(message?.content).toMatchObject({
      text: "@toadsworth /release-notes since:v2",
      skill: {
        name: "release-notes",
        version: 2,
        arguments: "since:v2",
        text: "NEW: notes since v2 for customers.",
      },
    });
    const expansion = entries.find(
      (e) => e.kind === "context_update" && !e.promptHash,
    );
    expect(expansion?.content).toMatchObject({
      skill: {
        name: "release-notes",
        text: "NEW: notes since v2 for customers.",
      },
    });
    expect(expansion!.seq).toBe(message!.seq + 1);
  });

  test("missing arguments reach the model as a note to pass on; an unknown /name is plain text", async () => {
    stage.models.play([
      {
        toolCalls: [
          { name: "reply_and_wait", input: { text: "It needs since." } },
        ],
        expect: { lastMessageIncludes: "could not be filled in" },
      },
      {
        toolCalls: [{ name: "reply_and_wait", input: { text: "?" } }],
        expect: { lastMessageIncludes: "/no-such-skill now" },
      },
    ]);
    await startConversation(stage, "/release-notes");
    await runTicks();
    const plain = await startConversation(stage, "/no-such-skill now");
    await runTicks();
    const { entries } = await readEntries(stage, plain.body.conversation.id);
    expect(
      entries.find((e) => e.kind === "message" && e.role === "user")?.content,
    ).not.toHaveProperty("skill");
  });
});

describe("the human actions", () => {
  test("access lists gate read and write; versions and attachments are listed", async () => {
    const guarded = await call<{ skill: { id: number } }>(
      stage.u.url,
      stage.u.mario,
      "PUT",
      `${base()}/skill`,
      {
        name: "incident-review",
        description: "Run an incident review",
        body: "Review $ARGUMENTS.",
        accessRead: ["operators"],
        accessWrite: ["operators"],
      },
    );
    expect(guarded.status).toBe(200);
    const id = guarded.body.skill.id;

    // Luigi cannot see it at all, so he cannot change it either; Peach
    // (admin) can.
    expect(
      (await call(stage.u.url, stage.u.luigi, "GET", `${base()}/skill/${id}`))
        .status,
    ).toBe(404);
    const luigiList = await call<{ skills: { name: string }[] }>(
      stage.u.url,
      stage.u.luigi,
      "GET",
      `${base()}/skills`,
    );
    expect(luigiList.body.skills.map((s) => s.name)).toEqual(["release-notes"]);
    expect(
      (
        await call(
          stage.u.url,
          stage.u.peach,
          "POST",
          `${base()}/skill/${id}`,
          { description: "Review an incident" },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call(
          stage.u.url,
          stage.u.luigi,
          "POST",
          `${base()}/skill/${id}`,
          { description: "x" },
        )
      ).status,
    ).toBe(404);

    // A non-admin cannot save lists that lock them out.
    const locked = await call(
      stage.u.url,
      stage.u.toad,
      "PUT",
      `${base()}/skill`,
      {
        name: "secret",
        description: "x",
        body: "x",
        accessWrite: ["operators"],
      },
    );
    expect(locked.status).toBe(406);

    const dupe = await call(
      stage.u.url,
      stage.u.peach,
      "PUT",
      `${base()}/skill`,
      {
        name: "release-notes",
        description: "x",
        body: "x",
      },
    );
    expect(dupe.status).toBe(406);

    const versions = await call<{
      versions: { version: number }[];
      pagination: { total: number };
    }>(
      stage.u.url,
      stage.u.peach,
      "GET",
      `${base()}/skill/${skillId}/versions?limit=1`,
    );
    expect(versions.body.versions.map((v) => v.version)).toEqual([2]);
    expect(versions.body.pagination.total).toBe(2);

    const attached = await call<{
      botSkills: {
        name: string;
        version: number;
        pinnedVersion: number | null;
      }[];
      pagination: { total: number };
    }>(
      stage.u.url,
      stage.u.luigi,
      "GET",
      `${base()}/bot/${stage.botId}/skills`,
    );
    expect(attached.body.botSkills).toEqual([
      expect.objectContaining({
        name: "release-notes",
        version: 2,
        pinnedVersion: null,
      }),
    ]);

    const detached = await call(
      stage.u.url,
      stage.u.peach,
      "DELETE",
      `${base()}/bot/${stage.botId}/skill/${skillId}`,
    );
    expect(detached.status).toBe(200);
    expect(
      (
        await call(
          stage.u.url,
          stage.u.peach,
          "DELETE",
          `${base()}/bot/${stage.botId}/skill/${skillId}`,
        )
      ).status,
    ).toBe(404);

    const removed = await call(
      stage.u.url,
      stage.u.peach,
      "DELETE",
      `${base()}/skill/${id}`,
    );
    expect(removed.status).toBe(200);
  });
});
