import type { InboxList } from "@backend/actions/inbox/inbox-list";
import type { ActionResponse } from "keryx";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useRead } from "../../components/bots/data";
import {
  useDashboardFrames,
  useReadableBotIds,
} from "../../components/dashboard/live";
import {
  ago,
  inboxHref,
  inboxKindLabel,
  inboxQuery,
  waitingGlyph,
} from "../../components/dashboard/model";
import { ListLayout } from "../../components/layouts/ListLayout";
import { SkeletonBlocks } from "../../components/SkeletonBlocks";
import { useAuth } from "../../context/AuthContext";
import {
  Alert,
  BotBadge,
  Chip,
  ListGroup,
  ListRow,
  Pagination,
  StatusGlyph,
} from "../../ui";

/** The kind filters, in the order the chips are drawn. */
const KIND_FILTERS = [
  { value: "", label: "Everything" },
  { value: "approval", label: "Approvals" },
  { value: "help", label: "Help requests" },
  { value: "sandbox-question", label: "Sandbox questions" },
] as const;

/**
 * `/inbox` — everything in the project waiting on a person, for the bots the
 * reader may read: tool calls to approve, questions a bot escalated to the
 * team, and questions a sandbox job asked its conversation. A row opens the
 * page where it is answered, which runs the same action a platform's button
 * does; a row the reader may not answer says so. The list follows its bots'
 * dashboard channels and re-reads when an item is raised or settled.
 * @returns The page.
 */
export function InboxPage() {
  const { activeProjectId, activeOrganizationId } = useAuth();
  const [search] = useSearchParams();
  const botId = search.get("botId") ? Number(search.get("botId")) : undefined;
  const [kind, setKind] = useState("");
  const [chosen, setChosen] = useState({ key: "", page: 1 });
  const page = chosen.key === kind ? chosen.page : 1;
  const query = `${inboxQuery(kind, page)}${botId ? `&botId=${botId}` : ""}`;
  const list = useRead<ActionResponse<InboxList>>(
    activeProjectId === null
      ? null
      : `/project/${activeProjectId}/inbox${query}`,
  );
  const readable = useReadableBotIds(activeProjectId);
  useDashboardFrames(activeProjectId, readable, ["inbox"], list.reload);
  const pages = list.data?.pagination.pages ?? 0;

  return (
    <ListLayout
      title="Inbox"
      filters={
        <div
          className="conversation-filters"
          role="group"
          aria-label="Filter by kind"
        >
          {KIND_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className="conversation-filter"
              aria-pressed={kind === f.value}
              onClick={() => setKind(f.value)}
              data-testid={`inbox-filter-${f.value || "all"}`}
            >
              {f.label}
            </button>
          ))}
        </div>
      }
    >
      <div className="conversations-page" data-testid="inbox-page">
        {!activeProjectId ? (
          <Alert variant="info" data-testid="no-project">
            {activeOrganizationId ? (
              <>
                This organization shows you no projects yet. See the{" "}
                <Link to="/organization/projects">organization's projects</Link>
                .
              </>
            ) : (
              "Choose an organization, then a project, to see what waits on a person."
            )}
          </Alert>
        ) : (
          <>
            {list.error && (
              <Alert variant="danger" data-testid="inbox-error">
                {list.error}
              </Alert>
            )}
            {list.data === null && !list.error && (
              <SkeletonBlocks
                count={3}
                testId="inbox-skeleton"
                label="Loading the inbox"
              />
            )}
            {list.data?.items.length === 0 && (
              <div className="shell-empty" data-testid="inbox-empty">
                {kind
                  ? "Nothing of this kind is waiting on a person."
                  : "Nothing is waiting on a person. Approvals, help requests, and sandbox questions land here."}
              </div>
            )}
            {list.data && list.data.items.length > 0 && (
              <ListGroup
                title="Waiting on a person"
                count={list.data.pagination.total}
                data-testid="inbox-list"
              >
                {list.data.items.map((item) => (
                  <ListRow
                    key={`${item.kind}-${item.id}`}
                    as={Link}
                    to={inboxHref(item)}
                    data-testid={`inbox-row-${item.kind}-${item.id}`}
                    data-kind={item.kind}
                    glyph={
                      <StatusGlyph
                        state="waiting"
                        waitingOn={waitingGlyph(item.kind)}
                        label={inboxKindLabel(item.kind)}
                      />
                    }
                    identifier={inboxKindLabel(item.kind)}
                    title={
                      <span className="dashboard-recent-title">
                        <span>{item.title}</span>
                        {item.detail && (
                          <span className="dashboard-detail">
                            {item.detail}
                          </span>
                        )}
                      </span>
                    }
                    trailing={
                      <>
                        {!item.canAnswer && (
                          <Chip
                            data-testid={`inbox-read-only-${item.kind}-${item.id}`}
                          >
                            You can read, not answer
                          </Chip>
                        )}
                        <BotBadge
                          name={item.bot.displayName || item.bot.name}
                        />
                        <span
                          className="conversation-activity tabular"
                          title={new Date(item.createdAt).toLocaleString()}
                        >
                          {ago(item.createdAt)}
                        </span>
                      </>
                    }
                  />
                ))}
              </ListGroup>
            )}
            {pages > 1 && (
              <Pagination size="sm" data-testid="inbox-pages">
                <Pagination.Prev
                  disabled={page <= 1}
                  onClick={() => setChosen({ key: kind, page: page - 1 })}
                />
                <Pagination.Item active>
                  {page} of {pages}
                </Pagination.Item>
                <Pagination.Next
                  disabled={page >= pages}
                  onClick={() => setChosen({ key: kind, page: page + 1 })}
                />
              </Pagination>
            )}
          </>
        )}
      </div>
    </ListLayout>
  );
}
