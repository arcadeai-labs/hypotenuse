import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api } from "keryx";
import { buildTestUniverse, HOOK_TIMEOUT, type TestUniverse } from "../setup";
import { FINEAR_FIXTURES, FINEAR_PRIMARY_KEY, useFinear } from "./finear";
import { appToken } from "./helpers";

let universe: TestUniverse;
beforeAll(async () => {
  universe = await buildTestUniverse();
}, HOOK_TIMEOUT);
afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

const linear = useFinear();

/**
 * The harness itself: every Linear suite stands on it, so it gets a suite of
 * its own that fails first, and says why, when finear moves under it.
 */
describe("the finear harness", () => {
  test("answers a fixture key over real HTTP, and refuses an unknown one", async () => {
    const human = await linear.graphql<{
      viewer: { id: string; name: string };
    }>(FINEAR_PRIMARY_KEY, "{ viewer { id name } }");
    expect(human.data?.viewer.name).toBe("Human 1");
    // finear, like Linear, answers an unknown key with GraphQL errors.
    const nobody = await linear.graphql("nope", "{ viewer { id } }");
    expect(nobody.errors?.length ?? 0).toBeGreaterThan(0);
  });

  test("installs the app through the real consent flow", async () => {
    const landed = await linear.install(
      universe.projectId,
      universe.peach.sessionId,
    );
    expect(landed.pathname).toBe("/settings/linear");
    expect(landed.searchParams.get("connected")).toBe("1");
  });

  test("the app user is a distinct viewer from the human who installed it", async () => {
    const token = await appToken(universe.projectId);
    const app = await linear.graphql<{
      viewer: { id: string; app: boolean };
      organization: { id: string };
    }>(`Bearer ${token}`, "{ viewer { id app } organization { id } }");
    expect(app.errors).toBeUndefined();
    expect(app.data?.viewer.app).toBe(true);
    expect(app.data?.viewer.id).not.toBe(FINEAR_FIXTURES.primary.user);
    expect(app.data?.organization.id).toBe(
      FINEAR_FIXTURES.primary.organization,
    );
  });

  test("the proxy records what the server sent Linear", () => {
    const paths = linear.requests().map((r) => r.path);
    expect(paths).toContain("/oauth/authorize");
    expect(paths).toContain("/oauth/token");
    expect(
      linear
        .requests()
        .some((r) => r.operationName === "GetInstallationIdentity"),
    ).toBe(true);
  });
});
