import { escapeHtml, layout, type NotificationTemplate } from "./types";

/**
 * A bot is waiting for someone to approve a tool call. The payload holds the
 * bot's display name, the server and tool, and the conversation — never the
 * call's arguments, which the inbox shows to people who may read the bot.
 * @param payload - `{ approvalId, botName, server, tool, conversationId, conversationTitle }`.
 * @param appUrl - The frontend's origin.
 * @returns Both renderings.
 */
export const approvalRequested: NotificationTemplate = (payload, appUrl) => {
  const bot = String(payload.botName ?? "A bot");
  const call = `${String(payload.server ?? "")}/${String(payload.tool ?? "")}`;
  const where = payload.conversationTitle
    ? `in "${String(payload.conversationTitle)}"`
    : `in conversation #${String(payload.conversationId ?? "")}`;
  const url = `${appUrl}/approvals/${String(payload.approvalId ?? "")}`;
  const title = `${bot} wants to run ${call}`;
  const body = `It is waiting for approval ${where}.`;
  return {
    title,
    body,
    subject: `Approval needed: ${bot} wants to run ${call}`,
    text: `${title}. ${body}\n\nApprove or deny it: ${url}\n`,
    html: layout({
      heading: title,
      bodyHtml: `<p style="margin:0;">${escapeHtml(body)}</p>`,
      actionLabel: "Review the call",
      actionUrl: url,
    }),
  };
};
