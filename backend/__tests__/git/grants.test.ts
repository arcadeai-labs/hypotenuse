import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { api } from "keryx";
import { githubInstallations } from "../../schema/github_installations";
import { FakeGitHub } from "../fakes/github/server";
import {
  buildTestUniverse,
  call,
  HOOK_TIMEOUT,
  type TestUniverse,
  type TestUser,
} from "../setup";
import { attachInstallation, useFakeGitHub } from "./repositories-harness";

/**
 * Repository grants: an admin's decision that the project's bots may reach a
 * repository, and whether they may push — held to the installation's account,
 * proven against GitHub before it is saved, warned about when it may push
 * without a branch prefix — and what each bot can reach as a result.
 */

const github = new FakeGitHub();
let u: TestUniverse;
let restore: () => void;
let installationId: number;
let adaId: number;
let bobId: number;
let secretBotId: number;
let bowserBotId: number;

interface Grant {
  id: number;
  githubInstallationId: number;
  accountLogin: string | null;
  owner: string;
  name: string;
  fullName: string;
  push: boolean;
  branchPrefix: string | null;
  botIds: number[] | null;
  allBots: boolean;
  recommendedRuleset: Record<string, unknown> | null;
}

/**
 * Create a bot as someone.
 * @param user - Who.
 * @param projectId - Where.
 * @param fields - Its fields.
 * @returns Its id.
 */
async function createBot(
  user: TestUser,
  projectId: number,
  fields: Record<string, unknown>,
): Promise<number> {
  const res = await call<{ bot: { id: number } }>(
    u.url,
    user,
    "PUT",
    `/project/${projectId}/bot`,
    { persona: "You fix things.", ...fields },
  );
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  return res.body.bot.id;
}

/**
 * Create a grant in Castle as Peach.
 * @param body - The grant's fields; the installation is filled in.
 * @returns The status and body.
 */
async function grant(body: Record<string, unknown>) {
  return call<{ repositoryGrant: Grant; warnings: string[] }>(
    u.url,
    u.peach,
    "PUT",
    `/project/${u.projectId}/repository-grant`,
    { githubInstallationId: installationId, ...body },
  );
}

/**
 * A bot's repositories as someone sees them.
 * @param user - Who asks.
 * @param botId - The bot.
 * @returns The status and body.
 */
async function repositoriesOf(user: TestUser, botId: number) {
  return call<{
    repositories: {
      grantId: number;
      fullName: string;
      access: string;
      branchPrefix: string | null;
    }[];
  }>(u.url, user, "GET", `/project/${u.projectId}/bot/${botId}/repositories`);
}

beforeAll(async () => {
  u = await buildTestUniverse();
  await github.start();
  restore = useFakeGitHub(github);
  github.install({
    id: "7001",
    login: "Acme",
    repositories: ["api", "web", "lib"],
  });
  installationId = await attachInstallation(
    u.url,
    github,
    u.peach,
    u.projectId,
    "7001",
  );
  adaId = await createBot(u.peach, u.projectId, { name: "Ada" });
  bobId = await createBot(u.peach, u.projectId, { name: "Bob" });
  secretBotId = await createBot(u.peach, u.projectId, {
    name: "Secret",
    accessRead: ["operators"],
    accessWrite: ["operators"],
  });
  bowserBotId = await createBot(u.bowser, u.bowser.projectId, {
    name: "Kamek",
  });
}, HOOK_TIMEOUT);

afterAll(async () => {
  restore();
  await github.stop();
  await api.stop();
}, HOOK_TIMEOUT);

describe("repository-grant:create", () => {
  test("a read grant for every bot, proven with a metadata-only token revoked at once", async () => {
    const res = await grant({ repository: "acme/web" });
    expect(res.status).toBe(200);
    expect(res.body.warnings).toEqual([]);
    expect(res.body.repositoryGrant).toMatchObject({
      githubInstallationId: installationId,
      accountLogin: "Acme",
      owner: "acme",
      name: "web",
      fullName: "acme/web",
      push: false,
      branchPrefix: null,
      botIds: null,
      allBots: true,
      recommendedRuleset: null,
    });
    const probe = github.tokens.findLast(
      (t) => t.repositories.join() === "web",
    );
    expect(probe?.permissions).toEqual({ metadata: "read" });
    expect(probe?.revoked).toBe(true);
    expect(github.revocations).toContain(probe!.token);
    expect(JSON.stringify(res.body)).not.toContain(probe!.token);
  });

  test("a push grant without a branch prefix is saved with a warning", async () => {
    const res = await grant({
      repository: `${github.url}/Acme/API`,
      push: true,
      botIds: [adaId, adaId],
    });
    expect(res.status).toBe(200);
    expect(res.body.repositoryGrant.fullName).toBe("acme/api");
    expect(res.body.repositoryGrant.botIds).toEqual([adaId]);
    expect(res.body.repositoryGrant.allBots).toBe(false);
    expect(res.body.warnings).toHaveLength(1);
    expect(res.body.warnings[0]).toContain("no branch prefix");
    expect(res.body.warnings[0]).toContain("ruleset");
  });

  test("the repository's owner must be the installation's account", async () => {
    const res = await grant({ repository: "koopa/castle" });
    expect(res.status).toBe(406);
    expect(res.body.error?.key).toBe("repository");
    expect(res.body.error?.message).toContain("on the GitHub account Acme");
  });

  test("a repository the installation cannot see is refused with where to add it", async () => {
    const before = github.tokens.length;
    const res = await grant({ repository: "acme/secret-plans" });
    expect(res.status).toBe(406);
    expect(res.body.error?.message).toContain(
      "Add the repository to the App's installation on GitHub",
    );
    expect(github.tokens.length).toBe(before);
    expect(github.mints.at(-1)).toMatchObject({
      repositories: ["secret-plans"],
      permissions: { metadata: "read" },
    });
  });

  test("not a repository, an unknown bot, another project's bot, a duplicate", async () => {
    const notRepo = await grant({ repository: "just-a-name" });
    expect(notRepo.status).toBe(406);
    expect(notRepo.body.error?.message).toContain("owner/name");

    const unknown = await grant({ repository: "acme/lib", botIds: [999_999] });
    expect(unknown.status).toBe(406);
    expect(unknown.body.error?.key).toBe("botIds");
    expect(unknown.body.error?.message).toContain("999999");

    const foreign = await grant({
      repository: "acme/lib",
      botIds: [bowserBotId],
    });
    expect(foreign.status).toBe(406);
    expect(foreign.body.error?.key).toBe("botIds");

    const none = await grant({ repository: "acme/lib", botIds: [] });
    expect(none.status).toBe(406);

    const duplicate = await grant({ repository: "ACME/web.git" });
    expect(duplicate.status).toBe(406);
    expect(duplicate.body.error?.message).toContain("already granted");
  });

  test("a suspended installation grants nothing", async () => {
    await api.db.db
      .update(githubInstallations)
      .set({ suspendedAt: new Date() })
      .where(eq(githubInstallations.id, installationId));
    try {
      const res = await grant({ repository: "acme/lib" });
      expect(res.status).toBe(406);
      expect(res.body.error?.message).toContain("suspended");
      expect((await repositoriesOf(u.peach, adaId)).body.repositories).toEqual(
        [],
      );
    } finally {
      await api.db.db
        .update(githubInstallations)
        .set({ suspendedAt: null })
        .where(eq(githubInstallations.id, installationId));
    }
  });
});

describe("repository-grant:list / view / edit / delete", () => {
  test("members list and view; the list is by repository name", async () => {
    const list = await call<{
      repositoryGrants: Grant[];
      pagination: { total: number; limit: number };
    }>(u.url, u.toad, "GET", `/project/${u.projectId}/repository-grants`);
    expect(list.status).toBe(200);
    expect(list.body.pagination).toMatchObject({ total: 2, limit: 25 });
    expect(list.body.repositoryGrants.map((g) => g.fullName)).toEqual([
      "acme/api",
      "acme/web",
    ]);

    const id = list.body.repositoryGrants[0].id;
    const view = await call<{ repositoryGrant: Grant; warnings: string[] }>(
      u.url,
      u.toad,
      "GET",
      `/project/${u.projectId}/repository-grant/${id}`,
    );
    expect(view.status).toBe(200);
    expect(view.body.repositoryGrant.push).toBe(true);
    expect(view.body.warnings).toHaveLength(1);

    expect(
      (
        await call(
          u.url,
          u.bowser,
          "GET",
          `/project/${u.bowser.projectId}/repository-grant/${id}`,
        )
      ).status,
    ).toBe(404);
  });

  test("an edit changes only what it sends; a prefix clears the warning and offers a ruleset", async () => {
    const [api_] = (
      await call<{ repositoryGrants: Grant[] }>(
        u.url,
        u.peach,
        "GET",
        `/project/${u.projectId}/repository-grants`,
      )
    ).body.repositoryGrants;
    const path = `/project/${u.projectId}/repository-grant/${api_.id}`;

    const prefixed = await call<{ repositoryGrant: Grant; warnings: string[] }>(
      u.url,
      u.peach,
      "POST",
      path,
      { branchPrefix: "hypotenuse/ada/" },
    );
    expect(prefixed.status).toBe(200);
    expect(prefixed.body.warnings).toEqual([]);
    expect(prefixed.body.repositoryGrant).toMatchObject({
      push: true,
      branchPrefix: "hypotenuse/ada/",
      botIds: [adaId],
    });
    expect(
      JSON.stringify(prefixed.body.repositoryGrant.recommendedRuleset),
    ).toContain("refs/heads/hypotenuse/ada/**");

    const bad = await call(u.url, u.peach, "POST", path, {
      branchPrefix: "../main",
    });
    expect(bad.status).toBe(406);

    const cleared = await call<{ repositoryGrant: Grant; warnings: string[] }>(
      u.url,
      u.peach,
      "POST",
      path,
      { branchPrefix: null },
    );
    expect(cleared.body.warnings).toHaveLength(1);

    const back = await call<{ repositoryGrant: Grant; warnings: string[] }>(
      u.url,
      u.peach,
      "POST",
      path,
      { branchPrefix: "hypotenuse/ada/", botIds: [adaId, secretBotId] },
    );
    expect(back.body.repositoryGrant.botIds).toEqual(
      [adaId, secretBotId].sort((a, b) => a - b),
    );

    expect(
      (await call(u.url, u.mario, "POST", path, { push: false })).status,
    ).toBe(403);
  });

  test("bot:repositories: listed bots get the grant, every bot gets an all-bots grant", async () => {
    const ada = await repositoriesOf(u.toad, adaId);
    expect(ada.status).toBe(200);
    expect(ada.body.repositories).toMatchObject([
      {
        fullName: "acme/api",
        access: "write",
        branchPrefix: "hypotenuse/ada/",
      },
      { fullName: "acme/web", access: "read", branchPrefix: null },
    ]);
    const bob = await repositoriesOf(u.toad, bobId);
    expect(bob.body.repositories.map((r) => r.fullName)).toEqual(["acme/web"]);

    // A bot the caller cannot read answers as not found.
    expect((await repositoriesOf(u.toad, secretBotId)).status).toBe(404);
    expect(
      (await repositoriesOf(u.mario, secretBotId)).body.repositories,
    ).toHaveLength(2);
    expect((await repositoriesOf(u.bowser, adaId)).status).toBe(403);
  });

  test("deleting a grant takes the repository from its bots", async () => {
    const [api_] = (
      await call<{ repositoryGrants: Grant[] }>(
        u.url,
        u.peach,
        "GET",
        `/project/${u.projectId}/repository-grants`,
      )
    ).body.repositoryGrants;
    const path = `/project/${u.projectId}/repository-grant/${api_.id}`;
    expect((await call(u.url, u.mario, "DELETE", path)).status).toBe(403);
    const res = await call<{ repositoryGrant: Grant }>(
      u.url,
      u.peach,
      "DELETE",
      path,
    );
    expect(res.status).toBe(200);
    expect(res.body.repositoryGrant.fullName).toBe("acme/api");
    expect((await call(u.url, u.peach, "GET", path)).status).toBe(404);
    expect(
      (await repositoriesOf(u.peach, adaId)).body.repositories.map(
        (r) => r.fullName,
      ),
    ).toEqual(["acme/web"]);
  });

  test("a detached installation leaves its bots nothing", async () => {
    const res = await call(
      u.url,
      u.peach,
      "DELETE",
      `/project/${u.projectId}/github/installation/${installationId}`,
    );
    expect(res.status).toBe(200);
    expect((await repositoriesOf(u.peach, bobId)).body.repositories).toEqual(
      [],
    );
  });
});

describe("bot:edit githubWakeEvents", () => {
  test("a new bot wakes on changes requested and failed checks", async () => {
    const view = await call<{ bot: { githubWakeEvents: string[] } }>(
      u.url,
      u.toad,
      "GET",
      `/project/${u.projectId}/bot/${bobId}`,
    );
    expect(view.body.bot.githubWakeEvents).toEqual([
      "changes_requested",
      "check_failed",
    ]);
  });

  test("a writer sets them, deduplicated and in a stable order; an unknown event is refused", async () => {
    const path = `/project/${u.projectId}/bot/${bobId}`;
    const res = await call<{ bot: { githubWakeEvents: string[] } }>(
      u.url,
      u.toad,
      "POST",
      path,
      { githubWakeEvents: ["merged", "approved", "merged"] },
    );
    expect(res.status).toBe(200);
    expect(res.body.bot.githubWakeEvents).toEqual(["approved", "merged"]);

    const none = await call<{ bot: { githubWakeEvents: string[] } }>(
      u.url,
      u.toad,
      "POST",
      path,
      { githubWakeEvents: [] },
    );
    expect(none.body.bot.githubWakeEvents).toEqual([]);

    const bad = await call(u.url, u.toad, "POST", path, {
      githubWakeEvents: ["pushed"],
    });
    expect(bad.status).toBe(406);
  });
});
