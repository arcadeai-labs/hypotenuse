import {
  createHmac,
  createPublicKey,
  createVerify,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * **The GitHub fake**: GitHub as the GitHub App sees it, over GitHub's real
 * wire protocols, in process. Following the fake-platform pattern
 * (`../base.ts`), but standalone, because git's smart HTTP is streamed bytes
 * and CGI, which the JSON base cannot carry.
 *
 * - **The App.** The fake generates the App's RSA key pair; a suite puts
 *   {@link FakeGitHub.privateKeyPem} in `config.github.privateKey`. Every
 *   `/app/*` call must carry a JWT signed with that key (`RS256`, `iss` the
 *   App id, unexpired), verified against the public key, as GitHub does.
 * - **Installation tokens.** `POST /app/installations/:id/access_tokens`
 *   mints a `ghs_…` token scoped to the repositories and permissions asked —
 *   an intersection with the installation, refused (422) when a repository is
 *   not in it or a permission is above it. `DELETE /installation/token`
 *   revokes the presenting token, recorded in {@link FakeGitHub.revocations}.
 * - **Git.** Every repository is a real bare repository served by
 *   `git http-backend` at `/<owner>/<name>.git`, and **private**: a request
 *   needs a token whose repository list names it (as GitHub enforces), with
 *   `contents: write` for a push. No credential is the `401` challenge that
 *   makes git run its credential helper.
 * - **REST.** The slice the read tools and the pull-request relay call —
 *   contents, code search, a pull request, an issue, creating a pull request
 *   — under the same token scope.
 * - **User OAuth.** `POST /login/oauth/access_token` exchanges a code issued
 *   by {@link FakeGitHub.authorizeUser}, and `GET /user/installations` lists
 *   what that user can see.
 * - **Webhooks.** {@link FakeGitHub.deliver} signs a payload with
 *   `X-Hub-Signature-256` (hex HMAC-SHA256 of the raw body under the App's
 *   webhook secret) and posts it with `X-GitHub-Event` and
 *   `X-GitHub-Delivery`; the helpers build GitHub's documented payloads for a
 *   review, a review comment, a check suite, and a pull request closing.
 */

/** One request the fake received. */
export interface GitHubRequest {
  method: string;
  path: string;
  search: string;
  authorization: string | null;
  body: unknown;
}

/** An installation of the App, as the fake keeps it. */
export interface FakeInstallation {
  id: string;
  account: { login: string; type: "Organization" | "User" };
  permissions: Record<string, string>;
  repositories: string[];
  suspended: boolean;
}

/** A token the fake minted. */
export interface FakeToken {
  token: string;
  installationId: string;
  repositories: string[];
  permissions: Record<string, string>;
  expiresAt: number;
  revoked: boolean;
}

/** A pull request, as the fake keeps it. */
export interface FakePullRequest {
  owner: string;
  name: string;
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  state: "open" | "closed";
  merged: boolean;
  author: string;
}

/** A user who can authorize the App, and the installations they can see. */
interface FakeUser {
  login: string;
  installationIds: string[];
}

/** The levels GitHub orders permissions by. */
const LEVEL: Record<string, number> = { read: 1, write: 2, admin: 3 };

/**
 * GitHub, faked.
 */
export class FakeGitHub {
  /** The App's id. */
  readonly appId = "424242";
  /** The App's slug, for the install link. */
  readonly appSlug = "hypotenuse-test";
  /** The App's OAuth client. */
  readonly clientId = "Iv1.fakeclient";
  readonly clientSecret = "fake-client-secret";
  /** The App's webhook secret. */
  readonly webhookSecret = `whsec-${randomBytes(8).toString("hex")}`;
  /** The App's private key, PEM, for `config.github.privateKey`. */
  readonly privateKeyPem: string;
  private readonly publicKeyPem: string;

  /** Every request, oldest first. */
  requests: GitHubRequest[] = [];
  /** Every token minted. */
  tokens: FakeToken[] = [];
  /** Every token revoked with `DELETE /installation/token`. */
  revocations: string[] = [];
  /** Every scoped mint request body, oldest first. */
  mints: {
    installationId: string;
    repositories: string[];
    permissions: Record<string, string>;
  }[] = [];
  installations = new Map<string, FakeInstallation>();
  pulls: FakePullRequest[] = [];
  /** Where {@link deliver} posts webhooks, once a suite sets it. */
  webhookUrl: string | null = null;

  private users = new Map<string, FakeUser>();
  private codes = new Map<string, string>();
  private userTokens = new Map<string, string>();
  private root = mkdtempSync(join(tmpdir(), "hypotenuse-github-"));
  private server: ReturnType<typeof Bun.serve> | null = null;
  private backend: string | null = null;

  constructor() {
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    this.privateKeyPem = pair.privateKey;
    this.publicKeyPem = pair.publicKey;
  }

  /** The fake's origin, standing in for both `github.com` and `api.github.com`. */
  get url(): string {
    if (!this.server) throw new Error("The GitHub fake is not started");
    return `http://127.0.0.1:${this.server.port}`;
  }

  /**
   * Start listening on a free port.
   * @returns The fake.
   */
  async start(): Promise<this> {
    this.backend = await gitHttpBackendPath();
    this.server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      maxRequestBodySize: 128 * 1024 * 1024,
      fetch: (req) => this.dispatch(req),
    });
    return this;
  }

  /** Stop listening. */
  async stop(): Promise<void> {
    await this.server?.stop(true);
    this.server = null;
  }

  /**
   * Point a Hypotenuse config at this fake: the App, both origins.
   * @param github - `config.github`, mutated.
   */
  configure(github: Record<string, unknown>): void {
    Object.assign(github, {
      appId: this.appId,
      appSlug: this.appSlug,
      privateKey: this.privateKeyPem,
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      webhookSecret: this.webhookSecret,
      apiUrl: this.url,
      webUrl: this.url,
    });
  }

  /**
   * Install the App on an account, with the repositories it was granted.
   * @param input - The installation.
   * @param input.id - Its id.
   * @param input.login - The account.
   * @param input.repositories - Repository names on the account.
   * @param input.permissions - What the App was granted; contents, issues, pull requests, and checks at write by default.
   * @returns The installation.
   */
  install(input: {
    id: string;
    login: string;
    repositories: string[];
    permissions?: Record<string, string>;
    type?: "Organization" | "User";
  }): FakeInstallation {
    const inst: FakeInstallation = {
      id: input.id,
      account: { login: input.login, type: input.type ?? "Organization" },
      permissions: input.permissions ?? {
        contents: "write",
        metadata: "read",
        issues: "write",
        pull_requests: "write",
        checks: "write",
        administration: "write",
        members: "read",
      },
      repositories: input.repositories.map((r) => r.toLowerCase()),
      suspended: false,
    };
    this.installations.set(inst.id, inst);
    return inst;
  }

  /**
   * Create a repository with one commit on `main`.
   * @param owner - The account.
   * @param name - The repository.
   * @param files - Its files, path → content.
   * @returns The bare repository's path.
   */
  async createRepository(
    owner: string,
    name: string,
    files: Record<string, string> = { "README.md": `# ${name}\n` },
  ): Promise<string> {
    const bare = this.repoPath(owner, name);
    const work = mkdtempSync(join(tmpdir(), "hypotenuse-github-work-"));
    await git(["init", "--quiet", "-b", "main", work], this.root);
    for (const [path, content] of Object.entries(files)) {
      const target = join(work, path);
      await Bun.write(target, content);
    }
    await git(["add", "-A"], work);
    await git(
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "initial",
      ],
      work,
    );
    await git(["clone", "--bare", "--quiet", work, bare], this.root);
    await git(["config", "http.receivepack", "true"], bare);
    return bare;
  }

  /**
   * The bare repository behind `owner/name`.
   * @param owner - The account.
   * @param name - The repository.
   * @returns Its path.
   */
  repoPath(owner: string, name: string): string {
    return join(this.root, owner.toLowerCase(), `${name.toLowerCase()}.git`);
  }

  /**
   * Run git in a repository the fake serves (to read what a push did).
   * @param owner - The account.
   * @param name - The repository.
   * @param args - git's arguments.
   * @returns stdout, trimmed.
   */
  async gitIn(owner: string, name: string, args: string[]): Promise<string> {
    return git(args, this.repoPath(owner, name));
  }

  /**
   * Let a GitHub user authorize the App and see some installations: the code
   * GitHub would put on the install callback.
   * @param login - The user.
   * @param installationIds - The installations they can see.
   * @returns The OAuth code.
   */
  authorizeUser(login: string, installationIds: string[]): string {
    this.users.set(login, { login, installationIds });
    const code = `code-${randomBytes(6).toString("hex")}`;
    this.codes.set(code, login);
    return code;
  }

  /**
   * Open a pull request as if a person had (or a job had, with `gh`).
   * @param pr - Its fields.
   * @returns The pull request.
   */
  openPull(
    pr: Omit<FakePullRequest, "number" | "state" | "merged"> & {
      number?: number;
    },
  ): FakePullRequest {
    const number =
      pr.number ??
      this.pulls.filter((p) => p.owner === pr.owner && p.name === pr.name)
        .length + 1;
    const row: FakePullRequest = {
      ...pr,
      owner: pr.owner.toLowerCase(),
      name: pr.name.toLowerCase(),
      number,
      state: "open",
      merged: false,
    };
    this.pulls.push(row);
    return row;
  }

  /**
   * The web URL of a pull request.
   * @param pr - The pull request.
   * @returns `<origin>/<owner>/<name>/pull/<number>`.
   */
  pullUrl(pr: Pick<FakePullRequest, "owner" | "name" | "number">): string {
    return `${this.url}/${pr.owner}/${pr.name}/pull/${pr.number}`;
  }

  /**
   * Sign and deliver one webhook to {@link webhookUrl}, as GitHub does.
   * @param event - `X-GitHub-Event`.
   * @param payload - The body.
   * @param options - A fixed delivery id (a retry), or a wrong secret.
   * @returns The status and body Hypotenuse answered.
   */
  async deliver(
    event: string,
    payload: Record<string, unknown>,
    options: { deliveryId?: string; secret?: string } = {},
  ): Promise<{ status: number; body: string; deliveryId: string }> {
    if (!this.webhookUrl) throw new Error("Set webhookUrl first");
    const body = JSON.stringify(payload);
    const deliveryId = options.deliveryId ?? randomUUID();
    const signature = createHmac("sha256", options.secret ?? this.webhookSecret)
      .update(body)
      .digest("hex");
    const res = await fetch(this.webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "GitHub-Hookshot/fake",
        "x-github-event": event,
        "x-github-delivery": deliveryId,
        "x-github-hook-id": "1",
        "x-github-hook-installation-target-type": "integration",
        "x-github-hook-installation-target-id": this.appId,
        "x-hub-signature-256": `sha256=${signature}`,
      },
      body,
    });
    return { status: res.status, body: await res.text(), deliveryId };
  }

  /**
   * GitHub's payload fields every repository event carries.
   * @param pr - The pull request.
   * @returns `repository`, `installation`, and `sender`.
   */
  private envelope(pr: FakePullRequest, sender = "octo-reviewer") {
    const inst = [...this.installations.values()].find(
      (i) => i.account.login.toLowerCase() === pr.owner,
    );
    return {
      repository: {
        id: 1000 + pr.number,
        name: pr.name,
        full_name: `${pr.owner}/${pr.name}`,
        private: true,
        owner: { login: pr.owner, type: "Organization" },
        html_url: `${this.url}/${pr.owner}/${pr.name}`,
      },
      installation: { id: Number(inst?.id ?? 0) },
      sender: { login: sender, type: "User" },
    };
  }

  /**
   * A pull request as GitHub serializes one in webhooks and REST.
   * @param pr - The pull request.
   * @returns The object.
   */
  pullJson(pr: FakePullRequest) {
    return {
      number: pr.number,
      html_url: this.pullUrl(pr),
      url: `${this.url}/repos/${pr.owner}/${pr.name}/pulls/${pr.number}`,
      title: pr.title,
      body: pr.body,
      state: pr.state,
      merged: pr.merged,
      draft: false,
      user: { login: pr.author, type: "Bot" },
      head: { ref: pr.head, sha: "a".repeat(40) },
      base: { ref: pr.base, sha: "b".repeat(40) },
    };
  }

  /**
   * Deliver `pull_request_review` (`submitted`).
   * @param pr - The pull request.
   * @param state - `approved`, `changes_requested`, or `commented`.
   * @param body - The review's text.
   * @param options - Delivery options.
   * @returns What Hypotenuse answered.
   */
  review(
    pr: FakePullRequest,
    state: "approved" | "changes_requested" | "commented",
    body: string,
    options: { deliveryId?: string; secret?: string } = {},
  ) {
    return this.deliver(
      "pull_request_review",
      {
        action: "submitted",
        review: {
          id: Math.floor(Math.random() * 1e9),
          state,
          body,
          user: { login: "octo-reviewer", type: "User" },
          html_url: `${this.pullUrl(pr)}#pullrequestreview-1`,
          submitted_at: new Date().toISOString(),
        },
        pull_request: this.pullJson(pr),
        ...this.envelope(pr),
      },
      options,
    );
  }

  /**
   * Deliver `pull_request_review_comment` (`created`).
   * @param pr - The pull request.
   * @param body - The comment.
   * @param path - The file it is on.
   * @returns What Hypotenuse answered.
   */
  reviewComment(pr: FakePullRequest, body: string, path = "README.md") {
    return this.deliver("pull_request_review_comment", {
      action: "created",
      comment: {
        id: Math.floor(Math.random() * 1e9),
        body,
        path,
        line: 1,
        user: { login: "octo-reviewer", type: "User" },
        html_url: `${this.pullUrl(pr)}#discussion_r1`,
      },
      pull_request: this.pullJson(pr),
      ...this.envelope(pr),
    });
  }

  /**
   * Deliver `check_suite` (`completed`) for the pull request's head.
   * @param pr - The pull request.
   * @param conclusion - `success`, `failure`, …
   * @returns What Hypotenuse answered.
   */
  checkSuite(pr: FakePullRequest, conclusion: "success" | "failure") {
    return this.deliver("check_suite", {
      action: "completed",
      check_suite: {
        id: Math.floor(Math.random() * 1e9),
        head_branch: pr.head,
        head_sha: "a".repeat(40),
        status: "completed",
        conclusion,
        app: { slug: "github-actions", name: "GitHub Actions" },
        pull_requests: [
          {
            number: pr.number,
            head: { ref: pr.head, sha: "a".repeat(40) },
            base: { ref: pr.base, sha: "b".repeat(40) },
          },
        ],
      },
      ...this.envelope(pr, "github-actions[bot]"),
    });
  }

  /**
   * Close (or merge) a pull request and deliver `pull_request` (`closed`).
   * @param pr - The pull request.
   * @param merged - Whether it was merged.
   * @returns What Hypotenuse answered.
   */
  close(pr: FakePullRequest, merged: boolean) {
    pr.state = "closed";
    pr.merged = merged;
    return this.deliver("pull_request", {
      action: "closed",
      number: pr.number,
      pull_request: this.pullJson(pr),
      ...this.envelope(pr),
    });
  }

  /**
   * Deliver `installation` for an installation (`deleted`, `suspend`, …).
   * @param id - The installation.
   * @param action - What happened.
   * @returns What Hypotenuse answered.
   */
  installationEvent(
    id: string,
    action: "created" | "deleted" | "suspend" | "unsuspend",
  ) {
    const inst = this.installations.get(id);
    if (inst && action === "suspend") inst.suspended = true;
    if (inst && action === "unsuspend") inst.suspended = false;
    return this.deliver("installation", {
      action,
      installation: {
        id: Number(id),
        account: inst?.account ?? { login: "unknown", type: "Organization" },
        permissions: inst?.permissions ?? {},
      },
      sender: { login: "octo-admin", type: "User" },
    });
  }

  /**
   * The live token a request presents, if any (bearer or basic).
   * @param req - The request.
   * @returns The token, or `null`.
   */
  private presented(req: Request): FakeToken | null {
    const auth = req.headers.get("authorization") ?? "";
    let value: string | null = null;
    const bearer = /^(?:bearer|token)\s+(.+)$/i.exec(auth.trim());
    if (bearer) value = bearer[1];
    const basic = /^basic\s+(.+)$/i.exec(auth.trim());
    if (basic) {
      const decoded = Buffer.from(basic[1], "base64").toString("utf8");
      value = decoded.slice(decoded.indexOf(":") + 1);
    }
    if (!value) return null;
    const token = this.tokens.find((t) => t.token === value);
    if (!token || token.revoked || token.expiresAt < Date.now()) return null;
    return token;
  }

  /**
   * Whether a token reaches a repository at a level.
   * @param token - The token.
   * @param owner - The account.
   * @param name - The repository.
   * @param permission - The permission key.
   * @param level - `read` or `write`.
   * @returns `true` when it does.
   */
  private allows(
    token: FakeToken | null,
    owner: string,
    name: string,
    permission: string,
    level: "read" | "write",
  ): boolean {
    if (!token) return false;
    const inst = this.installations.get(token.installationId);
    if (!inst || inst.suspended) return false;
    if (inst.account.login.toLowerCase() !== owner.toLowerCase()) return false;
    if (!token.repositories.includes(name.toLowerCase())) return false;
    return (LEVEL[token.permissions[permission] ?? ""] ?? 0) >= LEVEL[level];
  }

  /**
   * Verify an App JWT the way GitHub does.
   * @param req - The request.
   * @returns `true` when it is signed by the App's key, for the App, unexpired.
   */
  private appAuthorized(req: Request): boolean {
    const auth = req.headers.get("authorization") ?? "";
    const jwt = /^bearer\s+(.+)$/i.exec(auth.trim())?.[1];
    if (!jwt) return false;
    const [header, payload, signature] = jwt.split(".");
    if (!header || !payload || !signature) return false;
    const verify = createVerify("RSA-SHA256");
    verify.update(`${header}.${payload}`);
    if (
      !verify.verify(
        createPublicKey(this.publicKeyPem),
        Buffer.from(signature, "base64url"),
      )
    ) {
      return false;
    }
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      iss?: string;
      exp?: number;
      iat?: number;
    };
    const now = Math.floor(Date.now() / 1000);
    return (
      claims.iss === this.appId &&
      typeof claims.exp === "number" &&
      claims.exp > now &&
      claims.exp - (claims.iat ?? now) <= 600
    );
  }

  /**
   * Route one request.
   * @param req - The request.
   * @returns The response.
   */
  private async dispatch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
    let body: unknown = null;
    if (!gitMatch && req.method !== "GET" && req.method !== "DELETE") {
      const text = await req.text();
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
    }
    this.requests.push({
      method: req.method,
      path,
      search: url.search,
      authorization: req.headers.get("authorization"),
      body,
    });
    if (gitMatch) return this.git(req, url, gitMatch[1], gitMatch[2]);
    return this.rest(req, url, body);
  }

  /**
   * GitHub's REST API, the slice Hypotenuse calls.
   * @param req - The request.
   * @param url - Its URL.
   * @param body - Its parsed body.
   * @returns The response.
   */
  private async rest(req: Request, url: URL, body: unknown): Promise<Response> {
    const path = url.pathname;
    const notFound = () =>
      Response.json(
        {
          message: "Not Found",
          documentation_url: "https://docs.github.com/rest",
        },
        { status: 404 },
      );

    // The App, authenticated by its JWT.
    const mint = /^\/app\/installations\/([^/]+)\/access_tokens$/.exec(path);
    if (mint && req.method === "POST") {
      if (!this.appAuthorized(req)) {
        return Response.json({ message: "Bad credentials" }, { status: 401 });
      }
      const inst = this.installations.get(decodeURIComponent(mint[1]));
      if (!inst) return notFound();
      if (inst.suspended) {
        return Response.json(
          { message: "This installation has been suspended" },
          { status: 403 },
        );
      }
      const asked = (body ?? {}) as {
        repositories?: string[];
        permissions?: Record<string, string>;
      };
      const repositories = (asked.repositories ?? inst.repositories).map((r) =>
        r.toLowerCase(),
      );
      this.mints.push({
        installationId: inst.id,
        repositories,
        permissions: { ...(asked.permissions ?? {}) },
      });
      if (repositories.some((r) => !inst.repositories.includes(r))) {
        return Response.json(
          {
            message:
              "There is at least one repository that does not exist or is not accessible to the parent installation.",
          },
          { status: 422 },
        );
      }
      const permissions = asked.permissions ?? inst.permissions;
      for (const [name, level] of Object.entries(permissions)) {
        if ((LEVEL[inst.permissions[name] ?? ""] ?? 0) < (LEVEL[level] ?? 9)) {
          return Response.json(
            {
              message: `The permissions requested are not granted to this installation.`,
            },
            { status: 422 },
          );
        }
      }
      const token: FakeToken = {
        token: `ghs_${randomBytes(18).toString("hex")}`,
        installationId: inst.id,
        repositories,
        permissions,
        expiresAt: Date.now() + 60 * 60 * 1000,
        revoked: false,
      };
      this.tokens.push(token);
      return Response.json(
        {
          token: token.token,
          expires_at: new Date(token.expiresAt).toISOString(),
          permissions,
          repository_selection: "selected",
          repositories: repositories.map((name) => ({
            name,
            full_name: `${inst.account.login}/${name}`,
          })),
        },
        { status: 201 },
      );
    }
    const installation = /^\/app\/installations\/([^/]+)$/.exec(path);
    if (installation && req.method === "GET") {
      if (!this.appAuthorized(req)) {
        return Response.json({ message: "Bad credentials" }, { status: 401 });
      }
      const inst = this.installations.get(decodeURIComponent(installation[1]));
      if (!inst) return notFound();
      return Response.json({
        id: Number(inst.id),
        account: inst.account,
        permissions: inst.permissions,
        repository_selection: "selected",
        suspended_at: inst.suspended ? new Date().toISOString() : null,
      });
    }
    if (path === "/installation/token" && req.method === "DELETE") {
      const token = this.presented(req);
      if (!token) return new Response(null, { status: 401 });
      token.revoked = true;
      this.revocations.push(token.token);
      return new Response(null, { status: 204 });
    }

    // A user, authorized by the install's OAuth.
    if (path === "/login/oauth/access_token" && req.method === "POST") {
      const b = (body ?? {}) as Record<string, string>;
      const login =
        b.client_id === this.clientId && b.client_secret === this.clientSecret
          ? this.codes.get(b.code)
          : undefined;
      if (!login) {
        return Response.json({
          error: "bad_verification_code",
          error_description: "The code passed is incorrect or expired.",
        });
      }
      this.codes.delete(b.code);
      const token = `ghu_${randomBytes(12).toString("hex")}`;
      this.userTokens.set(token, login);
      return Response.json({ access_token: token, token_type: "bearer" });
    }
    if (path === "/user/installations" && req.method === "GET") {
      const bearer = /^bearer\s+(.+)$/i.exec(
        (req.headers.get("authorization") ?? "").trim(),
      )?.[1];
      const login = bearer ? this.userTokens.get(bearer) : undefined;
      if (!login) {
        return Response.json({ message: "Bad credentials" }, { status: 401 });
      }
      const user = this.users.get(login);
      const installations = (user?.installationIds ?? [])
        .map((id) => this.installations.get(id))
        .filter((i): i is FakeInstallation => Boolean(i))
        .map((i) => ({ id: Number(i.id), account: i.account }));
      return Response.json({
        total_count: installations.length,
        installations,
      });
    }

    // Repositories, authenticated by an installation token.
    const token = this.presented(req);
    const repoRoute = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
    if (repoRoute) {
      const [, owner, name, rest = ""] = repoRoute;
      const permissionFor = rest.startsWith("/pulls")
        ? "pull_requests"
        : rest.startsWith("/issues")
          ? "issues"
          : "contents";
      const write = req.method !== "GET";
      if (!this.allows(token, owner, name, "metadata", "read")) {
        return notFound();
      }
      if (
        !this.allows(
          token,
          owner,
          name,
          permissionFor,
          write ? "write" : "read",
        )
      ) {
        return Response.json(
          { message: "Resource not accessible by integration" },
          { status: 403 },
        );
      }
      return this.repo(
        req,
        url,
        owner.toLowerCase(),
        name.toLowerCase(),
        rest,
        body,
      );
    }
    if (path === "/search/code" && req.method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      const repo = /repo:([^/\s]+)\/(\S+)/.exec(q);
      if (!repo) {
        return Response.json(
          { message: "Validation Failed: a repo: qualifier is required here" },
          { status: 422 },
        );
      }
      const [, owner, name] = repo;
      if (!this.allows(token, owner, name, "contents", "read")) {
        return Response.json(
          { message: "Validation Failed", errors: [{ code: "invalid" }] },
          { status: 422 },
        );
      }
      const term = q.replace(/repo:\S+/g, "").trim();
      const out = await tryGit(
        ["grep", "-l", "-i", "-F", term, "HEAD"],
        this.repoPath(owner, name),
      );
      const paths =
        out.code === 0 ? out.stdout.split("\n").filter(Boolean) : [];
      const items = paths.map((p) => {
        const file = p.replace(/^HEAD:/, "");
        return {
          name: file.split("/").pop(),
          path: file,
          html_url: `${this.url}/${owner}/${name}/blob/main/${file}`,
          repository: {
            full_name: `${owner.toLowerCase()}/${name.toLowerCase()}`,
          },
        };
      });
      return Response.json({
        total_count: items.length,
        incomplete_results: false,
        items,
      });
    }
    return notFound();
  }

  /**
   * One repository's REST routes.
   * @param req - The request.
   * @param url - Its URL.
   * @param owner - The account, lowercased.
   * @param name - The repository, lowercased.
   * @param rest - The path after `/repos/:owner/:name`.
   * @param body - The parsed body.
   * @returns The response.
   */
  private async repo(
    req: Request,
    url: URL,
    owner: string,
    name: string,
    rest: string,
    body: unknown,
  ): Promise<Response> {
    const bare = this.repoPath(owner, name);
    if (rest === "" && req.method === "GET") {
      return Response.json({
        name,
        full_name: `${owner}/${name}`,
        private: true,
        default_branch: "main",
        html_url: `${this.url}/${owner}/${name}`,
      });
    }
    const contents = /^\/contents\/?(.*)$/.exec(rest);
    if (contents && req.method === "GET") {
      const path = decodeURIComponent(contents[1]);
      const ref = url.searchParams.get("ref") ?? "HEAD";
      const type = await tryGit(["cat-file", "-t", `${ref}:${path}`], bare);
      if (type.code !== 0) {
        return Response.json({ message: "Not Found" }, { status: 404 });
      }
      if (type.stdout.trim() === "tree") {
        const listing = await git(["ls-tree", `${ref}:${path}`], bare);
        return Response.json(
          listing
            .split("\n")
            .filter(Boolean)
            .map((line) => {
              const [meta, file] = line.split("\t");
              const kind = meta.split(" ")[1];
              return {
                name: file,
                path: path ? `${path}/${file}` : file,
                type: kind === "tree" ? "dir" : "file",
              };
            }),
        );
      }
      const proc = Bun.spawn(["git", "cat-file", "blob", `${ref}:${path}`], {
        cwd: bare,
        stdout: "pipe",
      });
      const bytes = Buffer.from(await new Response(proc.stdout).arrayBuffer());
      await proc.exited;
      return Response.json({
        type: "file",
        encoding: "base64",
        name: path.split("/").pop(),
        path,
        size: bytes.byteLength,
        content: bytes.toString("base64").replace(/(.{60})/g, "$1\n"),
        html_url: `${this.url}/${owner}/${name}/blob/main/${path}`,
      });
    }
    const pull = /^\/pulls\/(\d+)$/.exec(rest);
    if (pull && req.method === "GET") {
      const pr = this.pulls.find(
        (p) =>
          p.owner === owner && p.name === name && p.number === Number(pull[1]),
      );
      if (!pr) return Response.json({ message: "Not Found" }, { status: 404 });
      return Response.json(this.pullJson(pr));
    }
    if (rest === "/pulls" && req.method === "POST") {
      const b = (body ?? {}) as Record<string, string>;
      const pr = this.openPull({
        owner,
        name,
        title: b.title ?? "",
        body: b.body ?? "",
        head: b.head ?? "",
        base: b.base ?? "main",
        author: "hypotenuse-test[bot]",
      });
      return Response.json(this.pullJson(pr), { status: 201 });
    }
    const issue = /^\/issues\/(\d+)$/.exec(rest);
    if (issue && req.method === "GET") {
      const pr = this.pulls.find(
        (p) =>
          p.owner === owner && p.name === name && p.number === Number(issue[1]),
      );
      if (pr) {
        return Response.json({
          number: pr.number,
          title: pr.title,
          body: pr.body,
          state: pr.state,
          html_url: this.pullUrl(pr),
          user: { login: pr.author },
          labels: [],
          comments: 0,
          pull_request: { html_url: this.pullUrl(pr) },
        });
      }
      return Response.json({ message: "Not Found" }, { status: 404 });
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  }

  /**
   * Git's smart HTTP for one private repository, behind GitHub's token
   * rules: no credential is the `401` challenge; a token that does not name
   * the repository, or lacks `contents: write` for a push, is `403`.
   * @param req - The request.
   * @param url - Its URL.
   * @param owner - The account.
   * @param name - The repository.
   * @returns The response.
   */
  private async git(
    req: Request,
    url: URL,
    owner: string,
    name: string,
  ): Promise<Response> {
    const write =
      url.searchParams.get("service") === "git-receive-pack" ||
      url.pathname.endsWith("/git-receive-pack");
    const auth = req.headers.get("authorization");
    if (!auth) {
      return new Response("Authentication required\n", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="GitHub"' },
      });
    }
    const token = this.presented(req);
    if (!token) {
      return new Response("Invalid username or token.\n", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="GitHub"' },
      });
    }
    if (
      !this.allows(token, owner, name, "contents", write ? "write" : "read")
    ) {
      return new Response(
        `remote: Permission to ${owner}/${name}.git denied to hypotenuse-test[bot].\n`,
        { status: 403 },
      );
    }
    const body =
      req.method === "POST"
        ? new Uint8Array(await req.arrayBuffer())
        : new Uint8Array(0);
    const proc = Bun.spawn([this.backend ?? "git-http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: this.root,
        GIT_HTTP_EXPORT_ALL: "1",
        REQUEST_METHOD: req.method,
        PATH_INFO: `/${owner.toLowerCase()}/${name.toLowerCase()}.git/${url.pathname.split(".git/")[1] ?? ""}`,
        QUERY_STRING: url.search.replace(/^\?/, ""),
        CONTENT_TYPE: req.headers.get("content-type") ?? "",
        CONTENT_LENGTH: String(body.byteLength),
        HTTP_CONTENT_ENCODING: req.headers.get("content-encoding") ?? "",
        REMOTE_ADDR: "127.0.0.1",
        REMOTE_USER: "x-access-token",
      },
      stdin: body,
      stdout: "pipe",
      stderr: "pipe",
    });
    const raw = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;
    const split = indexOfHeaderEnd(raw);
    if (split < 0) {
      return new Response(`git-http-backend said nothing usable\n${stderr}`, {
        status: 500,
      });
    }
    const headers = new Headers();
    let status = 200;
    for (const line of new TextDecoder()
      .decode(raw.subarray(0, split))
      .split(/\r?\n/)) {
      const cut = line.indexOf(":");
      if (cut < 0) continue;
      const key = line.slice(0, cut).trim();
      const value = line.slice(cut + 1).trim();
      if (key.toLowerCase() === "status") {
        status = Number.parseInt(value, 10) || 500;
        continue;
      }
      headers.set(key, value);
    }
    return new Response(raw.subarray(split + (raw[split] === 0x0d ? 4 : 2)), {
      status,
      headers,
    });
  }
}

/**
 * Where git keeps `git-http-backend`, asked of git.
 * @returns The absolute path.
 * @throws {Error} When git cannot be asked.
 */
export async function gitHttpBackendPath(): Promise<string> {
  const probe = Bun.spawn(["git", "--exec-path"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = (await new Response(probe.stdout).text()).trim();
  if ((await probe.exited) !== 0 || out === "") {
    throw new Error("could not ask git for its exec-path");
  }
  return join(out, "git-http-backend");
}

/**
 * Run git, failing loudly with what it said.
 * @param args - Arguments after `git`.
 * @param cwd - Where.
 * @param env - Extra environment.
 * @returns stdout, trimmed.
 */
export async function git(
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<string> {
  const out = await tryGit(args, cwd, env);
  if (out.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${out.code})\n${out.stderr}${out.stdout}`,
    );
  }
  return out.stdout.trim();
}

/**
 * Run git and report the outcome rather than throwing.
 * @param args - Arguments after `git`.
 * @param cwd - Where.
 * @param env - Extra environment.
 * @returns The exit code and both streams.
 */
export async function tryGit(
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/**
 * Where a CGI response's headers end.
 * @param bytes - The whole response.
 * @returns The offset of the blank line, or -1.
 */
function indexOfHeaderEnd(bytes: Uint8Array): number {
  for (let i = 0; i + 1 < bytes.byteLength; i++) {
    if (bytes[i] === 0x0a && bytes[i + 1] === 0x0a) return i;
    if (
      i + 3 < bytes.byteLength &&
      bytes[i] === 0x0d &&
      bytes[i + 1] === 0x0a &&
      bytes[i + 2] === 0x0d &&
      bytes[i + 3] === 0x0a
    ) {
      return i;
    }
  }
  return -1;
}
