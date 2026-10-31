import type { BotSkillList } from "@backend/actions/bot-skill/bot-skill-list";
import type { ActionResponse } from "keryx";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useMay } from "../../hooks/useMay";
import { apiFetch } from "../../utils/client";
import { useRead } from "../bots/data";
import type { ApprovalRow } from "../mcp/data";
import {
  type ConversationViewResponse,
  type Entry,
  platformOf,
} from "../transcript/model";
import { ChatComposer } from "./ChatComposer";
import { ChatLog } from "./ChatLog";
import { buildChat, type LiveSurface } from "./model";
import { usePeople } from "./usePeople";

/** See {@link ChatPanel}. */
export interface ChatPanelProps {
  projectId: number;
  /** `conversation:view`'s answer. */
  view: ConversationViewResponse;
  entries: Entry[];
  live: LiveSurface | null;
  /** Read the conversation again. */
  refresh: () => Promise<void>;
  botAvatar?: string;
}

/**
 * One conversation as a chat, with its box: the log built by `buildChat`,
 * the live surface, and the composer that completes the bot's skills. An
 * option button sends its label as the answer (`conversation:message`); an
 * approval card decides through `approval:decide` with `via: "dashboard"`.
 * Whether either is live is the server's word — `standing.canAnswer` and
 * `standing.canDecideApprovals` — never the page's guess.
 * @param props - See {@link ChatPanelProps}.
 * @returns The chat and its composer.
 */
export function ChatPanel({
  projectId,
  view,
  entries,
  live,
  refresh,
  botAvatar,
}: ChatPanelProps) {
  const { reason } = useMay();
  const { conversation, bot, standing } = view;
  const people = usePeople(projectId, entries);
  const items = useMemo(
    () => buildChat(entries, { working: conversation.state === "working" }),
    [entries, conversation.state],
  );
  const base = `/project/${projectId}/conversation/${conversation.id}`;

  const skills = useRead<ActionResponse<BotSkillList>>(
    `/project/${projectId}/bot/${bot.id}/skills?limit=100`,
  );

  // The conversation's approvals, read again whenever it moves, if it ever
  // waited on one.
  const waited = items.some((item) => item.kind === "approval");
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `lastSeq` and `state` are re-read triggers.
  useEffect(() => {
    if (!waited) return;
    let cancelled = false;
    apiFetch<{ approvals: ApprovalRow[] }>(
      `/project/${projectId}/approvals?conversationId=${conversation.id}&limit=100`,
    )
      .then((res) => {
        if (!cancelled) setApprovals(res.approvals);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [
    waited,
    projectId,
    conversation.id,
    conversation.lastSeq,
    conversation.state,
  ]);

  const send = useCallback(
    async (text: string) => {
      await apiFetch(`${base}/message`, {
        method: "PUT",
        body: JSON.stringify({ text }),
      });
      await refresh();
    },
    [base, refresh],
  );

  const decide = useCallback(
    async (approvalId: number, decision: "approve" | "deny") => {
      await apiFetch(`/project/${projectId}/approval/${approvalId}`, {
        method: "POST",
        body: JSON.stringify({ decision, via: "dashboard" }),
      });
      await refresh();
    },
    [projectId, refresh],
  );

  const messageDenied =
    reason("conversation:message") ??
    (standing.canMessage
      ? undefined
      : "You may not write to this conversation.");

  return (
    <div className="chat-panel" data-testid="chat-panel">
      <ChatLog
        conversationId={conversation.id}
        items={items}
        live={live}
        speakers={{
          botName: bot.name,
          botAvatar,
          platform: platformOf(view.channel.type),
          speakerName: people.speakerName,
        }}
        standing={{
          canAnswer: standing.canAnswer && messageDenied === undefined,
          canDecideApprovals:
            standing.canDecideApprovals &&
            reason("approval:decide") === undefined,
        }}
        approvals={approvals}
        waitingApprovalIds={
          conversation.state === "waiting" &&
          conversation.waitingOn?.kind === "approval"
            ? conversation.waitingOn.approvalIds
            : []
        }
        onAnswer={send}
        onDecide={decide}
      />
      <ChatComposer
        onSend={send}
        placeholder={`Write to ${bot.name}`}
        deniedReason={messageDenied}
        skills={(skills.data?.botSkills ?? []).map((s) => ({
          name: s.name,
          description: s.description,
        }))}
        hint={
          conversation.state === "working"
            ? `${bot.name} is working; it reads this before its next step.`
            : conversation.state === "ended"
              ? "This conversation has ended; writing starts a new turn."
              : undefined
        }
      />
    </div>
  );
}
