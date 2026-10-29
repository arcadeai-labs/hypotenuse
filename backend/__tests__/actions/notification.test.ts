import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, lt } from "drizzle-orm";
import { api, config } from "keryx";
import {
  enqueueNotification,
  resetNotificationTransport,
  resolveRecipients,
} from "../../ops/NotificationOps";
import { notifications } from "../../schema/notifications";
import { type FakeSmtpServer, startFakeSmtpServer } from "../fixtures/smtp";
import {
  buildTestUniverse,
  call,
  HOOK_TIMEOUT,
  runAction,
  type TestUniverse,
  type TestUser,
} from "../setup";

/**
 * Notifications, and the property that matters most: **a notification belongs
 * to a user, and no param can change whose.** These actions are session-gated
 * rather than project-gated — the bell spans every project a person can see —
 * so `rbac.test.ts` reports them as `none`, and this file is where that is made
 * safe. Email goes through the real nodemailer transport to an in-process SMTP
 * server; the browser half is proven in `channels/project-notifications.test.ts`.
 */

let u: TestUniverse;
let smtp: FakeSmtpServer;

/**
 * Queue one browser + email pair for a person. No feature raises a notification
 * yet, so the template is one nobody registered, which also exercises the
 * generic rendering.
 * @param user - The recipient.
 * @param projectId - The project it belongs to (defaults to Castle).
 */
async function seed(user: TestUser, projectId = u.projectId): Promise<void> {
  await enqueueNotification(api.db.db, {
    projectId,
    userIds: [user.userId],
    template: "test_seeded",
    payload: { note: "seeded by the suite" },
    linkPath: "/settings",
  });
}

/**
 * Every notification row belonging to a person.
 * @param user - Who.
 * @returns Their rows.
 */
async function rowsOf(user: TestUser) {
  return await api.db.db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, user.userId));
}

beforeAll(async () => {
  u = await buildTestUniverse();
  await seed(u.peach);
  await seed(u.peach);
  await seed(u.mario);
}, HOOK_TIMEOUT);

afterAll(async () => {
  smtp?.stop();
  resetNotificationTransport();
  await api.stop();
}, HOOK_TIMEOUT);

describe("notification:list", () => {
  test("returns only the caller's own rows, and only browser ones", async () => {
    const { status, body } = await call<{
      notifications: { userId: number; title: string }[];
      pagination: { total: number };
    }>(u.url, u.peach, "GET", "/notifications");
    expect(status).toBe(200);
    expect(body.pagination.total).toBe(2);
    expect(body.notifications.every((n) => n.userId === u.peach.userId)).toBe(
      true,
    );
    expect(body.notifications[0].title).toBe("Hypotenuse notification");
  });

  test("a userId param cannot widen the scope", async () => {
    const { body } = await call<{ pagination: { total: number } }>(
      u.url,
      u.peach,
      "GET",
      `/notifications?userId=${u.mario.userId}`,
    );
    expect(body.pagination.total).toBe(2);
  });

  test("signed out is 401, not an empty list", async () => {
    expect((await call(u.url, null, "GET", "/notifications")).status).toBe(401);
  });
});

describe("notification:unread-count and notification:mark-read", () => {
  test("counts unread browser rows, optionally within one project", async () => {
    const count = await call<{ count: number }>(
      u.url,
      u.peach,
      "GET",
      "/notifications/unread-count",
    );
    expect(count.body.count).toBe(2);
    const elsewhere = await call<{ count: number }>(
      u.url,
      u.peach,
      "GET",
      `/notifications/unread-count?projectId=${u.peach.projectId}`,
    );
    expect(elsewhere.body.count).toBe(0);
  });

  test("ids belonging to someone else match nothing", async () => {
    const [marios] = (await rowsOf(u.mario)).filter(
      (r) => r.channel === "browser",
    );
    const res = await call<{ updated: number; unread: number }>(
      u.url,
      u.peach,
      "POST",
      "/notifications/read",
      { notificationIds: [marios.id] },
    );
    expect(res.body.updated).toBe(0);
    const [still] = (await rowsOf(u.mario)).filter(
      (r) => r.channel === "browser",
    );
    expect(still.readAt).toBeNull();
  });

  test("all: true clears the caller's unread set and nobody else's", async () => {
    const res = await call<{ updated: number; unread: number }>(
      u.url,
      u.peach,
      "POST",
      "/notifications/read",
      { all: true },
    );
    expect(res.body).toEqual({ updated: 2, unread: 0 });
    const mario = await call<{ count: number }>(
      u.url,
      u.mario,
      "GET",
      "/notifications/unread-count",
    );
    expect(mario.body.count).toBe(1);
  });

  test("neither ids nor all is a 406", async () => {
    const res = await call(u.url, u.peach, "POST", "/notifications/read", {});
    expect(res.status).toBe(406);
  });
});

describe("resolveRecipients", () => {
  test("a named tag reaches its holders, case-insensitively", async () => {
    expect(await resolveRecipients(u.projectId, " Operators ")).toEqual([
      u.mario.userId,
    ]);
  });

  test("no tag, or a tag nobody holds, reaches everyone with admin standing", async () => {
    // Peach is Castle's explicit admin and the organization's only owner.
    expect(await resolveRecipients(u.projectId, null)).toEqual([
      u.peach.userId,
    ]);
    await call(
      u.url,
      u.peach,
      "POST",
      `/organization/${u.organizationId}/member/${u.daisy.userId}`,
      {
        role: "owner",
      },
    );
    expect((await resolveRecipients(u.projectId, "nobody")).sort()).toEqual(
      [u.peach.userId, u.daisy.userId].sort(),
    );
  });
});

describe("notifications:dispatch", () => {
  test("sends each email over SMTP and marks every row sent", async () => {
    smtp = startFakeSmtpServer();
    config.notifications.smtpHost = "127.0.0.1";
    config.notifications.smtpPort = smtp.port;
    resetNotificationTransport();

    await seed(u.toad);
    await runAction("notifications:dispatch");

    const rows = await rowsOf(u.toad);
    expect(rows.map((r) => r.channel).sort()).toEqual(["browser", "email"]);
    expect(rows.every((r) => r.status === "sent" && r.sentAt !== null)).toBe(
      true,
    );

    const mail = smtp.received.find((m) => m.to.includes(u.toad.email));
    expect(mail?.subject).toBe("[Hypotenuse] Hypotenuse notification");
    expect(mail?.from).toBe("noreply@example.invalid");
    // The link is the dashboard's origin, never the API's.
    expect(mail?.data).toContain(config.frontend.url);
  });

  test("a failed send is retried later, not dropped", async () => {
    smtp.failing = true;
    try {
      await seed(u.bowser, u.bowser.projectId);
      await runAction("notifications:dispatch");
      const [email] = (await rowsOf(u.bowser)).filter(
        (r) => r.channel === "email",
      );
      expect(email.status).toBe("pending");
      expect(email.attempts).toBe(1);
      expect(email.error).toContain("mail server down");
      expect(email.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    } finally {
      smtp.failing = false;
    }
  });

  test("with no SMTP host, email is logged and still marked sent", async () => {
    config.notifications.smtpHost = "";
    resetNotificationTransport();
    await seed(u.luigi);
    await runAction("notifications:dispatch");
    const email = (await rowsOf(u.luigi)).filter((r) => r.channel === "email");
    expect(email.every((r) => r.status === "sent")).toBe(true);
  });
});

describe("notifications:sweep", () => {
  test("deletes past the retention window and keeps what is inside it", async () => {
    const cutoff = new Date(
      Date.now() - config.notifications.retentionDays * 24 * 60 * 60 * 1000,
    );
    // Time is controlled by writing the column, never by waiting.
    await api.db.db
      .update(notifications)
      .set({ createdAt: new Date(cutoff.getTime() - 60_000) })
      .where(eq(notifications.userId, u.luigi.userId));
    const old = await api.db.db
      .select()
      .from(notifications)
      .where(lt(notifications.createdAt, cutoff));
    expect(old.length).toBe(2);

    const result = await runAction<{ deleted: number }>("notifications:sweep");
    expect(result.deleted).toBe(2);
    expect(await rowsOf(u.luigi)).toEqual([]);
    expect((await rowsOf(u.peach)).length).toBe(4);
  });
});
