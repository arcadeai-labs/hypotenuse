import { expect, test } from "@playwright/test";
import { seedSession } from "./seed.ts";
import { LANDED, openSection, openSettings, signUp } from "./session.ts";

/**
 * Settings → Integrations: a connected Linear card shows its workspace and
 * the webhook's health (last delivery and recent outcomes). The connection is
 * written as rows, because there is no Linear in the e2e stack.
 */

test("the Linear card shows a connected workspace and its deliveries", async ({
  page,
}) => {
  await signUp(page, "Linked Lou");
  await seedSession(page);
  await openSettings(page);
  await openSection(page, "integrations");
  await expect(page.getByTestId("linear-connected")).toBeVisible(LANDED);
  await expect(page.getByTestId("linear-workspace")).toHaveText("Acme");
  await expect(page.getByTestId("linear-last-webhook")).toHaveText("—");
  await expect(page.getByTestId("linear-deliveries-empty")).toBeVisible();
});

test("a project with no connection offers to connect", async ({ page }) => {
  await signUp(page, "Unlinked Una");
  await openSettings(page);
  await openSection(page, "integrations");
  await expect(page.getByTestId("linear-disconnected")).toBeVisible(LANDED);
});
