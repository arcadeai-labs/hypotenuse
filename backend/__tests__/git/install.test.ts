import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, desc, eq } from "drizzle-orm";
import { api, config } from "keryx";
import { auditLogs } from "../../schema/audit_logs";
import { githubInstallations } from "../../schema/github_installations";
import { repositoryGrants } from "../../schema/repository_grants";
import { FakeGitHub } from "../fakes/github/server";
import {
  buildTestUniverse,
  call,
  HOOK_TIMEOUT,
  type TestUniverse,
} from "../setup";
import {
  attachInstallation,
  installCallback,
  installUrl,
  useFakeGitHub,
} from "./repositories-harness";

/**
 * Attaching the deployment's GitHub App to a project: the install link, the
 * callback GitHub sends the browser to (state, the person's proof they can
 * see the installation, reattaching), listing and detaching, who may do each,
 * and what the audit log keeps — against the GitHub fake.
 */

const github = new FakeGitHub();
let u: TestUniverse;
let restore: () => void;

beforeAll(async () => {
  u = await buildTestUniverse();
  await github.start();
  restore = useFakeGitHub(github);
  github.install({ id: "7001", login: "Acme", repositories: ["api", "web"] });
  github.install({ id: "8002", login: "koopa", repositories: ["castle"] });
}, HOOK_TIMEOUT);

afterAll(async () => {
  restore();
  await github.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * The newest audit row for an action.
 * @param action - The action name.
 * @returns The row, or `undefined`.
 */
async function lastAudit(action: string) {
  const [row] = await api.db.db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.action, action))
    .orderBy(desc(auditLogs.id))
    .limit(1);
  return row;
}

describe("github:install-url", () => {
  test("an admin gets GitHub's install link carrying a fresh state", async () => {
    const a = await installUrl(u.url, u.peach, u.projectId);
    const b = await installUrl(u.url, u.peach, u.projectId);
    expect(a.status).toBe(200);
    expect(a.body.missing).toEqual([]);
    expect(a.body.url).toStartWith(
      `${github.url}/apps/${github.appSlug}/installations/new?state=`,
    );
    expect(a.state).not.toBe(b.state);
  });

  test("an unconfigured App answers no link and what is missing", async () => {
    const saved = { ...config.github };
    Object.assign(config.github, { appId: "", clientSecret: "" });
    try {
      const res = await installUrl(u.url, u.peach, u.projectId);
      expect(res.status).toBe(200);
      expect(res.body.url).toBeNull();
      expect(res.body.missing).toContain("GITHUB_APP_ID");
      expect(res.body.missing).toContain("GITHUB_APP_CLIENT_SECRET");
      expect(res.body.message).toContain("GITHUB_APP_ID");
    } finally {
      Object.assign(config.github, saved);
    }
  });

  test("a member who is not an admin, and an outsider, are refused", async () => {
    expect((await installUrl(u.url, u.mario, u.projectId)).status).toBe(403);
    expect((await installUrl(u.url, u.bowser, u.projectId)).status).toBe(403);
  });
});

describe("github:install-callback", () => {
  let attachedId: number;

  // github.install.callback
  test("a person who can see the installation attaches it, and lands on Repositories", async () => {
    const { state } = await installUrl(u.url, u.peach, u.projectId);
    const code = github.authorizeUser("peach-gh", ["7001"]);
    const res = await installCallback(u.url, u.peach, {
      state: state!,
      installation_id: "7001",
      setup_action: "install",
      code,
    });
    expect(res.status).toBe(302);
    expect(res.location?.origin).toBe(new URL(config.frontend.url).origin);
    expect(res.location?.pathname).toBe(
      `/projects/${u.projectId}/repositories`,
    );
    attachedId = Number(res.location?.searchParams.get("installed"));
    expect(attachedId).toBeGreaterThan(0);

    const list = await call<{
      installations: {
        id: number;
        installationId: string;
        accountLogin: string;
        accountType: string;
        status: string;
        permissions: Record<string, string>;
        attachedByUserId: number;
      }[];
    }>(u.url, u.peach, "GET", `/project/${u.projectId}/github/installations`);
    expect(list.body.installations).toHaveLength(1);
    expect(list.body.installations[0]).toMatchObject({
      id: attachedId,
      installationId: "7001",
      accountLogin: "Acme",
      accountType: "Organization",
      status: "active",
      attachedByUserId: u.peach.userId,
    });
    expect(list.body.installations[0].permissions.contents).toBe("write");

    const audit = await lastAudit("github:install-callback");
    expect(audit?.userId).toBe(u.peach.userId);
    expect(audit?.projectId).toBe(u.projectId);
    expect(audit?.organizationId).toBe(u.organizationId);
    expect(audit?.before).toBeNull();
    expect((audit?.after as { id: number }).id).toBe(attachedId);
    const text = JSON.stringify(audit);
    expect(text).not.toContain(code);
    expect(text).not.toContain(state!);
    expect(text).not.toMatch(/gh[us]_/);
  });

  test("a state works once", async () => {
    const { state } = await installUrl(u.url, u.peach, u.projectId);
    const query = {
      state: state!,
      installation_id: "7001",
      code: github.authorizeUser("peach-gh", ["7001"]),
    };
    expect(
      (await installCallback(u.url, u.peach, query)).location?.searchParams.get(
        "installed",
      ),
    ).toBeTruthy();
    const again = await installCallback(u.url, u.peach, {
      ...query,
      code: github.authorizeUser("peach-gh", ["7001"]),
    });
    expect(again.status).toBe(302);
    expect(again.location?.searchParams.get("error")).toContain(
      "expired or was already used",
    );
  });

  test("another person's state is refused without using it up", async () => {
    const { state } = await installUrl(u.url, u.peach, u.projectId);
    const mario = await installCallback(u.url, u.mario, {
      state: state!,
      installation_id: "7001",
      code: github.authorizeUser("mario-gh", ["7001"]),
    });
    expect(mario.location?.searchParams.get("error")).toContain(
      "started by somebody else",
    );
    const signedOut = await installCallback(u.url, null, {
      state: state!,
      installation_id: "7001",
      code: github.authorizeUser("mario-gh", ["7001"]),
    });
    expect(signedOut.location?.searchParams.get("error")).toContain("Sign in");
    const peach = await installCallback(u.url, u.peach, {
      state: state!,
      installation_id: "7001",
      code: github.authorizeUser("peach-gh", ["7001"]),
    });
    expect(peach.location?.searchParams.get("installed")).toBe(
      String(attachedId),
    );
  });

  // github.install.spoofed
  test("a spoofed installation id the person cannot see writes nothing", async () => {
    const before = await lastAudit("github:install-callback");
    const { state } = await installUrl(u.url, u.peach, u.projectId);
    const res = await installCallback(u.url, u.peach, {
      state: state!,
      installation_id: "8002",
      setup_action: "install",
      code: github.authorizeUser("peach-gh", ["7001"]),
    });
    expect(res.status).toBe(302);
    expect(res.location?.pathname).toBe(
      `/projects/${u.projectId}/repositories`,
    );
    expect(res.location?.searchParams.get("error")).toContain(
      "not one you can access",
    );
    expect(res.location?.searchParams.get("installed")).toBeNull();
    const rows = await api.db.db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.installationId, "8002"));
    expect(rows).toHaveLength(0);
    expect((await lastAudit("github:install-callback"))?.id).toBe(before?.id);
  });

  test("a requested install says an organization owner must approve it", async () => {
    const { state } = await installUrl(u.url, u.peach, u.projectId);
    const res = await installCallback(u.url, u.peach, {
      state: state!,
      setup_action: "request",
    });
    expect(res.location?.searchParams.get("error")).toContain(
      "owner of the GitHub organization must approve",
    );
  });

  test("a missing code is refused with how to fix the App", async () => {
    const { state } = await installUrl(u.url, u.peach, u.projectId);
    const res = await installCallback(u.url, u.peach, {
      state: state!,
      installation_id: "7001",
    });
    expect(res.location?.searchParams.get("error")).toContain(
      "Request user authorization",
    );
  });

  test("an installation GitHub removed is reattached in place", async () => {
    await api.db.db
      .update(githubInstallations)
      .set({ revokedAt: new Date() })
      .where(eq(githubInstallations.id, attachedId));
    const removed = await call<{ installations: { status: string }[] }>(
      u.url,
      u.mario,
      "GET",
      `/project/${u.projectId}/github/installations`,
    );
    expect(removed.body.installations[0].status).toBe("removed");

    const id = await attachInstallation(
      u.url,
      github,
      u.peach,
      u.projectId,
      "7001",
    );
    expect(id).toBe(attachedId);
    const audit = await lastAudit("github:install-callback");
    expect((audit?.before as { status: string }).status).toBe("removed");
    expect((audit?.after as { status: string }).status).toBe("active");
    expect(audit?.metadata).toMatchObject({ reattached: true });
  });
});

describe("github:installation-list and github:installation-detach", () => {
  let koopaInstallation: number;

  test("members list; non-admins and other projects' admins cannot change anything", async () => {
    const mario = await call<{
      installations: unknown[];
      pagination: { total: number };
    }>(u.url, u.mario, "GET", `/project/${u.projectId}/github/installations`);
    expect(mario.status).toBe(200);
    expect(mario.body.pagination.total).toBe(1);

    expect(
      (
        await call(
          u.url,
          u.bowser,
          "GET",
          `/project/${u.projectId}/github/installations`,
        )
      ).status,
    ).toBe(403);

    const [row] = await api.db.db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.projectId, u.projectId));
    expect(
      (
        await call(
          u.url,
          u.mario,
          "DELETE",
          `/project/${u.projectId}/github/installation/${row.id}`,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          u.url,
          u.mario,
          "PUT",
          `/project/${u.projectId}/repository-grant`,
          { githubInstallationId: row.id, repository: "acme/api" },
        )
      ).status,
    ).toBe(403);
    // Bowser is an admin of his own project, which does not hold the row.
    expect(
      (
        await call(
          u.url,
          u.bowser,
          "DELETE",
          `/project/${u.bowser.projectId}/github/installation/${row.id}`,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await call(
          u.url,
          u.bowser,
          "PUT",
          `/project/${u.bowser.projectId}/repository-grant`,
          { githubInstallationId: row.id, repository: "acme/api" },
        )
      ).status,
    ).toBe(406);
  });

  test("the same installation attaches to another project on its own", async () => {
    koopaInstallation = await attachInstallation(
      u.url,
      github,
      u.bowser,
      u.bowser.projectId,
      "8002",
    );
    const list = await call<{ installations: { accountLogin: string }[] }>(
      u.url,
      u.bowser,
      "GET",
      `/project/${u.bowser.projectId}/github/installations`,
    );
    expect(list.body.installations.map((i) => i.accountLogin)).toEqual([
      "koopa",
    ]);
    expect(koopaInstallation).toBeGreaterThan(0);
  });

  test("detaching deletes the installation's grants with it, audited", async () => {
    const [row] = await api.db.db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.projectId, u.projectId));
    const grant = await call<{ repositoryGrant: { id: number } }>(
      u.url,
      u.peach,
      "PUT",
      `/project/${u.projectId}/repository-grant`,
      { githubInstallationId: row.id, repository: "acme/api", push: true },
    );
    expect(grant.status).toBe(200);
    const grantAudit = await lastAudit("repository-grant:create");
    expect(grantAudit?.targetPath).toBe("acme/api");
    expect(JSON.stringify(grantAudit)).not.toMatch(/ghs_/);

    const res = await call<{
      installation: { id: number; accountLogin: string };
      removedGrants: { id: number; fullName: string }[];
    }>(
      u.url,
      u.peach,
      "DELETE",
      `/project/${u.projectId}/github/installation/${row.id}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.installation.accountLogin).toBe("Acme");
    expect(res.body.removedGrants).toEqual([
      { id: grant.body.repositoryGrant.id, fullName: "acme/api" },
    ]);
    expect(
      await api.db.db
        .select()
        .from(repositoryGrants)
        .where(eq(repositoryGrants.projectId, u.projectId)),
    ).toHaveLength(0);
    const audit = await lastAudit("github:installation-detach");
    expect(audit?.after).toBeNull();
    expect((audit?.before as { id: number }).id).toBe(row.id);
    expect(audit?.metadata).toMatchObject({
      removedGrants: [{ fullName: "acme/api" }],
    });

    // Bowser's attachment of another installation is untouched.
    const still = await api.db.db
      .select()
      .from(githubInstallations)
      .where(
        and(
          eq(githubInstallations.projectId, u.bowser.projectId),
          eq(githubInstallations.id, koopaInstallation),
        ),
      );
    expect(still).toHaveLength(1);
  });
});
