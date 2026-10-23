import { expect, test } from "@playwright/test";
import { seedSession } from "./seed.ts";
import { LANDED, signUp } from "./session.ts";

/**
 * Sessions, in a real browser against the real server. Linear is not in the
 * e2e stack, so the sessions are mirrored rows written straight to the
 * database (`seed.ts`); everything after that is the real path — the list,
 * the session page's reads, the cancel action, and the live frame on
 * `project:<id>:sessions` that wakes a second open page.
 */

test.describe("sessions", () => {
  test.setTimeout(60_000);

  test("an empty project says how sessions start", async ({ page }) => {
    await signUp(page, "Empty Emma");
    await page.getByTestId("nav-sessions").click();
    await expect(page.getByTestId("sessions-empty")).toBeVisible(LANDED);
  });

  test("list → page: the transcript, plan, links, and turns render", async ({
    page,
  }) => {
    await signUp(page, "Reader Rae");
    const session = await seedSession(page);
    await page.getByTestId("nav-sessions").click();
    const row = page.getByTestId(`session-row-${session.id}`);
    await expect(row).toContainText(session.identifier, LANDED);
    await row.click();
    await expect(page).toHaveURL(new RegExp(`/sessions/${session.id}$`));

    await expect(page.getByTestId("session-title")).toContainText(
      "Add retry to webhook ingress",
      LANDED,
    );
    const transcript = page.getByTestId("transcript");
    await expect(transcript).toContainText("please take this");
    await expect(transcript.locator("strong")).toHaveText("retry");
    // The ephemeral thought Linear replaced stays, struck through and folded.
    await expect(transcript.locator("s")).toHaveText(
      "Reading the ingress handler",
    );
    // Twelve result lines fold to eight until opened.
    await expect(page.getByTestId("action-result")).not.toContainText(
      "result line 9",
    );
    await page.getByTestId("action-result-toggle").click();
    await expect(page.getByTestId("action-result")).toContainText(
      "result line 12",
    );
    await expect(page.getByTestId("plan")).toContainText("Add retry");
    // Pull requests first.
    await expect(
      page.getByTestId("session-links").locator("a").first(),
    ).toContainText("Pull request #418");
    await expect(page.getByTestId("turns-table")).toContainText("completed");
    await expect(page.getByTestId("session-cost")).toContainText(
      "$0.42 · 1,500 tokens",
    );
    // Nothing is running or waiting: Cancel is there, and disabled.
    await expect(page.getByTestId("session-cancel")).toBeDisabled();
  });

  test("cancelling a waiting session answers it, and a second tab sees it live", async ({
    page,
    context,
  }) => {
    await signUp(page, "Stopper Sam");
    const session = await seedSession(page, { awaiting: true });
    await page.goto(`/sessions/${session.id}`);
    await expect(page.getByTestId("elicitation")).toContainText(
      "Allow",
      LANDED,
    );

    const watcher = await context.newPage();
    await watcher.goto(`/sessions/${session.id}`);
    await expect(watcher.getByTestId("transcript")).toBeVisible(LANDED);

    await page.getByTestId("session-cancel").click();
    await page.getByTestId("session-cancel-confirm").click();
    await expect(page.getByTestId("session-notice")).toBeVisible(LANDED);

    // The watcher never reloads: the sessions frame makes it re-read.
    await expect(watcher.getByTestId("transcript")).toContainText(
      "Stopped from the Hypotenuse dashboard by Stopper Sam",
      { timeout: 15_000 },
    );
  });
});
