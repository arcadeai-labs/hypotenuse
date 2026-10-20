import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, lt } from "drizzle-orm";
import { api, config } from "keryx";
import { shouldPublishAsMcpTool } from "../../ops/McpToolPolicyOps";
import {
  enqueueNotification,
  NOTIFICATIONS_FRAME,
  projectNotificationsChannel,
  setBroadcasterForTesting,
  setTransportForTesting,
} from "../../ops/NotificationOps";
import { notifications } from "../../schema/notifications";
import {
  authHeaders,
  buildTestUniverse,
  cookieHeader,
  HOOK_TIMEOUT,
  runAction,
  type TestUniverse,
  type TestUser,
} from "../setup";

/**
 * The read-state half of notifications, and the one property that matters most:
 * **a notification belongs to a user, and no param can change whose.**
 *
 * These actions are session-gated rather than project-gated on purpose — the
 * bell spans every project a person is in — which means `rbac.test.ts` reports
 * them as `none` and this file is where that is actually made safe. Every query
 * filters on the session's `userId`, so the tests here are mostly about a caller
 * failing to reach somebody else's rows however they ask.
 */

let universe: TestUniverse;
let url: string;

/**
 * Queue one browser+email pair for a user directly. No feature raises a
 * notification yet, so the template is one nobody registered — which also
 * exercises the generic fallback rendering.
 */
async function seed(
  user: TestUser,
  overrides: { template?: string; projectId?: number } = {},
): Promise<void> {
  await enqueueNotification(api.db.db, {
    projectId: overrides.projectId ?? universe.projectId,
    userIds: [user.userId],
    template: overrides.template ?? "test_seeded",
    payload: { note: "seeded by the suite" },
    linkPath: "/settings/members",
  });
}

/** Every notification row belonging to a user. */
async function rowsOf(user: TestUser) {
  return await api.db.db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, user.userId));
}

/** `notification:list` as a signed-in person. */
async function list(
  user: TestUser,
  query = "",
): Promise<{
  notifications: { id: number; userId: number; readAt: number | null }[];
  pagination: { total: number };
}> {
  const res = await fetch(`${url}/api/notifications?${query}`, {
    headers: cookieHeader(user.sessionId),
  });
  return (await res.json()) as {
    notifications: { id: number; userId: number; readAt: number | null }[];
    pagination: { total: number };
  };
}

/** `notification:unread-count` as a signed-in person. */
async function unread(user: TestUser, query = ""): Promise<number> {
  const res = await fetch(`${url}/api/notifications/unread-count?${query}`, {
    headers: cookieHeader(user.sessionId),
  });
  return ((await res.json()) as { count: number }).count;
}

beforeAll(async () => {
  universe = await buildTestUniverse();
  url = universe.url;

  await seed(universe.peach);
  await seed(universe.peach);
  await seed(universe.mario);
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

describe("notification:list", () => {
  test("returns only the caller's own rows, and only browser ones", async () => {
    const body = await list(universe.peach);

    expect(body.notifications.length).toBe(2);
    expect(
      body.notifications.every((n) => n.userId === universe.peach.userId),
    ).toBe(true);
    // Peach has four rows in the table — two browser, two email — and only the
    // browser ones are inbox items. An `email` row is a delivery record with no
    // `readAt` anybody sets, so listing it would show each event twice with one
    // copy permanently unread.
    expect((await rowsOf(universe.peach)).length).toBe(4);
    expect(body.pagination.total).toBe(2);
  });

  test("a userId param cannot widen the scope", async () => {
    // The action declares no `userId` input at all, so this is a param the
    // framework drops — the assertion is that dropping it changes nothing,
    // which is the whole authorization model stated as a test.
    const body = await list(
      universe.mario,
      `userId=${universe.peach.userId}&limit=50`,
    );
    expect(
      body.notifications.every((n) => n.userId === universe.mario.userId),
    ).toBe(true);
    expect(body.notifications.length).toBe(1);
  });

  test("signed out is 401, not an empty list", async () => {
    const res = await fetch(`${url}/api/notifications`);
    expect(res.status).toBe(401);
  });

  test("unreadOnly narrows to what is unread", async () => {
    const all = await list(universe.peach, "limit=50");
    const unreadOnly = await list(universe.peach, "unreadOnly=true&limit=50");
    expect(unreadOnly.notifications.length).toBe(all.notifications.length);
  });
});

describe("notification:unread-count", () => {
  test("matches the browser rows with no readAt", async () => {
    const rows = (await rowsOf(universe.peach)).filter(
      (r) => r.channel === "browser" && r.readAt === null,
    );
    expect(await unread(universe.peach)).toBe(rows.length);
  });

  test("a project filter narrows it", async () => {
    // Peach's own bootstrap project holds none of these.
    expect(
      await unread(universe.peach, `projectId=${universe.projectId}`),
    ).toBe(2);
    expect(await unread(universe.bowser, "")).toBe(0);
  });
});

describe("notification:mark-read", () => {
  test("explicit ids only touch the caller's own rows", async () => {
    const peachRows = await list(universe.peach, "limit=50");
    const marioRows = await list(universe.mario, "limit=50");

    const res = await fetch(`${url}/api/notifications/read`, {
      method: "POST",
      headers: authHeaders(universe.mario.sessionId),
      // Mario asks for one of his own and one of Peach's. The second matches
      // nothing, silently — telling a caller which guessed ids exist would be
      // an oracle, and the honest answer is the `updated` count.
      body: JSON.stringify({
        notificationIds: [
          marioRows.notifications[0].id,
          peachRows.notifications[0].id,
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { updated: number; unread: number };
    expect(body.updated).toBe(1);

    expect(await unread(universe.mario)).toBe(0);
    // Peach's is untouched.
    expect(await unread(universe.peach)).toBe(2);
  });

  test("all: true clears the caller's unread set and nobody else's", async () => {
    await seed(universe.mario);

    const res = await fetch(`${url}/api/notifications/read`, {
      method: "POST",
      headers: authHeaders(universe.peach.sessionId),
      body: JSON.stringify({ all: true }),
    });
    expect(res.status).toBe(200);

    expect(await unread(universe.peach)).toBe(0);
    expect(await unread(universe.mario)).toBe(1);
  });

  test("neither ids nor all is a 406, not a silent no-op", async () => {
    const res = await fetch(`${url}/api/notifications/read`, {
      method: "POST",
      headers: authHeaders(universe.peach.sessionId),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(406);
  });

  test("is a human MCP tool", () => {
    // A person's Claude can clear the badge the same way the UI can. A runner
    // token cannot reach it at all: it may call only `daemon:*` actions.
    const action = api.actions.actions.find(
      (a) => a.name === "notification:mark-read",
    );
    expect(action).toBeDefined();
    expect(shouldPublishAsMcpTool(action!)).toBe(true);
    expect(action?.mcp?.tool).toBe(true);
  });
});

describe("notifications:dispatch", () => {
  test("delivers a queued pair: the browser row pings the channel, the e-mail is sent", async () => {
    const broadcasts: { channel: string; message: string }[] = [];
    const sent: { to: string; subject: string }[] = [];
    const restoreBroadcaster = setBroadcasterForTesting(
      async (channel, message) => {
        broadcasts.push({ channel, message });
      },
    );
    const restoreTransport = setTransportForTesting({
      sendMail: async (mail: { to: string; subject: string }) => {
        sent.push({ to: mail.to, subject: mail.subject });
      },
    } as unknown as Parameters<typeof setTransportForTesting>[0]);

    try {
      await seed(universe.toad);
      await runAction("notifications:dispatch");

      const rows = await rowsOf(universe.toad);
      expect(rows.map((r) => r.channel).sort()).toEqual(["browser", "email"]);
      expect(rows.every((r) => r.status === "sent")).toBe(true);
      expect(rows.every((r) => r.sentAt !== null)).toBe(true);

      // Every browser row is a ping on its project's channel, with no
      // content. Earlier suites' rows were due too, so assert the shape of
      // every frame rather than the count.
      expect(broadcasts.length).toBeGreaterThan(0);
      for (const frame of broadcasts) {
        expect(frame.channel).toBe(
          projectNotificationsChannel(universe.projectId),
        );
        expect(JSON.parse(frame.message)).toEqual(NOTIFICATIONS_FRAME);
        expect(Object.keys(JSON.parse(frame.message))).toEqual(["event"]);
      }

      // The e-mail went to Toad, rendered by the generic fallback.
      expect(sent).toContainEqual({
        to: universe.toad.email,
        subject: "[Hypotenuse] Hypotenuse notification",
      });
    } finally {
      restoreTransport();
      restoreBroadcaster();
    }
  });

  test("with no SMTP host the e-mail is logged and still marked sent", async () => {
    const restoreTransport = setTransportForTesting(null);
    const restoreBroadcaster = setBroadcasterForTesting(async () => {});
    try {
      await seed(universe.toad);
      await runAction("notifications:dispatch");
      const email = (await rowsOf(universe.toad)).filter(
        (r) => r.channel === "email",
      );
      expect(email.length).toBeGreaterThan(0);
      expect(email.every((r) => r.status === "sent")).toBe(true);
    } finally {
      restoreBroadcaster();
      restoreTransport();
    }
  });

  test("a failed send is retried later, not dropped", async () => {
    const restoreBroadcaster = setBroadcasterForTesting(async () => {});
    const restoreTransport = setTransportForTesting({
      sendMail: async () => {
        throw new Error("mail server down");
      },
    } as unknown as Parameters<typeof setTransportForTesting>[0]);
    try {
      await seed(universe.bowser, { projectId: universe.bowser.projectId });
      await runAction("notifications:dispatch");
      const [email] = (await rowsOf(universe.bowser)).filter(
        (r) => r.channel === "email",
      );
      expect(email.status).toBe("pending");
      expect(email.attempts).toBe(1);
      expect(email.error).toBe("mail server down");
      expect(email.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    } finally {
      restoreTransport();
      restoreBroadcaster();
    }
  });
});

describe("notifications:sweep", () => {
  test("deletes past the retention window and keeps what is inside it", async () => {
    const cutoff = new Date(
      Date.now() - config.notifications.retentionDays * 24 * 60 * 60 * 1000,
    );
    const old = new Date(cutoff.getTime() - 24 * 60 * 60 * 1000);

    await seed(universe.luigi);
    // Time is controlled by writing the column, never by waiting.
    await api.db.db
      .update(notifications)
      .set({ createdAt: old })
      .where(eq(notifications.userId, universe.luigi.userId));

    const before = await api.db.db
      .select()
      .from(notifications)
      .where(lt(notifications.createdAt, cutoff));
    expect(before.length).toBe(2);

    const body = (await runAction("notifications:sweep")) as {
      deleted: number;
    };
    expect(body.deleted).toBe(2);

    expect((await rowsOf(universe.luigi)).length).toBe(0);
    // Everything inside the window survives.
    expect((await rowsOf(universe.peach)).length).toBe(4);
  });
});
