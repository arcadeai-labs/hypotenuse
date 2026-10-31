import { useState } from "react";
import { Link } from "react-router-dom";
import { useRead } from "../../components/bots/data";
import {
  HELP_FILTERS,
  type HelpRow,
  helpStatusLabel,
  listQuery,
  urgencyLabel,
} from "../../components/help/model";
import { ListLayout } from "../../components/layouts/ListLayout";
import { SkeletonBlocks } from "../../components/SkeletonBlocks";
import { relativeTime } from "../../components/shell/NotificationBell";
import { useAuth } from "../../context/AuthContext";
import {
  Alert,
  BotBadge,
  Chip,
  CompleteGlyph,
  ListGroup,
  ListRow,
  Pagination,
  StaleGlyph,
  StatusGlyph,
} from "../../ui";
import { expiresInWords } from "../../utils/mcp";

/**
 * The glyph a help request's row starts with.
 * @param props.status - Its status.
 * @returns The glyph.
 */
function HelpGlyph({ status }: { status: string }) {
  if (status === "pending") {
    return <StatusGlyph state="waiting" waitingOn="answer" />;
  }
  if (status === "answered") return <CompleteGlyph label="Answered" />;
  return <StaleGlyph label={helpStatusLabel(status)} />;
}

/**
 * `/help` — the help inbox: what bots asked a person, because nobody in the
 * channel could answer, for the bots the reader may read, newest first. Each
 * names its bot (always visibly a bot), how urgent it is, and whether the bot
 * is stopped until someone answers. A row opens the request, where it is
 * answered.
 * @returns The page.
 */
export function HelpInboxPage() {
  const { activeProjectId, activeOrganizationId } = useAuth();
  const [status, setStatus] = useState<string>("pending");
  const [chosen, setChosen] = useState({ key: "", page: 1 });
  const page = chosen.key === status ? chosen.page : 1;
  const list = useRead<{
    helpRequests: HelpRow[];
    pagination: { total: number; pages: number };
  }>(
    activeProjectId === null
      ? null
      : `/project/${activeProjectId}/help${listQuery({ status }, page)}`,
  );
  const pages = list.data?.pagination.pages ?? 0;

  return (
    <ListLayout
      title="Help inbox"
      filters={
        <div
          className="conversation-filters"
          role="group"
          aria-label="Filter by status"
        >
          {HELP_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className="conversation-filter"
              aria-pressed={status === f.value}
              onClick={() => setStatus(f.value)}
              data-testid={`help-filter-${f.value || "all"}`}
            >
              {f.label}
            </button>
          ))}
        </div>
      }
    >
      <div className="conversations-page help-page" data-testid="help-page">
        {!activeProjectId ? (
          <Alert variant="info" data-testid="no-project">
            {activeOrganizationId ? (
              <>
                This organization shows you no projects yet. See the{" "}
                <Link to="/organization/projects">organization's projects</Link>
                .
              </>
            ) : (
              "Choose an organization, then a project, to see what its bots asked."
            )}
          </Alert>
        ) : (
          <>
            {list.error && (
              <Alert variant="danger" data-testid="help-error">
                {list.error}
              </Alert>
            )}
            {list.data === null && !list.error && (
              <SkeletonBlocks
                count={3}
                testId="help-skeleton"
                label="Loading requests"
              />
            )}
            {list.data?.helpRequests.length === 0 && (
              <div className="shell-empty" data-testid="no-help">
                {status === "pending"
                  ? "No bot is waiting on a person. When a bot asks for help — because nobody in the channel could answer — the request lands here."
                  : "No requests in this state."}
              </div>
            )}
            {list.data && list.data.helpRequests.length > 0 && (
              <ListGroup
                title={
                  status === "pending"
                    ? "Waiting for an answer"
                    : status
                      ? helpStatusLabel(status)
                      : "Requests"
                }
                count={list.data.pagination.total}
                data-testid="help-list"
              >
                {list.data.helpRequests.map((r) => (
                  <ListRow
                    key={r.id}
                    as={Link}
                    to={`/help/${r.id}`}
                    data-testid={`help-row-${r.id}`}
                    data-status={r.status}
                    glyph={<HelpGlyph status={r.status} />}
                    identifier={`#${r.id}`}
                    title={<span className="help-question">{r.question}</span>}
                    trailing={
                      <>
                        {r.urgency !== "normal" && (
                          <Chip
                            tone={r.urgency === "high" ? "accent" : "subtle"}
                            data-testid={`help-urgency-${r.id}`}
                          >
                            {urgencyLabel(r.urgency)}
                          </Chip>
                        )}
                        {r.blocking && r.status === "pending" && (
                          <Chip title="The bot is stopped until someone answers">
                            Blocking
                          </Chip>
                        )}
                        {r.status === "pending" ? (
                          <span className="text-meta tabular">
                            {expiresInWords(r.expiresAt)}
                          </span>
                        ) : (
                          <Chip>{helpStatusLabel(r.status)}</Chip>
                        )}
                        <BotBadge name={r.botName} />
                        <span
                          className="conversation-activity tabular"
                          title={new Date(r.createdAt).toLocaleString()}
                        >
                          {relativeTime(r.createdAt)}
                        </span>
                      </>
                    }
                  />
                ))}
              </ListGroup>
            )}
            {pages > 1 && (
              <Pagination size="sm" data-testid="help-pages">
                <Pagination.Prev
                  disabled={page <= 1}
                  onClick={() => setChosen({ key: status, page: page - 1 })}
                />
                <Pagination.Item active>
                  {page} of {pages}
                </Pagination.Item>
                <Pagination.Next
                  disabled={page >= pages}
                  onClick={() => setChosen({ key: status, page: page + 1 })}
                />
              </Pagination>
            )}
          </>
        )}
      </div>
    </ListLayout>
  );
}
