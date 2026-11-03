import type { ProjectOverview } from "@backend/actions/project/project-overview";
import type { ActionResponse } from "keryx";
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useDashboardFrames } from "../dashboard/live";
import { spendLabel } from "../dashboard/model";
import { SectionCard } from "../sections/SectionCard";
import type { Bot } from "./data";
import { useRead } from "./data";

/**
 * One number of the Activity card.
 * @param props - The label, the value, and an optional link.
 * @returns The tile.
 */
function Tile({
  label,
  value,
  to,
  testId,
}: {
  label: string;
  value: string | number;
  to?: string;
  testId: string;
}) {
  const body = (
    <>
      <span className="dashboard-stat-value tabular">{value}</span>
      <span className="dashboard-stat-label">{label}</span>
    </>
  );
  return to ? (
    <Link to={to} className="dashboard-stat" data-testid={testId}>
      {body}
    </Link>
  ) : (
    <div className="dashboard-stat" data-testid={testId}>
      {body}
    </div>
  );
}

/**
 * The bot's activity right now: its conversations by state, what waits on a
 * person, how much it remembers where it works, and today's model spend —
 * the bot's own row of `project:overview`, live on its dashboard channel.
 * @param props - The project and the bot.
 * @returns The card.
 */
export function ActivitySection({
  projectId,
  bot,
}: {
  projectId: number;
  bot: Bot;
}) {
  const overview = useRead<ActionResponse<ProjectOverview>>(
    `/project/${projectId}/overview?recent=0`,
  );
  const ids = useMemo(() => [bot.id], [bot.id]);
  useDashboardFrames(
    projectId,
    ids,
    ["conversations", "inbox"],
    overview.reload,
  );
  const row = overview.data?.overview.bots.find((b) => b.id === bot.id);
  return (
    <SectionCard
      title="Activity"
      testId="activity"
      idPrefix="bot"
      intro="What this bot is doing now. The counts move as its conversations do."
      error={overview.error}
      loading={!row && !overview.error}
      loadingBlocks={1}
    >
      {row && (
        <div className="dashboard-activity">
          <Tile
            label="Working"
            value={row.counts.working}
            to={`/conversations?botId=${bot.id}&state=working`}
            testId="bot-activity-working"
          />
          <Tile
            label="Waiting"
            value={row.counts.waitingTotal}
            to={`/conversations?botId=${bot.id}&state=waiting`}
            testId="bot-activity-waiting"
          />
          <Tile
            label="Hibernating"
            value={row.counts.hibernating}
            testId="bot-activity-hibernating"
          />
          <Tile
            label="Need a person"
            value={row.needsPerson}
            to={`/inbox?botId=${bot.id}`}
            testId="bot-activity-inbox"
          />
          <Tile
            label="Channel memories"
            value={row.memoryDocuments}
            to="/memory"
            testId="bot-activity-memory"
          />
          <Tile
            label="Spend today"
            value={spendLabel(
              row.spendToday.usd,
              row.spendToday.unpricedRecords,
            )}
            testId="bot-activity-spend"
          />
        </div>
      )}
      <p className="dashboard-detail">
        <Link to={`/bots/${bot.id}/conversations`}>
          All of its conversations
        </Link>
      </p>
    </SectionCard>
  );
}
