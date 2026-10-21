import { escapeHtml, layout, type NotificationTemplate } from "./types";

/**
 * `@hypotenuse` was uninstalled from a Linear workspace from Linear's side
 * (`OAuthApp` / `revoked`), so the project is no longer connected. Sent to the
 * project's admins by the webhook processor.
 * @param payload - `{ workspaceName }`.
 * @param appUrl - The frontend's origin.
 * @returns Both renderings.
 */
export const linearRevoked: NotificationTemplate = (payload, appUrl) => {
  const workspace = String(payload.workspaceName ?? "your Linear workspace");
  const title = `Linear disconnected: ${workspace}`;
  const body = `@hypotenuse was uninstalled from ${workspace} in Linear, so it no longer answers there. An admin can connect it again in Settings → Integrations.`;
  const url = `${appUrl}/settings/integrations`;
  return {
    title,
    body,
    subject: `[Hypotenuse] ${title}`,
    text: `${body}\n\n${url}`,
    html: layout({
      heading: title,
      bodyHtml: `<p>${escapeHtml(body)}</p>`,
      actionLabel: "Open Settings → Integrations",
      actionUrl: url,
    }),
  };
};
