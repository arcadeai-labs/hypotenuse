import { execFileSync } from "node:child_process";
import { expect, type Page, test } from "@playwright/test";
import { BACKEND_URL, DATABASE_URL } from "./env.ts";
import { LANDED, signUp } from "./session.ts";

/**
 * Live notifications, in a real browser.
 *
 * **What only a browser can prove is the liveness**: that a notification queued
 * on the server reaches an already-open page over the WebSocket, raises a toast,
 * and moves the bell's count — with no reload. Everything else is a property of
 * rows, which the backend suites cover against a real server.
 *
 * No feature raises a notification yet, so the spec queues one the way a feature
 * will: a `pending` browser row in `notifications`, written straight to the e2e
 * database. From there it is the real path — the dispatch clock (on a one-second
 * tick in `BACKEND_ENV`) claims it, broadcasts the content-free
 * `{ event: "notifications" }` frame, and the page re-reads over HTTP.
 */

/** Long enough for a dispatcher tick plus a socket round trip. */
const DELIVERED = { timeout: 20_000 };

/**
 * Queue one browser notification for the signed-in user in their active
 * project. Written with Bun's SQL client in a child process, because
 * Playwright runs under Node and the frontend carries no Postgres driver.
 * @param page - The signed-in page; its cookies identify the recipient.
 * @param title - What the generic rendering will be keyed on.
 */
async function queueNotification(page: Page, title: string): Promise<void> {
  const me = await (await page.request.get(`${BACKEND_URL}/api/me`)).json();
  const list = await (
    await page.request.get(`${BACKEND_URL}/api/projects?limit=1`)
  ).json();
  const userId = Number(me.user.id);
  const projectId = Number(list.projects[0].id);
  const script = `
    import { SQL } from "bun";
    const sql = new SQL(process.env.DATABASE_URL);
    await sql\`INSERT INTO notifications
      (project_id, user_id, channel, template, payload, link_path)
      VALUES (\${${projectId}}, \${${userId}}, 'browser', \${process.env.TEMPLATE}, '{}'::jsonb, '/settings')\`;
    await sql.close();
  `;
  execFileSync("bun", ["-e", script], {
    env: { ...process.env, DATABASE_URL, TEMPLATE: title },
    stdio: "pipe",
  });
}

test.describe("notifications", () => {
  test.setTimeout(60_000);

  test("a notification reaches an open page without a reload", async ({
    page,
  }) => {
    await signUp(page, "Bell Betty");
    await expect(page.getByTestId("notification-bell")).toBeVisible();
    await expect(page.getByTestId("notification-unread-count")).toHaveCount(0);

    await queueNotification(page, "e2e-live");

    // The toast and the badge arrive over the socket — nothing reloads.
    await expect(page.getByTestId("notification-toasts")).toBeVisible(
      DELIVERED,
    );
    await expect(page.getByTestId("notification-unread-count")).toHaveText("1");

    // Opening it from the bell marks it read and goes where it points.
    await page.getByTestId("notification-bell-toggle").click();
    await page.locator('[data-testid^="notification-item-"]').first().click();
    await expect(page).toHaveURL(/\/settings/, LANDED);
    await expect(page.getByTestId("notification-unread-count")).toHaveCount(0);
  });

  test("the badge survives a reload, proving the row and not the socket", async ({
    page,
  }) => {
    await signUp(page, "Reload Rhea");
    await queueNotification(page, "e2e-reload");

    await page.reload();
    await expect(page.getByTestId("notification-unread-count")).toHaveText(
      "1",
      LANDED,
    );

    // Mark all read clears it, and that survives a reload too.
    await page.getByTestId("notification-bell-toggle").click();
    await page.getByTestId("notification-mark-all-read").click();
    await expect(page.getByTestId("notification-unread-count")).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("app-shell")).toBeVisible(LANDED);
    await expect(page.getByTestId("notification-unread-count")).toHaveCount(0);
  });

  test("an empty bell says so", async ({ page }) => {
    await signUp(page, "Quiet Quinn");
    await page.getByTestId("notification-bell-toggle").click();
    await expect(page.getByTestId("notification-empty")).toBeVisible();
    await expect(page.getByTestId("notification-mark-all-read")).toBeDisabled();
  });

  test("desktop permission is only ever asked for from a click", async ({
    page,
  }) => {
    // Headless Chromium's starting permission differs between builds ("denied"
    // in CI, "default" locally), so the browser's own answer proves nothing.
    // A stand-in that starts at "default" and counts every ask does: the
    // property is that loading the app never calls `requestPermission`.
    await page.addInitScript(() => {
      const calls = { count: 0 };
      (
        window as unknown as { __permissionAsks: typeof calls }
      ).__permissionAsks = calls;
      class StandInNotification {
        static permission: NotificationPermission = "default";
        static async requestPermission(): Promise<NotificationPermission> {
          calls.count++;
          return StandInNotification.permission;
        }
      }
      Object.defineProperty(window, "Notification", {
        value: StandInNotification,
        configurable: true,
      });
    });
    const asks = () =>
      page.evaluate(
        () =>
          (window as unknown as { __permissionAsks: { count: number } })
            .__permissionAsks.count,
      );

    await signUp(page, "Permission Pat");
    expect(await asks()).toBe(0);

    await page.getByTestId("notification-bell-toggle").click();
    await expect(page.getByTestId("notification-enable-desktop")).toBeVisible();
    // Opening the bell is not consent either.
    expect(await asks()).toBe(0);

    await page.getByTestId("notification-enable-desktop").click();
    await expect.poll(asks).toBe(1);
  });
});
