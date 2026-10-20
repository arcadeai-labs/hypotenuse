import { expect, type Page, test } from "@playwright/test";

/**
 * Live notifications, in a real browser.
 *
 * **What only a browser can prove is the liveness**: that a notification queued
 * on the server reaches an already-open page over the WebSocket, raises a toast,
 * and moves the bell's count — with no reload anywhere. Everything else about
 * the notification system is a property of rows, and `notification.test.ts` and
 * `project-notifications.test.ts` cover those against a real server without
 * paying for a browser.
 *
 * **The notification is raised by a run that fails, not by an agent asking a
 * question**, and that is a deliberate limit rather than an oversight. A help
 * request can only be created by `toolexec:request-human-help`, which requires a
 * run token — and a run token only exists inside a live sandbox, which would put
 * an API key, a container, and minutes of wall clock into a spec about a badge.
 * The machinery under test is identical either way: both paths enqueue rows,
 * both are delivered by `notifications:dispatch`, and both arrive through Redis
 * on the same channel. The help-request half of the loop — asking, answering,
 * and the agent collecting the answer — is `help.test.ts`, end to end.
 *
 * The failing run is deterministic and costs nothing: the project's sandbox
 * provider is pointed at Vercel with no credentials, so provisioning fails
 * before a container is involved. Delivery then waits on the Resque ticks —
 * `runs:dispatch` / `notifications:dispatch` are task-only, and e2e speeds
 * those cadences up in `BACKEND_ENV` so the poll below does not wait out the
 * production thirty-second schedule.
 *
 * Like the other specs this shares one backend with every suite and cannot clear
 * its database, so it mints unique addresses and asserts only on its own rows.
 */

const PASSWORD = "password123";

/** Generous landing timeout; see `auth.spec.ts` for why signup is four round trips. */
const LANDED = { timeout: 10_000 };

/** Long enough for a dispatcher tick plus a socket round trip. */
const DELIVERED = { timeout: 20_000 };

/**
 * Signup + agent + run + two Resque ticks. Playwright's default 30s is not
 * enough once the ticks are no longer an HTTP poke in the poll loop.
 */
const LIVE_TIMEOUT = 60_000;

/** A description long enough to satisfy the MCP-tool-description minimum. */
const DESCRIPTION =
  "Reads the overnight CI failures and writes a summary for the morning standup.";

/**
 * A unique-per-run email, so repeat runs never collide on the unique index.
 * @param label - A human-readable prefix.
 * @returns An email address nobody else in this run will use.
 */
function uniqueEmail(label: string): string {
  const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  return `${label}-${nonce}@toolexec.test`;
}

/**
 * Sign up through the real form and wait for the app to land.
 *
 * The landing signal is the settings sidebar rather than any one card: it renders
 * before `project:view` resolves, and it does not move when the default section
 * changes.
 * @param page - The Playwright page.
 * @param name - The display name.
 * @param email - The email to register.
 */
async function signUp(page: Page, name: string, email: string): Promise<void> {
  await page.goto("/sign-up");
  await page.getByTestId("name").fill(name);
  await page.getByTestId("email").fill(email);
  await page.getByTestId("password").fill(PASSWORD);
  await page.getByTestId("confirm").fill(PASSWORD);
  await page.getByTestId("submit").click();
  await expect(page.getByTestId("project-home")).toBeVisible(LANDED);
  await page.getByTestId("project-menu").getByRole("button").click();
  await page.getByTestId("settings-link").click();
  await expect(page.getByTestId("settings-section-nav")).toBeVisible(LANDED);
  // ...and wait for the index route's redirect to settle. The sidebar renders from
  // the parent route, so it is clickable while the URL is still `/settings` — and a
  // section click that lands in that window is undone by the `<Navigate replace>`
  // arriving a moment later, which reads as the sidebar not working.
  await expect(page).toHaveURL(/\/settings\/[a-z-]+$/, LANDED);
}

/**
 * Define an agent through the real editor.
 * @param page - The Playwright page.
 * @param name - The agent's name.
 */
/**
 * Point this project's sandboxes at a provider with no credentials configured,
 * so the run each test starts below fails at provisioning — deterministically,
 * on any machine, for a reason with nothing to do with notifications.
 *
 * Defining an agent with no model credential used to be enough: `run:start`
 * refused to provision one and the run failed. Credential containment moved that
 * key behind the model proxy, which resolves it per request, so an agent without
 * one now provisions perfectly happily. What kept these two tests green after
 * that was CI having no sandbox image built — an accident that passed there and
 * failed on every machine that had built one.
 * @param page - The signed-in admin's page.
 */
async function failProvisioning(page: Page): Promise<void> {
  await page.getByTestId("project-menu").getByRole("button").click();
  await page.getByTestId("settings-link").click();
  await expect(page).toHaveURL(/\/settings\/[a-z-]+$/, LANDED);
  await page.getByTestId("section-sandbox").click();
  await expect(page.getByTestId("sandbox-settings")).toBeVisible(LANDED);
  await page.getByTestId("sandbox-provider").selectOption("vercel");
  await page.getByTestId("save-sandbox").click();
  await expect(page.getByTestId("sandbox-notice")).toBeVisible(LANDED);
}

async function createAgent(page: Page, name: string): Promise<void> {
  await page.getByTestId("agents-link").click();
  await expect(page.getByTestId("agents-table")).toBeVisible(LANDED);
  await page.getByTestId("new-agent").click();
  await expect(page.getByTestId("agent-identity")).toBeVisible(LANDED);

  // The create form asks for a name and a coding agent and nothing else; the
  // description and the prompt are their own sections afterwards.
  await page.getByTestId("agent-name").fill(name);
  await page.getByTestId("coding-agent-model").fill("claude-opus-5");
  await page.getByTestId("save-agent").click();
  await expect(page).toHaveURL(/\/agents\/\d+\/identity$/, LANDED);

  await page.getByTestId("agent-description").fill(DESCRIPTION);
  await page.getByTestId("save-identity").click();
  await expect(page.getByTestId("identity-notice")).toBeVisible(LANDED);

  await page.getByTestId("section-prompt").click();
  await page.getByTestId("agent-prompt").fill("Summarize the failures.");
  await page.getByTestId("save-prompt").click();
  await expect(page.getByTestId("prompt-notice")).toBeVisible(LANDED);
}

test.describe("live notifications", () => {
  test.beforeEach(async ({ page }) => {
    // Stub the Web Notifications API rather than relying on a real OS
    // permission, which Playwright cannot grant deterministically across
    // platforms. Installed as `default` so the "Enable desktop notifications"
    // control is the one the page renders — the in-app toast and the badge are
    // what the assertions are about, and both must work with permission ungranted.
    await page.addInitScript(() => {
      class StubNotification {
        static permission = "default";
        static async requestPermission() {
          StubNotification.permission = "granted";
          return "granted";
        }
      }
      Object.defineProperty(window, "Notification", {
        configurable: true,
        value: StubNotification,
      });
    });
  });

  test("a notification reaches an open page without a reload", async ({
    page,
  }) => {
    test.setTimeout(LIVE_TIMEOUT);
    await signUp(page, "Bell Bella", uniqueEmail("notify"));
    await failProvisioning(page);
    await createAgent(page, "Will not provision");

    // Sit on a page that is *not* the run's own, so nothing on screen is
    // polling for the thing under test. If the badge moves here, it moved
    // because a broadcast arrived.
    await page.getByTestId("run-agent").click();
    await page.getByTestId("run-modal-submit").click();
    await expect(page).toHaveURL(/\/runs\/\d+$/, LANDED);
    const runId = page.url().split("/").pop();

    await page.getByTestId("agents-link").click();
    await expect(page.getByTestId("agents-table")).toBeVisible(LANDED);

    // The bell is present from the moment there is a session, count or no count.
    await expect(page.getByTestId("notification-bell")).toBeVisible();

    // Wait for the Resque ticks: `run:create` nudges `runs:dispatch`, the
    // failed provision queues a row, and `notifications:dispatch` broadcasts.
    // Those actions have no HTTP route; e2e shortens their frequencies in
    // `BACKEND_ENV` so this poll is not waiting on production's 30s cadence.
    await expect
      .poll(
        async () => await page.getByTestId("notification-unread-count").count(),
        { timeout: 30_000, intervals: [500] },
      )
      .toBeGreaterThan(0);

    // **No reload anywhere above this line.** The toast is the socket's own
    // work: it exists only because a broadcast arrived at a page that was
    // already open.
    await expect(page.getByTestId("notification-toasts")).toBeVisible(
      DELIVERED,
    );
    await expect(page.getByTestId("notification-unread-count")).toHaveText("1");

    // Clicking through lands where the notification points.
    await page.getByTestId("notification-bell-toggle").click();
    await page.locator("[data-testid^='notification-item-']").first().click();
    await expect(page).toHaveURL(new RegExp(`/runs/${runId}$`), LANDED);

    // And opening it is what marks it read, rather than a second deliberate act.
    await expect(page.getByTestId("notification-unread-count")).toHaveCount(
      0,
      LANDED,
    );
  });

  test("the badge survives a reload, proving the row and not the socket", async ({
    page,
  }) => {
    test.setTimeout(LIVE_TIMEOUT);
    await signUp(page, "Reload Rhea", uniqueEmail("notify-reload"));
    await failProvisioning(page);
    await createAgent(page, "Also will not provision");

    await page.getByTestId("run-agent").click();
    await page.getByTestId("run-modal-submit").click();
    await expect(page).toHaveURL(/\/runs\/\d+$/, LANDED);

    await expect
      .poll(
        async () => await page.getByTestId("notification-unread-count").count(),
        { timeout: 30_000, intervals: [500] },
      )
      .toBeGreaterThan(0);

    // A reload throws the socket away and rebuilds the badge from
    // `notification:unread-count`. That it survives is the property the whole
    // design rests on: **the WebSocket is an accelerant, not the delivery
    // mechanism**, and a user who was offline for the whole exchange still finds
    // the unread badge waiting.
    await page.reload();
    await expect(page.getByTestId("notification-unread-count")).toHaveText(
      "1",
      LANDED,
    );

    // Mark all read decrements it, from the dropdown, without a reload.
    await page.getByTestId("notification-bell-toggle").click();
    await page.getByTestId("notification-mark-all-read").click();
    await expect(page.getByTestId("notification-unread-count")).toHaveCount(
      0,
      LANDED,
    );
  });

  test("the help inbox is reachable and says so when it is empty", async ({
    page,
  }) => {
    await signUp(page, "Inbox Ivy", uniqueEmail("notify-help"));

    await page.getByTestId("help-link").click();
    await expect(page.getByTestId("help-empty")).toBeVisible(LANDED);
    // The default filter is "only unanswered", which is what an inbox is for.
    await expect(page.getByTestId("help-pending-only")).toBeChecked();
  });

  test("desktop permission is only ever asked for from a click", async ({
    page,
  }) => {
    await signUp(page, "Permission Pat", uniqueEmail("notify-perm"));

    // Nothing has been asked on load — the stub would have flipped to
    // `granted` if anything had called `requestPermission()`.
    expect(await page.evaluate(() => window.Notification.permission)).toBe(
      "default",
    );

    await page.getByTestId("notification-bell-toggle").click();
    await page.getByTestId("notification-enable-desktop").click();

    expect(await page.evaluate(() => window.Notification.permission)).toBe(
      "granted",
    );
  });
});
