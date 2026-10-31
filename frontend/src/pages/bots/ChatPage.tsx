import type { BotView } from "@backend/actions/bot/bot-view";
import type { BotSkillList } from "@backend/actions/bot-skill/bot-skill-list";
import type { ActionResponse } from "keryx";
import { FileText, MessageSquarePlus, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { useRead } from "../../components/bots/data";
import { ChatComposer } from "../../components/chat/ChatComposer";
import { ChatPanel } from "../../components/chat/ChatPanel";
import { newestWebConversation } from "../../components/chat/model";
import { LoadingLabel } from "../../components/LoadingLabel";
import { PageHeader } from "../../components/shell/PageHeader";
import type { ConversationRow } from "../../components/transcript/model";
import { useConversation } from "../../components/transcript/useConversation";
import { useAuth } from "../../context/AuthContext";
import { useMay } from "../../hooks/useMay";
import { Alert, Avatar, Button, Chip } from "../../ui";
import { botAvatarSrc } from "../../utils/avatar";
import { API_URL, apiFetch } from "../../utils/client";

/**
 * Read a positive id from a search parameter.
 * @param value - The parameter.
 * @returns The id, or `null`.
 */
function idParam(value: string | null): number | null {
  const n = Number(value);
  return value && Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * `/bots/:botId/chat` — talk to a bot from the dashboard, as a teammate would
 * on a platform: the bot's own chat, on its `web` channel.
 *
 * It opens the newest dashboard conversation the person started with the bot
 * (`?c=` names one), or a blank box when they have none. **New chat** starts
 * another conversation in the bot's shared `dashboard` channel, whose memory
 * the bot keeps; **New chat in a fresh channel** starts one in a new scratch
 * channel, whose memory is empty — the way to check what the bot does without
 * what it has learned. The first message creates the conversation.
 * @returns The page.
 */
export function ChatPage() {
  const { botId } = useParams();
  const { activeProjectId, user } = useAuth();
  const { reason } = useMay();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const id = Number(botId);
  const chosen = idParam(search.get("c"));
  const fresh = search.get("new") === "fresh";
  const blank = search.get("new") !== null;
  const [looked, setLooked] = useState<string | null>(null);

  const bot = useRead<ActionResponse<BotView>>(
    activeProjectId && Number.isSafeInteger(id) && id > 0
      ? `/project/${activeProjectId}/bot/${id}`
      : null,
  );
  const skills = useRead<ActionResponse<BotSkillList>>(
    activeProjectId && blank
      ? `/project/${activeProjectId}/bot/${id}/skills?limit=100`
      : null,
  );
  const { view, entries, live, error, loaded, refresh } = useConversation(
    activeProjectId,
    chosen,
  );

  // With no conversation named, open the newest one this person started here.
  const lookupKey = `${activeProjectId}:${id}:${user?.id ?? ""}`;
  useEffect(() => {
    if (chosen || blank || !activeProjectId || looked === lookupKey) return;
    let cancelled = false;
    apiFetch<{ conversations: ConversationRow[] }>(
      `/project/${activeProjectId}/conversations?botId=${id}&channelType=web&mine=true&limit=1`,
    )
      .then((res) => {
        if (cancelled) return;
        setLooked(lookupKey);
        const found = newestWebConversation(
          res.conversations,
          user?.id ?? null,
        );
        if (found) setSearch({ c: String(found) }, { replace: true });
      })
      .catch(() => {
        if (!cancelled) setLooked(lookupKey);
      });
    return () => {
      cancelled = true;
    };
  }, [
    chosen,
    blank,
    activeProjectId,
    id,
    user?.id,
    looked,
    lookupKey,
    setSearch,
  ]);

  if (!activeProjectId) {
    return (
      <div className="page" data-testid="chat-page">
        <Alert variant="info" data-testid="no-project">
          Choose a project to chat with its bots.
        </Alert>
      </div>
    );
  }
  if (bot.error && !bot.data) {
    return (
      <div className="page" data-testid="chat-page">
        <Alert variant="warning" data-testid="chat-bot-missing">
          {bot.error}. It may belong to another project, or be limited to tags
          you do not hold. <Link to="/chat">Choose a bot</Link>
        </Alert>
      </div>
    );
  }
  if (!bot.data) {
    return (
      <div className="page" data-testid="chat-page">
        <LoadingLabel block testId="chat-loading" label="Loading the bot" />
      </div>
    );
  }

  const theBot = bot.data.bot;
  const avatar = botAvatarSrc(API_URL, theBot.avatarUrl);
  const startDenied =
    reason("conversation:create") ??
    (theBot.enabled ? undefined : `${theBot.name} is disabled.`);
  const searching = !chosen && !blank && looked !== lookupKey;

  /**
   * Start a conversation with the first message, then open it.
   * @param text - The message.
   */
  async function start(text: string) {
    const res = await apiFetch<{ conversation: { id: number } }>(
      `/project/${activeProjectId}/bot/${theBot.id}/conversation`,
      {
        method: "PUT",
        body: JSON.stringify({
          text,
          channelType: "web",
          ...(fresh ? { fresh: true } : {}),
        }),
      },
    );
    setSearch({ c: String(res.conversation.id) });
  }

  return (
    <div className="page chat-page" data-testid="chat-page">
      <PageHeader
        title={
          <span className="bot-page-title">
            <Link to={`/bots/${theBot.id}`} className="shell-page-crumb">
              {theBot.name}
            </Link>
            <span className="shell-page-subtitle" aria-hidden="true">
              {" "}
              /{" "}
            </span>
            <span data-testid="chat-title">Chat</span>
          </span>
        }
        actions={
          <>
            {view && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  navigate(
                    `/conversations/${view.conversation.id}?view=transcript`,
                  )
                }
                data-testid="chat-open-transcript"
              >
                <FileText size={14} aria-hidden="true" /> Transcript
              </Button>
            )}
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setSearch({ new: "1" })}
              data-testid="chat-new"
            >
              <MessageSquarePlus size={14} aria-hidden="true" /> New chat
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setSearch({ new: "fresh" })}
              data-testid="chat-new-fresh"
              title="A new channel whose memory is empty"
            >
              <Sparkles size={14} aria-hidden="true" /> New chat in a fresh
              channel
            </Button>
          </>
        }
      />
      {view && (
        <div className="chat-where" data-testid="chat-where">
          <Chip>{view.channel.name}</Chip>
          <span className="text-meta">
            {view.channel.name === "dashboard"
              ? `${theBot.name}'s shared dashboard channel: it remembers what it learns here.`
              : "A fresh channel: its memory started empty."}
          </span>
        </div>
      )}
      {chosen ? (
        !loaded ? (
          <LoadingLabel
            block
            testId="chat-conversation-loading"
            label="Loading the conversation"
          />
        ) : !view ? (
          <Alert variant="warning" data-testid="chat-conversation-missing">
            {error}.{" "}
            <Link to={`/bots/${theBot.id}/chat?new=1`}>Start a new chat</Link>
          </Alert>
        ) : (
          <ChatPanel
            projectId={activeProjectId}
            view={view}
            entries={entries}
            live={live}
            refresh={refresh}
            botAvatar={avatar}
          />
        )
      ) : searching ? (
        <LoadingLabel block testId="chat-searching" label="Finding your chat" />
      ) : (
        <div className="chat-panel" data-testid="chat-blank">
          <div className="chat-log chat-log-blank">
            <div className="chat-blank">
              <Avatar name={theBot.name} src={avatar} bot size={40} />
              <p>
                {fresh
                  ? `Your first message starts a conversation with ${theBot.name} in a fresh channel. Nothing it remembers from other channels' conversations comes with it; what the project remembers still does.`
                  : `Your first message starts a conversation with ${theBot.name} in its dashboard channel.`}
              </p>
            </div>
          </div>
          <ChatComposer
            onSend={start}
            placeholder={`Write to ${theBot.name}`}
            deniedReason={startDenied}
            skills={(skills.data?.botSkills ?? []).map((s) => ({
              name: s.name,
              description: s.description,
            }))}
            label="Start chat"
          />
        </div>
      )}
    </div>
  );
}
