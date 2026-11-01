import { createHash, createPrivateKey, createSign } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { api, config, ErrorType, TypedError } from "keryx";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../config/github";
import {
  type GithubInstallation,
  githubInstallations,
} from "../schema/github_installations";
import type { DbHandle } from "./DbOps";

/**
 * GitHub App authentication: **one App for the deployment**, and an
 * installation token minted per request from an installation a project
 * attached.
 *
 * **There is no long-lived GitHub credential anywhere in this system**, and
 * that is the property this file exists for. A personal access token outlives
 * every job it was used for, sits in a database, and grants whatever the
 * person who made it could do. An installation token is created on the way
 * to using it, expires in an hour, and — because every mint here passes a
 * scope — is good for one repository rather than for every repository the
 * installation can see.
 *
 * The App's private key never leaves the server: it signs a JWT, the JWT buys
 * an installation token, and only that token is handed on.
 *
 * The App is shared: `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` live in the
 * deployment environment, so web and worker mint with the same key. What a
 * project attaches is only the **installation** (`github_installations`) —
 * which repositories that shared App was granted on an account.
 *
 * Attaching an installation goes through the install flow's user-to-server
 * OAuth (`GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET`): GitHub
 * documents that a Setup URL's `installation_id` can be spoofed, so a new
 * install confirms the installing user can see it via `GET /user/installations`.
 *
 * Ported from ToolExec's `GitHubAppOps`; the reuse-from-another-project path
 * is not carried, since an installation is attached per project here.
 */

/**
 * How long an App JWT is good for.
 *
 * GitHub's ceiling is ten minutes and it rejects anything longer. Nine buys the
 * whole exchange room without ever being the thing that fails.
 */
const JWT_TTL_SECONDS = 9 * 60;

/**
 * How long a minted installation token may be reused.
 *
 * GitHub issues them for an hour; fifty minutes means a token is never handed
 * out inside the ten minutes before it expires, so a slow clone that started
 * with a fresh-looking token cannot have it lapse mid-transfer.
 */
export const INSTALLATION_TOKEN_TTL_SECONDS = 50 * 60;

/** Where installation tokens are minted, injectable so a test can stand one up. */
const GITHUB_API_ORIGIN = "https://api.github.com";

/** Where user-to-server OAuth codes are exchanged. */
const GITHUB_OAUTH_ORIGIN = "https://github.com";

/** One project's resolved GitHub App: the shared App plus its installation. */
export interface GitHubApp {
  /** The App's own id, which it signs as. */
  appId: string;
  /** The App's private key, PEM-encoded. */
  privateKey: string;
  /** The installation this project's repositories live under. */
  installationId: string;
}

/**
 * Base64url without padding, which is what JWT requires and what
 * `Buffer.toString("base64url")` already produces.
 * @param value - The bytes or text to encode.
 * @returns The encoded string.
 */
function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

/**
 * Normalize a configured PEM private key.
 *
 * Newlines survive a round trip badly and there are several ways they arrive
 * wrong. Most secret stores and every shell hand back a single line with `\n` in
 * it literally. A key pasted from a Windows editor arrives CRLF-delimited, which
 * OpenSSL's PEM reader rejects. A Render or dashboard paste often drops newlines
 * entirely, leaving `-----BEGIN…-----` and the base64 body on one line. And both
 * single and double quotes are sometimes stored as part of the value when a
 * shell or UI wrapped the secret. All are accepted and fixed here.
 * @param raw - The configured key.
 * @returns The key with real, LF-delimited newlines.
 */
export function normalizePrivateKey(raw: string): string {
  let key = restorePemLineBreaks(raw).trim();

  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1).trim();
  }

  if (!key.includes("BEGIN")) {
    const compact = key.replace(/\s/g, "");
    if (/^[A-Za-z0-9+/=]+$/.test(compact)) {
      try {
        const decoded = Buffer.from(compact, "base64").toString("utf8");
        if (decoded.includes("BEGIN")) {
          // Decode first, then the same newline rewrite the plaintext path
          // already ran — a Windows `.pem` encoded for an env var still has
          // CRLF *inside* the decoded bytes.
          key = restorePemLineBreaks(decoded).trim();
        }
      } catch {
        // Not base64 — leave the value for the signing check to refuse.
      }
    }
  }

  const pem =
    /^(-----BEGIN [^-]+-----)\s*([\s\S]*?)\s*(-----END [^-]+-----)\s*$/.exec(
      key,
    );
  if (pem) {
    const [, begin, body, end] = pem;
    const base64 = body.replace(/\s/g, "");
    if (base64 && !body.includes("\n")) {
      const lines = base64.match(/.{1,64}/g) ?? [base64];
      key = `${begin}\n${lines.join("\n")}\n${end}\n`;
    } else if (!key.endsWith("\n")) {
      // `trim()` above drops the trailing newline a PEM file always has.
      // Restore it so a well-formed key is byte-identical after a `\n` or
      // CRLF round trip — the contract the existing suite asserts.
      key = `${key}\n`;
    }
  }

  return key;
}

/**
 * Turn escaped and Windows newlines into LF.
 *
 * Shared by the plaintext path and the base64 path so a CRLF `.pem` that was
 * encoded for an env var is rewritten after decode, not only before it.
 * @param value - The configured or decoded key text.
 * @returns The same text with LF newlines.
 */
function restorePemLineBreaks(value: string): string {
  return value.replace(/\\n/g, "\n").replace(/\r\n?/g, "\n");
}

/**
 * Whether a normalized GitHub App private key can be parsed and used to sign.
 *
 * Shared by the status of the App and `signAppJwt` so every surface agrees
 * about "configured" versus "usable". The OpenSSL error is deliberately dropped
 * — a mint failure's text reaches the coding agent through git's stderr.
 * @param privateKey - The normalized PEM private key.
 * @returns `true` when the key can sign a JWT.
 */
export function githubAppPrivateKeyCanSign(privateKey: string): boolean {
  try {
    const key = createPrivateKey(privateKey);
    const signer = createSign("RSA-SHA256");
    signer.update("hypotenuse-github-app-key-check");
    signer.sign(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * The deployment's shared GitHub App, or `null` when it is not configured.
 *
 * Read from `config.github` rather than from `Bun.env` directly so a test can
 * assign the values after boot and point the origins at its GitHub fake. Empty strings count as absent — `loadFromEnvIfSet` defaults them there
 * so a checkout that has not filled `.env` yet boots, and a project that has
 * connected an installation still cannot clone until an operator sets both.
 * @returns The App id and private key, or `null`.
 */
export function platformGitHubApp(): Pick<
  GitHubApp,
  "appId" | "privateKey"
> | null {
  const appId = String(config.github.appId ?? "").trim();
  const privateKey = String(config.github.privateKey ?? "").trim();
  if (!appId || !privateKey) return null;

  return { appId, privateKey: normalizePrivateKey(privateKey) };
}

/**
 * Whether the deployment's shared GitHub App is configured and its private key
 * can sign installation-token requests.
 *
 * `platformGitHubApp` answers "is there an id and a non-empty key"; this answers
 * the follow-up that matters at clone time.
 * @returns `true` when both halves are present and the key can sign.
 */
export function platformGitHubAppCanSign(): boolean {
  const platform = platformGitHubApp();
  if (!platform) return false;
  return githubAppPrivateKeyCanSign(platform.privateKey);
}

/**
 * The shared App's OAuth client id and secret, or `null` when either is unset.
 *
 * Required for the install flow: exchanging the user authorization `code`
 * GitHub returns alongside `installation_id` is what lets
 * {@link assertUserCanAccessInstallation} ask GitHub whether *this* user can
 * see *that* installation.
 * @returns The client credentials, or `null`.
 */
export function platformGitHubAppOAuth(): {
  clientId: string;
  clientSecret: string;
} | null {
  const clientId = String(config.github.clientId ?? "").trim();
  const clientSecret = String(config.github.clientSecret ?? "").trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/**
 * Where this process talks to GitHub's REST API.
 *
 * Overridable so a suite can point at its GitHub fake without touching the
 * real origin.
 * @returns The origin, no trailing slash.
 */
export function githubApiOrigin(): string {
  return String(config.github.apiUrl || GITHUB_API_ORIGIN).replace(/\/+$/, "");
}

/**
 * Where this process exchanges GitHub user-to-server OAuth codes.
 * @returns The origin, no trailing slash.
 */
export function githubOAuthOrigin(): string {
  return String(config.github.webUrl || GITHUB_OAUTH_ORIGIN).replace(
    /\/+$/,
    "",
  );
}

/**
 * Sign a short-lived App JWT.
 *
 * `iat` is backdated sixty seconds because GitHub rejects a token whose issue
 * time is in the future by its clock, and two machines' clocks are never quite
 * the same. That skew allowance is the single most common cause of an App
 * integration that works locally and fails in a deployment.
 * @param app - The App to sign as.
 * @param nowMs - The current time, injectable so the signing is testable.
 * @returns The signed JWT.
 * @throws {Error} If the private key cannot sign — with a message of our own
 *   rather than OpenSSL's, see below.
 */
export function signAppJwt(
  app: Pick<GitHubApp, "appId" | "privateKey">,
  nowMs: number = Date.now(),
): string {
  const now = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iat: now - 60,
      exp: now + JWT_TTL_SECONDS,
      iss: app.appId.trim(),
    }),
  );

  const normalizedKey = normalizePrivateKey(app.privateKey);
  if (!githubAppPrivateKeyCanSign(normalizedKey)) {
    throw new Error(
      "this deployment's GitHub App private key could not be used to sign a request; check GITHUB_APP_PRIVATE_KEY",
    );
  }

  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer
    .sign(createPrivateKey(normalizedKey))
    .toString("base64url");

  return `${header}.${payload}.${signature}`;
}

/**
 * How narrow a minted token should be.
 *
 * **Both fields are always supplied by our callers, and that is the point.** An
 * empty body asks GitHub for a token carrying every repository the installation
 * was granted and every permission the App declares — which, once the token is
 * handed to a sandbox, is the difference between "this job may read one
 * repository" and "this job holds the org". GitHub applies each field as an
 * intersection with the installation, so naming a repository the installation
 * does not have is a refusal rather than an escalation.
 */
export interface InstallationTokenScope {
  /**
   * Repository names, without the owner — GitHub scopes to the installation's
   * own account, so `["api"]` and not `["acme/api"]`.
   */
  repositories: string[];
  /**
   * Permissions, as GitHub's own names and levels. `{ contents: "read" }` is
   * enough to clone; `{ contents: "write" }` is what a push needs.
   *
   * **There is no ref-level permission here and there is no way to add one.**
   * `contents: write` is write to every branch and tag of the repository, which
   * is why the branch namespace an agent is asked to use is a convention the
   * remote's own rulesets enforce rather than something a token can express.
   */
  permissions: Record<string, string>;
}

/** A minted token and the moment GitHub says it stops working. */
export interface MintedInstallationToken {
  /** The token itself, `ghs_…`. */
  token: string;
  /** When GitHub will stop accepting it, in epoch milliseconds. */
  expiresAtMs: number;
}

/**
 * A stable fingerprint of the App the token was minted from.
 *
 * The private key rather than only the id, so a rotated deployment key cannot
 * match a cache entry the new key never authorized. Callers that cache a minted
 * token key on this.
 * @param app - The App a token is wanted for.
 * @returns Sixteen hex characters.
 */
export function githubAppFingerprint(app: GitHubApp): string {
  return createHash("sha256")
    .update(normalizePrivateKey(app.privateKey))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Mint one installation access token, scoped.
 *
 * Deliberately **uncached**. Its callers hand the result to a sandbox and revoke
 * it when the job ends, and a token shared between two jobs could not be
 * revoked by either — the first job to finish would break the second. Reuse
 * within a single job is that caller's business, in `GitCredentialOps`, where
 * the set of live tokens per job is already tracked for the revocation.
 * @param app - The App and installation to mint from.
 * @param scope - The repositories and permissions to narrow to.
 * @param origin - The GitHub API origin, injectable for tests.
 * @returns The token and its expiry.
 * @throws {Error} If GitHub refuses to issue one.
 */
export async function mintInstallationToken(
  app: GitHubApp,
  scope: InstallationTokenScope,
  origin: string = githubApiOrigin(),
): Promise<MintedInstallationToken> {
  const response = await fetch(
    `${origin}/app/installations/${encodeURIComponent(app.installationId)}/access_tokens`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${signAppJwt(app)}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        repositories: scope.repositories,
        permissions: scope.permissions,
      }),
    },
  );

  if (!response.ok) {
    // The body is included because GitHub's messages here are genuinely useful
    // — "integration not installed", "bad credentials", and above all "there is
    // at least one repository that does not exist or is not accessible", which
    // is what a scoped mint says when the installation was never granted the
    // repository an agent named. It is GitHub's own text about ids we sent, and
    // carries nothing of the key we signed with.
    throw new Error(
      `GitHub refused to issue an installation token: ${response.status} ${await response.text()}`,
    );
  }

  const body = (await response.json()) as {
    token?: string;
    expires_at?: string;
  };
  if (!body.token) {
    throw new Error("GitHub issued an installation token with no token in it");
  }

  const parsed = body.expires_at ? Date.parse(body.expires_at) : Number.NaN;

  return {
    token: body.token,
    // GitHub has always sent `expires_at`, but a missing or unparseable one must
    // not become `NaN` in a comparison that then reads as "not expired". An hour
    // is the documented lifetime and the safe assumption.
    expiresAtMs: Number.isNaN(parsed) ? Date.now() + 60 * 60 * 1000 : parsed,
  };
}

/**
 * The repository (and organization) permissions an installation currently has.
 *
 * Sandbox mints must ask for a subset of this map or GitHub refuses the token.
 * Callers drop organization keys and cap each remaining level to the job's
 * grant so widening the App automatically widens the next mint — without
 * hard-coding `checks` / `actions` and without failing clone on an App that
 * has not been granted them yet.
 * @param app - The App and installation to read.
 * @param origin - The GitHub API origin, injectable for tests.
 * @returns The permission map, or `null` when GitHub could not be read.
 */
export async function fetchInstallationPermissions(
  app: GitHubApp,
  origin: string = githubApiOrigin(),
): Promise<Record<string, string> | null> {
  try {
    const response = await fetch(
      `${origin}/app/installations/${encodeURIComponent(app.installationId)}`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${signAppJwt(app)}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
      },
    );
    if (!response.ok) {
      api.logger.warn("could not read GitHub installation permissions", {
        status: response.status,
      });
      return null;
    }

    const body = (await response.json()) as { permissions?: unknown };
    if (
      !body.permissions ||
      typeof body.permissions !== "object" ||
      Array.isArray(body.permissions)
    ) {
      return null;
    }

    const permissions: Record<string, string> = {};
    for (const [name, level] of Object.entries(
      body.permissions as Record<string, unknown>,
    )) {
      if (typeof level === "string" && level.trim() !== "") {
        permissions[name] = level;
      }
    }
    return Object.keys(permissions).length > 0 ? permissions : null;
  } catch (e) {
    api.logger.warn("could not read GitHub installation permissions", {
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/**
 * Hand a token back to GitHub before it would have expired.
 *
 * `DELETE /installation/token` revokes the token that authenticates the request
 * — there is no way to revoke one by id, which is why the caller has to keep the
 * tokens themselves rather than a list of handles.
 *
 * **Never throws.** This runs after `finalizeSandboxJob`, on the one funnel
 * every ending goes through, and a job that has already finished must not fail
 * to finish because GitHub was briefly unreachable. A token we could not
 * revoke expires on its own within the hour.
 * @param token - The token to revoke.
 * @param origin - The GitHub API origin, injectable for tests.
 * @returns Whether GitHub confirmed the revocation.
 */
export async function revokeInstallationToken(
  token: string,
  origin: string = githubApiOrigin(),
): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/installation/token`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    });
    // 204 is success. 401 means it was already invalid, which is the outcome we
    // wanted and not a failure worth logging as one.
    return response.status === 204 || response.status === 401;
  } catch (e) {
    api.logger.warn("could not revoke a GitHub installation token", {
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

/**
 * Exchange a user-to-server OAuth `code` for an access token.
 *
 * Used by the install callback after GitHub redirects with both `code` and
 * `installation_id` (the App must have "Request user authorization during
 * installation" enabled). The token is short-lived for our purposes — we only
 * need it long enough to ask {@link assertUserCanAccessInstallation}.
 * @param code - The code GitHub put on the Setup URL redirect.
 * @param oauthOrigin - Where to POST the exchange, injectable for tests.
 * @returns The user access token.
 * @throws {TypedError} When the client is unset or GitHub refuses the code.
 */
export async function exchangeGitHubUserCode(
  code: string,
  oauthOrigin: string = githubOAuthOrigin(),
): Promise<string> {
  const oauth = platformGitHubAppOAuth();
  if (!oauth) {
    throw new TypedError({
      message:
        "This deployment cannot finish a GitHub App install — set GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET.",
      type: ErrorType.CONNECTION_ACTION_RUN,
    });
  }

  const response = await fetch(`${oauthOrigin}/login/oauth/access_token`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      client_id: oauth.clientId,
      client_secret: oauth.clientSecret,
      code,
    }),
  });

  if (!response.ok) {
    throw new TypedError({
      message: `GitHub refused to exchange the install authorization code (${response.status}). Start again from Repositories.`,
      type: ErrorType.CONNECTION_ACTION_RUN,
    });
  }

  const body = (await response.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };

  if (!body.access_token) {
    throw new TypedError({
      message:
        body.error_description ||
        body.error ||
        "GitHub did not return an access token for the install authorization. Start again from Repositories.",
      type: ErrorType.CONNECTION_ACTION_RUN,
    });
  }

  return body.access_token;
}

/**
 * Refuse unless the user behind `userToken` can see `installationId`.
 *
 * This is the check GitHub's docs require for a Setup URL `installation_id`:
 * the query value can be spoofed, and under a shared App an unverified id is
 * another tenant's repositories. `GET /user/installations` is the list that
 * proves the user can access the installation GitHub just returned from its
 * privileged install/configure flow. It is not an administration list and must
 * never authorize a client-selected installation.
 * @param userToken - A user-to-server token from {@link exchangeGitHubUserCode}.
 * @param installationId - The candidate installation id.
 * @param apiOrigin - GitHub's API origin, injectable for tests.
 * @throws {TypedError} When the user cannot see that installation.
 */
export async function assertUserCanAccessInstallation(
  userToken: string,
  installationId: string,
  apiOrigin: string = githubApiOrigin(),
): Promise<void> {
  const wanted = installationId.trim();
  const installations = await listUserInstallations(userToken, apiOrigin);
  if (installations.some((entry) => entry.id === wanted)) return;

  throw new TypedError({
    message:
      "That GitHub App installation is not one you can access. Install the App on an organization or account you administer, or sign in to GitHub as someone who can.",
    type: ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
  });
}

/** One shared-App installation the authorized GitHub user can access. */
export interface UserGitHubInstallation {
  /** GitHub's installation id. */
  id: string;
  /** The organization or user account that owns the installation. */
  accountLogin: string;
  /** GitHub's account type, normally `Organization` or `User`. */
  accountType: string;
}

/**
 * List every shared-App installation the authorized GitHub user can access.
 * @param userToken - A GitHub user-to-server token.
 * @param apiOrigin - GitHub's API origin, injectable for tests.
 * @returns The installations, preserving GitHub's page order.
 */
export async function listUserInstallations(
  userToken: string,
  apiOrigin: string = githubApiOrigin(),
): Promise<UserGitHubInstallation[]> {
  const found: UserGitHubInstallation[] = [];
  let page = 1;

  for (;;) {
    const response = await fetch(
      `${apiOrigin}/user/installations?per_page=100&page=${page}`,
      {
        headers: {
          authorization: `Bearer ${userToken}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
      },
    );

    if (!response.ok) {
      throw new TypedError({
        message: `GitHub refused to list installations for the installing user (${response.status}). Start again from Repositories.`,
        type: ErrorType.CONNECTION_ACTION_RUN,
      });
    }

    const body = (await response.json()) as {
      installations?: Array<{
        id?: number | string;
        account?: { login?: string; type?: string };
      }>;
    };
    const installations = body.installations ?? [];
    for (const entry of installations) {
      const id = String(entry.id ?? "").trim();
      if (!id) continue;
      found.push({
        id,
        accountLogin: String(entry.account?.login ?? "").trim() || "Unknown",
        accountType: String(entry.account?.type ?? "").trim() || "Account",
      });
    }

    if (installations.length < 100) break;
    page += 1;
    // A hard ceiling so a pathological pagination loop cannot hang the action.
    if (page > 50) break;
  }

  return found;
}

/**
 * Whether the deployment's GitHub App is configured enough to install: an id,
 * a key that signs, a slug for the install link, and the OAuth client the
 * callback needs.
 * @returns What is missing, as environment variable names; empty when ready.
 */
export function missingGitHubAppConfig(): string[] {
  const missing: string[] = [];
  if (!String(config.github.appId ?? "").trim()) missing.push("GITHUB_APP_ID");
  if (!String(config.github.appSlug ?? "").trim()) {
    missing.push("GITHUB_APP_SLUG");
  }
  const key = String(config.github.privateKey ?? "").trim();
  if (!key || !githubAppPrivateKeyCanSign(normalizePrivateKey(key))) {
    missing.push("GITHUB_APP_PRIVATE_KEY");
  }
  if (!platformGitHubAppOAuth()) {
    missing.push("GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET");
  }
  return missing;
}

/**
 * Whether an attached installation may mint: not suspended, not removed.
 * @param inst - The row.
 * @returns `true` when usable.
 */
export function isUsableInstallation(
  inst: Pick<GithubInstallation, "suspendedAt" | "revokedAt">,
): boolean {
  return inst.suspendedAt === null && inst.revokedAt === null;
}

/**
 * The App for one attached installation: the shared deployment App plus the
 * installation's id. `null` rather than a throw — matching every other
 * credential reader — when the App is not configured or the installation is
 * suspended or removed, because each caller's own refusal is the one worth
 * showing (the credential helper's is a sentence git prints; a read tool's is
 * a sentence the model reads).
 * @param inst - The attached installation.
 * @returns The App, or `null`.
 */
export function appForInstallation(
  inst: Pick<
    GithubInstallation,
    "installationId" | "suspendedAt" | "revokedAt"
  >,
): GitHubApp | null {
  const platform = platformGitHubApp();
  if (!platform || !isUsableInstallation(inst)) return null;
  return { ...platform, installationId: inst.installationId };
}

/**
 * A project's attached installation, by its row id.
 * @param db - A database handle.
 * @param projectId - The project.
 * @param id - The `github_installations` row.
 * @returns The row, or `undefined`.
 */
export async function projectInstallation(
  db: DbHandle,
  projectId: number,
  id: number,
): Promise<GithubInstallation | undefined> {
  const [row] = await db
    .select()
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.id, id),
        eq(githubInstallations.projectId, projectId),
        isNull(githubInstallations.revokedAt),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Call GitHub's REST API with an installation token: the one way the server
 * itself reads a repository (the read tools, a pull request's title and
 * branch). Answers GitHub's status and parsed body; a network failure is
 * thrown.
 * @param token - An installation token, scoped by its minter.
 * @param path - The path under the API origin, e.g. `/repos/acme/api/pulls/1`.
 * @param init - Method and body.
 * @returns The status and the JSON body (or `null` for none).
 */
export async function githubRest(
  token: string,
  path: string,
  init: { method?: string; body?: unknown; accept?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${githubApiOrigin()}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      accept: init.accept ?? "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(init.body !== undefined
        ? { "content-type": "application/json" }
        : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, body };
}

/**
 * Where git clones from and where a pull request's URL points:
 * `https://github.com` unless a suite points it at its fake.
 * @returns The origin, no trailing slash.
 */
export function githubWebOrigin(): string {
  return githubOAuthOrigin();
}
