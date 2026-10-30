import type { BotView } from "@backend/actions/bot/bot-view";
import type { ActionResponse } from "keryx";
import { useCallback, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useRead } from "../../components/bots/data";
import { LoadingLabel } from "../../components/LoadingLabel";
import { DetailLayout } from "../../components/layouts/DetailLayout";
import type { PromptSectionsResponse } from "../../components/prompts/data";
import { NewSectionForm } from "../../components/prompts/NewSectionForm";
import { PromptPreviewPane } from "../../components/prompts/PromptPreviewPane";
import { PromptSectionCard } from "../../components/prompts/PromptSectionCard";
import { useAuth } from "../../context/AuthContext";
import { useMay } from "../../hooks/useMay";
import { useProjectStanding } from "../../hooks/useProjectStanding";
import { Alert, Card } from "../../ui";
import { botWriteDenied } from "../../utils/bots";
import { assemblyOrder, projectSectionDenied } from "../../utils/prompts";

/** Enough sections for any prompt that fits a budget. */
const SECTIONS_LIMIT = 100;

/**
 * `/bots/:botId/prompt` — a bot's system prompt, section by section, in the
 * order it is assembled: its *Identity*, the project's sections every bot
 * includes, then its own, the contextual ones last. Each section edits on
 * its own, with its versions, a diff, and a revert; beside them, the prompt
 * the bot would be sent, assembled by the server, with a sample message to
 * see which contextual sections it brings in.
 *
 * A bot's own sections are gated by the bot's write list (`standing.canWrite`
 * from `bot:view`); the project's by admin standing. Both are the server's
 * answers; the page re-implements neither.
 * @returns The page.
 */
export function BotPromptPage() {
  const { botId } = useParams();
  const { activeProjectId } = useAuth();
  const { reason } = useMay();
  const projectStanding = useProjectStanding();
  // Bumped after every change, so the preview assembles again.
  const [version, setVersion] = useState(0);
  const base = activeProjectId ? `/project/${activeProjectId}` : null;
  const bot = useRead<ActionResponse<BotView>>(
    base && botId ? `${base}/bot/${botId}` : null,
  );
  const botSections = useRead<PromptSectionsResponse>(
    base && botId
      ? `${base}/prompt-sections?botId=${botId}&limit=${SECTIONS_LIMIT}`
      : null,
  );
  const projectSections = useRead<PromptSectionsResponse>(
    base ? `${base}/prompt-sections?limit=${SECTIONS_LIMIT}` : null,
  );

  const reloadBot = botSections.reload;
  const reloadProject = projectSections.reload;
  const onChanged = useCallback(async () => {
    await Promise.all([reloadBot(), reloadProject()]);
    setVersion((v) => v + 1);
  }, [reloadBot, reloadProject]);

  if (!activeProjectId) {
    return (
      <div className="page" data-testid="bot-prompt-page">
        <Alert variant="info" data-testid="no-project">
          Choose a project to see its bots.
        </Alert>
      </div>
    );
  }
  if (bot.error) {
    return (
      <div className="page" data-testid="bot-prompt-page">
        <Alert variant="warning" data-testid="bot-missing">
          {bot.error}. It may have been deleted, belong to another project, or
          be limited to tags you do not hold.{" "}
          <Link to="/bots">Back to bots</Link>
        </Alert>
      </div>
    );
  }
  if (!bot.data) {
    return (
      <div className="page" data-testid="bot-prompt-page">
        <LoadingLabel
          block
          testId="bot-prompt-loading"
          label="Loading the prompt"
        />
      </div>
    );
  }

  const { bot: theBot, standing } = bot.data;
  const botDenied = botWriteDenied(reason("prompt-section:edit"), standing);
  const createDenied = botWriteDenied(
    reason("prompt-section:create"),
    standing,
  );
  const projectDenied = projectSectionDenied(
    reason("prompt-section:edit"),
    projectStanding,
  );
  const ordered =
    botSections.data && projectSections.data
      ? assemblyOrder(
          projectSections.data.promptSections,
          botSections.data.promptSections,
        )
      : null;

  return (
    <div className="bot-prompt-page" data-testid="bot-prompt-page">
      <DetailLayout
        title={
          <span className="bot-page-title">
            <Link to="/bots" className="shell-page-crumb">
              Bots
            </Link>
            <span className="shell-page-subtitle" aria-hidden="true">
              {" "}
              /{" "}
            </span>
            <Link to={`/bots/${theBot.id}`} className="shell-page-crumb">
              {theBot.name}
            </Link>
            <span className="shell-page-subtitle" aria-hidden="true">
              {" "}
              /{" "}
            </span>
            <span data-testid="bot-prompt-title">Prompt</span>
          </span>
        }
      >
        <div className="prompt-page">
          <div className="prompt-page-sections">
            <p className="text-muted mb-0">
              What {theBot.name} is told before every step, in the order it is
              told. Sections that load <strong>always</strong> are in every
              step; <strong>contextual</strong> ones only when one of their
              keywords comes up, and they are dropped first when the prompt is
              over its budget of{" "}
              <span className="tabular">
                {theBot.promptBudgetTokens.toLocaleString()}
              </span>{" "}
              tokens (set on <Link to={`/bots/${theBot.id}`}>its page</Link>).
              After the sections come its goals, its skills, what its tools can
              do, and the fixed rules every bot follows.
            </p>
            {botDenied && (
              <Alert variant="info" data-testid="bot-read-only">
                {botDenied}
              </Alert>
            )}
            {(botSections.error || projectSections.error) && (
              <Alert variant="danger" data-testid="prompt-sections-error">
                {botSections.error ?? projectSections.error}
              </Alert>
            )}
            {ordered === null && !botSections.error && (
              <LoadingLabel
                block
                testId="prompt-sections-loading"
                label="Loading its sections"
              />
            )}
            <div className="prompt-section-list" data-testid="prompt-sections">
              {ordered?.map((section, i) => (
                <PromptSectionCard
                  key={section.id}
                  projectId={activeProjectId}
                  section={section}
                  place={i + 1}
                  denied={
                    section.scope === "project" ? projectDenied : botDenied
                  }
                  onChanged={onChanged}
                />
              ))}
            </div>
            <Card data-testid="prompt-new-card">
              <Card.Header as="h2">Add a section</Card.Header>
              <Card.Body>
                <p className="text-muted">
                  A section of {theBot.name}'s own. A section every bot in the
                  project includes is added in{" "}
                  <Link to="/settings/prompt-sections">
                    Settings → Prompt sections
                  </Link>
                  .
                </p>
                <NewSectionForm
                  projectId={activeProjectId}
                  botId={theBot.id}
                  denied={createDenied}
                  onCreated={onChanged}
                />
              </Card.Body>
            </Card>
          </div>
          <aside className="prompt-page-preview">
            <PromptPreviewPane
              projectId={activeProjectId}
              botId={theBot.id}
              version={version}
            />
          </aside>
        </div>
      </DetailLayout>
    </div>
  );
}
