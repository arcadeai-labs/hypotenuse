import type { BotView } from "@backend/actions/bot/bot-view";
import type { ConversationCreate } from "@backend/actions/conversation/conversation-create";
import type { ConversationList } from "@backend/actions/conversation/conversation-list";
import type { ActionResponse } from "keryx";
import { ExternalLink } from "lucide-react";
import { useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { useRead } from "../../components/bots/data";
import {
  useDashboardFrames,
  useReadableBotIds,
} from "../../components/dashboard/live";
import { stateDetail } from "../../components/dashboard/model";
import { ListLayout } from "../../components/layouts/ListLayout";
import { SkeletonBlocks } from "../../components/SkeletonBlocks";
import { relativeTime } from "../../components/shell/NotificationBell";
import { Composer } from "../../components/transcript/Composer";
import {
  conversationStateLabel,
  conversationStatus,
  conversationsQuery,
  conversationTitle,
  platformOf,
} from "../../components/transcript/model";
import { useAuth } from "../../context/AuthContext";
import { useMay } from "../../hooks/useMay";
import {
  Alert,
  BotBadge,
  Chip,
  ListGroup,
  ListRow,
  Pagination,
  PlatformChip,
  StatusGlyph,
} from "../../ui";
import { apiFetch } from "../../utils/client";

/** The state filters, in the order the chips are drawn. */
const STATE_FILTERS = [
  { value: "", label: "All" },
  { value: "working", label: "Working" },
  { value: "waiting", label: "Waiting" },
  { value: "hibernating", label: "Hibernating" },
  { value: "ended", label: "Ended" },
] as const;

/** What a waiting conversation can wait on, as filter chips. */
const WAITING_FILTERS = [
  { value: "", label: "Any wait" },
  { value: "answer", label: "Answer" },
  { value: "approval", label: "Approval" },
  { value: "help", label: "The team" },
  { value: "sandbox", label: "Sandbox" },
  { value: "timer", label: "Timer" },
] as const;

/** The platforms, as filter chips. */
const PLATFORM_FILTERS = [
  { value: "", label: "Every platform" },
  { value: "slack", label: "Slack" },
  { value: "linear", label: "Linear" },
  { value: "pylon", label: "Pylon" },
  { value: "web", label: "Chat" },
  { value: "api", label: "API" },
  { value: "webhook", label: "Webhook" },
] as const;

/**
 * `/conversations` and `/bots/:botId/conversations` — the project's
 * conversations, or one bot's, most recently active first: each row's state
 * glyph, where it lives, its title, how it ended, and when it last moved.
 * Chips filter by state, by what a waiting one waits on, and by platform
 * (the home page links here with `?botId=&waitingKind=`), and the list pages.
 * A row on Slack, Linear, or Pylon links to it there. The list follows its
 * bots' dashboard channels and re-reads when one says conversations changed.
 *
 * A bot's list also starts a conversation with it over the API channel:
 * `conversation:create` takes the first message, and the page opens the new
 * conversation.
 * @returns The page.
 */
export function ConversationsPage() {
  const { botId: botParam } = useParams();
  const [search] = useSearchParams();
  const botId = botParam
    ? Number(botParam)
    : search.get("botId")
      ? Number(search.get("botId"))
      : undefined;
  const { activeProjectId, activeOrganizationId } = useAuth();
  const { reason } = useMay();
  const navigate = useNavigate();
  const [state, setState] = useState(
    search.get("waitingKind") ? "waiting" : (search.get("state") ?? ""),
  );
  const [waitingKind, setWaitingKind] = useState(
    search.get("waitingKind") ?? "",
  );
  const [platform, setPlatform] = useState(search.get("platform") ?? "");
  const channelId = search.get("channelId")
    ? Number(search.get("channelId"))
    : undefined;
  const [chosen, setChosen] = useState({ key: "", page: 1 });
  const kind = state === "waiting" ? waitingKind : "";
  const filterKey = `${botId ?? ""}:${state}:${kind}:${platform}:${channelId ?? ""}`;
  // The page belongs to the filters it was chosen under, so new filters read page 1.
  const page = chosen.key === filterKey ? chosen.page : 1;

  const list = useRead<ActionResponse<ConversationList>>(
    activeProjectId === null
      ? null
      : `/project/${activeProjectId}/conversations${conversationsQuery({ botId, state, waitingKind: kind, channelType: platform, channelId }, page)}`,
  );
  const readable = useReadableBotIds(activeProjectId);
  useDashboardFrames(
    activeProjectId,
    botId ? readable.filter((id) => id === botId) : readable,
    ["conversations"],
    list.reload,
  );
  const bot = useRead<ActionResponse<BotView>>(
    activeProjectId !== null && botId
      ? `/project/${activeProjectId}/bot/${botId}`
      : null,
  );

  /**
   * Start a conversation with the bot and open it.
   * @param text - The first message.
   */
  async function onStart(text: string) {
    const res = await apiFetch<ActionResponse<ConversationCreate>>(
      `/project/${activeProjectId}/bot/${botId}/conversation`,
      { method: "PUT", body: JSON.stringify({ text }) },
    );
    navigate(`/conversations/${res.conversation.id}`);
  }

  const pages = list.data?.pagination.pages ?? 0;
  const botName = bot.data?.bot.name;
  const title = botId ? (
    <span className="bot-page-title">
      <Link to="/bots" className="shell-page-crumb">
        Bots
      </Link>
      <span className="shell-page-subtitle" aria-hidden="true">
        {" "}
        /{" "}
      </span>
      {bot.data ? (
        <Link to={`/bots/${botId}`} className="shell-page-crumb">
          {botName}
        </Link>
      ) : (
        <span>Bot</span>
      )}
      <span className="shell-page-subtitle" aria-hidden="true">
        {" "}
        /{" "}
      </span>
      <span>Conversations</span>
    </span>
  ) : (
    "Conversations"
  );

  return (
    <ListLayout
      title={title}
      filters={
        <div
          className="conversation-filters"
          role="group"
          aria-label="Filter by state"
        >
          {STATE_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className="conversation-filter"
              aria-pressed={state === f.value}
              onClick={() => setState(f.value)}
              data-testid={`conversation-filter-${f.value || "all"}`}
            >
              {f.label}
            </button>
          ))}
          {state === "waiting" &&
            WAITING_FILTERS.map((f) => (
              <button
                key={`w-${f.value}`}
                type="button"
                className="conversation-filter"
                aria-pressed={waitingKind === f.value}
                onClick={() => setWaitingKind(f.value)}
                data-testid={`conversation-waiting-${f.value || "any"}`}
              >
                {f.label}
              </button>
            ))}
          <select
            className="conversation-platform-filter"
            aria-label="Platform"
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
            data-testid="conversation-platform"
          >
            {PLATFORM_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
      }
    >
      <div className="conversations-page" data-testid="conversations-page">
        {!activeProjectId ? (
          <Alert variant="info" data-testid="no-project">
            {activeOrganizationId ? (
              <>
                This organization shows you no projects yet. See the{" "}
                <Link to="/organization/projects">organization's projects</Link>
                .
              </>
            ) : (
              "Choose an organization, then a project, to see its conversations."
            )}
          </Alert>
        ) : (
          <>
            {botId && bot.error && (
              <Alert variant="warning" data-testid="bot-missing">
                {bot.error}. <Link to="/bots">Back to bots</Link>
              </Alert>
            )}
            {botId && bot.data && (
              <div className="conversation-start">
                <Composer
                  onSend={onStart}
                  label="Start conversation"
                  placeholder={`Write to ${botName} to start a conversation`}
                  deniedReason={
                    reason("conversation:create") ??
                    (bot.data.bot.enabled
                      ? undefined
                      : `${botName} is disabled, so it takes no new conversations.`)
                  }
                  testId="new-conversation"
                  hint="It answers in the background; the conversation opens as soon as it starts."
                />
              </div>
            )}
            {list.error && (
              <Alert variant="danger" data-testid="conversations-error">
                {list.error}
              </Alert>
            )}
            {list.data === null && !list.error && (
              <SkeletonBlocks
                count={3}
                testId="conversations-skeleton"
                label="Loading conversations"
              />
            )}
            {list.data?.conversations.length === 0 && (
              <div className="shell-empty" data-testid="no-conversations">
                {platform || kind || channelId
                  ? "No conversations match these filters."
                  : state
                    ? "No conversations in this state."
                    : botId
                      ? `No conversations with ${botName ?? "this bot"} yet. Write to it above to start one.`
                      : "No conversations you can see yet. Open a bot and write to it to start one."}
              </div>
            )}
            {list.data && list.data.conversations.length > 0 && (
              <ListGroup
                title="Conversations"
                count={list.data.pagination.total}
                data-testid="conversation-list"
              >
                {list.data.conversations.map((c) => (
                  <div key={c.id} className="conversation-row-wrap">
                    <ListRow
                      as={Link}
                      to={`/conversations/${c.id}`}
                      data-testid={`conversation-row-${c.id}`}
                      data-state={c.state}
                      glyph={
                        <StatusGlyph
                          {...conversationStatus(c)}
                          label={conversationStateLabel(c)}
                        />
                      }
                      identifier={c.channel.name}
                      title={
                        <span className="dashboard-recent-title">
                          <span>{conversationTitle(c)}</span>
                          <span className="dashboard-detail">
                            {stateDetail(c)}
                          </span>
                        </span>
                      }
                      trailing={
                        <>
                          {c.state === "ended" && (
                            <Chip data-testid={`conversation-outcome-${c.id}`}>
                              {conversationStateLabel(c)}
                            </Chip>
                          )}
                          {!botId && <BotBadge name={c.bot.name} />}
                          <PlatformChip platform={platformOf(c.channel.type)} />
                          <span
                            className="conversation-activity tabular"
                            title={new Date(c.lastActivityAt).toLocaleString()}
                          >
                            {relativeTime(c.lastActivityAt)}
                          </span>
                        </>
                      }
                    />
                    {c.platformUrl && (
                      <a
                        href={c.platformUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="conversation-platform-link"
                        aria-label={`Open conversation ${c.id} on ${c.channel.type}`}
                        title={`Open on ${c.channel.type}`}
                        data-testid={`conversation-platform-link-${c.id}`}
                      >
                        <ExternalLink size={14} aria-hidden="true" />
                      </a>
                    )}
                  </div>
                ))}
              </ListGroup>
            )}
            {pages > 1 && (
              <Pagination size="sm" data-testid="conversations-pages">
                <Pagination.Prev
                  disabled={page <= 1}
                  onClick={() => setChosen({ key: filterKey, page: page - 1 })}
                />
                <Pagination.Item active>
                  {page} of {pages}
                </Pagination.Item>
                <Pagination.Next
                  disabled={page >= pages}
                  onClick={() => setChosen({ key: filterKey, page: page + 1 })}
                />
              </Pagination>
            )}
          </>
        )}
      </div>
    </ListLayout>
  );
}
