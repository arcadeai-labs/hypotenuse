import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ActionResponse, api } from "keryx";
import type { IntegrationCatalog } from "../../actions/integration/integration-catalog";
import { catalogKey } from "../../ops/LinearCatalogOps";
import {
  buildTestUniverse,
  cookieHeader,
  HOOK_TIMEOUT,
  type TestUniverse,
} from "../setup";
import { FINEAR_FIXTURES, FINEAR_PRIMARY_KEY, useFinear } from "./finear";
import { integrationRow } from "./helpers";

let universe: TestUniverse;
beforeAll(async () => {
  universe = await buildTestUniverse();
}, HOOK_TIMEOUT);
afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

const linear = useFinear();

let projectId: string;
let labelId: string;

beforeAll(async () => {
  // A project and a team label, made by the human, for the app to see.
  const project = await linear.graphql<{
    projectCreate: { project: { id: string } };
  }>(
    FINEAR_PRIMARY_KEY,
    `mutation($input: ProjectCreateInput!) { projectCreate(input: $input) { project { id } } }`,
    { input: { name: "Webhooks", teamIds: [FINEAR_FIXTURES.primary.team] } },
  );
  expect(project.errors).toBeUndefined();
  projectId = project.data!.projectCreate.project.id;
  const label = await linear.graphql<{
    issueLabelCreate: { issueLabel: { id: string } };
  }>(
    FINEAR_PRIMARY_KEY,
    `mutation($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { issueLabel { id } } }`,
    { input: { name: "agent", teamId: FINEAR_FIXTURES.primary.team } },
  );
  expect(label.errors).toBeUndefined();
  labelId = label.data!.issueLabelCreate.issueLabel.id;

  const landed = await linear.install(
    universe.projectId,
    universe.peach.sessionId,
  );
  expect(landed.searchParams.get("connected")).toBe("1");
}, HOOK_TIMEOUT);

/**
 * `integration:catalog` as someone.
 * @param project - The Hypotenuse project.
 * @param sessionId - Who asks.
 * @returns The response.
 */
const catalog = (project: number, sessionId: string) =>
  fetch(
    `${universe.url}/api/integration/catalog?projectId=${project}&type=linear`,
    {
      headers: cookieHeader(sessionId),
    },
  );

/** GraphQL requests the server has sent since the log was cleared. */
const graphqlSent = () =>
  linear.requests().filter((r) => r.path === "/graphql").length;

describe("integration:catalog", () => {
  test("answers the teams with their states, projects, and labels the app can see", async () => {
    linear.clearRequests();
    const res = await catalog(universe.projectId, universe.toad.sessionId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ActionResponse<IntegrationCatalog>;

    expect(body.teams).toEqual([
      {
        id: FINEAR_FIXTURES.primary.team,
        key: "ENG",
        name: "Engineering",
        private: false,
        states: [
          expect.objectContaining({
            id: FINEAR_FIXTURES.primary.backlog,
            type: "backlog",
          }),
          expect.objectContaining({
            id: FINEAR_FIXTURES.primary.started,
            type: "started",
          }),
          expect.objectContaining({
            id: FINEAR_FIXTURES.primary.completed,
            type: "completed",
          }),
        ],
      },
    ]);
    expect(body.projects).toEqual([
      {
        id: projectId,
        name: "Webhooks",
        teamIds: [FINEAR_FIXTURES.primary.team],
      },
    ]);
    expect(body.labels).toContainEqual({
      id: labelId,
      name: "agent",
      teamId: FINEAR_FIXTURES.primary.team,
    });
    expect(
      linear
        .requests()
        .map((r) => r.operationName)
        .sort(),
    ).toEqual(["ListLabels", "ListProjects", "ListTeams"]);
  });

  test("is cached: a second read does not reach Linear, and an expired cache does", async () => {
    linear.clearRequests();
    expect(
      (await catalog(universe.projectId, universe.mario.sessionId)).status,
    ).toBe(200);
    expect(graphqlSent()).toBe(0);

    const { id } = await integrationRow(universe.projectId);
    // EXPIRE 0 is the TTL running out, not a wait.
    await api.redis.redis.expire(catalogKey(id), 0);
    expect(
      (await catalog(universe.projectId, universe.mario.sessionId)).status,
    ).toBe(200);
    expect(graphqlSent()).toBe(3);
  });

  test("is member-gated, and answers 404 where nothing is connected", async () => {
    expect(
      (await catalog(universe.projectId, universe.bowser.sessionId)).status,
    ).toBe(403);
    expect(
      (await catalog(universe.toad.projectId, universe.toad.sessionId)).status,
    ).toBe(404);
  });
});
