import { type APIRequestContext, expect, type Page } from "@playwright/test";
import { BACKEND_URL, MAIL_INBOX_URL } from "./env.ts";

/**
 * Helpers every signed-in spec shares. The specs share one backend and never
 * clear its database, so each mints unique addresses rather than assuming an
 * empty world, and parallel workers never collide.
 */

/** The password every e2e account uses. */
export const PASSWORD = "password123";

/** Timeout for "did we land?" — sign-up is several round trips before a page mounts. */
export const LANDED = { timeout: 15_000 };

/** The landing page after a sign-in with nowhere better to go. */
export const LANDING = /\/organization\/projects$/;

/**
 * A unique-per-run email.
 * @param label - A readable prefix.
 * @returns An address nobody else in this run will use.
 */
export function uniqueEmail(label: string): string {
  const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  return `${label}-${nonce}@hypotenuse.test`;
}

/** What sign-up made, as `user:create` answers. */
export interface SignedUp {
  email: string;
  user: { id: number; name: string };
  organization: { id: number; name: string };
  project: { id: number; name: string };
}

/**
 * Call the backend's API with a request context's cookies.
 * @param request - `page.request` (the page's cookies) or a fixture's own context.
 * @param method - The HTTP verb.
 * @param path - The route beneath `/api`.
 * @param data - A JSON body.
 * @returns The parsed answer.
 * @throws {Error} If the answer is an error envelope.
 */
export async function api<T = Record<string, unknown>>(
  request: APIRequestContext,
  method: "GET" | "PUT" | "POST" | "DELETE",
  path: string,
  data?: unknown,
): Promise<T> {
  const response = await request.fetch(`${BACKEND_URL}/api${path}`, {
    method,
    data,
  });
  const body = await response.json();
  if (body?.error) {
    throw new Error(`${method} ${path}: ${body.error.message}`);
  }
  return body as T;
}

/**
 * The token from the newest verification mail the backend sent an address,
 * read from the suite's mail catcher.
 * @param email - The recipient.
 * @returns The token.
 * @throws {Error} If no verification mail reached that address.
 */
export async function verificationToken(email: string): Promise<string> {
  const res = await fetch(
    `${MAIL_INBOX_URL}/verification-token?to=${encodeURIComponent(email)}`,
  );
  const { token } = (await res.json()) as { token: string | null };
  if (!token) throw new Error(`No verification mail reached ${email}`);
  return token;
}

/**
 * Confirm an address by following the link mailed to it, through the API.
 * @param request - Any request context; the token is the proof.
 * @param email - The address (a sign-up address or a pending new one).
 */
export async function verifyEmail(
  request: APIRequestContext,
  email: string,
): Promise<void> {
  await api(request, "POST", "/email-verification/confirm", {
    token: await verificationToken(email),
  });
}

/**
 * Create an account and sign it in on a request context — the page's, so the
 * browser is signed in too. Faster than the form, for specs about something
 * else; `auth.spec.ts` drives the form itself. The address is confirmed from
 * its real mail unless `verified: false` asks otherwise.
 * @param request - `page.request`, or another context's.
 * @param name - The display name.
 * @param email - The address; a fresh one by default.
 * @param options - `verified: false` leaves the address unconfirmed.
 * @returns What sign-up created.
 */
export async function signUpApi(
  request: APIRequestContext,
  name: string,
  email: string = uniqueEmail("user"),
  options: { verified?: boolean } = {},
): Promise<SignedUp> {
  const created = await api<Omit<SignedUp, "email">>(request, "PUT", "/user", {
    name,
    email,
    password: PASSWORD,
  });
  if (options.verified !== false) await verifyEmail(request, email);
  await api(request, "PUT", "/session", { email, password: PASSWORD });
  return { email, ...created };
}

/**
 * Sign in through the real form and wait for the landing page.
 * @param page - The page.
 * @param email - The account's address.
 * @param landing - Where the sign-in should land.
 */
export async function signIn(
  page: Page,
  email: string,
  landing: RegExp = LANDING,
): Promise<void> {
  await page.getByTestId("sign-in-email").fill(email);
  await page.getByTestId("sign-in-password").fill(PASSWORD);
  await page.getByTestId("sign-in-submit").click();
  await expect(page).toHaveURL(landing, LANDED);
}

/**
 * Open a settings section of the active project and wait for it to render.
 * @param page - The page.
 * @param slug - The section, e.g. `"tags"`.
 */
export async function openSettings(page: Page, slug: string): Promise<void> {
  await page.goto(`/settings/${slug}`);
  await expect(page.getByTestId("settings-section-nav")).toBeVisible(LANDED);
  await expect(page.getByTestId("settings-loading")).toHaveCount(0, LANDED);
}
