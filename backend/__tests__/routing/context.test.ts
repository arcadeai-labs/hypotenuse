import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api } from "keryx";
import {
  FINEAR_FIXTURES,
  FINEAR_PRIMARY_KEY,
  useFinear,
} from "../linear/finear";
import { integrationRow } from "../linear/helpers";
import {
  agentSessionEvent,
  deliver,
  type Target,
  webhookSession,
} from "../linear/inject";
import {
  createIssue,
  delegate,
  recordedEvent,
  sessionRow,
  settle,
} from "../linear/sessions";
import { buildTestUniverse, HOOK_TIMEOUT, type TestUniverse } from "../setup";
import {
  itemsOf,
  personSays,
  route,
  ScriptedDaemon,
  withoutRunnerRateLimits,
} from "./helpers";

/**
 * What Linear sends about a session reaches the agent as Linear sent it: the
 * claimed assignment carries `promptContext` verbatim, `guidance` with the
 * team's rules ahead of the workspace's, and a mention's `previousComments`;
 * and a follow-up's history is the session's activities, never the issue's
 * comments (which a person can edit). finear sends none of the three context
 * fields, so `created` is injected with them, signed, at the HTTP boundary.
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
let laptop: ScriptedDaemon;
beforeAll(async () => {
  await linear.install(universe.projectId, universe.peach.sessionId);
  const row = await integrationRow(universe.projectId);
  target = {
    organizationId: row.externalWorkspaceId,
    appUserId: row.externalAppUserId,
  };
  laptop = await ScriptedDaemon.register(
    universe.url,
    universe.mario,
    universe.projectId,
    "context-laptop",
  );
  await laptop.heartbeat();
}, HOOK_TIMEOUT);

/**
 * Delegate a fresh issue in finear and wait for its `created`.
 * @param title - The issue's title.
 * @returns The issue and Linear's session id.
 */
async function delegated(title: string) {
  const issue = await createIssue(linear, title);
  const externalSessionId = await delegate(linear, issue.id, target.appUserId);
  await recordedEvent(
    (e) =>
      e.action === "created" &&
      (e.payload as { agentSession?: { id?: string } }).agentSession?.id ===
        externalSessionId,
  );
  await settle();
  return { issue, externalSessionId };
}

describe("context", () => {
  test("LC-CTX-01 LC-CTX-02 LC-CTX-03 promptContext verbatim, team guidance first, and previousComments reach the claimed turn", async () => {
    const { issue, externalSessionId } = await delegated("Context issue");
    const promptContext = `<issue identifier="${issue.identifier}">\n<title>Context issue</title>\n</issue>\n<primary-directive-thread comment-id="c-2">\n<comment author="Human 1">@hypotenuse please look</comment>\n</primary-directive-thread>`;
    const workspaceRule = {
      body: "Use bun, never npm.",
      origin: { type: "Organization" },
    };
    const teamRule = {
      body: "Open PRs as drafts.",
      origin: {
        type: "Team",
        team: { id: FINEAR_FIXTURES.primary.team, key: "ENG", name: "Eng" },
      },
    };
    const previousComments = [
      { id: "c-1", body: "The rounding is off by a cent.", userId: "u-1" },
    ];
    const payload = agentSessionEvent(target, {
      action: "created",
      agentSession: webhookSession({
        id: externalSessionId,
        issueId: issue.id,
        issue: {
          id: issue.id,
          identifier: issue.identifier,
          title: "Context issue",
          url: `https://linear.app/issue/${issue.identifier}`,
          teamId: FINEAR_FIXTURES.primary.team,
          team: { id: FINEAR_FIXTURES.primary.team, key: "ENG", name: "Eng" },
        },
      }),
      promptContext,
      // Linear's order: the workspace's rule first.
      guidance: [workspaceRule, teamRule] as never,
      previousComments: previousComments as never,
    });
    expect((await deliver(universe.url, payload)).status).toBe(200);
    await settle();
    await route();

    const assignment = await laptop.claim();
    const session = await sessionRow(externalSessionId);
    expect(assignment?.agentSessionId).toBe(session!.id);
    expect(assignment?.promptContext).toBe(promptContext);
    expect(assignment?.guidance).toEqual([
      { origin: "team", teamKey: "ENG", body: "Open PRs as drafts." },
      { origin: "workspace", teamKey: null, body: "Use bun, never npm." },
    ]);
    expect(assignment?.previousComments).toEqual(previousComments);
    await laptop.complete(assignment!.workItemId, "completed");
  });

  test("LC-ACT-14 LC-BP-07 a follow-up's history is the session's activities, not the issue's comments", async () => {
    const { issue, externalSessionId } = await delegated("History issue");
    await route();
    const first = await laptop.claim();
    expect(first?.history.map((h) => h.direction)).not.toContain("inbound");
    await laptop.events(first!.workItemId, [
      { type: "response", body: "Fixed the rounding." },
    ]);
    await laptop.complete(first!.workItemId, "completed");
    await settle();

    // A comment on the issue is not part of the session's conversation.
    await linear.graphql(
      FINEAR_PRIMARY_KEY,
      "mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }",
      { input: { issueId: issue.id, body: "Also, the README is stale." } },
    );
    await personSays(linear, externalSessionId, "Do EUR as well");
    await route();
    const followUp = await laptop.claim();
    const session = await sessionRow(externalSessionId);
    expect(followUp?.workItemId).toBe((await itemsOf(session!.id))[1].id);
    const said = followUp!.history.map((h) => [h.direction, h.type, h.body]);
    expect(said).toContainEqual([
      "outbound",
      "response",
      "Fixed the rounding.",
    ]);
    expect(said.at(-1)).toEqual(["inbound", "prompt", "Do EUR as well"]);
    expect(said.map(([, , body]) => body)).not.toContain(
      "Also, the README is stale.",
    );
    // Every entry is an activity row, in the session's order.
    const seqs = followUp!.history.map((h) => h.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    await laptop.complete(followUp!.workItemId, "completed");
  });
});
