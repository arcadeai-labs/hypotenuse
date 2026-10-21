import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api } from "keryx";
import { ackBody, STOPPED_FALLBACK_BODY } from "../../ops/WorkItemOps";
import { useFinear } from "../linear/finear";
import { appToken, integrationRow } from "../linear/helpers";
import { finearSession, settle } from "../linear/sessions";
import { buildTestUniverse, HOOK_TIMEOUT, type TestUniverse } from "../setup";
import {
  delegatedSession,
  itemsOf,
  personSays,
  route,
  ScriptedDaemon,
  sessionById,
  withoutRunnerRateLimits,
} from "./helpers";

/**
 * The whole loop with a scripted daemon, against finear: a delegation is
 * acknowledged, offered, claimed, answered through `daemon:events`, and
 * completed; a follow-up goes back to the same runner with the history; a stop
 * mid-turn reaches the runner and ends in its final response.
 */

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
let token: string;
let laptop: ScriptedDaemon;
beforeAll(async () => {
  await linear.install(universe.projectId, universe.peach.sessionId);
  appUserId = (await integrationRow(universe.projectId)).externalAppUserId;
  token = await appToken(universe.projectId);
  laptop = await ScriptedDaemon.register(
    universe.url,
    universe.mario,
    universe.projectId,
    "mario-laptop",
  );
  await laptop.heartbeat();
}, HOOK_TIMEOUT);

describe("delegate → claim → answer → follow-up → stop", () => {
  test("LC-WH-12 LC-WH-13 LC-BP-10 one session, end to end", async () => {
    const { issue, externalSessionId, session } = await delegatedSession(
      linear,
      appUserId,
      "Fix checkout rounding",
    );

    // Offered to the only runner, which hears about it on its next heartbeat.
    const beat = await laptop.heartbeat();
    expect(beat.offers).toEqual([
      expect.objectContaining({
        agentSessionId: session.id,
        kind: "session_created",
        role: "worker",
      }),
    ]);
    const first = await laptop.claim();
    expect(first).toMatchObject({
      agentSessionId: session.id,
      kind: "session_created",
      role: "worker",
      fresh: true,
      repository: { remote: "github.com/acme/web", baseBranch: "main" },
      branch: `hypotenuse/${issue.identifier.toLowerCase()}-fix-checkout-rounding`,
      issue: {
        id: issue.id,
        identifier: issue.identifier,
        title: "Fix checkout rounding",
        teamKey: "ENG",
      },
      prompt: null,
      origin: "delegation",
      humanDelegated: true,
      externalSessionId,
    });
    expect(first!.history.map((h) => h.body)).toEqual([
      ackBody(issue.identifier),
      "Routing as **worker** (no rule matched; worker is the default).",
      "Working in **acme/web**.",
    ]);
    expect((await sessionById(session.id)).runnerId).toBe(laptop.id);

    const posted = await laptop.events(first!.workItemId, [
      { type: "thought", body: "Reading the checkout code", ephemeral: false },
      {
        type: "plan",
        entries: [
          { content: "Find the rounding", status: "completed" },
          { content: "Fix it", status: "in_progress" },
        ],
      },
      {
        type: "action",
        action: "Editing",
        parameter: "src/checkout.ts",
        result: "+2 −1",
        ephemeral: false,
      },
      { type: "response", body: "Fixed the rounding in `src/checkout.ts`." },
    ]);
    expect(posted).toEqual({
      status: 200,
      body: { accepted: 4, duplicates: 0, dropped: 0, cancelRequested: false },
    });
    expect(
      (await laptop.complete(first!.workItemId, "completed", { branch: "b" }))
        .status,
    ).toBe(200);
    await settle();

    const done = await finearSession(linear, token, externalSessionId);
    expect(done.status).toBe("complete");
    expect(done.activities.at(-1)?.content.body).toBe(
      "Fixed the rounding in `src/checkout.ts`.",
    );
    expect((await sessionById(session.id)).plan).toEqual([
      { content: "Find the rounding", status: "completed" },
      { content: "Fix it", status: "inProgress" },
    ]);

    // A follow-up is sticky: the same runner gets it, with the conversation.
    await personSays(linear, externalSessionId, "Also handle EUR");
    const followUp = await laptop.claim();
    expect(followUp).toMatchObject({
      kind: "prompt",
      fresh: false,
      prompt: [{ body: "Also handle EUR" }],
    });
    expect(followUp!.history.map((h) => [h.direction, h.body])).toEqual(
      expect.arrayContaining([
        ["outbound", "Fixed the rounding in `src/checkout.ts`."],
        ["inbound", "Also handle EUR"],
      ]),
    );
    await laptop.events(followUp!.workItemId, [
      { type: "thought", body: "Adding EUR", ephemeral: false },
    ]);

    // Stop mid-turn: the runner is told, may only answer, and completes.
    await personSays(linear, externalSessionId, "Stop", "stop");
    const stopping = await laptop.heartbeat();
    expect(stopping.cancels).toEqual([
      { workItemId: followUp!.workItemId, reason: "stop" },
    ]);
    const late = await laptop.events(followUp!.workItemId, [
      { type: "thought", body: "Still going", ephemeral: false },
      {
        type: "response",
        body: "Stopped. EUR handling is half-done on the branch, uncommitted.",
      },
    ]);
    expect(late.body).toMatchObject({
      accepted: 1,
      dropped: 1,
      cancelRequested: true,
    });
    await laptop.complete(followUp!.workItemId, "cancelled");
    await settle();

    const stopped = await finearSession(linear, token, externalSessionId);
    expect(stopped.activities.at(-1)?.content.body).toBe(
      "Stopped. EUR handling is half-done on the branch, uncommitted.",
    );
    expect(
      stopped.activities.some((a) => a.content.body === STOPPED_FALLBACK_BODY),
    ).toBe(false);
    expect((await itemsOf(session.id)).map((i) => i.status)).toEqual([
      "completed",
      "cancelled",
    ]);
    expect((await route()).offered).toEqual([]);
  });
});
