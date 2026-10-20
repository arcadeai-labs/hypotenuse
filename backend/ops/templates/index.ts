import type { NotificationTemplate } from "./types";

export type {
  NotificationTemplate,
  RenderedNotification,
} from "./types";
export { escapeHtml, layout } from "./types";

/**
 * Every notification template, keyed by the string stored in
 * `notifications.template`.
 *
 * Empty until a feature raises its first notification: each kind arrives with
 * the feature that raises it, as one file plus one entry here, and
 * `deliverNotification` never learns another name. A row whose template is
 * absent — one written by an older deploy, say — falls back to a generic
 * rendering rather than failing delivery, because a notification nobody can
 * render is still a notification somebody was meant to get.
 */
export const NOTIFICATION_TEMPLATES: Record<string, NotificationTemplate> = {};

/** The template names, for the tests that assert every one is registered. */
export const NOTIFICATION_TEMPLATE_NAMES = Object.keys(
  NOTIFICATION_TEMPLATES,
) as (keyof typeof NOTIFICATION_TEMPLATES)[];
