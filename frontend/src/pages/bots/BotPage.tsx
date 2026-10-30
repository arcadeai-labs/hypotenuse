import type { BotView } from "@backend/actions/bot/bot-view";
import type { ActionResponse } from "keryx";
import { Brain, MessagesSquare } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { AccessSection } from "../../components/bots/AccessSection";
import { ApprovalSettingsSection } from "../../components/bots/ApprovalSettingsSection";
import { BudgetSection } from "../../components/bots/BudgetSection";
import { CallbackSecretSection } from "../../components/bots/CallbackSecretSection";
import {
  type Bot,
  type BotStanding,
  useAccessTags,
  useModelAliases,
} from "../../components/bots/data";
import { IdentitySection } from "../../components/bots/IdentitySection";
import { MemorySection } from "../../components/bots/MemorySection";
import { MissingAliasesBanner } from "../../components/bots/MissingAliasesBanner";
import { ModelSection } from "../../components/bots/ModelSection";
import { ToolsSection } from "../../components/bots/ToolsSection";
import { UnavailableSections } from "../../components/bots/UnavailableSections";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { GatedButton } from "../../components/GatedButton";
import { LoadingLabel } from "../../components/LoadingLabel";
import { DetailLayout } from "../../components/layouts/DetailLayout";
import { useAuth } from "../../context/AuthContext";
import { useMay } from "../../hooks/useMay";
import {
  Alert,
  Avatar,
  Button,
  Chip,
  PropertiesPanel,
  Property,
} from "../../ui";
import { botAvatarSrc } from "../../utils/avatar";
import { botWriteDenied } from "../../utils/bots";
import { API_URL, apiFetch } from "../../utils/client";
import { describeAccess } from "../../utils/models";

/** The page's view of its bot. */
type Loaded =
  | { state: "loading" }
  | { state: "missing"; message: string }
  | { state: "loaded"; bot: Bot; standing: BotStanding };

/**
 * `/bots/:botId` — one bot: who it is, which models it uses, who may read
 * and change it, its budget, how fast its memory fades, its MCP servers and
 * what runs without asking, and who decides what waits, each section saving
 * on its own; then the parts of a bot this page does not configure
 * yet, disabled. The properties panel says the same at a glance, and the
 * header links to its conversations and its memory.
 *
 * Every control is gated twice, both by the server's word: `can()` on the
 * action, and the bot's own write list, which `bot:view` answers as
 * `standing.canWrite`. A bot the person may not read is the same "not found"
 * as one that does not exist.
 * @returns The page.
 */
export function BotPage() {
  const { botId } = useParams();
  const { activeProjectId } = useAuth();
  const { reason } = useMay();
  const navigate = useNavigate();
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const aliases = useModelAliases(activeProjectId);
  const tags = useAccessTags(activeProjectId);

  const load = useCallback(async () => {
    if (!activeProjectId || !botId) return;
    try {
      const res = await apiFetch<ActionResponse<BotView>>(
        `/project/${activeProjectId}/bot/${botId}`,
      );
      setLoaded({ state: "loaded", bot: res.bot, standing: res.standing });
    } catch (err) {
      setLoaded({
        state: "missing",
        message:
          err instanceof Error ? err.message : "Could not load this bot.",
      });
    }
  }, [activeProjectId, botId]);

  useEffect(() => {
    setLoaded({ state: "loading" });
    load();
  }, [load]);

  /**
   * Take an edit's answer as the page's bot.
   * @param answer - `bot:edit`'s answer.
   */
  const onSaved = useCallback(
    (answer: { bot: Bot; standing: BotStanding }) =>
      setLoaded({
        state: "loaded",
        bot: answer.bot,
        standing: answer.standing,
      }),
    [],
  );

  if (!activeProjectId) {
    return (
      <div className="page" data-testid="bot-page">
        <Alert variant="info" data-testid="no-project">
          Choose a project to see its bots.
        </Alert>
      </div>
    );
  }
  if (loaded.state === "loading") {
    return (
      <div className="page" data-testid="bot-page">
        <LoadingLabel block testId="bot-loading" label="Loading the bot" />
      </div>
    );
  }
  if (loaded.state === "missing") {
    return (
      <div className="page" data-testid="bot-page">
        <Alert variant="warning" data-testid="bot-missing">
          {loaded.message}. It may have been deleted, belong to another project,
          or be limited to tags you do not hold.{" "}
          <Link to="/bots">Back to bots</Link>
        </Alert>
      </div>
    );
  }

  const { bot, standing } = loaded;
  const editDenied = botWriteDenied(reason("bot:edit"), standing);
  const deleteDenied = botWriteDenied(reason("bot:delete"), standing);
  const mainAlias = aliases.data?.modelAliases.find(
    (a) => a.name === bot.modelAlias,
  );

  /** Delete the bot, then go back to the list. */
  async function onDelete() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await apiFetch(`/project/${activeProjectId}/bot/${bot.id}`, {
        method: "DELETE",
      });
      navigate("/bots");
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : "Could not delete it.",
      );
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  const sectionProps = {
    projectId: activeProjectId,
    bot,
    denied: editDenied,
    onSaved,
  };

  return (
    <div className="bot-page" data-testid="bot-page">
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
            <span data-testid="bot-title">{bot.name}</span>
          </span>
        }
        actions={
          <>
            <Button
              onClick={() => navigate(`/bots/${bot.id}/conversations`)}
              size="sm"
              variant="secondary"
              data-testid="bot-conversations"
            >
              <MessagesSquare size={14} aria-hidden="true" /> Conversations
            </Button>
            <Button
              onClick={() => navigate(`/bots/${bot.id}/memory`)}
              size="sm"
              variant="secondary"
              data-testid="bot-memory-explorer"
            >
              <Brain size={14} aria-hidden="true" /> Memory
            </Button>
            <GatedButton
              size="sm"
              variant="outline-danger"
              deniedReason={deleteDenied}
              onClick={() => setConfirmDelete(true)}
              data-testid="delete-bot"
            >
              Delete bot
            </GatedButton>
          </>
        }
        properties={
          <PropertiesPanel data-testid="bot-properties">
            <Property label="Bot">
              <Avatar
                name={bot.name}
                src={botAvatarSrc(API_URL, bot.avatarUrl)}
                bot
                size={20}
              />
            </Property>
            <Property label="Status">
              <Chip tone={bot.enabled ? "accent" : "subtle"}>
                {bot.enabled ? "Enabled" : "Disabled"}
              </Chip>
            </Property>
            <Property label="Slug">
              <span className="mono">{bot.slug}</span>
            </Property>
            <Property label="Model">
              <span className="mono">{bot.modelAlias}</span>
              <span className="text-meta bot-property-detail">
                {mainAlias
                  ? `${mainAlias.modelId} via ${mainAlias.connectionName}`
                  : "not set yet"}
              </span>
            </Property>
            <Property label="Fast model">
              <span className="mono">{bot.fastModelAlias}</span>
            </Property>
            <Property label="Memory fades">
              <span className="tabular" data-testid="bot-property-memory">
                {bot.memoryChannelHalfLifeDays}d channel ·{" "}
                {bot.memoryProjectHalfLifeDays}d project
              </span>
            </Property>
            <Property label="Who may read">
              <span data-testid="bot-property-read">
                {describeAccess(bot.accessRead)}
              </span>
            </Property>
            <Property label="Who may change">
              <span data-testid="bot-property-write">
                {describeAccess(bot.accessWrite)}
              </span>
            </Property>
            <Property label="Asks for help">
              {bot.helpNotifyTag ?? "Project admins"}
            </Property>
            <Property label="Approvals">
              <span data-testid="bot-property-approvals">
                {bot.approverTag
                  ? `Its writers and ${bot.approverTag}`
                  : "Its writers"}
              </span>
            </Property>
            <Property label="You">
              <span data-testid="bot-property-standing">
                {editDenied ? "Can read" : "Can read and change"}
              </span>
            </Property>
            <Property label="Created">
              <span className="tabular">
                {new Date(bot.createdAt).toLocaleDateString()}
              </span>
            </Property>
          </PropertiesPanel>
        }
      >
        <div className="bot-page-sections">
          {aliases.data && (
            <MissingAliasesBanner
              missing={aliases.data.missingRequired}
              canSet={reason("model-alias:create") === undefined}
            />
          )}
          {deleteError && (
            <Alert
              variant="danger"
              dismissible
              onClose={() => setDeleteError(null)}
              data-testid="delete-bot-error"
            >
              {deleteError}
            </Alert>
          )}
          {editDenied && (
            <Alert variant="info" data-testid="bot-read-only">
              {editDenied}
            </Alert>
          )}
          <IdentitySection {...sectionProps} />
          <ModelSection {...sectionProps} aliases={aliases.data} />
          <AccessSection {...sectionProps} tags={tags} />
          <BudgetSection {...sectionProps} />
          <MemorySection {...sectionProps} />
          <ToolsSection
            projectId={activeProjectId}
            bot={bot}
            denied={botWriteDenied(reason("bot-mcp-server:set"), standing)}
          />
          <ApprovalSettingsSection {...sectionProps} tags={tags} />
          <CallbackSecretSection
            {...sectionProps}
            denied={botWriteDenied(
              reason("bot:rotate-callback-secret"),
              standing,
            )}
          />
          <UnavailableSections />
        </div>
      </DetailLayout>
      <ConfirmDialog
        show={confirmDelete}
        title={`Delete ${bot.name}?`}
        confirmLabel="Delete bot"
        busy={deleting}
        onConfirm={onDelete}
        onCancel={() => setConfirmDelete(false)}
        testId="delete-bot"
      >
        Its persona, settings, and avatar are deleted, and it cannot be undone.
      </ConfirmDialog>
    </div>
  );
}
