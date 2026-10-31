import type { BotList } from "@backend/actions/bot/bot-list";
import type { ActionResponse } from "keryx";
import { Link } from "react-router-dom";
import { useRead } from "../../components/bots/data";
import { ListLayout } from "../../components/layouts/ListLayout";
import { SkeletonBlocks } from "../../components/SkeletonBlocks";
import { useAuth } from "../../context/AuthContext";
import { Alert, Avatar, Chip, ListGroup, ListRow } from "../../ui";
import { botAvatarSrc } from "../../utils/avatar";
import { API_URL } from "../../utils/client";

/**
 * `/chat` — pick a bot to chat with: the active project's bots the person
 * may read, each opening its own chat.
 * @returns The page.
 */
export function ChatIndexPage() {
  const { activeProjectId } = useAuth();
  const bots = useRead<ActionResponse<BotList>>(
    activeProjectId === null
      ? null
      : `/project/${activeProjectId}/bots?limit=100`,
  );

  return (
    <ListLayout title="Chat">
      <div className="bots-page" data-testid="chat-index-page">
        {!activeProjectId ? (
          <Alert variant="info" data-testid="no-project">
            Choose a project to chat with its bots.
          </Alert>
        ) : (
          <>
            {bots.error && (
              <Alert variant="danger" data-testid="chat-index-error">
                {bots.error}
              </Alert>
            )}
            {bots.data === null && !bots.error && (
              <SkeletonBlocks count={3} testId="chat-index-skeleton" />
            )}
            {bots.data?.bots.length === 0 && (
              <div className="shell-empty" data-testid="chat-index-empty">
                No bots you can see yet. Make one under{" "}
                <Link to="/bots">Bots</Link>.
              </div>
            )}
            {bots.data && bots.data.bots.length > 0 && (
              <ListGroup
                title="Choose a bot"
                count={bots.data.pagination.total}
                data-testid="chat-index-list"
              >
                {bots.data.bots.map((bot) => (
                  <ListRow
                    key={bot.id}
                    as={Link}
                    to={`/bots/${bot.id}/chat`}
                    data-testid={`chat-index-row-${bot.slug}`}
                    title={
                      <span className="bot-row-title">
                        <Avatar
                          name={bot.name}
                          src={botAvatarSrc(API_URL, bot.avatarUrl)}
                          bot
                          size={20}
                        />
                        {bot.description && (
                          <span className="bot-row-description">
                            {bot.description}
                          </span>
                        )}
                      </span>
                    }
                    trailing={
                      !bot.enabled && <Chip tone="subtle">Disabled</Chip>
                    }
                  />
                ))}
              </ListGroup>
            )}
          </>
        )}
      </div>
    </ListLayout>
  );
}
