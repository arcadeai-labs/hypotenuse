import {
  CONVERSATION_STATUS,
  CONVERSATION_STATUS_ORDER,
  type ConversationStatusKey,
  conversationStatusKey,
} from "../../../../design/states";
import {
  BotBadge,
  ListGroup,
  ListRow,
  PlatformChip,
  StatusGlyph,
} from "../../ui";
import type { ConversationSummary } from "./types";

/** The heading each group of the list carries. */
const GROUP_TITLES: Record<string, string> = {
  person: "Waiting for a person",
  working: "Working",
  system: "Waiting on work",
  hibernating: "Hibernating",
  ended: "Ended",
};

/**
 * Which group a status falls in: anything that needs a person comes first.
 * @param key - The flattened status.
 * @returns The group id.
 */
function groupOf(key: ConversationStatusKey): string {
  const glyph = CONVERSATION_STATUS[key].glyph;
  if (glyph === "waiting-person") return "person";
  if (glyph === "waiting-system") return "system";
  if (key.startsWith("ended:")) return "ended";
  return key;
}

/**
 * Conversations grouped by state — waiting for a person first, ended last —
 * one 36px row each: glyph, channel, title, the bot, and the platform.
 * @param props - The conversations.
 * @returns The grouped list.
 */
export function ConversationList({
  conversations,
}: {
  conversations: ConversationSummary[];
}) {
  const sorted = [...conversations].sort(
    (a, b) =>
      CONVERSATION_STATUS_ORDER.indexOf(conversationStatusKey(a.status)) -
      CONVERSATION_STATUS_ORDER.indexOf(conversationStatusKey(b.status)),
  );
  const groups = new Map<string, ConversationSummary[]>();
  for (const c of sorted) {
    const id = groupOf(conversationStatusKey(c.status));
    groups.set(id, [...(groups.get(id) ?? []), c]);
  }
  return (
    <div className="conversation-list" data-testid="conversation-list">
      {[...groups].map(([id, rows]) => (
        <ListGroup
          key={id}
          title={GROUP_TITLES[id] ?? id}
          count={rows.length}
          defaultCollapsed={id === "ended"}
        >
          {rows.map((c) => (
            <ListRow
              key={c.id}
              glyph={<StatusGlyph {...c.status} />}
              identifier={c.identifier ?? c.channel}
              title={c.title}
              trailing={
                <>
                  <BotBadge name={c.bot} />
                  <PlatformChip platform={c.platform} />
                </>
              }
            />
          ))}
        </ListGroup>
      ))}
    </div>
  );
}
