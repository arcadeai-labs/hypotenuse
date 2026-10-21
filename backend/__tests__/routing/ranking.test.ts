import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { api } from "keryx";
import { type EligibleRunner, rankRunners } from "../../ops/RoutingOps";
import { createSessionCreatedItem } from "../../ops/WorkItemOps";
import { agentActivities } from "../../schema/agent_activities";
import { agentSessions } from "../../schema/agent_sessions";
import { externalIdentities } from "../../schema/external_identities";
import type { Integration } from "../../schema/integrations";
import { runners } from "../../schema/runners";
import { workItems } from "../../schema/work_items";
import { FINEAR_FIXTURES, useFinear } from "../linear/finear";
import { integrationRow } from "../linear/helpers";
import {
  buildTestUniverse,
  createUserAndLogin,
  HOOK_TIMEOUT,
  inviteAndAccept,
  TEST_PASSWORD,
  type TestUniverse,
  type TestUser,
} from "../setup";
import {
  ago,
  delegatedSession,
  itemsOf,
  personSays,
  route,
  ScriptedDaemon,
  sessionById,
  setItem,
  withoutRunnerRateLimits,
} from "./helpers";

/**
 * Ranking: the runner holding a session's worktree first, then the issuer's
 * own runners, then everyone else by load — and the issuer found by e-mail,
 * recorded as a visible link.
 */

/**
 * An eligible runner, for the pure ordering tests.
 * @param over - The fields that matter to the test.
 * @returns The runner.
 */
function eligibleRunner(
  over: Partial<EligibleRunner> & { id: number },
): EligibleRunner {
  return {
    userId: 100,
    name: `r${over.id}`,
    agentId: "claude",
    used: 0,
    maxParallelJobs: 4,
    lastClaimedAt: null,
    remotes: [],
    ...over,
  };
}

/**
 * The ids in ranked order.
 * @param ranked - The ranked runners.
 * @returns Their ids.
 */
function order(ranked: EligibleRunner[]): number[] {
  return ranked.map((r) => r.id);
}

describe("rankRunners", () => {
  const fleet = [
    eligibleRunner({ id: 1, userId: 7, used: 3 }),
    eligibleRunner({ id: 2, userId: 8, used: 2 }),
    eligibleRunner({ id: 3, userId: 9, used: 0, lastClaimedAt: 500 }),
    eligibleRunner({ id: 4, userId: 9, used: 0, lastClaimedAt: 100 }),
    eligibleRunner({ id: 5, userId: 8, used: 1 }),
  ];

  test("with no preference: least loaded, then longest idle", () => {
    expect(
      order(
        rankRunners(fleet, { stickyRunnerId: null, preferredUserId: null }),
      ),
    ).toEqual([4, 3, 5, 2, 1]);
  });

  test("the issuer's runners come before less-loaded strangers, least loaded first", () => {
    expect(
      order(rankRunners(fleet, { stickyRunnerId: null, preferredUserId: 8 })),
    ).toEqual([5, 2, 4, 3, 1]);
  });

  test("the sticky runner comes first, however loaded, before the issuer's", () => {
    expect(
      order(rankRunners(fleet, { stickyRunnerId: 1, preferredUserId: 8 })),
    ).toEqual([1, 5, 2, 4, 3]);
  });

  test("load is relative to each machine's size", () => {
    const sized = [
      eligibleRunner({ id: 1, used: 2, maxParallelJobs: 8 }),
      eligibleRunner({ id: 2, used: 1, maxParallelJobs: 2 }),
    ];
    expect(
      order(
        rankRunners(sized, { stickyRunnerId: null, preferredUserId: null }),
      ),
    ).toEqual([1, 2]);
  });
});

let universe: TestUniverse;
beforeAll(async () => {
  universe = await buildTestUniverse();
}, HOOK_TIMEOUT);
afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

const linear = useFinear();
withoutRunnerRateLimits();

let appUserId: string;
let integration: Integration;
let human: TestUser;
let humanLaptop: ScriptedDaemon;
let peachBox: ScriptedDaemon;
beforeAll(async () => {
  await linear.install(universe.projectId, universe.peach.sessionId);
  integration = await integrationRow(universe.projectId);
  appUserId = integration.externalAppUserId;
  // The same e-mail as finear's Human 1, who starts every delegation.
  human = await createUserAndLogin(
    universe.url,
    "Human One",
    "human1@example.test",
    TEST_PASSWORD,
  );
  await inviteAndAccept(
    universe.url,
    universe.peach,
    universe.projectId,
    human,
    [],
  );
  humanLaptop = await ScriptedDaemon.register(
    universe.url,
    human,
    universe.projectId,
    "human-laptop",
    { limits: { maxParallelJobs: 4 } },
  );
  peachBox = await ScriptedDaemon.register(
    universe.url,
    universe.peach,
    universe.projectId,
    "peach-box",
    { limits: { maxParallelJobs: 4 } },
  );
  await humanLaptop.heartbeat();
  await peachBox.heartbeat();
}, HOOK_TIMEOUT);

/**
 * Insert a bare session of the installed integration.
 * @param creator - The creator's id and e-mail, or null for an automation.
 * @returns The session row.
 */
async function bareSession(creator: { id: string; email: string } | null) {
  const [row] = await api.db.db
    .insert(agentSessions)
    .values({
      projectId: integration.projectId,
      type: "linear",
      integrationId: integration.id,
      externalSessionId: crypto.randomUUID(),
      externalIssueId: crypto.randomUUID(),
      teamKey: "ENG",
      origin: "delegation",
      creatorExternalUserId: creator?.id ?? null,
      creatorEmail: creator?.email ?? null,
    })
    .returning();
  return row;
}

/**
 * Give a runner a held turn on a session of its own, to load it.
 * @param runnerId - The runner.
 */
async function loadWith(runnerId: number): Promise<void> {
  const session = await bareSession(null);
  await api.db.db.insert(workItems).values({
    projectId: integration.projectId,
    agentSessionId: session.id,
    kind: "prompt",
    role: "worker",
    status: "claimed",
    repository: "github.com/acme/web",
    repositoryResolved: true,
    runnerId,
    agentId: "claude",
    claimedAt: new Date(),
    leaseExpiresAt: new Date(Date.now() + 60_000),
  });
}

describe("the issuer, by e-mail", () => {
  test("a delegation goes to the issuer's runner even when a stranger's is less loaded", async () => {
    await loadWith(humanLaptop.id);
    await loadWith(humanLaptop.id);
    const { session } = await delegatedSession(
      linear,
      appUserId,
      "Mine, please",
    );

    const [item] = await itemsOf(session.id);
    expect(item.preferredUserId).toBe(human.userId);
    expect(item).toMatchObject({
      status: "offered",
      offeredToRunnerId: humanLaptop.id,
    });

    const links = await api.db.db
      .select()
      .from(externalIdentities)
      .where(eq(externalIdentities.integrationId, integration.id));
    expect(
      links.map((l) => [
        l.userId,
        l.externalUserId,
        l.externalEmail,
        l.linkedVia,
      ]),
    ).toEqual([
      [
        human.userId,
        FINEAR_FIXTURES.primary.user,
        "human1@example.test",
        "email",
      ],
    ]);
  });

  test("LC-WH-15 a session with no creator (an automation) has no issuer; an existing link is reused", async () => {
    const automated = await bareSession(null);
    const linked = await bareSession({
      id: FINEAR_FIXTURES.primary.user,
      email: "someone-else@example.test",
    });
    const [none, theirs] = await api.db.db.transaction(async (tx) => [
      await createSessionCreatedItem(tx, automated),
      await createSessionCreatedItem(tx, linked),
    ]);
    expect(none.preferredUserId).toBeNull();
    // The link made by e-mail decides, whatever e-mail the event carries now.
    expect(theirs.preferredUserId).toBe(human.userId);
    expect(
      await api.db.db
        .select()
        .from(externalIdentities)
        .where(eq(externalIdentities.integrationId, integration.id)),
    ).toHaveLength(1);
  });
});

describe("stickiness", () => {
  test("a follow-up waits for the runner with the worktree, then moves on after the sticky timeout, fresh", async () => {
    const { externalSessionId, session } = await delegatedSession(
      linear,
      appUserId,
      "Sticky work",
    );
    await humanLaptop.heartbeat();
    const [offer] = await itemsOf(session.id);
    expect(offer.offeredToRunnerId).toBe(humanLaptop.id);
    const first = await humanLaptop.claim([offer.id]);
    expect(first).toMatchObject({ agentSessionId: session.id, fresh: true });
    await humanLaptop.events(first!.workItemId, [
      { type: "response", body: "Done the first part." },
    ]);
    await humanLaptop.complete(first!.workItemId, "completed");
    expect((await sessionById(session.id)).runnerId).toBe(humanLaptop.id);

    // The laptop's lid closes.
    await api.db.db
      .update(runners)
      .set({ status: "offline" })
      .where(eq(runners.id, humanLaptop.id));
    await personSays(linear, externalSessionId, "And the second part");

    const followUp = (await itemsOf(session.id)).at(-1)!;
    const waiting =
      "Waiting for **human-laptop**, which has this session's worktree.";
    expect(followUp).toMatchObject({
      kind: "prompt",
      status: "queued",
      waitingReason: waiting,
    });
    const said = await api.db.db
      .select()
      .from(agentActivities)
      .where(eq(agentActivities.agentSessionId, session.id));
    expect(
      said.some(
        (a) => a.ephemeral && (a.content as { body?: string }).body === waiting,
      ),
    ).toBe(true);

    // Still inside the sticky timeout: nothing moves.
    await route();
    expect((await itemsOf(session.id)).at(-1)!.status).toBe("queued");

    // Past it, anyone eligible may take it, and starts a fresh worktree.
    await setItem(followUp.id, { queuedAt: ago(11 * 60 * 1000) });
    await route();
    expect((await itemsOf(session.id)).at(-1)).toMatchObject({
      status: "offered",
      offeredToRunnerId: peachBox.id,
    });
    await peachBox.heartbeat();
    const moved = await peachBox.claim();
    expect(moved).toMatchObject({
      workItemId: followUp.id,
      fresh: true,
      prompt: [{ body: "And the second part" }],
    });
    expect((await sessionById(session.id)).runnerId).toBe(peachBox.id);
  });
});
