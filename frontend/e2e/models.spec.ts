import { expect, test } from "@playwright/test";
import {
  addMember,
  LANDED,
  openSettings,
  openTenant,
  signUpApi,
} from "./session.ts";

test("an admin adds a connection, tests it, and sets the default model name; a member reads it all, disabled", async ({
  page,
  browser,
}) => {
  const admin = await signUpApi(page.request, "Model Admin");
  await openSettings(page, "models");

  // Both required names are listed as missing before anything exists.
  await expect(page.getByTestId("alias-missing-default")).toBeVisible(LANDED);
  await expect(page.getByTestId("alias-missing-fast")).toBeVisible();
  await expect(page.getByTestId("no-model-connections")).toBeVisible();

  // Add a connection. Loopback, on a port nothing listens on: the suite is
  // offline, so its test can only fail — which is what is asserted.
  await page.getByTestId("new-connection-name").fill("Local");
  await page
    .getByTestId("new-connection-provider")
    .selectOption("openai-compatible");
  await page
    .getByTestId("new-connection-base-url")
    .fill("http://127.0.0.1:9/v1");
  await page.getByTestId("new-connection-key").fill("sk-test-secret-wxyz");
  await page.getByTestId("new-connection-submit").click();
  const row = page.getByTestId("connection-row-Local");
  await expect(row).toContainText("OpenAI-compatible", LANDED);
  await expect(page.getByTestId("connection-key-Local")).toHaveText("…wxyz");
  await expect(page.getByTestId("connection-status-Local")).toHaveAttribute(
    "data-status",
    "unverified",
  );
  // The key went up once and is nowhere on the page.
  await expect(page.getByTestId("new-connection-key")).toHaveValue("");
  expect(await page.content()).not.toContain("sk-test-secret");

  // Test it: the failure is an answer, drawn as the error glyph with the reason.
  await page.getByTestId("test-connection-Local").click();
  await expect(page.getByTestId("connection-status-Local")).toHaveAttribute(
    "data-status",
    "error",
    LANDED,
  );
  await expect(page.getByTestId("connection-error-Local")).toBeVisible();
  await expect(page.getByTestId("model-connections-error")).toContainText(
    "Local did not answer as expected",
  );

  // Set `default`. The provider cannot list its models, so the picker says to
  // type the id, and takes one.
  await page.getByTestId("set-alias-default").click();
  await expect(page.getByTestId("alias-name")).toHaveValue("default");
  await expect(page.getByTestId("alias-model-hint")).not.toHaveText(
    /Asking the provider/,
    LANDED,
  );
  await page.getByTestId("alias-model").fill("local-model");
  await page.getByTestId("alias-save").click();
  const alias = page.getByTestId("alias-row-default");
  await expect(alias).toContainText("local-model", LANDED);
  await expect(alias).toContainText("Local");
  await expect(page.getByTestId("alias-missing-default")).toHaveCount(0);
  await expect(page.getByTestId("alias-missing-fast")).toBeVisible();

  // A connection a model name uses cannot be deleted, and the refusal says why.
  await page.getByTestId("delete-connection-Local").click();
  await page.getByTestId("delete-connection-confirm").click();
  await expect(page.getByTestId("model-connections-error")).toContainText(
    "default",
  );
  await expect(page.getByTestId("connection-row-Local")).toBeVisible();

  // A member reads the same section, every control disabled with the reason.
  const memberContext = await browser.newContext();
  const member = await memberContext.newPage();
  await addMember(page.request, admin, member.request, "Model Member");
  await openTenant(member, admin);
  await openSettings(member, "models");
  await expect(member.getByTestId("connection-key-Local")).toHaveText(
    "…wxyz",
    LANDED,
  );
  await expect(member.getByTestId("alias-row-default")).toContainText(
    "local-model",
  );
  for (const id of [
    "new-connection-submit",
    "test-connection-Local",
    "rotate-connection-Local",
    "delete-connection-Local",
    "edit-alias-default",
    "set-alias-fast",
  ]) {
    await expect(member.getByTestId(id), id).toHaveAttribute(
      "title",
      "Only project admins can do this.",
    );
  }
  // The Bots page tells a member whom to ask rather than linking them there.
  await member.goto("/bots");
  await expect(member.getByTestId("missing-aliases")).toContainText(
    "Ask a project admin",
    LANDED,
  );
  await memberContext.close();
});
