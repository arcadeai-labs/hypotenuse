import { Navigate, useLocation, useParams } from "react-router-dom";
import {
  botIndexTarget,
  findBotSection,
  useBotSection,
} from "../../components/bots/sections";
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

/**
 * `/bots/:botId` — redirects to a section, keeping the query string, so a
 * platform install's result still reaches the Channels cards that read it.
 * @returns The redirect.
 */
export function BotIndexRedirect() {
  const { search } = useLocation();
  return <Navigate to={botIndexTarget(search)} replace />;
}
