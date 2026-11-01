import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { api, config } from "keryx";
import {
  findGrant,
  grantLevel,
  parseCredentialRepository,
  parseRepositoryName,
  recommendedRuleset,
} from "../../ops/GitAccessOps";
import {
  capSandboxGitHubPermission,
  installationSandboxPermissions,
  jobPermissionFor,
  redactGitHubTokens,
} from "../../ops/GitCredentialOps";
import {
  assertUserCanAccessInstallation,
  exchangeGitHubUserCode,
  fetchInstallationPermissions,
  type GitHubApp,
  githubAppPrivateKeyCanSign,
  mintInstallationToken,
  missingGitHubAppConfig,
  normalizePrivateKey,
  revokeInstallationToken,
  signAppJwt,
} from "../../ops/GitHubAppOps";
import { FakeGitHub } from "../fakes/github/server";
import { HOOK_TIMEOUT } from "../setup";

/**
 * The GitHub App, ported from ToolExec: a key that signs, a JWT GitHub
 * accepts, a token minted for one repository and refused for another, a
 * revocation GitHub records, and the install's proof that a person can see
 * the installation — against the GitHub fake, which verifies the JWT with the
 * App's public key and enforces a token's scope as GitHub does.
 */

const github = new FakeGitHub();
const saved = { ...config.github };
let app: GitHubApp;

beforeAll(async () => {
  await api.start();
  await github.start();
  github.configure(config.github as unknown as Record<string, unknown>);
  github.install({ id: "7001", login: "acme", repositories: ["api"] });
  app = {
    appId: github.appId,
    privateKey: github.privateKeyPem,
    installationId: "7001",
  };
}, HOOK_TIMEOUT);

afterAll(async () => {
  Object.assign(config.github, saved);
  await github.stop();
  await api.stop();
}, HOOK_TIMEOUT);

describe("the App's key", () => {
  test("a key pasted with literal \\n, CRLF, quotes, or base64 normalizes to one that signs", () => {
    const pem = github.privateKeyPem;
    for (const pasted of [
      pem.replace(/\n/g, "\\n"),
      pem.replace(/\n/g, "\r\n"),
      `"${pem}"`,
      Buffer.from(pem).toString("base64"),
    ]) {
      expect(githubAppPrivateKeyCanSign(normalizePrivateKey(pasted))).toBe(
        true,
      );
    }
    expect(githubAppPrivateKeyCanSign("not a key")).toBe(false);
  });

  // Coverage: `github.app.jwt`.
  test("the JWT is RS256, issued by the App, backdated a minute, and under ten minutes long", () => {
    const now = Date.UTC(2030, 0, 1);
    const jwt = signAppJwt(app, now);
    const [header, payload, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(claims.iss).toBe(github.appId);
    expect(claims.iat).toBe(now / 1000 - 60);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const wrong = createVerify("RSA-SHA256");
    wrong.update(`${header}.${payload}`);
    expect(wrong.verify(publicKey, Buffer.from(signature, "base64url"))).toBe(
      false,
    );
  });

  test("a configured App with nothing missing reports nothing missing", () => {
    expect(missingGitHubAppConfig()).toEqual([]);
    const key = config.github.privateKey;
    config.github.privateKey = "";
    try {
      expect(missingGitHubAppConfig()).toContain("GITHUB_APP_PRIVATE_KEY");
    } finally {
      config.github.privateKey = key;
    }
  });
});

describe("installation tokens", () => {
  // Coverage: `github.out.access-token`.
  test("a token minted for acme/api reads acme/api and nothing else", async () => {
    const minted = await mintInstallationToken(app, {
      repositories: ["api"],
      permissions: { contents: "read", metadata: "read" },
    });
    expect(minted.token).toMatch(/^ghs_/);
    expect(minted.expiresAtMs).toBeGreaterThan(Date.now());
    const record = github.tokens.find((t) => t.token === minted.token);
    expect(record?.repositories).toEqual(["api"]);
    expect(record?.permissions).toEqual({ contents: "read", metadata: "read" });
  });

  test("a repository the installation was never granted is GitHub's refusal, not a wider token", async () => {
    await expect(
      mintInstallationToken(app, {
        repositories: ["other"],
        permissions: { contents: "read", metadata: "read" },
      }),
    ).rejects.toThrow(/not accessible to the parent installation/);
  });

  // Coverage: `github.out.installation`.
  test("the installation's live permissions are read with the App's JWT", async () => {
    const permissions = await fetchInstallationPermissions(app);
    expect(permissions?.contents).toBe("write");
  });

  // Coverage: `github.out.revoke`.
  test("revoking presents the token itself, and GitHub records it", async () => {
    const minted = await mintInstallationToken(app, {
      repositories: ["api"],
      permissions: { contents: "read", metadata: "read" },
    });
    expect(await revokeInstallationToken(minted.token)).toBe(true);
    expect(github.revocations).toContain(minted.token);
    // Already invalid is the outcome we wanted.
    expect(await revokeInstallationToken(minted.token)).toBe(true);
  });
});

describe("the install's proof", () => {
  // Coverage: `github.oauth.code`, `github.out.user-installations`.
  test("a person who can see the installation passes; one who cannot is refused", async () => {
    const code = github.authorizeUser("peach", ["7001"]);
    const token = await exchangeGitHubUserCode(code);
    await assertUserCanAccessInstallation(token, "7001");
    await expect(
      assertUserCanAccessInstallation(token, "9999"),
    ).rejects.toThrow(/not one you can access/);
  });

  test("a code used twice is refused", async () => {
    const code = github.authorizeUser("mario", []);
    await exchangeGitHubUserCode(code);
    await expect(exchangeGitHubUserCode(code)).rejects.toThrow();
  });
});

describe("grants and permissions, pure", () => {
  test("a credential path is exactly owner/repo, never a traversal", () => {
    expect(parseCredentialRepository("acme/api.git")).toEqual({
      owner: "acme",
      repo: "api",
    });
    for (const bad of [
      "acme",
      "acme/api/x",
      "../api",
      "acme/..",
      "a b/c",
      "",
    ]) {
      expect(parseCredentialRepository(bad)).toBeNull();
    }
    expect(parseRepositoryName("https://github.com/Acme/API")).toEqual({
      owner: "acme",
      repo: "api",
    });
  });

  test("a grant covers its listed bots, or every bot when it lists none; case does not matter", () => {
    const grants = [
      {
        host: "github.com",
        owner: "acme",
        name: "api",
        botIds: [1],
        push: true,
      },
      {
        host: "github.com",
        owner: "acme",
        name: "web",
        botIds: null,
        push: false,
      },
    ];
    const t = (repo: string) => ({ host: "github.com", owner: "ACME", repo });
    expect(grantLevel(findGrant(grants, 1, t("API")))).toBe("write");
    expect(grantLevel(findGrant(grants, 2, t("api")))).toBe("none");
    expect(grantLevel(findGrant(grants, 2, t("web")))).toBe("read");
  });

  test("a job writes only the repository it was started to change, and only with push", () => {
    const job = {
      repository: {
        host: "github.com",
        owner: "acme",
        name: "api",
        mode: "write",
      },
    };
    expect(jobPermissionFor(job, true, { owner: "acme", repo: "api" })).toBe(
      "write",
    );
    expect(jobPermissionFor(job, true, { owner: "acme", repo: "lib" })).toBe(
      "read",
    );
    expect(jobPermissionFor(job, false, { owner: "acme", repo: "api" })).toBe(
      "read",
    );
    expect(
      jobPermissionFor(
        { repository: { ...job.repository, mode: "read" } },
        true,
        { owner: "acme", repo: "api" },
      ),
    ).toBe("read");
    expect(
      jobPermissionFor({ repository: null }, true, {
        owner: "acme",
        repo: "api",
      }),
    ).toBe("read");
  });

  test("permissions are capped to the job, organization scopes and administration dropped", () => {
    const installed = {
      contents: "write",
      metadata: "read",
      pull_requests: "write",
      checks: "write",
      administration: "write",
      workflows: "write",
      members: "read",
      organization_projects: "write",
    };
    expect(installationSandboxPermissions("read", installed)).toEqual({
      contents: "read",
      metadata: "read",
      pull_requests: "read",
      checks: "read",
    });
    expect(installationSandboxPermissions("write", installed)).toEqual({
      contents: "write",
      metadata: "read",
      pull_requests: "write",
      checks: "read",
    });
    expect(capSandboxGitHubPermission("contents", "", "write")).toBeNull();
  });

  test("the recommended ruleset blocks every branch outside the prefix", () => {
    const ruleset = recommendedRuleset("hypotenuse/toadsworth/");
    expect(JSON.stringify(ruleset)).toContain(
      "refs/heads/hypotenuse/toadsworth/**",
    );
  });

  test("a GitHub token printed by an agent is redacted", () => {
    const token = `ghs_${"a".repeat(36)}`;
    expect(redactGitHubTokens({ text: `GH_TOKEN=${token}` })).toEqual({
      text: "GH_TOKEN=ghs_[redacted]",
    });
  });
});
