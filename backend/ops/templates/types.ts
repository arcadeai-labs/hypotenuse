import { EMAIL_PALETTE } from "../../theme/email-palette";

/**
 * What a template produces: one shape covering both channels.
 *
 * `title` / `body` are what the browser channel broadcasts and the inbox
 * renders; `subject` / `text` / `html` are the email. One object rather than two
 * functions, because the two renderings of the same event have to agree, and the
 * cheapest way to make them agree is to write them next to each other.
 */
export interface RenderedNotification {
  /** The one-line heading, shown in the bell dropdown and the in-app toast. */
  title: string;
  /** The supporting sentence, shown beneath the title. */
  body: string;
  /** The email's `Subject:`. */
  subject: string;
  /** The plain-text email part. */
  text: string;
  /** The HTML email part. */
  html: string;
}

/**
 * A template: a pure function from a stored payload to both renderings.
 *
 * Plain TypeScript rather than a template engine, and inline styles rather than
 * a stylesheet, because mail clients strip most of what a real layout would do.
 * The colors come from {@link EMAIL_PALETTE}, generated from the design tokens,
 * so mail changes look when the app does.
 */
export type NotificationTemplate = (
  payload: Record<string, unknown>,
  /** The frontend's origin, so a template never has to know about config. */
  appUrl: string,
) => RenderedNotification;

/**
 * Escape a value for interpolation into an HTML email.
 *
 * Everything a template renders is attacker-adjacent: issue titles, comment
 * bodies, and whatever a coding agent wrote all come from outside this
 * application. This is the only thing standing between that and a recipient's
 * mail client.
 * @param value - The value to escape; non-strings are stringified first.
 * @returns HTML-safe text.
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Wrap a template's body in the shared chrome: the app's font stack and
 * palette, one button, no images.
 * @param parts.heading - The heading line.
 * @param parts.bodyHtml - Already-escaped HTML for the message body.
 * @param parts.actionLabel - The button's text.
 * @param parts.actionUrl - Where the button goes.
 * @returns A complete HTML document.
 */
export function layout(parts: {
  heading: string;
  bodyHtml: string;
  actionLabel: string;
  actionUrl: string;
}): string {
  const p = EMAIL_PALETTE;
  return [
    `<div style="font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:${p.background};color:${p.text};padding:24px;">`,
    `<div style="max-width:640px;margin:0 auto;background:${p.surface};border:1px solid ${p.border};border-radius:8px;padding:24px;">`,
    `<div style="font-size:12px;font-weight:600;color:${p.textMuted};margin-bottom:16px;">Hypotenuse</div>`,
    `<h1 style="font-size:18px;margin:0 0 16px;color:${p.text};">${escapeHtml(parts.heading)}</h1>`,
    parts.bodyHtml,
    `<p style="margin:24px 0 0;"><a href="${escapeHtml(parts.actionUrl)}" style="display:inline-block;background:${p.accent};color:${p.textOnAccent};border-radius:6px;padding:10px 18px;text-decoration:none;">${escapeHtml(parts.actionLabel)}</a></p>`,
    `<p style="margin:16px 0 0;font-size:12px;color:${p.textMuted};">${escapeHtml(parts.actionUrl)}</p>`,
    `</div></div>`,
  ].join("");
}
