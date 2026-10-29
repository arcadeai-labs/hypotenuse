import { expect, test } from "@playwright/test";
import { LANDED, signUpApi } from "./session.ts";

test("the bell reads the unread count and shows an empty list", async ({
  page,
}) => {
  const me = await signUpApi(page.request, "Bell Ringer");
  const count = page.waitForResponse(
    (response) =>
      response.url().includes("/api/notifications/unread-count") &&
      response.url().includes(`projectId=${me.project.id}`),
  );
  await page.goto("/organization/projects");
  const answer = await count;
  expect(answer.status()).toBe(200);
  expect(await answer.json()).toEqual({ count: 0 });

  const toggle = page.getByTestId("notification-bell-toggle");
  await expect(toggle).toHaveAttribute("data-unread", "0", LANDED);
  await expect(page.getByTestId("notification-unread-count")).toHaveCount(0);
  await toggle.click();
  await expect(page.getByTestId("notification-empty")).toBeVisible();
  await expect(page.getByTestId("notification-mark-all-read")).toBeDisabled();
});

test("the bell subscribes to the active project's notification channel", async ({
  page,
}) => {
  const me = await signUpApi(page.request, "Socket Sam");
  const channel = `project:${me.project.id}:notifications`;
  const subscribed = new Promise<string>((resolve) => {
    page.on("websocket", (socket) => {
      socket.on("framereceived", ({ payload }) => {
        const text = String(payload);
        if (text.includes(channel)) resolve(text);
      });
    });
  });
  await page.goto("/organization/projects");
  const reply = await subscribed;
  // The server confirmed the subscription rather than refusing it.
  expect(reply).not.toContain("error");
});

test("signed out, the bell is drawn disabled rather than left out", async ({
  page,
}) => {
  await page.goto("/status");
  const toggle = page.getByTestId("notification-bell-toggle");
  await expect(toggle).toHaveAttribute("aria-disabled", "true", LANDED);
  await expect(toggle).toHaveAttribute("title", "Not signed in");
});
