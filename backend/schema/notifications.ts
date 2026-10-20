import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { projects } from "./projects";
import { users } from "./users";

/** The delivery channels a notification can take. */
export const NOTIFICATION_CHANNELS = ["browser", "email"] as const;

/** One of {@link NOTIFICATION_CHANNELS}. */
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** Every state a notification row can be in. */
export const NOTIFICATION_STATUSES = ["pending", "sent", "failed"] as const;

/** One of {@link NOTIFICATION_STATUSES}. */
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

/**
 * One thing to tell one person, through one channel.
 *
 * **A table rather than a direct send**, because the things that raise a
 * notification are machine paths — a webhook being processed, a runner going
 * quiet — whose latency must not become an SMTP handshake and whose failure
 * mode must not become a mail server's. So the caller inserts rows and returns,
 * `notifications:dispatch` delivers them, and a transient outage costs a retry.
 *
 * **Every recipient gets both a `browser` row and an `email` row.** They are not
 * alternatives. The browser row *is* the in-app inbox item — unread until
 * `readAt` is set — and its broadcast is an accelerant on top of that, not the
 * delivery. Someone whose tab was closed for the whole exchange still finds the
 * unread badge waiting, so nothing here depends on a socket having been open.
 *
 * `payload` must be **safe by construction**: it is written once and read by a
 * template, with no filtering step in between. Nothing that could hold a secret
 * — a token, a credential's name, a prompt — belongs in it.
 *
 * `linkPath` is stored rather than derived at render time, so changing a
 * template can never change where an already-sent notification points.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** The recipient. Read state is per person, so there is one row each. */
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** `browser` | `email`. */
    channel: text("channel").notNull(),
    /** Which template renders it — a key of `NOTIFICATION_TEMPLATES`. */
    template: text("template").notNull(),
    /** Everything the template needs, already scrubbed. */
    payload: jsonb("payload").notNull().$type<Record<string, unknown>>(),
    /** `pending` | `sent` | `failed`. */
    status: text("status").notNull().default("pending"),
    /** How many delivery attempts have been made. */
    attempts: integer("attempts").notNull().default(0),
    /** When the dispatcher may next try. Backoff moves it out. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    /** Why the last attempt failed, when one did. */
    error: text("error"),
    /** When the recipient read it. `browser` rows only; drives the unread badge. */
    readAt: timestamp("read_at", { withTimezone: true }),
    /** Where clicking it goes, e.g. `/settings/members`. */
    linkPath: text("link_path").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => ({
    // The dispatcher's only query, every tick: what is due.
    dispatchIndex: index("notifications_dispatch_idx").on(
      t.status,
      t.nextAttemptAt,
    ),
    // The unread badge. Polled on every page load and again every sixty
    // seconds, per open tab, so it must be an index scan rather than a count
    // over a user's whole history.
    unreadIndex: index("notifications_unread_idx").on(
      t.userId,
      t.channel,
      t.readAt,
    ),
  }),
);

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
