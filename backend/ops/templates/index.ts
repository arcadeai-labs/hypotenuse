import { approvalRequested } from "./approval-requested";
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
 * Each kind arrives with the feature that raises it (a help request, an approval waiting on a person), as
 * one file plus one entry here, and `deliverNotification` never learns another
 * name. A row whose template is absent — one written by an older deploy, say —
 * renders generically rather than failing delivery, because a notification
 * nobody can render is still a notification somebody was meant to get.
 */
export const NOTIFICATION_TEMPLATES: Record<string, NotificationTemplate> = {
  "approval-requested": approvalRequested,
};

/** The template names, for the tests that assert every one is registered. */
export const NOTIFICATION_TEMPLATE_NAMES = Object.keys(NOTIFICATION_TEMPLATES);
