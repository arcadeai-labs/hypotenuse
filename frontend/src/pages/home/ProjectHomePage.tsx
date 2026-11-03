import type { InboxList } from "@backend/actions/inbox/inbox-list";
import type { ProjectOverview } from "@backend/actions/project/project-overview";
import type { ActionResponse } from "keryx";
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useRead } from "../../components/bots/data";
import { useDashboardFrames } from "../../components/dashboard/live";
import {
  ago,
  inboxHref,
  inboxKindLabel,
  spendLabel,
  stateDetail,
  waitingGlyph,
} from "../../components/dashboard/model";
import { ListLayout } from "../../components/layouts/ListLayout";
import { SkeletonBlocks } from "../../components/SkeletonBlocks";
import {
  conversationStateLabel,
  conversationStatus,
  conversationTitle,
  platformOf,
} from "../../components/transcript/model";
import { useAuth } from "../../context/AuthContext";
import {
  Alert,
  BotBadge,
  Chip,
  ListGroup,
  ListRow,
  PlatformChip,
  StatusGlyph,
} from "../../ui";

/** The overview's answer. */
type Overview = ActionResponse<ProjectOverview>["overview"];

/**
 * One number on the home page's top row.
 * @param props - The label, the number, and its test id.
 * @returns The tile.
 */
function Stat({
  label,
  value,
  testId,
}: {
  label: string;
  value: string | number;
  testId: string;
}) {
  return (
    <div className="dashboard-stat" data-testid={testId}>
      <span className="dashboard-stat-value tabular">{value}</span>
      <span className="dashboard-stat-label">{label}</span>
    </div>
  );
}

/**
 * One bot's card: its live counts by state, what waits on a person, and
 * today's spend.
 * @param props - The bot as the overview answers it.
 * @returns The card.
 */
function BotCard({ bot }: { bot: Overview["bots"][number] }) {
  const c = bot.counts;
  const waiting = Object.entries(c.waiting).filter(([, n]) => n > 0);
  return (
    <div className="dashboard-bot" data-testid={`home-bot-${bot.id}`}>
      <div className="dashboard-bot-head">
        <Link to={`/bots/${bot.id}`} className="dashboard-bot-name">
          <BotBadge name={bot.displayName || bot.name} />
        </Link>
        <span
          className="dashboard-bot-spend tabular"
          title="Model spend today (UTC)"
        >
          {spendLabel(bot.spendToday.usd, bot.spendToday.unpricedRecords)}
        </span>
      </div>
      <dl className="dashboard-bot-counts">
        <div>
          <dt>
            <StatusGlyph state="working" label="Working" />
            Working
          </dt>
          <dd className="tabular" data-testid={`home-bot-${bot.id}-working`}>
            {c.working}
          </dd>
        </div>
        <div>
          <dt>
            <StatusGlyph state="waiting" waitingOn="answer" label="Waiting" />
            Waiting
          </dt>
          <dd className="tabular" data-testid={`home-bot-${bot.id}-waiting`}>
            {c.waitingTotal}
          </dd>
        </div>
        <div>
          <dt>
            <StatusGlyph state="hibernating" label="Hibernating" />
            Hibernating
          </dt>
          <dd className="tabular">{c.hibernating}</dd>
        </div>
      </dl>
      {waiting.length > 0 && (
        <div className="dashboard-bot-waiting">
          {waiting.map(([kind, n]) => (
            <Link
              key={kind}
              to={`/conversations?botId=${bot.id}&waitingKind=${kind}`}
              className="dashboard-bot-waiting-kind"
            >
              <StatusGlyph
                state="waiting"
                waitingOn={waitingGlyph(kind)}
                label={`Waiting: ${kind}`}
              />
              {n} {kind}
            </Link>
          ))}
        </div>
      )}
      <div className="dashboard-bot-foot">
        <Link to={`/conversations?botId=${bot.id}`}>Conversations</Link>
        {bot.needsPerson > 0 && (
          <Link to={`/inbox?botId=${bot.id}`}>
            <Chip>{bot.needsPerson} need a person</Chip>
          </Link>
        )}
        <span className="dashboard-bot-ended">{c.endedToday} ended today</span>
      </div>
    </div>
  );
}

/**
 * `/home` — mission control for the active project: what every bot the
 * reader may read is doing right now (counts by state, waiting split by what
 * it waits on, today's spend), what is waiting on a person, and the
 * conversations that changed most recently. It follows each bot's dashboard
 * channel and re-reads `project:overview` and `inbox:list` when a frame says
 * they went stale.
 * @returns The page.
 */
export function ProjectHomePage() {
  const { activeProjectId, activeOrganizationId } = useAuth();
  const overview = useRead<ActionResponse<ProjectOverview>>(
    activeProjectId === null ? null : `/project/${activeProjectId}/overview`,
  );
  const inbox = useRead<ActionResponse<InboxList>>(
    activeProjectId === null
      ? null
      : `/project/${activeProjectId}/inbox?limit=5`,
  );
  const o = overview.data?.overview ?? null;
  const botIds = useMemo(() => (o ? o.bots.map((b) => b.id) : []), [o]);
  useDashboardFrames(
    activeProjectId,
    botIds,
    ["conversations", "inbox"],
    () => {
      overview.reload();
      inbox.reload();
    },
  );

  if (!activeProjectId) {
    return (
      <ListLayout title="Home">
        <Alert variant="info" data-testid="no-project">
          {activeOrganizationId ? (
            <>
              This organization shows you no projects yet. See the{" "}
              <Link to="/organization/projects">organization's projects</Link>.
            </>
          ) : (
            "Choose an organization, then a project, to see what its bots are doing."
          )}
        </Alert>
      </ListLayout>
    );
  }

  return (
    <ListLayout title="Home">
      <div className="dashboard-home" data-testid="home-page">
        {overview.error && (
          <Alert variant="danger" data-testid="home-error">
            {overview.error}
          </Alert>
        )}
        {o === null && !overview.error && (
          <SkeletonBlocks
            count={3}
            testId="home-skeleton"
            label="Loading the project"
          />
        )}
        {o && (
          <>
            <div className="dashboard-stats" data-testid="home-stats">
              <Stat
                label="Working"
                value={o.totals.counts.working}
                testId="home-working"
              />
              <Stat
                label="Waiting"
                value={o.totals.counts.waitingTotal}
                testId="home-waiting"
              />
              <Stat
                label="Hibernating"
                value={o.totals.counts.hibernating}
                testId="home-hibernating"
              />
              <Stat
                label="Need a person"
                value={o.inbox.total}
                testId="home-inbox-total"
              />
              <Stat
                label="Spend today"
                value={spendLabel(
                  o.totals.spendToday.usd,
                  o.totals.spendToday.unpricedRecords,
                )}
                testId="home-spend"
              />
            </div>

            {o.bots.length === 0 ? (
              <div className="shell-empty" data-testid="home-no-bots">
                No bots you can read yet. <Link to="/bots/new">Create one</Link>
                .
              </div>
            ) : (
              <section
                aria-label="Bots"
                className="dashboard-bots"
                data-testid="home-bots"
              >
                {o.bots.map((bot) => (
                  <BotCard key={bot.id} bot={bot} />
                ))}
              </section>
            )}

            <div className="dashboard-columns">
              <ListGroup
                title="Needs a person"
                count={o.inbox.total}
                data-testid="home-inbox"
              >
                {inbox.data && inbox.data.items.length === 0 && (
                  <div className="shell-empty" data-testid="home-inbox-empty">
                    Nothing is waiting on a person.
                  </div>
                )}
                {inbox.data?.items.map((item) => (
                  <ListRow
                    key={`${item.kind}-${item.id}`}
                    as={Link}
                    to={inboxHref(item)}
                    data-testid={`home-inbox-${item.kind}-${item.id}`}
                    glyph={
                      <StatusGlyph
                        state="waiting"
                        waitingOn={waitingGlyph(item.kind)}
                        label={inboxKindLabel(item.kind)}
                      />
                    }
                    identifier={inboxKindLabel(item.kind)}
                    title={item.title}
                    trailing={
                      <>
                        <BotBadge
                          name={item.bot.displayName || item.bot.name}
                        />
                        <span className="conversation-activity tabular">
                          {ago(item.createdAt)}
                        </span>
                      </>
                    }
                  />
                ))}
                {o.inbox.total > 5 && (
                  <div className="dashboard-more">
                    <Link to="/inbox">All {o.inbox.total} in the inbox</Link>
                  </div>
                )}
              </ListGroup>

              <ListGroup title="Recently changed" data-testid="home-recent">
                {o.recent.length === 0 && (
                  <div className="shell-empty">No conversations yet.</div>
                )}
                {o.recent.map((c) => (
                  <ListRow
                    key={c.id}
                    as={Link}
                    to={`/conversations/${c.id}`}
                    data-testid={`home-recent-${c.id}`}
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
                        <BotBadge name={c.bot.name} />
                        <PlatformChip platform={platformOf(c.channel.type)} />
                      </>
                    }
                  />
                ))}
              </ListGroup>
            </div>
          </>
        )}
      </div>
    </ListLayout>
  );
}
