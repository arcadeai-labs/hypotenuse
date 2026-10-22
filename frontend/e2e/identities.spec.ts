import { expect, test } from "@playwright/test";
import { seedSession } from "./seed.ts";
import { fromProjectMenu, LANDED, signUp } from "./session.ts";

/**
 * Identities: everyone sees the Linear accounts linked to them; an admin
 * (a project's creator) also manages every link. Linking needs a Linear
 * connection, written as rows here.
 */

test("an admin links a Linear user to themselves and unlinks it", async ({
  page,
}) => {
  await signUp(page, "Admin Ada");
  await seedSession(page);
  await fromProjectMenu(page, "identities-link");
  await expect(page).toHaveURL(/\/identities$/, LANDED);
  await expect(page.getByTestId("linked-identities-empty")).toBeVisible(LANDED);
  await expect(page.getByTestId("all-identities-empty")).toBeVisible();

  await page.getByTestId("identity-member").selectOption({ index: 1 });
  await page.getByTestId("identity-external-id").fill("linear-user-1");
  await page.getByTestId("identity-external-name").fill("Ada in Linear");
  await page.getByTestId("identity-link").click();

  const row = page.locator('tr[data-testid^="identity-"]').filter({
    hasText: "Ada in Linear",
  });
  await expect(row).toBeVisible(LANDED);
  await page.reload();
  await expect(page.getByTestId("linked-identities-table")).toContainText(
    "Ada in Linear",
    LANDED,
  );
  await page.locator('[data-testid^="admin-unlink-"]').first().click();
  await expect(page.getByTestId("all-identities-empty")).toBeVisible(LANDED);
});
