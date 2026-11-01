import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { type BotRow, useRead } from "../../components/bots/data";
import { listQuery } from "../../components/help/model";
import { ListLayout } from "../../components/layouts/ListLayout";
import { SkeletonBlocks } from "../../components/SkeletonBlocks";
import { SandboxJobStatusGlyph } from "../../components/sandboxes/SandboxJobStatusGlyph";
import { relativeTime } from "../../components/shell/NotificationBell";
import { useAuth } from "../../context/AuthContext";
import {
  Alert,
  BotBadge,
  Chip,
  Form,
  ListGroup,
  ListRow,
  Pagination,
} from "../../ui";
import {
  jobStatusLabel,
  SANDBOX_JOB_FILTERS,
  type SandboxJobRow,
  usageWords,
} from "../../utils/sandboxJobs";

/**
 * `/sandboxes` — the project's sandbox jobs, newest first: code work a bot
 * handed to a coding agent in an ephemeral sandbox. Each row names its bot
 * (always visibly a bot), its title, its status, and the model tokens it
 * used. Chips filter by status, a menu by bot (`?bot=` in the address, so a
 * bot's page can link to its own jobs), and a row opens the job.
 * @returns The page.
 */
export function SandboxJobsPage() {
  const { activeProjectId, activeOrganizationId } = useAuth();
  const [search, setSearch] = useSearchParams();
  const botId = search.get("bot") ?? "";
  const [status, setStatus] = useState("");
  const filterKey = `${botId}|${status}`;
  const [chosen, setChosen] = useState({ key: "", page: 1 });
  const page = chosen.key === filterKey ? chosen.page : 1;
  const list = useRead<{
    sandboxJobs: SandboxJobRow[];
    pagination: { total: number; pages: number };
  }>(
    activeProjectId === null
      ? null
      : `/project/${activeProjectId}/sandbox-jobs${listQuery({ botId, status }, page)}`,
  );
  const bots = useRead<{ bots: BotRow[] }>(
    activeProjectId === null
      ? null
      : `/project/${activeProjectId}/bots?limit=100`,
  );
  const pages = list.data?.pagination.pages ?? 0;

  return (
    <ListLayout
      title="Sandboxes"
      filters={
        <div className="events-filters">
          <div
            className="conversation-filters"
            role="group"
            aria-label="Filter by status"
          >
            {SANDBOX_JOB_FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                className="conversation-filter"
                aria-pressed={status === f.value}
                onClick={() => setStatus(f.value)}
                data-testid={`sandbox-filter-${f.value || "all"}`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <Form.Select
            size="sm"
            className="settings-input sandbox-bot-filter"
            aria-label="Filter by bot"
            value={botId}
            onChange={(e) => {
              const next = new URLSearchParams(search);
              if (e.target.value) next.set("bot", e.target.value);
              else next.delete("bot");
              setSearch(next, { replace: true });
            }}
            data-testid="sandbox-bot-filter"
          >
            <option value="">Every bot</option>
            {bots.data?.bots.map((b) => (
              <option key={b.id} value={String(b.id)}>
                {b.name}
              </option>
            ))}
          </Form.Select>
        </div>
      }
    >
      <div className="conversations-page" data-testid="sandboxes-page">
        {!activeProjectId ? (
          <Alert variant="info" data-testid="no-project">
            {activeOrganizationId ? (
              <>
                This organization shows you no projects yet. See the{" "}
                <Link to="/organization/projects">organization's projects</Link>
                .
              </>
            ) : (
              "Choose an organization, then a project, to see its sandbox jobs."
            )}
          </Alert>
        ) : (
          <>
            {list.error && (
              <Alert variant="danger" data-testid="sandboxes-error">
                {list.error}
              </Alert>
            )}
            {list.data === null && !list.error && (
              <SkeletonBlocks
                count={3}
                testId="sandboxes-skeleton"
                label="Loading sandbox jobs"
              />
            )}
            {list.data?.sandboxJobs.length === 0 && (
              <div className="shell-empty" data-testid="no-sandbox-jobs">
                {status || botId
                  ? "No jobs match."
                  : "No bot has started a sandbox job yet. When one hands code work to a coding agent — with sandbox_start — the job is listed here."}
              </div>
            )}
            {list.data && list.data.sandboxJobs.length > 0 && (
              <ListGroup
                title={status ? jobStatusLabel(status) : "Jobs"}
                count={list.data.pagination.total}
                data-testid="sandbox-job-list"
              >
                {list.data.sandboxJobs.map((job) => (
                  <ListRow
                    key={job.id}
                    as={Link}
                    to={`/sandboxes/${job.id}`}
                    data-testid={`sandbox-job-row-${job.id}`}
                    data-status={job.status}
                    glyph={<SandboxJobStatusGlyph status={job.status} />}
                    identifier={`#${job.id}`}
                    title={<span className="help-question">{job.title}</span>}
                    trailing={
                      <>
                        <Chip data-testid={`sandbox-job-status-${job.id}`}>
                          {jobStatusLabel(job.status)}
                        </Chip>
                        <span
                          className="text-meta tabular"
                          title={`${job.usage.requests} model requests`}
                        >
                          {usageWords(job.usage, job.budgetTokens)}
                        </span>
                        <BotBadge name={job.bot.name} />
                        <span
                          className="conversation-activity tabular"
                          title={new Date(job.createdAt).toLocaleString()}
                        >
                          {relativeTime(job.createdAt)}
                        </span>
                      </>
                    }
                  />
                ))}
              </ListGroup>
            )}
            {pages > 1 && (
              <Pagination size="sm" data-testid="sandbox-job-pages">
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
