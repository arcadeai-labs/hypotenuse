import { escapeHtml, layout, type NotificationTemplate } from "./types";

/**
 * Linear refused an integration's refresh token, so the agent can no longer
 * act in that workspace until an admin reconnects it. Sent to the project's
 * admins by `refreshIntegrationTokens`.
 * @param payload - `{ workspaceName }`.
 * @param appUrl - The frontend's origin.
 * @returns Both renderings.
 */
export const linearRefreshFailed: NotificationTemplate = (payload, appUrl) => {
  const workspace = String(payload.workspaceName ?? "your Linear workspace");
  const title = `Reconnect Linear: ${workspace}`;
  const body = `Linear stopped accepting Hypotenuse's credentials for ${workspace}, so @hypotenuse cannot answer there until an admin reconnects it in Settings → Integrations.`;
  const url = `${appUrl}/settings/integrations`;
  return {
    title,
    body,
    subject: `[Hypotenuse] ${title}`,
    text: `${body}\n\n${url}`,
    html: layout({
      heading: title,
      bodyHtml: `<p>${escapeHtml(body)}</p>`,
      actionLabel: "Reconnect Linear",
      actionUrl: url,
    }),
  };
};
