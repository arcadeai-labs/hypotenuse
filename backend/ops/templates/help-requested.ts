import { escapeHtml, layout, type NotificationTemplate } from "./types";

/**
 * A bot escalated to a person: it needs an answer it could not get in its
 * channel. The payload carries the bot's name, the question, and the
 * urgency; the question is shown because the recipients are exactly the
 * people who may read the bot.
 * @param payload - `{ helpRequestId, botName, question, urgency, conversationId }`.
 * @param appUrl - The frontend's origin.
 * @returns Both renderings.
 */
export const helpRequested: NotificationTemplate = (payload, appUrl) => {
  const bot = String(payload.botName ?? "A bot");
  const question = String(payload.question ?? "");
  const urgent = payload.urgency === "high" ? "Urgent: " : "";
  const url = `${appUrl}/help/${String(payload.helpRequestId ?? "")}`;
  const title = `${urgent}${bot} is asking for help`;
  return {
    title,
    body: question,
    subject: `${urgent}${bot} needs an answer from the team`,
    text: `${title}:\n\n${question}\n\nAnswer it: ${url}\n`,
    html: layout({
      heading: title,
      bodyHtml: `<p style="margin:0;">${escapeHtml(question)}</p>`,
      actionLabel: "Answer",
      actionUrl: url,
    }),
  };
};
