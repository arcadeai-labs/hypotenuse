import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { and, desc, eq } from "drizzle-orm";
import { api } from "keryx";
import { auditLogs } from "../../schema/audit_logs";
import { conversationEntries } from "../../schema/conversation_entries";
import { promptSectionVersions } from "../../schema/prompt_sections";
import {
  type AgentStage,
  buildAgentStage,
  clearLoopQueues,
} from "../agent/harness";
import { call, HOOK_TIMEOUT } from "../setup";
import {
  botCalls,
  botCallsIn,
  editSection,
  promptUpdates,
  sectionId,
  sentSystem,
  toolOutputs,
} from "./harness";

/**
 * A bot editing its own prompt: only sections a person marked editable, on
 * itself, against the version it read, with the conversation and entry that
 * caused it on the version row — and a person can revert it, audited.
 */
let stage: AgentStage;

beforeAll(async () => {
  stage = await buildAgentStage("anthropic");
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

const LEARNED = "This team calls staging *preprod*.";

describe("prompt_edit on an editable section", () => {
  test("writes an agent version with provenance, and the next step sees it", async () => {
    const learned = await sectionId(stage.botId, "things-i-have-learned");
    const id = await botCalls(stage, [
      [{ name: "prompt_list", input: {} }],
      [{ name: "prompt_read", input: { section: "things-i-have-learned" } }],
      [
        {
          name: "prompt_edit",
          input: {
            section: learned,
            baseVersion: 1,
            changeNote: "Peach told me what they call staging.",
            patches: [{ start_line: 1, end_line: 1, content: LEARNED }],
          },
        },
      ],
    ]);

    const [list] = await toolOutputs(stage, id, "prompt_list");
    const sections = list.sections as { key: string; editable: boolean }[];
    expect(
      Object.fromEntries(sections.map((s) => [s.key, s.editable])),
    ).toMatchObject({
      identity: false,
      "how-i-work": true,
      "things-i-have-learned": true,
    });
    expect(list.agentSectionsLeft).toBe(10);
    const [read] = await toolOutputs(stage, id, "prompt_read");
    expect(read).toMatchObject({ version: 1, editable: true, content: "1\t" });
    const [edit] = await toolOutputs(stage, id, "prompt_edit");
    expect(edit).toEqual({
      id: learned,
      key: "things-i-have-learned",
      version: 2,
    });

    const [version] = await api.db.db
      .select()
      .from(promptSectionVersions)
      .where(
        and(
          eq(promptSectionVersions.sectionId, learned),
          eq(promptSectionVersions.version, 2),
        ),
      );
    const [intent] = await api.db.db
      .select()
      .from(conversationEntries)
      .where(
        and(
          eq(conversationEntries.conversationId, id),
          eq(conversationEntries.kind, "tool_call_intent"),
          eq(conversationEntries.toolName, "prompt_edit"),
        ),
      );
    expect(version).toMatchObject({
      body: LEARNED,
      source: "agent",
      conversationId: id,
      entryId: intent.id,
      userId: null,
      changeNote: "Peach told me what they call staging.",
    });

    // The step after the edit was sent the new text, and its context_update
    // names the section it added.
    expect(sentSystem(stage)).toContain(
      `## Things I have learned\n\n${LEARNED}`,
    );
    const updates = await promptUpdates(stage, id);
    expect(updates).toHaveLength(2);
    expect((updates[1].content as { added: unknown }).added).toEqual([
      { id: learned, key: "things-i-have-learned", version: 2 },
    ]);
  });

  test("a person reverts it, as a new version, audited", async () => {
    const learned = await sectionId(stage.botId, "things-i-have-learned");
    const res = await call<{
      promptSection: { currentVersion: number; body: string };
    }>(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/prompt-section/${learned}/revert`,
      { version: 1 },
    );
    expect(res.status).toBe(200);
    expect(res.body.promptSection).toMatchObject({
      currentVersion: 3,
      body: "",
    });
    const [audit] = await api.db.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "prompt-section:revert"))
      .orderBy(desc(auditLogs.id))
      .limit(1);
    expect(audit).toMatchObject({ targetType: "prompt-section" });
    expect((audit.before as { body: string }).body).toBe(LEARNED);
    expect((audit.after as { body: string }).body).toBe("");

    const versions = await call<{
      versions: {
        version: number;
        source: string;
        conversationId: number | null;
      }[];
    }>(
      stage.u.url,
      stage.u.peach,
      "GET",
      `/project/${stage.u.projectId}/prompt-section/${learned}/versions`,
    );
    expect(versions.body.versions.map((v) => [v.version, v.source])).toEqual([
      [3, "revert"],
      [2, "agent"],
      [1, "seed"],
    ]);
    expect(versions.body.versions[1].conversationId).not.toBeNull();
  });
});

describe("refusals", () => {
  test("a section that is not editable, or the project's, is refused with who can change it", async () => {
    const identity = await sectionId(stage.botId, "identity");
    const project = await call<{ promptSection: { id: number } }>(
      stage.u.url,
      stage.u.peach,
      "PUT",
      `/project/${stage.u.projectId}/prompt-section`,
      { title: "House style", body: "Write plainly." },
    );
    expect(project.status).toBe(200);
    const patch = [{ start_line: 1, end_line: 1, content: "I am Bowser." }];
    const id = await botCalls(stage, [
      [
        {
          name: "prompt_edit",
          input: {
            section: identity,
            baseVersion: 1,
            changeNote: "x",
            patches: patch,
          },
        },
      ],
      [
        {
          name: "prompt_edit",
          input: {
            section: project.body.promptSection.id,
            baseVersion: 1,
            changeNote: "x",
            patches: patch,
          },
        },
      ],
    ]);
    const [own, shared] = await toolOutputs(stage, id, "prompt_edit");
    expect(own).toMatchObject({ is_error: true, error_type: "not_editable" });
    expect(String(own.next_action_hint)).toContain("Prompt tab");
    expect(shared).toMatchObject({
      is_error: true,
      error_type: "not_editable",
    });
    expect(String(shared.next_action_hint)).toContain("project admin");
  });

  test("a stale baseVersion is refused, naming the current one", async () => {
    const howIWork = await sectionId(stage.botId, "how-i-work");
    await editSection(stage, howIWork, { body: "A person wrote this." });
    const id = await botCalls(stage, [
      [
        {
          name: "prompt_edit",
          input: {
            section: "how-i-work",
            baseVersion: 1,
            changeNote: "x",
            patches: [{ start_line: 1, end_line: 1, content: "Mine now." }],
          },
        },
      ],
    ]);
    const [out] = await toolOutputs(stage, id, "prompt_edit");
    expect(out).toMatchObject({
      is_error: true,
      error_type: "version_conflict",
    });
    expect(String(out.message)).toContain("current version is 2");
  });

  test("another bot's section is not found", async () => {
    const other = await call<{ bot: { id: number } }>(
      stage.u.url,
      stage.u.peach,
      "PUT",
      `/project/${stage.u.projectId}/bot`,
      { name: "Kamek", persona: "A wizard." },
    );
    const theirs = await sectionId(other.body.bot.id, "how-i-work");
    const id = await botCalls(stage, [
      [{ name: "prompt_read", input: { section: theirs } }],
    ]);
    const [out] = await toolOutputs(stage, id, "prompt_read");
    expect(out).toMatchObject({ is_error: true, error_type: "not_found" });
  });
});

describe("prompt_create", () => {
  test("adds a contextual, editable section of the bot's own, up to the cap", async () => {
    const capped = await call(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/bot/${stage.botId}`,
      { maxAgentSections: 1 },
    );
    expect(capped.status).toBe(200);
    const create = (title: string) => ({
      name: "prompt_create",
      input: {
        title,
        body: `How ${title.toLowerCase()} works here.`,
        keywords: ["preprod"],
        changeNote: "Learned it today.",
      },
    });
    const id = await botCalls(stage, [
      [create("Preprod deploys")],
      [create("Rollbacks")],
    ]);
    const [first, second] = await toolOutputs(stage, id, "prompt_create");
    expect(first).toMatchObject({ key: "preprod-deploys", version: 1 });
    expect(second).toMatchObject({
      is_error: true,
      error_type: "limit_reached",
    });
    const sections = await call<{
      promptSections: {
        key: string;
        loading: string;
        agentEditable: boolean;
        origin: string;
      }[];
    }>(
      stage.u.url,
      stage.u.peach,
      "GET",
      `/project/${stage.u.projectId}/prompt-sections?botId=${stage.botId}`,
    );
    expect(
      sections.body.promptSections.find((s) => s.key === "preprod-deploys"),
    ).toMatchObject({
      loading: "contextual",
      agentEditable: true,
      origin: "agent",
    });

    // It comes in when its keyword does.
    await botCallsIn(stage, id, [], "Ship it to preprod.");
    expect(sentSystem(stage)).toContain("## Preprod deploys");
  });
});
