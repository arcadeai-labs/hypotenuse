import { expect, test } from "@playwright/test";
import {
  api,
  LANDED,
  LANDING,
  PASSWORD,
  signUpApi,
  uniqueEmail,
  verificationToken,
} from "./session.ts";

test("a new address is confirmed from the link mailed to it, and only then are its invitations shown", async ({
  page,
  browser,
}) => {
  const email = uniqueEmail("unconfirmed");
  await page.goto("/sign-up");
  await page.getByTestId("sign-up-name").fill("Unconfirmed Una");
  await page.getByTestId("sign-up-email").fill(email);
  await page.getByTestId("sign-up-password").fill(PASSWORD);
  await page.getByTestId("sign-up-submit").click();
  await expect(page).toHaveURL(LANDING, LANDED);

  const banner = page.getByTestId("verify-email-banner");
  await expect(banner).toContainText(email);

  // Someone invites the address; an unconfirmed account cannot see it yet.
  const inviter = await browser.newContext();
  const owner = await signUpApi(inviter.request, "Inviting Ines");
  await api(
    inviter.request,
    "PUT",
    `/organization/${owner.organization.id}/invite`,
    { inviteeEmail: email, tagIds: [] },
  );
  await inviter.close();
  await page.goto("/invites");
  await expect(page.getByTestId("invites-unverified")).toBeVisible(LANDED);
  await expect(page.getByTestId("no-pending-invites")).toHaveCount(0);

  // A resend inside the cooldown is refused in the server's words.
  await banner.getByTestId("verify-email-resend").click();
  await expect(page.getByTestId("verify-email-error")).toContainText(
    "less than a minute ago",
  );

  // Following the link confirms on a click, not on load.
  await page.goto(`/verify-email?token=${await verificationToken(email)}`);
  await expect(page.getByTestId("verify-email-confirmed")).toHaveCount(0);
  await page.getByTestId("verify-email-submit").click();
  await expect(page.getByTestId("verify-email-confirmed")).toContainText(email);
  await page.getByTestId("verify-email-continue").click();

  await expect(page).toHaveURL(/\/invites$/);
  await expect(page.getByTestId("verify-email-banner")).toHaveCount(0);
  await expect(page.getByTestId("pending-invites")).toContainText(
    owner.organization.name,
  );
});

test("a used link is refused on the page, in the server's words", async ({
  page,
}) => {
  const { email } = await signUpApi(page.request, "Twice Clicked");
  // `signUpApi` already followed this link.
  await page.goto(`/verify-email?token=${await verificationToken(email)}`);
  await page.getByTestId("verify-email-submit").click();
  await expect(page.getByTestId("form-error")).toContainText(
    "expired, was already used",
  );
});

test("changing your address waits for the new one to be confirmed", async ({
  page,
}) => {
  const { email } = await signUpApi(page.request, "Moving Mo");
  const next = uniqueEmail("moved");
  await page.goto("/account");
  await expect(page.getByTestId("email-confirmed")).toBeVisible(LANDED);

  await page.getByTestId("account-email-input").fill(next);
  await page.getByTestId("account-submit").click();
  await expect(page.getByTestId("form-error")).toContainText(
    "current password",
  );

  await page.getByTestId("account-current-password").fill(PASSWORD);
  await page.getByTestId("account-submit").click();
  const pending = page.getByTestId("pending-email");
  await expect(pending).toContainText(next);
  await expect(page.getByTestId("account-email-input")).toHaveValue(email);

  await page.goto(`/verify-email?token=${await verificationToken(next)}`);
  await page.getByTestId("verify-email-submit").click();
  await expect(page.getByTestId("verify-email-confirmed")).toContainText(next);

  await page.goto("/account");
  await expect(page.getByTestId("account-email-input")).toHaveValue(
    next,
    LANDED,
  );
  await expect(page.getByTestId("pending-email")).toHaveCount(0);
});
