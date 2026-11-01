import { useParams } from "react-router-dom";
import { findBotSection, useBotSection } from "../../components/bots/sections";
import { Alert } from "../../ui";

/**
 * `/bots/:botId/:section` — one page of the bot's settings, its cards drawn
 * from `BOT_SECTIONS` against the context the bot page provides.
 * @returns The section's cards, or a warning when there is no such section.
 */
export function BotSectionPage() {
  const { section: slug } = useParams();
  const ctx = useBotSection();
  const section = findBotSection(slug);
  if (!section) {
    return (
      <Alert variant="warning" data-testid="no-such-section">
        No such section.
      </Alert>
    );
  }
  return (
    <div className="bot-page-sections" data-testid={`bot-section-${slug}`}>
      {section.render(ctx)}
    </div>
  );
}
