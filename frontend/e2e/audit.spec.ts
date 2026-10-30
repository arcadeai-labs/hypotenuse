import { expect, type Page, type Request, test } from "@playwright/test";
import { api, LANDED, signUpApi } from "./session.ts";

const mod = process.platform === "darwin" ? "Meta" : "Control";

/**
 * Wait for the next audit-log request and return its query.
 * @param page - The page.
 * @param act - What triggers the request.
 * @returns The request's search params.
 */
async function nextAuditQuery(
  page: Page,
  act: () => Promise<void>,
): Promise<URLSearchParams> {
  const request = page.waitForRequest(
    (r: Request) => r.method() === "GET" && /\/audit\?/.test(r.url()),
  );
  await act();
  return new URL((await request).url()).searchParams;
}

test("renaming a project shows up in its audit log: one row, by you, before and after", async ({
  page,
}) => {
  const me = await signUpApi(page.request, "Audit Reader");
  await page.goto("/settings/general");
  await page.getByTestId("project-name").fill("Renamed Desk");
  await page.getByTestId("save-general").click();
  await expect(page.getByTestId("project-switcher-toggle")).toContainText(
    "Renamed Desk",
    LANDED,
  );

  // Reached from the project switcher.
  await page.getByTestId("project-switcher-toggle").click();
  await page.getByTestId("project-audit-link").click();
  await expect(page).toHaveURL(/\/audit$/);

  await page.locator("#audit-action").selectOption("project:edit");
  const rows = page.locator("[data-testid^='audit-row-']");
  await expect(rows).toHaveCount(1, LANDED);
  await expect(rows.first()).toContainText("Audit Reader");
  await expect(rows.first()).toContainText(me.email);
  await expect(rows.first()).toContainText("project:edit");

  await rows.first().getByRole("button", { name: "Details" }).click();
  const details = page.locator("[data-testid^='audit-details-']");
  await expect(details).toContainText('"name": "Default"');
  await expect(details).toContainText('"name": "Renamed Desk"');
});

test("dates, the action filter, and Reset each ask for page 1 again", async ({
  page,
}) => {
  const me = await signUpApi(page.request, "Audit Pager");
  // Thirty tags: two pages of tag:create rows, on top of the sign-up's.
  for (let i = 0; i < 30; i++) {
    await api(page.request, "PUT", `/project/${me.project.id}/tag`, {
      name: `tag-${String(i).padStart(2, "0")}`,
    });
  }
  await page.goto("/audit");
  await expect(page.getByTestId("audit-next")).toBeVisible(LANDED);

  /** Go to page 2 and wait for it. */
  const toPageTwo = async () => {
    const query = await nextAuditQuery(page, () =>
      page.getByTestId("audit-next").click(),
    );
    expect(query.get("page")).toBe("2");
    await expect(page.getByTestId("audit-current-page")).toContainText("2 of");
  };

  await toPageTwo();
  const byAction = await nextAuditQuery(page, () =>
    page.locator("#audit-action").selectOption("tag:create"),
  );
  expect(byAction.get("page")).toBe("1");
  expect(byAction.get("action")).toBe("tag:create");

  await toPageTwo();
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const byDate = await nextAuditQuery(page, () =>
    page.locator("#audit-since").fill(iso),
  );
  expect(byDate.get("page")).toBe("1");
  expect(byDate.get("since")).not.toBeNull();

  await toPageTwo();
  const reset = await nextAuditQuery(page, () =>
    page.getByTestId("audit-reset").click(),
  );
  expect(reset.get("page")).toBe("1");
  expect(reset.has("action")).toBe(false);
  expect(reset.has("since")).toBe(false);
});

test("an owner reads the organization's log, every project in it, from Organization", async ({
  page,
}) => {
  const me = await signUpApi(page.request, "Org Auditor");
  const second = await api<{ project: { id: number } }>(
    page.request,
    "PUT",
    "/project",
    { organizationId: me.organization.id, name: "Second Desk" },
  );
  await page.goto("/organization/projects");
  await page.getByTestId("organization-switcher-toggle").click();
  await page.getByTestId("organization-audit-link").click();
  await expect(page).toHaveURL(/\/organization\/audit$/);

  const rows = page.locator("[data-testid^='organization-audit-row-']");
  // Sign-up's two system rows, the organization's, and Second Desk's.
  await expect(rows.filter({ hasText: "System" })).toHaveCount(2, LANDED);
  await expect(rows.filter({ hasText: "Second Desk" })).toHaveCount(1);

  await page
    .locator("#organization-audit-project")
    .selectOption(String(second.project.id));
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("project:create");
  await expect(rows.first()).toContainText("Org Auditor");

  // Organization only: sign-up's organization row, and nothing of a project's.
  await page
    .locator("#organization-audit-project")
    .selectOption("organization");
  await expect(rows.filter({ hasText: "organization:create" })).toHaveCount(1);
  await expect(rows.filter({ hasText: "Second Desk" })).toHaveCount(0);
  await expect(rows.filter({ hasText: "Default" })).toHaveCount(0);
});

test("the palette opens the audit log", async ({ page }) => {
  await signUpApi(page.request, "Palette Auditor");
  await page.goto("/organization/projects");
  await expect(page.getByTestId("organization-switcher-toggle")).toContainText(
    "Palette Auditor",
    LANDED,
  );
  await page.keyboard.press(`${mod}+k`);
  await page.keyboard.type("Open audit log");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/audit$/);
  await expect(page.locator("[data-testid^='audit-row-']").first()).toBeVisible(
    LANDED,
  );
});
