import { expect, type Page } from "@playwright/test";

/**
 * Helpers every signed-in spec shares. These specs share one backend with every
 * other suite and cannot clear its database, so each mints unique addresses
 * rather than assuming an empty world.
 */

/** The password every e2e account uses. */
export const PASSWORD = "password123";

/**
 * Timeout for the "did we land?" assertions. Signing up is a chain of four
 * sequential round trips (`user:create` → `session:create` → `me:view` →
 * `project:list`) before the page mounts and fetches its own data, which is
 * tight for the default 5s once two workers share one dev-mode backend.
 */
export const LANDED = { timeout: 10_000 };

/**
 * A unique-per-run email, so repeat runs never collide on the unique index.
 * @param label - A human-readable prefix.
 * @returns An address nobody else in this run will use.
 */
export function uniqueEmail(label: string): string {
  const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  return `${label}-${nonce}@hypotenuse.test`;
}

/**
 * Sign up through the real form and wait for the project home.
 * @param page - The Playwright page.
 * @param name - The display name.
 * @param email - The address to register; a fresh one by default.
 * @returns The address used.
 */
export async function signUp(
  page: Page,
  name: string,
  email: string = uniqueEmail("user"),
): Promise<string> {
  await page.goto("/sign-up");
  await page.getByTestId("sign-up-name").fill(name);
  await page.getByTestId("sign-up-email").fill(email);
  await page.getByTestId("sign-up-password").fill(PASSWORD);
  await page.getByTestId("sign-up-submit").click();
  await expect(page).toHaveURL(/\/home$/, LANDED);
  await expect(page.getByTestId("app-shell")).toBeVisible(LANDED);
  return email;
}

/**
 * Sign in through the real form and wait for the project home.
 * @param page - The Playwright page.
 * @param email - The account's address.
 */
export async function signIn(page: Page, email: string): Promise<void> {
  await page.goto("/sign-in");
  await page.getByTestId("sign-in-email").fill(email);
  await page.getByTestId("sign-in-password").fill(PASSWORD);
  await page.getByTestId("sign-in-submit").click();
  await expect(page).toHaveURL(/\/home$/, LANDED);
}

/**
 * Open the active project's settings and wait for the index redirect to settle.
 * The section sidebar renders from the parent route, so it is clickable while
 * the URL is still `/settings` — and a click in that window is undone by the
 * `<Navigate replace>` arriving a moment later.
 * @param page - The Playwright page.
 */
export async function openSettings(page: Page): Promise<void> {
  await page.getByTestId("nav-settings").click();
  await expect(page).toHaveURL(/\/settings\/general$/, LANDED);
  await expect(page.getByTestId("settings-section-nav")).toBeVisible(LANDED);
}

/**
 * Open one settings section.
 * @param page - The Playwright page.
 * @param slug - The section's slug, e.g. `"tags"`.
 */
export async function openSection(page: Page, slug: string): Promise<void> {
  await page.getByTestId(`section-${slug}`).click();
  await expect(page).toHaveURL(new RegExp(`/settings/${slug}$`), LANDED);
}

/**
 * Open one entry of the sidebar's project switcher.
 * @param page - The Playwright page.
 * @param testId - The entry's test id, e.g. `"invites-link"`.
 */
export async function fromProjectMenu(
  page: Page,
  testId: string,
): Promise<void> {
  await page.getByTestId("project-switcher-toggle").click();
  await page.getByTestId(testId).click();
}
