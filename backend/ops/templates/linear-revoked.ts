import { escapeHtml, layout, type NotificationTemplate } from "./types";

/**
 * `@hypotenuse` was uninstalled from a Linear workspace from Linear's side
 * (`OAuthApp` / `revoked`), so the project is no longer connected. Sent to the
 * project's admins by the webhook processor.
 * @param payload - `{ organizationName }`.
 * @param appUrl - The frontend's origin.
 * @returns Both renderings.
 */
export const linearRevoked: NotificationTemplate = (payload, appUrl) => {
  const workspace = String(payload.organizationName ?? "your Linear workspace");
  const title = `Linear disconnected: ${workspace}`;
  const body = `@hypotenuse was uninstalled from ${workspace} in Linear, so it no longer answers there. An admin can connect it again in Settings → Linear.`;
  const url = `${appUrl}/settings/linear`;
  return {
    title,
    body,
    subject: `[Hypotenuse] ${title}`,
    text: `${body}\n\n${url}`,
    html: layout({
      heading: title,
      bodyHtml: `<p>${escapeHtml(body)}</p>`,
      actionLabel: "Open Settings → Linear",
      actionUrl: url,
    }),
  };
};
