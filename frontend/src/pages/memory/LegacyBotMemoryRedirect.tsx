import { Navigate, useLocation, useParams } from "react-router-dom";

/**
 * `/bots/:botId/memory`, `/bots/:botId/memory/:channelId`, and its
 * `/document` — the addresses a bot's memory had when each bot kept its own
 * memory of a channel. A channel's memory is now shared by every bot working
 * there, so each goes to the same place in the one explorer, keeping the
 * query (a search, a document's path and version).
 * @param props.document - Whether this is a document's address.
 * @returns The redirect.
 */
export function LegacyBotMemoryRedirect({
  document = false,
}: {
  document?: boolean;
}) {
  const { channelId } = useParams();
  const { search } = useLocation();
  const base = channelId ? `/memory/channels/${channelId}` : "/memory";
  return (
    <Navigate to={`${base}${document ? "/document" : ""}${search}`} replace />
  );
}
