import { config } from "keryx";
import type { FakeGitHub } from "../fakes/github/server";
import { call, cookieHeader, type TestUser } from "../setup";

/**
 * Attaching GitHub App installations to a project over HTTP, as a person's
 * browser does: ask `github:install-url` for the link, let the GitHub fake
 * authorize the person, and land on `github:install-callback` with what
 * GitHub would put on the Setup URL.
 */

/**
 * Ask for an install link as a person, and read the state out of it.
 * @param url - The server.
 * @param user - Who asks.
 * @param projectId - The project.
 * @returns The status, body, and the state on the link (or `null`).
 */
export async function installUrl(
  url: string,
  user: TestUser,
  projectId: number,
) {
  const res = await call<{
    url: string | null;
    missing: string[];
    message: string | null;
  }>(url, user, "GET", `/project/${projectId}/github/install-url`);
  const state = res.body.url
    ? new URL(res.body.url).searchParams.get("state")
    : null;
  return { ...res, state };
}

/**
 * Land on the install callback as a person's browser would, without following
 * the redirect.
 * @param url - The server.
 * @param user - Whose browser, or `null` for a signed-out one.
 * @param query - The Setup URL's query string.
 * @returns The status and the redirect's location, parsed.
 */
export async function installCallback(
  url: string,
  user: TestUser | null,
  query: Record<string, string>,
): Promise<{ status: number; location: URL | null }> {
  const res = await fetch(
    `${url}/api/github/install/callback?${new URLSearchParams(query)}`,
    {
      redirect: "manual",
      headers: user ? cookieHeader(user.sessionId) : {},
    },
  );
  const location = res.headers.get("location");
  return { status: res.status, location: location ? new URL(location) : null };
}

/**
 * Attach an installation the GitHub fake knows to a project, end to end, as
 * an admin.
 * @param url - The server.
 * @param github - The GitHub fake (configured into `config.github`).
 * @param admin - The project admin.
 * @param projectId - The project.
 * @param installationId - GitHub's installation id.
 * @returns The attached row's id in Hypotenuse.
 */
export async function attachInstallation(
  url: string,
  github: FakeGitHub,
  admin: TestUser,
  projectId: number,
  installationId: string,
): Promise<number> {
  const { state } = await installUrl(url, admin, projectId);
  if (!state) throw new Error("no install state");
  const code = github.authorizeUser(`${admin.name}-gh`, [installationId]);
  const { location } = await installCallback(url, admin, {
    state,
    installation_id: installationId,
    setup_action: "install",
    code,
  });
  const installed = location?.searchParams.get("installed");
  if (!installed) {
    throw new Error(`attach failed: ${location?.searchParams.get("error")}`);
  }
  return Number(installed);
}

/**
 * Point the server's GitHub config at a fake, returning a restore function.
 * @param github - The started fake.
 * @returns Puts `config.github` back as it was.
 */
export function useFakeGitHub(github: FakeGitHub): () => void {
  const saved = { ...config.github };
  github.configure(config.github as unknown as Record<string, unknown>);
  return () => {
    Object.assign(config.github, saved);
  };
}
