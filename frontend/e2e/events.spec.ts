import { expect, test } from "@playwright/test";
import { seedEvents } from "./seed.ts";
import { LANDED, signUp } from "./session.ts";

/**
 * The event log, in a real browser against the real server. Linear is not in
 * the e2e stack, so the deliveries are rows written as processing leaves them
 * (`seed.ts`); the list, its filters, and the event page are the real path.
 */

test.describe("events", () => {
  test.setTimeout(60_000);

  test("an empty project says where events come from", async ({ page }) => {
    await signUp(page, "Quiet Quinn");
    await page.getByTestId("nav-events").click();
    await expect(page.getByTestId("events-empty")).toBeVisible(LANDED);
  });

  test("list → event: what it did, how it was routed, and the payload for an admin", async ({
    page,
  }) => {
    await signUp(page, "Router Rory");
    const seeded = await seedEvents(page);
    await page.getByTestId("nav-events").click();

    const created = page.getByTestId(`event-row-${seeded.createdId}`);
    await expect(created).toContainText(seeded.session.identifier, LANDED);
    await expect(created).toContainText("rule /work");
    await expect(
      page.getByTestId(`event-placement-${seeded.createdId}`),
    ).toHaveText("Completed");
    // Ignored events are hidden until asked for.
    await expect(page.getByTestId(`event-row-${seeded.ignoredId}`)).toHaveCount(
      0,
    );
    // A click, not `check()`: the switch follows the URL, which React Router
    // commits a beat after the click.
    await page.getByTestId("filter-show-ignored").click();
    await expect(page.getByTestId("filter-show-ignored")).toBeChecked();
    await expect(
      page.getByTestId(`event-row-${seeded.ignoredId}`),
    ).toContainText("Ignored: a change to", LANDED);

    await created.click();
    await expect(page).toHaveURL(new RegExp(`/events/${seeded.createdId}$`));
    await expect(page.getByTestId("event-summary")).toContainText(
      "queued its first turn",
      LANDED,
    );
    await expect(page.getByTestId("event-role")).toContainText("rule /work");
    await expect(page.getByTestId("event-payload-json")).toContainText(
      "AgentSessionEvent",
    );
    await page.getByTestId("event-session").getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`/sessions/${seeded.session.id}$`));
  });
});
