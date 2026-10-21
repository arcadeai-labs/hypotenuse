import {
  index,
  integer,
  pgTable,
  serial,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { TriggerType } from "./integrations";
import { runners } from "./runners";

/** The kinds of scope a runner can subscribe to. */
export const SUBSCRIPTION_KINDS = ["team", "project", "label"] as const;

/** One of {@link SUBSCRIPTION_KINDS}. */
export type SubscriptionKind = (typeof SUBSCRIPTION_KINDS)[number];

/**
 * One trigger scope a runner accepts work from — a team key, a project id, or
 * a label name (lowercased) — replaced wholesale whenever the runner's
 * reported capabilities change. A table rather than a jsonb column because
 * routing reads it by value across every runner in a project.
 *
 * **No rows of a kind means every value of that kind**; kinds intersect.
 */
export const runnerSubscriptions = pgTable(
  "runner_subscriptions",
  {
    id: serial("id").primaryKey(),
    runnerId: integer("runner_id")
      .notNull()
      .references(() => runners.id, { onDelete: "cascade" }),
    type: text("type").$type<TriggerType>().notNull(),
    kind: text("kind").$type<SubscriptionKind>().notNull(),
    value: text("value").notNull(),
  },
  (t) => ({
    uniqueValue: uniqueIndex("runner_subscriptions_unique_idx").on(
      t.runnerId,
      t.type,
      t.kind,
      t.value,
    ),
    // Routing: which runners accept this team / label.
    valueIndex: index("runner_subscriptions_value_idx").on(
      t.type,
      t.kind,
      t.value,
    ),
  }),
);

export type RunnerSubscription = typeof runnerSubscriptions.$inferSelect;
export type NewRunnerSubscription = typeof runnerSubscriptions.$inferInsert;
