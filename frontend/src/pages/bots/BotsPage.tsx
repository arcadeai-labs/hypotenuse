import type { BotList } from "@backend/actions/bot/bot-list";
import type { ActionResponse } from "keryx";
import { MessageCircle, Plus } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { useModelAliases, useRead } from "../../components/bots/data";
import { MissingAliasesBanner } from "../../components/bots/MissingAliasesBanner";
import { GatedButton } from "../../components/GatedButton";
import { ListLayout } from "../../components/layouts/ListLayout";
import { SkeletonBlocks } from "../../components/SkeletonBlocks";
import { useAuth } from "../../context/AuthContext";
import { useMay } from "../../hooks/useMay";
import { Alert, Avatar, Chip, ListGroup, ListRow } from "../../ui";
import { botAvatarSrc } from "../../utils/avatar";
import { API_URL } from "../../utils/client";

/**
 * `/bots` — the active project's bots that the person may read: each with its
 * avatar and bot badge, what it is for, the model names it uses, and whether
 * it is enabled, with a Chat link beside each row. A bot whose read list
 * leaves the person out is not here at all; the server leaves it out of the
 * answer.
 *
 * While the project lacks a required model name, a banner says no bot can
 * run yet.
 * @returns The page.
 */
export function BotsPage() {
  const { activeProjectId, activeOrganizationId } = useAuth();
  const { reason } = useMay();
  const navigate = useNavigate();
  const bots = useRead<ActionResponse<BotList>>(
    activeProjectId === null
      ? null
      : `/project/${activeProjectId}/bots?limit=100`,
  );
  const aliases = useModelAliases(activeProjectId);
  const createDenied = reason("bot:create");
  const chatDenied = reason("conversation:create");

  return (
    <ListLayout
      title="Bots"
      actions={
        <GatedButton
          size="sm"
          variant="primary"
          deniedReason={
            activeProjectId ? createDenied : "Choose a project first."
          }
          onClick={() => navigate("/bots/new")}
          data-testid="new-bot"
        >
          <Plus size={14} aria-hidden="true" /> New bot
        </GatedButton>
      }
    >
      <div className="bots-page" data-testid="bots-page">
        {!activeProjectId ? (
          <Alert variant="info" data-testid="no-project">
            {activeOrganizationId ? (
              <>
                This organization shows you no projects yet. See the{" "}
                <Link to="/organization/projects">organization's projects</Link>
                .
              </>
            ) : (
              "Choose an organization, then a project, to see its bots."
            )}
          </Alert>
        ) : (
          <>
            {aliases.data && (
              <MissingAliasesBanner
                missing={aliases.data.missingRequired}
                canSet={reason("model-alias:create") === undefined}
              />
            )}
            {bots.error && (
              <Alert variant="danger" data-testid="bots-error">
                {bots.error}
              </Alert>
            )}
            {bots.data === null && !bots.error && (
              <SkeletonBlocks
                count={3}
                testId="bots-skeleton"
                label="Loading bots"
              />
            )}
            {bots.data?.bots.length === 0 && (
              <div className="shell-empty" data-testid="no-bots">
                No bots you can see yet. A bot is a persona, the models it uses,
                and who may read and change it; make one with{" "}
                <strong>New bot</strong>.
              </div>
            )}
            {bots.data && bots.data.bots.length > 0 && (
              <ListGroup
                title="Bots"
                count={bots.data.pagination.total}
                data-testid="bot-list"
              >
                {bots.data.bots.map((bot) => (
                  <div key={bot.id} className="bot-row-with-action">
                    <ListRow
                      as={Link}
                      to={`/bots/${bot.id}`}
                      data-testid={`bot-row-${bot.slug}`}
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
                        <>
                          <Chip title="Main model name">
                            <span className="mono">{bot.modelAlias}</span>
                          </Chip>
                          <Chip title="Fast model name">
                            <span className="mono">{bot.fastModelAlias}</span>
                          </Chip>
                          <Chip
                            tone={bot.enabled ? "accent" : "subtle"}
                            data-testid={`bot-enabled-${bot.slug}`}
                          >
                            {bot.enabled ? "Enabled" : "Disabled"}
                          </Chip>
                        </>
                      }
                    />
                    <Link
                      to={`/bots/${bot.id}/chat`}
                      className="bot-row-chat"
                      aria-label={`Chat with ${bot.name}`}
                      title={chatDenied ?? `Chat with ${bot.name}`}
                      aria-disabled={chatDenied ? true : undefined}
                      onClick={(e) => {
                        if (chatDenied) e.preventDefault();
                      }}
                      data-testid={`bot-chat-${bot.slug}`}
                    >
                      <MessageCircle size={14} aria-hidden="true" /> Chat
                    </Link>
                  </div>
                ))}
              </ListGroup>
            )}
          </>
        )}
      </div>
    </ListLayout>
  );
}
