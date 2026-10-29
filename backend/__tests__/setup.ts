import { setMaxListeners } from "node:events";
import {
  type ActionResponse,
  api,
  CONNECTION_TYPE,
  Connection,
  config,
  type WebServer,
} from "keryx";
// Must be first among local imports: sets `api.rootDir` so the framework can
// auto-discover actions, initializers, and channels before any of them load.
import "../index";
import type { InviteCreate } from "../actions/invite/invite-create";
import type { InviteListPending } from "../actions/invite/invite-list-pending";
import type { OrganizationEdit } from "../actions/organization/organization-edit";
import type { ProjectCreate } from "../actions/project/project-create";
import type { SessionCreate } from "../actions/session";
import type { TagCreate } from "../actions/tag/tag-create";
import type { UserCreate } from "../actions/user";

// Each test file boots its own server; the shared event bus can exceed the
// default 10-listener warning threshold when many suites run.
setMaxListeners(999);

/** Generous lifecycle-hook timeout — `api.start()` connects to Postgres + Redis and runs migrations. */
export const HOOK_TIMEOUT = 30_000;

/**
 * Run an action in-process the way a Resque worker would.
 *
 * Clocks and their child jobs are task-only (no public HTTP route), so suites
 * drive them through {@link Connection.act} rather than `fetch`. Uses
 * `CONNECTION_TYPE.TASK` so middleware that keys off the transport sees the
 * same shape production does.
 * @param name - Registered action name.
 * @param params - Raw params, validated against the action's Zod inputs.
 * @returns The action's response body.
 * @throws The action's TypedError when it fails.
 */
export async function runAction<T = unknown>(
  name: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const connection = new Connection(CONNECTION_TYPE.TASK, `test:${name}`);
  try {
    const { response, error } = await connection.act(name, params);
    if (error) throw error;
    return response as T;
  } finally {
    connection.destroy();
  }
}

/** How long {@link drainTasks} waits for a queue to go quiet. */
const DRAIN_TIMEOUT = 10_000;

/**
 * Wait until a Resque queue is empty and no worker is still inside a job.
 *
 * A test that calls a background helper directly races the worker that calls
 * it too; draining first makes the suite the only caller. Bounded rather than
 * unbounded: a queue that never empties is a suite bug worth seeing as the
 * assertion that follows, not as a hung file.
 * @param queueName - The queue to wait on.
 */
export async function drainTasks(queueName = "default"): Promise<void> {
  const deadline = Date.now() + DRAIN_TIMEOUT;
  while (Date.now() < deadline) {
    const queued = await api.resque.queue.length(queueName);
    const working = await api.resque.queue.allWorkingOn();
    const busy = Object.values(working).some(
      (entry) => typeof entry === "object" && entry !== null,
    );
    if (queued === 0 && !busy) return;
    await Bun.sleep(20);
  }
}

/**
 * Return the URL the web server actually bound to (with its resolved port).
 * Call after `api.start()` (tests use `WEB_SERVER_PORT_TEST=0` for a random
 * free port per file). A wildcard host is rewritten to loopback, because
 * `0.0.0.0` is an address to listen on, not one to connect to.
 * @returns The bound base URL, or an empty string if the web server isn't running.
 */
export function serverUrl(): string {
  const web = api.servers.servers.find((s) => s.name === "web") as
    | WebServer
    | undefined;
  return (web?.url || "").replace("://0.0.0.0:", "://127.0.0.1:");
}

/**
 * Clear every table, retrying the Postgres deadlock (`40P01`) and
 * lock-not-available (`55P03`) codes a still-draining previous file can cause,
 * so a green suite is not a function of scheduling.
 */
export async function retryClearDatabase(): Promise<void> {
  const maxAttempts = 8;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await api.db.clearDatabase();
      return;
    } catch (error) {
      if (attempt === maxAttempts || !isRetryableClearDatabaseError(error)) {
        throw error;
      }
      await Bun.sleep(25 * attempt);
    }
  }
}

/**
 * Walk an error (and Drizzle's wrapped cause) for a retryable Postgres code.
 * @param error - What `clearDatabase` threw.
 * @returns Whether another attempt may succeed.
 */
function isRetryableClearDatabaseError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current != null; depth++) {
    if (typeof current === "object" && "code" in current) {
      const code = (current as { code: unknown }).code;
      if (code === "40P01" || code === "55P03") return true;
    }
    current =
      typeof current === "object" && current !== null && "cause" in current
        ? (current as { cause: unknown }).cause
        : null;
  }
  return false;
}

/**
 * Headers for a JSON request carrying a session cookie.
 * @param sessionId - The session id to send.
 * @returns A headers object for `fetch()`.
 */
export function authHeaders(sessionId: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Cookie: `${config.session.cookieName}=${sessionId}`,
  };
}

/**
 * Headers carrying only the session cookie, for requests with no body.
 * @param sessionId - The session id to send.
 * @returns A headers object for `fetch()`.
 */
export function cookieHeader(sessionId: string): Record<string, string> {
  return { Cookie: `${config.session.cookieName}=${sessionId}` };
}

/** A seeded, signed-in person, with the tenant sign-up gave them. */
export interface TestUser {
  userId: number;
  sessionId: string;
  name: string;
  email: string;
  /** The organization sign-up created, which they own. */
  organizationId: number;
  /** Its "Default" project, where they are admin. */
  projectId: number;
}

/** Password shared by every seeded test user. */
export const TEST_PASSWORD = "password123";

/**
 * Call an action over real HTTP as a person, and parse the answer.
 * @param url - The base server URL.
 * @param user - Who is asking, or `null` for nobody.
 * @param method - The HTTP verb.
 * @param path - The route beneath `/api`.
 * @param body - A JSON body, for verbs that take one.
 * @returns The HTTP status and the parsed body.
 */
export async function call<T = Record<string, unknown>>(
  url: string,
  user: TestUser | null,
  method: "GET" | "PUT" | "POST" | "DELETE",
  path: string,
  body?: Record<string, unknown>,
): Promise<{
  status: number;
  body: T & { error?: { message: string; key?: string } };
}> {
  const res = await fetch(`${url}/api${path}`, {
    method,
    headers: user
      ? body
        ? authHeaders(user.sessionId)
        : cookieHeader(user.sessionId)
      : body
        ? { "Content-Type": "application/json" }
        : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as never };
}

/**
 * Register a user over real HTTP and sign them in. Goes through `user:create`
 * and `session:create` rather than inserting rows, so every suite that seeds a
 * person exercises the sign-up bootstrap.
 * @param url - The base server URL.
 * @param name - Display name (at least 3 characters).
 * @param email - Email address.
 * @param password - Password (at least 8 characters).
 * @returns The user, their session, and the organization and project sign-up made.
 * @throws {Error} If sign-up or sign-in does not return HTTP 200.
 */
export async function createUserAndLogin(
  url: string,
  name: string,
  email: string,
  password = TEST_PASSWORD,
): Promise<TestUser> {
  const createRes = await fetch(`${url}/api/user`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, email, password }),
  });
  const created = (await createRes.json()) as ActionResponse<UserCreate>;
  if (createRes.status !== 200) {
    throw new Error(`Failed to create ${email}: ${JSON.stringify(created)}`);
  }
  const loginRes = await fetch(`${url}/api/session`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const login = (await loginRes.json()) as ActionResponse<SessionCreate>;
  if (loginRes.status !== 200) {
    throw new Error(`Failed to sign in ${email}: ${JSON.stringify(login)}`);
  }
  return {
    userId: created.user.id,
    sessionId: login.session.id,
    name,
    email,
    organizationId: created.organization.id,
    projectId: created.project.id,
  };
}

/**
 * Create a project tag as an admin, over HTTP.
 * @param url - The base server URL.
 * @param admin - Someone with admin standing in the project.
 * @param projectId - The project.
 * @param name - The tag name.
 * @returns The new tag's id.
 */
export async function createTag(
  url: string,
  admin: TestUser,
  projectId: number,
  name: string,
): Promise<number> {
  const { status, body } = await call<ActionResponse<TagCreate>>(
    url,
    admin,
    "PUT",
    `/project/${projectId}/tag`,
    { name },
  );
  if (status !== 200) throw new Error(`tag:create: ${JSON.stringify(body)}`);
  return body.tag.id;
}

/**
 * Invite someone and have them accept, through the **real** three-request flow
 * (`invite:create` → `invite:list-pending` → `invite:accept`), so the fixture
 * that seeds every suite's cast also proves the invite lifecycle end to end.
 * @param url - The base server URL.
 * @param inviter - Who sends it.
 * @param organizationId - The organization.
 * @param projectId - The project, or `null` for an organization invite.
 * @param invitee - Who accepts it (already signed in).
 * @param tagIds - Project tags to grant.
 */
export async function inviteAndAccept(
  url: string,
  inviter: TestUser,
  organizationId: number,
  projectId: number | null,
  invitee: TestUser,
  tagIds: number[] = [],
): Promise<void> {
  const created = await call<ActionResponse<InviteCreate>>(
    url,
    inviter,
    "PUT",
    `/organization/${organizationId}/invite`,
    {
      inviteeEmail: invitee.email,
      tagIds,
      ...(projectId ? { projectId } : {}),
    },
  );
  if (created.status !== 200) {
    throw new Error(`invite:create: ${JSON.stringify(created.body)}`);
  }
  const pending = await call<ActionResponse<InviteListPending>>(
    url,
    invitee,
    "GET",
    "/invites/pending",
  );
  const invite = pending.body.invites.find(
    (i) => i.id === created.body.invite.id,
  );
  if (!invite) throw new Error(`No pending invite for ${invitee.email}`);
  const accepted = await call(
    url,
    invitee,
    "POST",
    `/invite/${invite.id}/accept`,
  );
  if (accepted.status !== 200) {
    throw new Error(`invite:accept: ${JSON.stringify(accepted.body)}`);
  }
}

/**
 * The seeded cast, so a test reads as a sentence rather than a setup script.
 *
 * - **Mushroom Kingdom** (Peach's sign-up organization, renamed): Peach owns it.
 *   Its **Castle** project has Peach as its explicit admin, Mario (`operators`),
 *   Luigi (`viewers`), and Toad (no tags) as members. **Daisy** is a member of
 *   the organization with **no** project, which proves organization membership
 *   grants no project visibility.
 * - **Koopa Troop** (Bowser's, renamed): Bowser owns it, and is the outsider to
 *   everything in the Mushroom Kingdom.
 *
 * Every person also owns the organization and "Default" project their own
 * sign-up made.
 */
export interface TestUniverse {
  url: string;
  peach: TestUser;
  mario: TestUser;
  luigi: TestUser;
  toad: TestUser;
  daisy: TestUser;
  bowser: TestUser;
  /** Mushroom Kingdom. */
  organizationId: number;
  /** Koopa Troop. */
  koopaOrganizationId: number;
  /** Castle, in Mushroom Kingdom. */
  projectId: number;
  tagIds: { operators: number; viewers: number };
}

/**
 * Start the server, clear the database, and seed the {@link TestUniverse} over
 * HTTP. Call from a suite's `beforeAll` with {@link HOOK_TIMEOUT}.
 * @returns The server URL, the cast, and the ids of their tenants.
 */
export async function buildTestUniverse(): Promise<TestUniverse> {
  await api.start();
  const url = serverUrl();
  await retryClearDatabase();

  const [peach, mario, luigi, toad, daisy, bowser] = await Promise.all([
    createUserAndLogin(url, "Peach", "peach@mushroom.kingdom"),
    createUserAndLogin(url, "Mario", "mario@mushroom.kingdom"),
    createUserAndLogin(url, "Luigi", "luigi@mushroom.kingdom"),
    createUserAndLogin(url, "Toad", "toad@mushroom.kingdom"),
    createUserAndLogin(url, "Daisy", "daisy@sarasa.land"),
    createUserAndLogin(url, "Bowser", "bowser@koopa.troop"),
  ]);

  const organizationId = peach.organizationId;
  for (const [owner, name] of [
    [peach, "Mushroom Kingdom"],
    [bowser, "Koopa Troop"],
  ] as const) {
    const renamed = await call<ActionResponse<OrganizationEdit>>(
      url,
      owner,
      "POST",
      `/organization/${owner.organizationId}`,
      { name },
    );
    if (renamed.status !== 200) {
      throw new Error(`organization:edit: ${JSON.stringify(renamed.body)}`);
    }
  }

  const castle = await call<ActionResponse<ProjectCreate>>(
    url,
    peach,
    "PUT",
    "/project",
    { organizationId, name: "Castle" },
  );
  if (castle.status !== 200) {
    throw new Error(`project:create: ${JSON.stringify(castle.body)}`);
  }
  const projectId = castle.body.project.id;

  const operators = await createTag(url, peach, projectId, "operators");
  const viewers = await createTag(url, peach, projectId, "viewers");
  await inviteAndAccept(url, peach, organizationId, projectId, mario, [
    operators,
  ]);
  await inviteAndAccept(url, peach, organizationId, projectId, luigi, [
    viewers,
  ]);
  await inviteAndAccept(url, peach, organizationId, projectId, toad);
  await inviteAndAccept(url, peach, organizationId, null, daisy);

  return {
    url,
    peach,
    mario,
    luigi,
    toad,
    daisy,
    bowser,
    organizationId,
    koopaOrganizationId: bowser.organizationId,
    projectId,
    tagIds: { operators, viewers },
  };
}

/**
 * A random string of unreserved characters, for PKCE verifiers and nonces.
 * @param length - How many characters to generate.
 * @returns The random string.
 */
export function randomString(length: number): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Compute the PKCE S256 code challenge (base64url SHA-256) for a verifier.
 * @param verifier - The PKCE code verifier.
 * @returns The base64url-encoded challenge.
 */
export async function computeS256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  let binary = "";
  for (const byte of new Uint8Array(digest)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Drive the full OAuth authorization-code + PKCE flow for an **existing** user and
 * return a Bearer access token for OAuth-protected MCP requests.
 *
 * Uses `mode: "login"`, which Keryx's authorize page routes to our
 * `isLoginAction` — so the token belongs to a seeded {@link TestUniverse} member,
 * carrying their memberships and tags. This is the same flow a person's MCP
 * client runs; it lives here with the other fixtures because it is identity
 * plumbing.
 * @param url - The base server URL (from {@link serverUrl}).
 * @param email - The existing user's email.
 * @param password - The existing user's password.
 * @returns A Bearer access token.
 * @throws {Error} If any step of the flow does not behave as expected.
 */
export async function getMcpAccessToken(
  url: string,
  email: string,
  password: string,
): Promise<string> {
  const redirectUri = "http://localhost:9999/callback";

  const regRes = await fetch(`${url}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      client_name: "Hypotenuse MCP Test Client",
    }),
  });
  const { client_id: clientId } = (await regRes.json()) as {
    client_id: string;
  };

  const codeVerifier = randomString(43);
  const codeChallenge = await computeS256Challenge(codeVerifier);

  const authRes = await fetch(`${url}/oauth/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      mode: "login",
      email,
      password,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      response_type: "code",
      state: "helper",
    }).toString(),
    redirect: "manual",
  });
  if (authRes.status !== 302) {
    throw new Error(
      `OAuth authorize did not redirect (status ${authRes.status}): ${await authRes.text()}`,
    );
  }
  const location = authRes.headers.get("location");
  if (!location) throw new Error("OAuth authorize returned no Location header");
  const code = new URL(location).searchParams.get("code");
  if (!code) {
    throw new Error(`OAuth authorize redirect carried no code: ${location}`);
  }

  const tokenRes = await fetch(`${url}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      client_id: clientId,
      redirect_uri: redirectUri,
    }).toString(),
  });
  const { access_token: accessToken } = (await tokenRes.json()) as {
    access_token: string;
  };
  if (!accessToken) {
    throw new Error("OAuth token exchange returned no access_token");
  }
  return accessToken;
}

// ioredis can emit a late "Connection is closed." rejection during `api.stop()`
// teardown races; it is benign, so swallow only that specific case.
process.on("unhandledRejection", (reason: unknown) => {
  if (
    reason instanceof Error &&
    reason.message === "Connection is closed." &&
    reason.stack?.includes("ioredis")
  ) {
    return;
  }
  throw reason;
});
