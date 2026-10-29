import { expect, test } from "@playwright/test";
import { FRONTEND_URL } from "./env.ts";
import {
  LANDED,
  LANDING,
  PASSWORD,
  signIn,
  signUpApi,
  uniqueEmail,
} from "./session.ts";

test("sign-up lands in the app, in a new organization and its Default project", async ({
  page,
}) => {
  const email = uniqueEmail("signup");
  await page.goto("/");
  await page.getByTestId("public-sign-in-link").click();
  await page.getByTestId("sign-up-link").click();
  await page.getByTestId("sign-up-name").fill("Grace Hopper");
  await page.getByTestId("sign-up-email").fill(email);
  await page.getByTestId("sign-up-password").fill(PASSWORD);
  await page.getByTestId("sign-up-submit").click();

  await expect(page).toHaveURL(LANDING, LANDED);
  await expect(page.getByTestId("app-shell")).toBeVisible();
  // An organization named after them, which they own…
  await expect(page.getByTestId("organization-switcher-toggle")).toContainText(
    "Grace Hopper",
  );
  await expect(page.getByTestId("organization-role")).toHaveText("Owner");
  // …and its first project, active.
  await expect(page.getByTestId("project-switcher-toggle")).toContainText(
    "Default",
  );
  await expect(page.getByTestId("organization-projects")).toContainText(
    "Default",
  );
  await expect(page.getByTestId("account-name")).toHaveText("Grace Hopper");
});

test("the client refuses a sign-up the server would, without a round trip", async ({
  page,
}) => {
  await page.goto("/sign-up");
  await page.getByTestId("sign-up-name").fill("Al");
  await page.getByTestId("sign-up-email").fill("not-an-email");
  await page.getByTestId("sign-up-password").fill("short");
  await page.getByTestId("sign-up-submit").click();
  await expect(page.getByTestId("sign-up-form")).toContainText(
    "Use at least 3 characters.",
  );
  await expect(page.getByTestId("sign-up-form")).toContainText(
    "Enter an email address.",
  );
  await expect(page).toHaveURL(/\/sign-up$/);
});

test("sign out, then sign back in", async ({ page }) => {
  const { email } = await signUpApi(page.request, "Ada Lovelace");
  await page.goto("/organization/projects");
  await expect(page.getByTestId("account-name")).toHaveText("Ada Lovelace");

  await page.getByTestId("account-menu").click();
  await page.getByTestId("sign-out").click();
  await expect(page).toHaveURL(/\/sign-in$/, LANDED);

  // The session is gone server-side, not just forgotten by the page.
  await page.goto("/account");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Faccount$/, LANDED);

  await signIn(page, email, /\/account$/);
  await expect(page.getByTestId("account-name-input")).toHaveValue(
    "Ada Lovelace",
  );
});

test("a wrong password is refused in the server's words", async ({ page }) => {
  const { email } = await signUpApi(page.request, "Wrong Password");
  // Signed up on the page's own context; forget that session to sign in afresh.
  await page.context().clearCookies();
  await page.goto("/sign-in");
  await page.getByTestId("sign-in-email").fill(email);
  await page.getByTestId("sign-in-password").fill("not-the-password");
  await page.getByTestId("sign-in-submit").click();
  await expect(page.getByTestId("form-error")).toHaveText(
    "Invalid email or password",
  );
});

test("a protected page sends a signed-out visitor to sign in, then back to it", async ({
  page,
  request,
}) => {
  // Created on a separate request context, so this page stays signed out.
  const { email } = await signUpApi(request, "Return Path");
  await page.goto("/organization/members");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Forganization%2Fmembers$/);
  await signIn(page, email, /\/organization\/members$/);
  await expect(page.getByTestId("organization-members")).toContainText(email);
});

for (const next of [
  "//evil.example/steal",
  "https://evil.example/steal",
  "/\\evil.example",
]) {
  test(`?next=${next} cannot send a sign-in off the site`, async ({
    page,
    request,
  }) => {
    const { email } = await signUpApi(request, "Open Redirect");
    await page.goto(`/sign-in?next=${encodeURIComponent(next)}`);
    await signIn(page, email);
    await expect(page).toHaveURL(LANDING);
    expect(new URL(page.url()).origin).toBe(FRONTEND_URL);
  });
}
