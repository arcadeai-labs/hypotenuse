import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { api } from "keryx";
import { decayFactor } from "../../ops/MemoryOps";
import { memoryDocuments } from "../../schema/memory_documents";
import { clearLoopQueues } from "../agent/harness";
import { call, HOOK_TIMEOUT, runAction } from "../setup";
import {
  botCalls,
  buildMemoryStage,
  channelOf,
  clearMemory,
  getMemory,
  type MemoryStage,
  runMemoryJobs,
  writeMemory,
} from "./harness";

/**
 * Decay: the factor itself, its weight in ranking, and the clock that
 * tombstones faded channel memory and prunes old versions. Time is moved by
 * writing columns.
 */
let stage: MemoryStage;
let channelId: number;

beforeAll(async () => {
  stage = await buildMemoryStage({ embedding: false });
  channelId = await channelOf(await botCalls(stage, "lobby", []));
}, HOOK_TIMEOUT);

afterEach(async () => {
  await clearLoopQueues();
  await clearMemory();
  stage.models.reset();
});

afterAll(async () => {
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

const DAY = 86_400_000;

/**
 * Age every version of a path by writing its timestamps.
 * @param path - The path.
 * @param days - How many days ago it was written.
 * @param extra - Other columns to set.
 */
async function age(
  path: string,
  days: number,
  extra: Partial<typeof memoryDocuments.$inferInsert> = {},
): Promise<void> {
  await api.db.db
    .update(memoryDocuments)
    .set({ createdAt: new Date(Date.now() - days * DAY), ...extra })
    .where(eq(memoryDocuments.logicalPath, path));
}

/**
 * The current row of a path in a scope.
 * @param path - The path.
 * @param scope - The scope.
 * @returns The row.
 */
async function current(path: string, scope: "channel" | "project") {
  const [row] = await api.db.db
    .select()
    .from(memoryDocuments)
    .where(
      and(
        eq(memoryDocuments.logicalPath, path),
        eq(memoryDocuments.scope, scope),
        eq(memoryDocuments.isCurrent, true),
      ),
    );
  return row;
}

/** Run the clock and every project run it fans out. */
async function runDecayClock(): Promise<void> {
  await runAction("memory:decay");
  await runMemoryJobs("memory:decay-project");
}

describe("the decay factor", () => {
  const now = Date.UTC(2026, 9, 30);
  const at = (daysAgo: number, extra = {}) => ({
    pinned: false,
    createdAt: new Date(now - daysAgo * DAY),
    lastAccessedAt: null,
    ...extra,
  });

  test("1 when new, ½ at one half-life, 2⁻¹⁰ at ten", () => {
    expect(decayFactor(at(0), 30, now)).toBe(1);
    expect(decayFactor(at(30), 30, now)).toBeCloseTo(0.5, 12);
    expect(decayFactor(at(300), 30, now)).toBeCloseTo(2 ** -10, 12);
  });

  test("a pinned memory never decays", () => {
    expect(decayFactor(at(3000, { pinned: true }), 30, now)).toBe(1);
  });

  test("age counts from the last use when that is newer", () => {
    const used = at(300, { lastAccessedAt: new Date(now - 30 * DAY) });
    expect(decayFactor(used, 30, now)).toBeCloseTo(0.5, 12);
  });
});

describe("decay in ranking", () => {
  test("a memory one half-life old keeps the floor plus three quarters of half", async () => {
    await writeMemory(stage, {
      scope: "project",
      path: "facts/fresh.md",
      content: "The orchard has apple trees.",
    });
    await writeMemory(stage, {
      scope: "project",
      path: "facts/stale.md",
      content: "The orchard has pear trees.",
    });
    await age("facts/stale.md", 180); // the project half-life
    const res = await getMemory<{
      hits: { path: string; relevance: number; decay: number; score: number }[];
    }>(stage, "memory/search", { query: "orchard trees", scope: "project" });
    const stale = res.body.hits.find((h) => h.path === "facts/stale.md");
    expect(stale?.decay).toBeCloseTo(0.5, 3);
    expect(stale?.score).toBeCloseTo((stale?.relevance ?? 0) * 0.625, 3);
    // The old memory still shows: decay ranks, it does not hide.
    expect(res.body.hits.map((h) => h.path).sort()).toEqual([
      "facts/fresh.md",
      "facts/stale.md",
    ]);
  });
});

describe("the decay clock", () => {
  test("it forgets a channel memory only once it has faded for the project's slowest-fading bot", async () => {
    // Every bot in a channel shares its memory: a bot whose channel half-life
    // is a year still finds a 300-day-old memory, so the clock keeps it.
    const slow = await call<{ bot: { id: number } }>(
      stage.u.url,
      stage.u.peach,
      "PUT",
      `/project/${stage.u.projectId}/bot`,
      {
        name: "Slowpoke",
        persona: "You remember for a long time.",
        memoryChannelHalfLifeDays: 365,
      },
    );
    expect(slow.status).toBe(200);
    const channel = { scope: "channel", channelId };
    await writeMemory(stage, {
      ...channel,
      path: "facts/old.md",
      content: "An old fact.",
    });
    await age("facts/old.md", 300);
    await runDecayClock();
    expect((await current("facts/old.md", "channel")).tombstone).toBe(false);

    // With that bot gone, the longest half-life is 30 days again.
    const deleted = await call(
      stage.u.url,
      stage.u.peach,
      "DELETE",
      `/project/${stage.u.projectId}/bot/${slow.body.bot.id}`,
    );
    expect(deleted.status).toBe(200);
    await runDecayClock();
    expect((await current("facts/old.md", "channel")).tombstone).toBe(true);
  });

  test("it tombstones faded channel memory, and spares pinned, well-used, and project memory", async () => {
    const channel = { scope: "channel", channelId };
    for (const path of [
      "facts/faded.md",
      "facts/pinned.md",
      "facts/used.md",
      "facts/recent.md",
    ]) {
      const res = await writeMemory(stage, {
        ...channel,
        path,
        content: `About ${path}.`,
      });
      expect(res.status).toBe(200);
    }
    await writeMemory(stage, {
      scope: "project",
      path: "facts/faded.md",
      content: "Project memory never fades on its own.",
    });
    const pin = await call(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/memory/document/pin`,
      { ...channel, path: "facts/pinned.md", pinned: true },
    );
    expect(pin.status).toBe(200);
    // Ten channel half-lives (30 days each): decay 2⁻¹⁰ < 0.05.
    for (const path of ["facts/faded.md", "facts/pinned.md", "facts/used.md"]) {
      await age(path, 300);
    }
    await api.db.db
      .update(memoryDocuments)
      .set({ accessCount: 3 })
      .where(eq(memoryDocuments.logicalPath, "facts/used.md"));
    await age("facts/recent.md", 30);

    await runDecayClock();

    const faded = await current("facts/faded.md", "channel");
    expect(faded).toMatchObject({
      tombstone: true,
      changeNote: "faded",
      sourceType: "decay",
    });
    for (const path of [
      "facts/pinned.md",
      "facts/used.md",
      "facts/recent.md",
    ]) {
      expect((await current(path, "channel")).tombstone, path).toBe(false);
    }
    expect((await current("facts/faded.md", "project")).tombstone).toBe(false);

    // A second run fades nothing more. The faded text itself, 300 days old
    // and no longer current, was past retention and pruned: the tombstone is
    // what is left.
    await runDecayClock();
    const versions = await api.db.db
      .select({ id: memoryDocuments.id })
      .from(memoryDocuments)
      .where(
        and(
          eq(memoryDocuments.logicalPath, "facts/faded.md"),
          eq(memoryDocuments.scope, "channel"),
        ),
      );
    expect(versions).toHaveLength(1);
    expect((await current("facts/faded.md", "channel")).tombstone).toBe(true);
  });

  test("it prunes old non-current versions, never a current one or one a promotion cites", async () => {
    const channel = { scope: "channel", channelId };
    for (const text of ["one", "two", "three"]) {
      await writeMemory(stage, {
        ...channel,
        path: "facts/rules.md",
        content: `Rule ${text}.`,
      });
    }
    // Promote the first version, then age everything past retention.
    const history = await getMemory<{ versions: { versionId: number }[] }>(
      stage,
      "memory/document/versions",
      { ...channel, path: "facts/rules.md" },
    );
    const first = history.body.versions[2].versionId;
    const promoted = await call(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/memory/document/promote`,
      {
        channelId,
        path: "facts/rules.md",
        versionId: first,
      },
    );
    expect(promoted.status).toBe(200);
    await age("facts/rules.md", 120);

    await runDecayClock();

    const left = await api.db.db
      .select({
        versionId: memoryDocuments.versionId,
        scope: memoryDocuments.scope,
        isCurrent: memoryDocuments.isCurrent,
        content: memoryDocuments.content,
      })
      .from(memoryDocuments)
      .where(eq(memoryDocuments.logicalPath, "facts/rules.md"))
      .orderBy(sql`${memoryDocuments.scope}, ${memoryDocuments.versionId}`);
    // The channel's cited first version and its current third remain; the
    // second is gone; the project copy is current.
    expect(left.map((r) => [r.scope, r.isCurrent, r.content])).toEqual([
      ["channel", false, "Rule one."],
      ["channel", true, "Rule three."],
      ["project", true, "Rule one."],
    ]);
  });
});
