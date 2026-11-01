import { describe, expect, test } from "bun:test";
import { DESTINATIONS } from "../components/shell/destinations";
import {
  BRANCH_PREFIX_PLACEHOLDER,
  DEFAULT_WAKE_EVENTS,
  EMPTY_GRANT_DRAFT,
  GITHUB_WAKE_EVENTS,
  grantAccessWords,
  grantBotsWords,
  grantCreateBody,
  grantDraftOf,
  grantEditBody,
  handoutOutcomeLabel,
  INSTALLATION_STATUS_TONE,
  installationStatusLabel,
  installNotice,
  jobModeDetail,
  jobModeWords,
  jobRepository,
  jobRepositoryWords,
  orderWakeEvents,
  parseRepositoryInput,
  pullRequestFromText,
  pullRequestStateLabel,
  type RepositoryGrant,
  repositoryUrl,
  rulesetJson,
  sameWakeEvents,
} from "../utils/repositories";

/**
 * A grant as `repository-grant:list` serializes it, with the fields a test
 * does not care about filled in.
 * @param fields - What the test does care about.
 * @returns The grant.
 */
function grant(fields: Partial<RepositoryGrant> = {}): RepositoryGrant {
  return {
    id: 7,
    projectId: 1,
    githubInstallationId: 3,
    accountLogin: "acme",
    host: "github.com",
    owner: "acme",
    name: "api",
    fullName: "acme/api",
    push: false,
    branchPrefix: null,
    botIds: null,
    allBots: true,
    recommendedRuleset: null,
    createdByUserId: 1,
    createdAt: 0,
    updatedAt: 0,
    ...fields,
  } as RepositoryGrant;
}

describe("the Repositories destination", () => {
  test("is live in the sidebar, on g r, beside Sandboxes", () => {
    const ids = DESTINATIONS.map((d) => d.id);
    const repositories = DESTINATIONS.find((d) => d.id === "repositories");
    expect(repositories?.available).toBe(true);
    expect(repositories?.to).toBe("/repositories");
    expect(repositories?.shortcut).toBe("g r");
    expect(ids.indexOf("repositories")).toBe(ids.indexOf("sandboxes") + 1);
    const shortcuts = DESTINATIONS.flatMap((d) => d.shortcut ?? []);
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
  });
});

describe("pull-request wake events", () => {
  test("mirror the server's list, in its order, each in words of its own", () => {
    expect(GITHUB_WAKE_EVENTS.map((e) => e.value)).toEqual([
      "changes_requested",
      "approved",
      "commented",
      "review_comment",
      "check_failed",
      "check_passed",
      "closed",
      "merged",
    ]);
    const labels = GITHUB_WAKE_EVENTS.map((e) => e.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const label of labels) expect(label).not.toMatch(/_/);
  });

  test("a new bot wakes for changes requested and a failed check", () => {
    expect(DEFAULT_WAKE_EVENTS).toEqual(["changes_requested", "check_failed"]);
  });

  test("chosen events are put in the server's order without repeats, and compared as sets", () => {
    expect(
      orderWakeEvents(["merged", "check_failed", "merged", "approved"]),
    ).toEqual(["approved", "check_failed", "merged"]);
    expect(
      sameWakeEvents(
        ["check_failed", "changes_requested"],
        ["changes_requested", "check_failed"],
      ),
    ).toBe(true);
    expect(sameWakeEvents(["check_failed"], [])).toBe(false);
  });
});

describe("installations and grants in words", () => {
  test("every installation status has words and a tone", () => {
    for (const status of ["active", "suspended", "removed"]) {
      expect(installationStatusLabel(status)).not.toBe(status);
      expect(INSTALLATION_STATUS_TONE[status]).toBeDefined();
    }
  });

  test("access reads as read, or read and push", () => {
    expect(grantAccessWords(false)).toBe("Read");
    expect(grantAccessWords(true)).toBe("Read and push");
  });

  test("a grant names its bots, or every bot; a bot the reader cannot see is still counted", () => {
    const names = new Map([
      [1, "Ada"],
      [2, "Grace"],
    ]);
    expect(grantBotsWords(grant(), names)).toBe("Every bot");
    expect(
      grantBotsWords(grant({ allBots: false, botIds: [2, 1, 9] }), names),
    ).toBe("Grace, Ada, Bot #9");
  });

  test("the ruleset is indented JSON, and only for a grant with a prefix", () => {
    expect(rulesetJson(grant())).toBeNull();
    const ruleset = { name: "Hypotenuse branches", target: "branch" };
    expect(rulesetJson(grant({ recommendedRuleset: ruleset }))).toBe(
      JSON.stringify(ruleset, null, 2),
    );
  });

  test("a repository's address is on its host", () => {
    expect(repositoryUrl("acme/api")).toBe("https://github.com/acme/api");
    expect(repositoryUrl("acme/api", "ghe.acme.dev")).toBe(
      "https://ghe.acme.dev/acme/api",
    );
  });

  test("the branch prefix placeholder is the one the server falls back to", () => {
    expect(BRANCH_PREFIX_PLACEHOLDER).toBe("hypotenuse/<bot-slug>/");
  });
});

describe("arriving from GitHub's install flow", () => {
  test("an error wins, an attach is good news, and nothing says nothing", () => {
    expect(installNotice(new URLSearchParams("installed=4"))?.tone).toBe(
      "success",
    );
    expect(
      installNotice(new URLSearchParams("installed=4&error=Expired")),
    ).toEqual({ tone: "danger", text: "Expired" });
    expect(installNotice(new URLSearchParams(""))).toBeNull();
  });
});

describe("the grant form", () => {
  test("a repository is owner/name, or its GitHub URL; anything else is refused before a round trip", () => {
    expect(parseRepositoryInput(" acme/api ")).toBe("acme/api");
    expect(parseRepositoryInput("https://github.com/acme/api.git")).toBe(
      "acme/api",
    );
    expect(parseRepositoryInput("https://github.com/acme/api/")).toBe(
      "acme/api",
    );
    expect(parseRepositoryInput("acme")).toBeNull();
    expect(parseRepositoryInput("acme/api/tree/main")).toBeNull();
  });

  test("a new grant needs an installation, a repository, and a bot when not every bot", () => {
    expect(grantCreateBody(EMPTY_GRANT_DRAFT)).toMatch(/installation/);
    const draft = { ...EMPTY_GRANT_DRAFT, installationId: "3" };
    expect(grantCreateBody({ ...draft, repository: "api" })).toMatch(
      /owner\/name/,
    );
    expect(
      grantCreateBody({ ...draft, repository: "acme/api", allBots: false }),
    ).toMatch(/at least one bot/);
    expect(
      grantCreateBody({
        ...draft,
        repository: "acme/api",
        push: true,
        branchPrefix: "  hypotenuse/ada/ ",
        allBots: false,
        botIds: [5, 2],
      }),
    ).toEqual({
      githubInstallationId: 3,
      repository: "acme/api",
      push: true,
      branchPrefix: "hypotenuse/ada/",
      botIds: [2, 5],
    });
    expect(grantCreateBody({ ...draft, repository: "acme/api" })).toEqual({
      githubInstallationId: 3,
      repository: "acme/api",
      push: false,
      branchPrefix: null,
      botIds: null,
    });
  });

  test("an edit sends only what changed; a blank prefix clears it, every bot is null", () => {
    const saved = grant({
      push: true,
      branchPrefix: "hypotenuse/ada/",
      allBots: false,
      botIds: [2, 1],
    });
    const draft = grantDraftOf(saved);
    expect(grantEditBody(saved, draft)).toEqual({});
    expect(
      grantEditBody(saved, { ...draft, botIds: [1, 2], branchPrefix: "" }),
    ).toEqual({ branchPrefix: null });
    expect(
      grantEditBody(saved, { ...draft, push: false, allBots: true }),
    ).toEqual({ push: false, botIds: null });
    expect(grantEditBody(saved, { ...draft, botIds: [] })).toMatch(
      /at least one bot/,
    );
  });
});

describe("a job's repository, handouts, and pull requests", () => {
  test("a job's repository is read from its JSON; a job on none says so", () => {
    expect(jobRepository(null)).toBeNull();
    expect(jobRepository({ owner: "acme" })).toBeNull();
    const repo = jobRepository({
      host: "github.com",
      owner: "acme",
      name: "api",
      ref: "fix/login",
      mode: "read",
    });
    expect(repo).toEqual({
      host: "github.com",
      owner: "acme",
      name: "api",
      ref: "fix/login",
      mode: "read",
    });
    expect(jobRepositoryWords(repo)).toBe("acme/api at fix/login");
    expect(
      jobRepositoryWords(jobRepository({ owner: "acme", name: "api" })),
    ).toBe("acme/api");
    expect(jobModeWords("write")).toBe("Write");
    expect(jobModeWords("read")).toBe("Read only");
    expect(jobModeDetail("write")).toMatch(/pull request/);
    expect(jobModeDetail("read")).toMatch(/pushes nothing/);
  });

  test("handout outcomes and pull-request states have words of their own", () => {
    const outcomes = ["issued", "reused", "refused"].map(handoutOutcomeLabel);
    expect(new Set(outcomes).size).toBe(3);
    const states = ["open", "closed", "merged"].map(pullRequestStateLabel);
    expect(states).toEqual(["Open", "Closed", "Merged"]);
  });

  test("the transcript line a job's pull request leaves is read back as its name and link", () => {
    expect(
      pullRequestFromText(
        'sandbox job #3 ("Fix it") opened pull request acme/api#12: https://github.com/acme/api/pull/12',
      ),
    ).toEqual({
      name: "acme/api#12",
      url: "https://github.com/acme/api/pull/12",
    });
    expect(pullRequestFromText("The job ended.")).toBeNull();
  });
});
