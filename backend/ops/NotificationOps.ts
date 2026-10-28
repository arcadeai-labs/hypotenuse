import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { api, config } from "keryx";
import nodemailer, { type Transporter } from "nodemailer";
// Type-only, purely for the `declare module "keryx"` augmentations inside.
import type {} from "../config/frontend";
import type {} from "../config/notifications";
import {
  NOTIFICATION_CHANNELS,
  type Notification,
  type NotificationChannel,
  notifications,
} from "../schema/notifications";
import { projectMemberships } from "../schema/project_memberships";
import { projects } from "../schema/projects";
import { tags } from "../schema/tags";
import { userTags } from "../schema/user_tags";
import { users } from "../schema/users";
import type { DbHandle } from "./DbOps";
import { getAdminUserIds } from "./MembershipOps";
import { getOwnerUserIds } from "./OrganizationOps";
import { NOTIFICATION_TEMPLATES, type RenderedNotification } from "./templates";

/**
 * The Redis-backed PubSub channel a project's notifications are broadcast on.
 *
 * **Per project, not per user**, which is only defensible because the frames on
 * it carry **no content** — not even an id or a recipient. See
 * {@link broadcastNotification}.
 *
 * With the content gone, one subscription per open tab regardless of team size
 * costs nothing in disclosure. Per-user channels would still need the same
 * membership check, since the channel name is client-supplied either way.
 * @param projectId - The project.
 * @returns The channel name.
 */
export function projectNotificationsChannel(projectId: number): string {
  return `project:${projectId}:notifications`;
}

/** The channel-name shape {@link projectNotificationsChannel} produces. */
export const PROJECT_NOTIFICATIONS_CHANNEL_PATTERN =
  /^project:(\d+):notifications$/;

/** The one frame ever published on a notifications channel. */
export const NOTIFICATIONS_FRAME = { event: "notifications" } as const;

/** The memoized transport, or `undefined` before the first {@link getTransport}. */
let transport: Transporter | null | undefined;

/** Whether the log-only warning has already been emitted this process. */
let warnedLogOnly = false;

/**
 * The nodemailer transport, or `null` when SMTP is unconfigured.
 *
 * **`null` is log-only mode, not an error.** With no `SMTP_HOST` an email row is
 * logged and marked `sent`, which is what keeps local development and CI working
 * with no mail server — and it is the mode the notification tests assert
 * against. A production deploy that fell into it by accident would silently
 * swallow every message, so the first time it happens the process says so at
 * `warn`.
 *
 * Memoized rather than resolved at import, for the reason `CryptoOps` memoizes
 * its key: `config` is not populated until `api.initialize()`, and action
 * discovery imports this file long before that.
 * @returns The transport, or `null` in log-only mode.
 */
export function getTransport(): Transporter | null {
  if (transport !== undefined) return transport;

  const host = config.notifications.smtpHost;
  if (!host) {
    if (!warnedLogOnly) {
      warnedLogOnly = true;
      api.logger.warn(
        "SMTP_HOST is unset, so email notifications will be logged instead of sent",
      );
    }
    transport = null;
    return transport;
  }

  transport = nodemailer.createTransport({
    host,
    port: config.notifications.smtpPort,
    secure: config.notifications.smtpSecure,
    ...(config.notifications.smtpUser
      ? {
          auth: {
            user: config.notifications.smtpUser,
            pass: config.notifications.smtpPassword,
          },
        }
      : {}),
  });

  return transport;
}

/**
 * Forget the memoized transport, so the next send reads `config.notifications`
 * again. For a process (or suite) that changed the SMTP settings after the first
 * send — the notification suites point it at an in-process SMTP server.
 */
export function resetNotificationTransport(): void {
  transport?.close();
  transport = undefined;
}

/** What {@link enqueueNotification} needs to write a batch of rows. */
export interface NotificationEntry {
  /** The project the notification belongs to. */
  projectId: number;
  /** Who to tell. One row per user per channel. */
  userIds: number[];
  /** Which template renders it. */
  template: string;
  /** Everything the template needs — **already safe to store**. */
  payload: Record<string, unknown>;
  /** Where clicking it goes, relative to the frontend's origin. */
  linkPath: string;
  /** Which channels to use. Defaults to both. */
  channels?: NotificationChannel[];
}

/**
 * Queue one row per recipient per channel. **Delivers nothing.**
 *
 * Takes a `db` handle rather than reaching for `api.db.db`, because a caller
 * should write the thing it is telling people about and their notifications in
 * one transaction: an event that is visible in the app with nothing queued to
 * tell anyone about it is the failure this whole table exists to avoid.
 * @param db - A transaction handle, or the shared `api.db.db`.
 * @param entry - Who to tell, about what, and where it points.
 * @returns How many rows were written.
 */
export async function enqueueNotification(
  db: DbHandle,
  entry: NotificationEntry,
): Promise<number> {
  const channels = entry.channels ?? [...NOTIFICATION_CHANNELS];
  const recipients = [...new Set(entry.userIds)];
  if (recipients.length === 0 || channels.length === 0) return 0;

  const rows = recipients.flatMap((userId) =>
    channels.map((channel) => ({
      projectId: entry.projectId,
      userId,
      channel,
      template: entry.template,
      payload: entry.payload,
      linkPath: entry.linkPath,
    })),
  );

  await db.insert(notifications).values(rows);
  return rows.length;
}

/**
 * Who to tell about something happening in a project.
 *
 * A named tag when the caller has one, everyone with admin standing when it does
 * not — the project's admins and its organization's owners. The fallback is
 * admins rather than every member on purpose: something nobody is responsible
 * for is something nobody acts on, and admin standing is the one thing a project
 * is guaranteed to have someone holding.
 *
 * A tag naming nobody — or a tag that has since been deleted — falls back to the
 * admins too. The alternative is a notification that reaches no one at all
 * because somebody renamed a tag, which is a silent failure of the one feature
 * whose whole point is not failing silently.
 * @param projectId - The project.
 * @param tag - The tag name to notify, or `null` for the admins.
 * @returns The recipient user ids.
 */
export async function resolveRecipients(
  projectId: number,
  tag: string | null,
): Promise<number[]> {
  if (tag) {
    const wanted = tag.trim().toLowerCase();
    const rows = await api.db.db
      .select({ userId: userTags.userId })
      .from(userTags)
      .innerJoin(tags, eq(userTags.tagId, tags.id))
      .innerJoin(
        projectMemberships,
        and(
          eq(projectMemberships.userId, userTags.userId),
          eq(projectMemberships.projectId, projectId),
        ),
      )
      .where(
        and(
          eq(tags.projectId, projectId),
          sql`lower(trim(${tags.name})) = ${wanted}`,
        ),
      );

    const holders = [...new Set(rows.map((r) => r.userId))];
    if (holders.length > 0) return holders;

    api.logger.warn(
      "a notification tag matched nobody, falling back to project admins",
      { projectId, tag },
    );
  }

  const [project] = await api.db.db
    .select({ organizationId: projects.organizationId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const owners = project
    ? await getOwnerUserIds(api.db.db, project.organizationId)
    : [];
  return [
    ...new Set([...(await getAdminUserIds(api.db.db, projectId)), ...owners]),
  ];
}

/**
 * Render a stored notification into both of its forms.
 *
 * An unregistered template renders generically rather than throwing. Delivery
 * is the wrong place to discover that a deploy rolled back past a template: the
 * row was queued by code that existed, and a recipient reading "Hypotenuse
 * notification" is strictly better than one reading nothing.
 * @param template - The template name from the row.
 * @param payload - The stored payload.
 * @returns The rendered notification.
 */
export function renderTemplate(
  template: string,
  payload: Record<string, unknown>,
): RenderedNotification {
  const render = NOTIFICATION_TEMPLATES[template];
  const appUrl = config.frontend.url.replace(/\/+$/, "");

  if (!render) {
    api.logger.warn("no template is registered under that name", { template });
    const title = "Hypotenuse notification";
    const body = `An event of type "${template}" occurred.`;
    return {
      title,
      body,
      subject: `[Hypotenuse] ${title}`,
      text: `${body}\n\n${appUrl}`,
      html: `<p>${body}</p>`,
    };
  }

  return render(payload, appUrl);
}

/**
 * Deliver one row through its own channel. **Never throws.**
 *
 * The dispatcher runs this over a batch, and one unreachable mail server must
 * not stop the rest of the batch — nor turn a tick into an unhandled rejection
 * inside a background task. Every failure lands on the row instead, as an
 * `error` and a pushed-out `nextAttemptAt`.
 *
 * The two arms are deliberately asymmetric. **A `browser` row never retries**:
 * the broadcast is fire-and-forget by design, and there is nothing to retry
 * against — the row itself is the durable half, unread until somebody reads it.
 * The `email` arm is the one with a remote party, so it is the one with backoff.
 *
 * That asymmetry is enforced by {@link deliverBrowser} swallowing its own
 * failures rather than by this `catch`, and the difference is not cosmetic: a
 * broadcast that threw would otherwise land in `recordFailure` and be retried
 * like an email, which contradicts the guarantee above and can re-toast a
 * notification the recipient has already read on a page load. So the `catch`
 * here is the email arm's, and the browser arm is unreachable from it.
 * @param row - The notification to deliver.
 */
export async function deliverNotification(row: Notification): Promise<void> {
  try {
    if (row.channel === "browser") {
      await deliverBrowser(row);
    } else {
      await deliverEmail(row);
    }
  } catch (e) {
    await recordFailure(row, e instanceof Error ? e.message : String(e));
  }
}

/**
 * Broadcast a browser notification and mark it sent.
 *
 * Marked `sent` **whether or not anyone is connected**, because a broadcast has
 * no delivery receipt and the row's own unread state is what an absent user sees
 * on their next page load. That is the property worth stating plainly: the
 * WebSocket is an accelerant, not the delivery mechanism.
 *
 * The broadcast goes through Keryx's PubSub, which is Redis-backed — so a row
 * dispatched by the *worker* reaches sockets held by the *web service*, which in
 * this topology is the only way it ever reaches anyone. A naive in-process emitter
 * would work perfectly on a laptop and never once fire in staging.
 *
 * **A failed broadcast is logged and the row is still marked `sent`.** That is
 * the same argument as "sent whether or not anyone is connected", applied one
 * step earlier: a Redis publish that failed is indistinguishable, from here,
 * from one that succeeded and reached nobody. Retrying it would re-toast a
 * notification the recipient may already have read, and the badge they actually
 * need is coming from the row on their next page load either way.
 * @param row - The notification to broadcast.
 */
async function deliverBrowser(row: Notification): Promise<void> {
  try {
    await broadcastNotification(row);
  } catch (e) {
    api.logger.error(
      "could not broadcast a notification; the row still stands",
      {
        notificationId: row.id,
        projectId: row.projectId,
        error: e instanceof Error ? e.message : String(e),
      },
    );
  }

  await markSent(row);
}

/**
 * Publish a **content-free** ping on the project's channel.
 *
 * **The frame is `{ "event": "notifications" }` and nothing else** — no id, no
 * recipient, no title. A per-project channel every member may subscribe to is
 * only honest if there is nothing on it to leak, and content belongs on the path
 * that checks who is asking: the client learns *that* something changed and
 * re-reads through `notification:list` / `notification:unread-count`, which are
 * scoped to the session's own user. The same rule holds for every channel in
 * this application — Postgres is the truth, and a frame is a ping.
 *
 * Split out from {@link deliverBrowser} so the swallow there wraps exactly the
 * remote call and nothing else. The two failures are genuinely different — a
 * publish that failed reached nobody, a `markSent` that failed lost bookkeeping
 * for something already delivered — and {@link markSent} handles its own, since
 * treating the second like the first re-sent messages that had gone out.
 * @param row - The notification.
 */
async function broadcastNotification(row: Notification): Promise<void> {
  await api.pubsub.broadcast(
    projectNotificationsChannel(row.projectId),
    JSON.stringify(NOTIFICATIONS_FRAME),
    "notifications:dispatch",
  );
}

/**
 * Send one email, or log it when SMTP is unconfigured.
 * @param row - The notification to send.
 * @throws Whatever the transport throws, for {@link deliverNotification} to record.
 */
async function deliverEmail(row: Notification): Promise<void> {
  const rendered = renderTemplate(row.template, row.payload);
  const to = await recipientEmail(row.userId);

  if (!to) {
    // A user deleted between queueing and dispatch. Not a failure to retry:
    // there is no address, and there never will be one.
    api.logger.warn("skipping an email notification with no recipient", {
      notificationId: row.id,
      userId: row.userId,
    });
    await markSent(row);
    return;
  }

  const mailer = getTransport();

  if (!mailer) {
    api.logger.info("email notification (log-only mode: SMTP_HOST is unset)", {
      notificationId: row.id,
      to,
      subject: rendered.subject,
      linkPath: row.linkPath,
    });
    await markSent(row);
    return;
  }

  await mailer.sendMail({
    from: config.notifications.from,
    to,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
  });

  await markSent(row);
}

/**
 * The address a notification's recipient reads.
 * @param userId - The recipient.
 * @returns Their email, or `null` if the user is gone.
 */
async function recipientEmail(userId: number): Promise<string | null> {
  const [row] = await api.db.db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.email ?? null;
}

/**
 * Stamp a row as delivered. **Never throws.**
 *
 * That matters, and it is the correction to a comment that used to sit on
 * {@link broadcastNotification} saying a failed `markSent` "must not be mistaken
 * for a broadcast that did". True, and the handling was still wrong: letting it
 * propagate meant {@link deliverNotification}'s `catch` ran `recordFailure`,
 * which puts the row back to `pending` — so a message that **was** delivered got
 * re-sent on the next tick. A duplicate email, or a second toast for the same
 * event, from a database blip in the two lines after a successful send.
 *
 * Swallowing is truthful rather than merely convenient, because
 * {@link claimDueNotifications} already moved the row out of `pending` and into
 * `sent` when it claimed it. This update only enriches that with `sentAt` and
 * the attempt count; losing it leaves a row that is still, correctly, `sent`.
 * The one observable cost is a `sentAt` that stays null on a delivered row,
 * which is a reporting wrinkle rather than a delivery bug.
 * @param row - The notification.
 */
async function markSent(row: Notification): Promise<void> {
  const now = new Date();
  try {
    await api.db.db
      .update(notifications)
      .set({
        status: "sent",
        sentAt: now,
        attempts: row.attempts + 1,
        error: null,
        updatedAt: now,
      })
      .where(eq(notifications.id, row.id));
  } catch (e) {
    api.logger.error(
      "delivered a notification but could not stamp it; it stays sent and is not retried",
      {
        notificationId: row.id,
        channel: row.channel,
        error: e instanceof Error ? e.message : String(e),
      },
    );
  }
}

/**
 * Record a failed attempt: count it, push the next one out, and give up once the
 * attempt budget is spent.
 *
 * Backoff is `2^attempts` minutes, which reaches roughly half an hour by the
 * fifth attempt — long enough to ride out a mail provider's outage without
 * turning the dispatcher's tick into a retry storm.
 * @param row - The notification that failed.
 * @param message - Why.
 */
async function recordFailure(
  row: Notification,
  message: string,
): Promise<void> {
  const attempts = row.attempts + 1;
  const exhausted = attempts >= config.notifications.maxAttempts;
  const now = new Date();

  await api.db.db
    .update(notifications)
    .set({
      status: exhausted ? "failed" : "pending",
      attempts,
      error: message.slice(0, 2000),
      nextAttemptAt: new Date(now.getTime() + 2 ** attempts * 60_000),
      updatedAt: now,
    })
    .where(eq(notifications.id, row.id));

  api.logger[exhausted ? "error" : "warn"](
    exhausted
      ? "giving up on a notification after the last attempt"
      : "a notification delivery failed and will be retried",
    { notificationId: row.id, attempts, error: message },
  );
}

/**
 * Claim due `pending` notifications.
 *
 * Raw SQL because Drizzle cannot express `FOR UPDATE SKIP LOCKED`, and without
 * it two overlapping ticks select the same rows and send the same email twice —
 * the kind of thing that erodes trust in the feature faster than a missing one
 * does.
 *
 * Claiming *is* the status change: a row is moved out of `pending` by the same
 * statement that selects it, so nothing else can pick it up while delivery is in
 * flight. A crash mid-delivery therefore strands a `sent` row that never sent —
 * the accepted trade against a crash mid-delivery stranding a `pending` row that
 * sends twice, because an email is not idempotent and a lost one is recoverable
 * by asking again.
 * @param limit - How many rows to claim.
 * @returns The claimed rows, ready to deliver.
 */
export async function claimDueNotifications(
  limit: number,
): Promise<Notification[]> {
  const claimed = await api.db.db.execute(sql`
    UPDATE notifications SET
      status = 'sent',
      updated_at = now()
    WHERE id IN (
      SELECT id FROM notifications
      WHERE status = 'pending'
        AND next_attempt_at <= now()
      ORDER BY next_attempt_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    RETURNING id
  `);

  const ids = (claimed.rows as { id: number }[]).map((r) => Number(r.id));
  if (ids.length === 0) return [];

  return await api.db.db
    .select()
    .from(notifications)
    .where(inArray(notifications.id, ids));
}

/**
 * How many unread `browser` notifications a user has.
 *
 * `email` rows are excluded by the query rather than by convention: they have no
 * `readAt` anybody sets, so counting them would make the badge a number that
 * only ever grows.
 * @param userId - The user.
 * @param projectId - Narrow to one project, or omit for every project.
 * @returns The unread count.
 */
export async function unreadCount(
  userId: number,
  projectId?: number,
): Promise<number> {
  const [row] = await api.db.db
    .select({ count: count() })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.channel, "browser"),
        isNull(notifications.readAt),
        projectId ? eq(notifications.projectId, projectId) : undefined,
      ),
    );

  return Number(row?.count ?? 0);
}

/**
 * Shape a notification row for the API and for the broadcast.
 *
 * The rendered `title` and `body` travel with it, so the inbox and the toast
 * render from the same strings the email was built from and no copy of a
 * template ends up in the browser.
 * @param row - The notification row.
 * @param rendered - Its rendering, computed already when the caller has one.
 * @returns The serialized notification.
 */
export function serializeNotification(
  row: Notification,
  rendered?: RenderedNotification,
) {
  const view = rendered ?? renderTemplate(row.template, row.payload);
  return {
    id: row.id,
    projectId: row.projectId,
    userId: row.userId,
    channel: row.channel,
    template: row.template,
    payload: row.payload,
    status: row.status,
    linkPath: row.linkPath,
    readAt: row.readAt?.getTime() ?? null,
    createdAt: row.createdAt.getTime(),
    title: view.title,
    body: view.body,
  };
}
