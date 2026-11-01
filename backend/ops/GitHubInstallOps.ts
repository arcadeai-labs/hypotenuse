import { randomBytes } from "node:crypto";
import { api, config, ErrorType, TypedError } from "keryx";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../config/frontend";
import type {} from "../config/github";
import {
  githubApiOrigin,
  githubWebOrigin,
  platformGitHubApp,
  signAppJwt,
} from "./GitHubAppOps";

/**
 * Attaching a GitHub App installation to a project: the browser's round trip
 * through GitHub's install page.
 *
 * `github:install-url` mints a single-use `state`, bound in Redis to the
 * project and the admin who asked, and answers GitHub's install link carrying
 * it. GitHub sends the browser back to `github:install-callback` with that
 * `state`, the `installation_id` it chose, and a user-authorization `code`.
 * The state names the project; the code proves who the person is on GitHub;
 * and only an installation that person can see is attached.
 */

/** How long an install link works, in seconds. */
export const GITHUB_INSTALL_STATE_TTL_SECONDS = 10 * 60;

/** What a `state` stands for while GitHub has the browser. */
export interface PendingGitHubInstall {
  /** The project the installation will be attached to. */
  projectId: number;
  /** The admin who started it; only they may finish it. */
  userId: number;
}

/**
 * The Redis key one state lives under.
 * @param state - The state.
 * @returns The key.
 */
function installKey(state: string): string {
  return `github:install:${state}`;
}

/**
 * Mint a single-use state for an install, bound to a project and a person.
 * @param pending - The project and the person.
 * @returns The state, for GitHub's `state` query parameter.
 */
export async function startGitHubInstall(
  pending: PendingGitHubInstall,
): Promise<string> {
  const state = randomBytes(24).toString("base64url");
  await api.redis.redis.set(
    installKey(state),
    JSON.stringify(pending),
    "EX",
    GITHUB_INSTALL_STATE_TTL_SECONDS,
  );
  return state;
}

/**
 * Read a state without using it up, so somebody else's request cannot burn a
 * live install.
 * @param state - The state GitHub returned.
 * @returns The install, or `null` for an unknown, used, or expired state.
 */
export async function peekGitHubInstall(
  state: string,
): Promise<PendingGitHubInstall | null> {
  const raw = await api.redis.redis.get(installKey(state));
  return raw ? (JSON.parse(raw) as PendingGitHubInstall) : null;
}

/**
 * Use a state up: it works once.
 * @param state - The state GitHub returned.
 * @returns The install, or `null` when another request already took it.
 */
export async function takeGitHubInstall(
  state: string,
): Promise<PendingGitHubInstall | null> {
  const raw = await api.redis.redis.getdel(installKey(state));
  return raw ? (JSON.parse(raw) as PendingGitHubInstall) : null;
}

/**
 * GitHub's page that installs the deployment's App, carrying a state.
 * @param state - From {@link startGitHubInstall}.
 * @returns `<github>/apps/<slug>/installations/new?state=…`.
 */
export function githubInstallUrl(state: string): string {
  const url = new URL(
    `${githubWebOrigin()}/apps/${encodeURIComponent(String(config.github.appSlug).trim())}/installations/new`,
  );
  url.searchParams.set("state", state);
  return url.toString();
}

/** An installation as the App itself reads it from GitHub. */
export interface AppInstallation {
  accountLogin: string;
  accountType: string;
  permissions: Record<string, string>;
  suspended: boolean;
}

/**
 * Read one installation of the App with the App's JWT
 * (`GET /app/installations/:id`): the account it is on, what it was granted,
 * and whether it is suspended.
 * @param installationId - GitHub's installation id.
 * @returns The installation.
 * @throws {TypedError} When the App is not configured or GitHub will not say.
 */
export async function readAppInstallation(
  installationId: string,
): Promise<AppInstallation> {
  const app = platformGitHubApp();
  if (!app) {
    throw new TypedError({
      message:
        "This deployment's GitHub App is not configured (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY).",
      type: ErrorType.CONNECTION_ACTION_RUN,
    });
  }
  const response = await fetch(
    `${githubApiOrigin()}/app/installations/${encodeURIComponent(installationId)}`,
    {
      headers: {
        authorization: `Bearer ${signAppJwt(app)}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    },
  );
  if (!response.ok) {
    throw new TypedError({
      message: `GitHub would not describe installation ${installationId} (${response.status}). Start again from Repositories.`,
      type: ErrorType.CONNECTION_ACTION_RUN,
    });
  }
  const body = (await response.json()) as {
    account?: { login?: string; type?: string };
    permissions?: Record<string, unknown>;
    suspended_at?: string | null;
  };
  const permissions: Record<string, string> = {};
  for (const [name, level] of Object.entries(body.permissions ?? {})) {
    if (typeof level === "string" && level.trim()) permissions[name] = level;
  }
  return {
    accountLogin: String(body.account?.login ?? "").trim() || "unknown",
    accountType: String(body.account?.type ?? "").trim() || "Account",
    permissions,
    suspended: Boolean(body.suspended_at),
  };
}

/**
 * Where the install callback sends the browser: the project's Repositories
 * page, or — when the state did not name a project — the current project's.
 * @param projectId - The project, when known.
 * @param query - Query parameters (`installed`, `error`).
 * @returns The absolute dashboard URL.
 */
export function repositoriesPageUrl(
  projectId: number | null,
  query: Record<string, string>,
): string {
  const base = config.frontend.url.replace(/\/+$/, "");
  const url = new URL(
    projectId
      ? `${base}/projects/${projectId}/repositories`
      : `${base}/repositories`,
  );
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return url.toString();
}
