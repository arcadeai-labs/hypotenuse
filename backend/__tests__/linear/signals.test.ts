import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api, config } from "keryx";
import {
  STOP_UNCONFIRMED_BODY,
  STOPPED_BEFORE_START_BODY,
} from "../../ops/WorkItemOps";
import {
  ago,
  delegatedSession,
  itemRow,
  itemsOf,
  personSays,
  reap,
  route,
  ScriptedDaemon,
  setItem,
  withoutRunnerRateLimits,
} from "../routing/helpers";
import {
  authHeaders,
  buildTestUniverse,
  HOOK_TIMEOUT,
  type TestUniverse,
} from "../setup";
import { FINEAR_FIXTURES, useFinear } from "./finear";
import { appToken, integrationRow } from "./helpers";
import {
  agentSessionEvent,
  deliver,
  type Target,
  webhookSession,
} from "./inject";
import { activityRows, finearSession, sessionRow, settle } from "./sessions";

/**
 * Linear's signals on a person's prompt. A `stop` ends the turn and nothing
 * but its answer reaches Linear afterwards — queued chatter is withdrawn, the
 * daemon may only answer, and what the person typed with the stop is quoted
 * back, never acted on. `continue` (schema-only) is a plain follow-up.
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

let target: Target;
let token: string;
let laptop: ScriptedDaemon;
beforeAll(async () => {
  await linear.install(universe.projectId, universe.peach.sessionId);
  const row = await integrationRow(universe.projectId);
  target = {
    organizationId: row.externalWorkspaceId,
    appUserId: row.externalAppUserId,
  };
  token = await appToken(universe.projectId);
  laptop = await ScriptedDaemon.register(
    universe.url,
    universe.mario,
    universe.projectId,
    "signals-laptop",
    { limits: { maxParallelJobs: 8 } },
  );
}, HOOK_TIMEOUT);

/**
 * A delegated session whose turn the laptop is running, one thought sent.
 * @param title - The issue title.
 * @returns The session and its work item.
 */
async function running(title: string) {
  await laptop.heartbeat();
  const s = await delegatedSession(linear, target.appUserId, title);
  const [first] = await itemsOf(s.session.id);
  if (first.status !== "offered") await route();
  if (!(await laptop.claim([first.id]))) throw new Error("not claimed");
  await laptop.events(first.id, [{ type: "thought", body: "Working on it" }]);
  await settle();
  return { ...s, workItemId: first.id };
}

describe("LC-SIG-01 stop", () => {
  test("queued chatter is withdrawn, the runner may only answer, and the answer quotes the stop", async () => {
    const s = await running("Stop me mid-turn");
    // Accepted, but not yet sent: the stop arrives before the outbox runs.
    await laptop.events(s.workItemId, [
      { type: "action", action: "Editing", parameter: "src/cart.ts" },
      { type: "thought", body: "Almost there" },
    ]);
    await personSays(
      linear,
      s.externalSessionId,
      "wrong file, use cart.ts",
      "stop",
    );

    const outbound = (await activityRows(s.session.id)).filter(
      (r) => r.direction === "outbound",
    );
    expect(
      outbound
        .filter(
          (r) =>
            r.contentType === "action" || r.content.body === "Almost there",
        )
        .map((r) => r.deliveryStatus),
    ).toEqual(["superseded", "superseded"]);

    const beat = await laptop.heartbeat();
    expect(beat.cancels).toEqual([
      {
        workItemId: s.workItemId,
        reason: "stop",
        said: "wrong file, use cart.ts",
      },
    ]);
    // LC-SES-10 / LC-DIFF-03: while stopping, only a response or an error.
    const late = await laptop.events(s.workItemId, [
      { type: "action", action: "Running", parameter: "bun test" },
      {
        type: "response",
        body: "Stopped at your request.\n\n> You said: wrong file, use cart.ts",
      },
    ]);
    expect(late.body).toMatchObject({
      accepted: 1,
      dropped: 1,
      cancelRequested: true,
    });
    await laptop.complete(s.workItemId, "cancelled");
    await settle();
    expect((await itemRow(s.workItemId)).status).toBe("cancelled");

    const inLinear = await finearSession(linear, token, s.externalSessionId);
    const bodies = inLinear.activities.map((a) => a.content.body);
    expect(bodies).not.toContain("Almost there");
    expect(bodies.at(-1)).toBe(
      "Stopped at your request.\n\n> You said: wrong file, use cart.ts",
    );
  });

  test("a stop before any runner took the turn is answered with the quote; a bare Stop is not quoted", async () => {
    const quoted = await delegatedSession(
      linear,
      target.appUserId,
      "Stop me early, with words",
    );
    await personSays(linear, quoted.externalSessionId, "never mind", "stop");
    const last = (await activityRows(quoted.session.id))
      .filter((r) => r.direction === "outbound")
      .at(-1);
    expect(last?.content.body).toBe(
      `${STOPPED_BEFORE_START_BODY}\n\n> You said: never mind`,
    );
    // The stop's text was never made a prompt.
    expect((await itemsOf(quoted.session.id)).map((i) => i.status)).toEqual([
      "cancelled",
    ]);

    const bare = await delegatedSession(linear, target.appUserId, "Bare stop");
    await personSays(linear, bare.externalSessionId, "Stop", "stop");
    const answer = (await activityRows(bare.session.id))
      .filter((r) => r.direction === "outbound")
      .at(-1);
    expect(answer?.content.body).toBe(STOPPED_BEFORE_START_BODY);
  });

  test("a stop the runner never confirms is answered by the server, still quoting the stop", async () => {
    const s = await running("Unconfirmed stop");
    await personSays(linear, s.externalSessionId, "not that branch", "stop");
    await setItem(s.workItemId, { cancelRequestedAt: ago(31_000) });
    expect((await reap()).stopped).toContain(s.workItemId);
    await settle();
    const inLinear = await finearSession(linear, token, s.externalSessionId);
    expect(inLinear.activities.at(-1)?.content.body).toBe(
      `${STOP_UNCONFIRMED_BODY}\n\n> You said: not that branch`,
    );
  });

  test("LC-SES-10 a stopping status Linear reports is mirrored, never set", async () => {
    const s = await running("Mirror stopping");
    const res = await deliver(
      universe.url,
      agentSessionEvent(target, {
        action: "prompted",
        agentSession: webhookSession({
          id: s.externalSessionId,
          status: "stopping",
          issueId: s.issue.id,
        }),
        agentActivity: {
          id: crypto.randomUUID(),
          agentSessionId: s.externalSessionId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          userId: FINEAR_FIXTURES.primary.user,
          content: { type: "prompt", body: "" },
          signal: "stop",
        } as never,
      }),
    );
    expect(res.status).toBe(200);
    await settle(1);
    expect((await sessionRow(s.externalSessionId))?.status).toBe("stopping");
    expect((await itemRow(s.workItemId)).cancelReason).toBe("stop");
    await laptop.complete(s.workItemId, "cancelled");
    await settle();
  });
});

describe("LC-SIG-04 continue", () => {
  test("a continue signal is one plain follow-up turn, its empty body read as the word", async () => {
    const s = await running("Continue me");
    await laptop.events(s.workItemId, [{ type: "response", body: "Paused." }]);
    await laptop.complete(s.workItemId, "completed");
    await settle();

    const res = await deliver(
      universe.url,
      agentSessionEvent(target, {
        action: "prompted",
        agentSession: webhookSession({
          id: s.externalSessionId,
          issueId: s.issue.id,
        }),
        agentActivity: {
          id: crypto.randomUUID(),
          agentSessionId: s.externalSessionId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          userId: FINEAR_FIXTURES.primary.user,
          content: { type: "prompt", body: "" },
          signal: "continue",
        } as never,
      }),
    );
    expect(res.status).toBe(200);
    await settle();
    const items = await itemsOf(s.session.id);
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({ kind: "prompt" });
    expect(items[1].prompt?.map((p) => p.body)).toEqual(["continue"]);
    const inbound = (await activityRows(s.session.id)).filter(
      (r) => r.direction === "inbound",
    );
    expect(inbound.at(-1)?.signal).toBe("continue");
  });
});

describe("LC-SIG-02 auth", () => {
  test("a provider links the runner's auth page; a public https URL passes through; a private one does not", async () => {
    const s = await running("Log me in");
    await laptop.events(s.workItemId, [
      {
        type: "elicitation",
        body: "GitHub sign-in needed",
        signal: "auth",
        signalMetadata: { provider: "github", providerName: "GitHub" },
      },
    ]);
    await laptop.events(s.workItemId, [
      {
        type: "elicitation",
        body: "Sign in to the agent",
        signal: "auth",
        signalMetadata: {
          url: "https://login.example.com/device",
          provider: "fake",
          userId: "spoofed",
        },
      },
      {
        type: "elicitation",
        body: "Sign in on the intranet",
        signal: "auth",
        signalMetadata: { url: "https://10.0.0.5/login", provider: "fake" },
      },
    ]);
    const asked = (await activityRows(s.session.id)).filter(
      (r) => r.signal === "auth",
    );
    const page = `${config.notifications.appUrl}/runners/${laptop.runner.id}/auth`;
    // No identity is linked: the session's creator sees the link.
    const creator = s.session.creatorExternalUserId;
    expect(asked.map((r) => r.signalMetadata)).toEqual([
      { url: `${page}/github`, userId: creator, providerName: "GitHub" },
      { url: "https://login.example.com/device", userId: creator },
      { url: `${page}/fake`, userId: creator },
    ]);
    await laptop.complete(s.workItemId, "completed");
    await settle();
  });

  test("the runner owner's linked Linear identity is who sees the link", async () => {
    const linked = await fetch(`${universe.url}/api/external-identity`, {
      method: "PUT",
      headers: authHeaders(universe.peach.sessionId),
      body: JSON.stringify({
        projectId: universe.projectId,
        userId: universe.mario.userId,
        externalUserId: "linear-mario",
      }),
    });
    expect(linked.status).toBe(200);
    const s = await running("Log me in, Mario");
    await laptop.events(s.workItemId, [
      {
        type: "elicitation",
        body: "Sign in",
        signal: "auth",
        signalMetadata: { provider: "codex", providerName: "Codex" },
      },
    ]);
    const [asked] = (await activityRows(s.session.id)).filter(
      (r) => r.signal === "auth",
    );
    expect(asked.signalMetadata).toMatchObject({ userId: "linear-mario" });
    await laptop.complete(s.workItemId, "completed");
    await settle();
  });

  test("an auth elicitation needs a url or a provider", async () => {
    const s = await running("Malformed login");
    const refused = await laptop.events(s.workItemId, [
      {
        type: "elicitation",
        body: "Sign in",
        signal: "auth",
        signalMetadata: { providerName: "Codex" },
      },
    ]);
    expect(refused.status).toBe(406);
    await laptop.complete(s.workItemId, "completed");
    await settle();
  });
});
