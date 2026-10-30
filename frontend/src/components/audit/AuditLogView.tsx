import type { AuditList } from "@backend/actions/audit/audit-list";
import type { ActionResponse } from "keryx";
import { Fragment, useEffect, useMemo, useState } from "react";
import { useAuth } from "../../context/AuthContext";
import { Alert, Badge, Button, Form, Pagination, Table } from "../../ui";
import { apiFetch } from "../../utils/client";
import { JsonBlock } from "../JsonBlock";
import { SkeletonRows } from "../SkeletonRows";

/** One audit row, as `audit:list` and `organization:audit-list` serialize it. */
export type AuditRow = ActionResponse<AuditList>["auditLogs"][number];

/** The page size the log asks for. */
const PAGE_SIZE = 25;

/** What the filter bar holds. Empty strings mean "any". */
export interface AuditFilters {
  /** `YYYY-MM-DD`, the first day to include, in the reader's time zone. */
  since: string;
  /** `YYYY-MM-DD`, the last day to include. */
  until: string;
  action: string;
  actorType: "" | AuditRow["actor"]["type"];
  /**
   * A project id, or {@link ORGANIZATION_ONLY} for the rows of no project; for
   * the organization's log only.
   */
  projectId: string;
}

/** The project filter's value for "the organization's own rows". */
export const ORGANIZATION_ONLY = "organization";

/** Every filter cleared. */
export const NO_FILTERS: AuditFilters = {
  since: "",
  until: "",
  action: "",
  actorType: "",
  projectId: "",
};

/**
 * The query string for one page of the log. Dates are whole days in the
 * reader's time zone, sent as epoch milliseconds so the server never guesses
 * an offset.
 * @param filters - The filter bar's values.
 * @param page - The 1-indexed page.
 * @returns The query string, without its `?`.
 */
export function auditQuery(filters: AuditFilters, page: number): string {
  const query = new URLSearchParams({
    page: String(page),
    limit: String(PAGE_SIZE),
  });
  if (filters.since) {
    query.set("since", String(new Date(`${filters.since}T00:00:00`).getTime()));
  }
  if (filters.until) {
    query.set(
      "until",
      String(new Date(`${filters.until}T23:59:59.999`).getTime()),
    );
  }
  if (filters.action) query.set("action", filters.action);
  if (filters.actorType) query.set("actorType", filters.actorType);
  if (filters.projectId === ORGANIZATION_ONLY) {
    query.set("organizationOnly", "true");
  } else if (filters.projectId) {
    query.set("projectId", filters.projectId);
  }
  return query.toString();
}

/**
 * Who made a decision, in words: a person by name, a platform participant by
 * id until participants have names to show, or the system.
 * @param props.actor - The row's actor.
 * @returns The cell's content.
 */
function Actor({ actor }: { actor: AuditRow["actor"] }) {
  if (actor.type === "system") {
    return <Badge bg="secondary">System</Badge>;
  }
  if (actor.type === "participant") {
    return (
      <span className="ui-chip ui-chip-subtle">
        Platform participant #{actor.participantId}
      </span>
    );
  }
  if (actor.name === null) {
    return <span className="audit-muted">Deleted user #{actor.userId}</span>;
  }
  return (
    <>
      <div>{actor.name}</div>
      <div className="audit-actor-email">{actor.email}</div>
    </>
  );
}

/** See {@link AuditLogView}. */
export interface AuditLogViewProps {
  /** The list's route, e.g. `/project/3/audit`. */
  path: string;
  /** Prefixes every `data-testid`, e.g. `"audit"` or `"organization-audit"`. */
  testId: string;
  /** The projects to filter by; given only for an organization's log. */
  projects?: { id: number; name: string }[];
}

/**
 * A tenant's audit log: filters, a table of rows newest first, each row's
 * before, after, and metadata on demand, and pages.
 *
 * The page is **derived** from the filters it was chosen under: change a
 * filter and the same render asks for page 1, so a request never pairs new
 * filters with an old page (an effect that reset the page afterwards would
 * send that request first).
 * @param props - See {@link AuditLogViewProps}.
 * @returns The log.
 */
export function AuditLogView({ path, testId, projects }: AuditLogViewProps) {
  const { permissions } = useAuth();
  const [filters, setFilters] = useState<AuditFilters>(NO_FILTERS);
  const filterKey = JSON.stringify([path, filters]);
  const [chosen, setChosen] = useState({ key: filterKey, page: 1 });
  const page = chosen.key === filterKey ? chosen.page : 1;
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [pages, setPages] = useState(0);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  // Every action the server has, as the vocabulary for the action filter.
  const actionNames = useMemo(
    () => Object.keys(permissions ?? {}).sort(),
    [permissions],
  );

  const query = auditQuery(filters, page);
  useEffect(() => {
    let current = true;
    setError(null);
    apiFetch<ActionResponse<AuditList>>(`${path}?${query}`)
      .then((res) => {
        if (!current) return;
        setRows(res.auditLogs);
        setPages(res.pagination.pages);
        setTotal(res.pagination.total);
      })
      .catch((err: unknown) => {
        if (!current) return;
        setError(
          err instanceof Error ? err.message : "Could not load the audit log.",
        );
        setRows([]);
      });
    return () => {
      current = false;
    };
  }, [path, query]);

  /**
   * Change one filter.
   * @param key - The filter.
   * @param value - Its new value.
   */
  function set<K extends keyof AuditFilters>(key: K, value: AuditFilters[K]) {
    setFilters((was) => ({ ...was, [key]: value }));
  }

  /** @param next - The page to show. */
  function go(next: number) {
    setChosen({ key: filterKey, page: next });
    setOpen(null);
  }

  const columns = projects ? 6 : 5;
  const filtered = JSON.stringify(filters) !== JSON.stringify(NO_FILTERS);

  return (
    <div data-testid={testId}>
      <div className="audit-filters" data-testid={`${testId}-filters`}>
        <Form.Group controlId={`${testId}-since`}>
          <Form.Label>From</Form.Label>
          <Form.Control
            type="date"
            className="audit-filter"
            value={filters.since}
            onChange={(e) => set("since", e.currentTarget.value)}
          />
        </Form.Group>
        <Form.Group controlId={`${testId}-until`}>
          <Form.Label>To</Form.Label>
          <Form.Control
            type="date"
            className="audit-filter"
            value={filters.until}
            onChange={(e) => set("until", e.currentTarget.value)}
          />
        </Form.Group>
        <Form.Group controlId={`${testId}-action`}>
          <Form.Label>Action</Form.Label>
          <Form.Select
            className="audit-filter"
            value={filters.action}
            onChange={(e) => set("action", e.currentTarget.value)}
          >
            <option value="">Any action</option>
            {actionNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Form.Select>
        </Form.Group>
        <Form.Group controlId={`${testId}-actor`}>
          <Form.Label>Made by</Form.Label>
          <Form.Select
            className="audit-filter"
            value={filters.actorType}
            onChange={(e) =>
              set(
                "actorType",
                e.currentTarget.value as AuditFilters["actorType"],
              )
            }
          >
            <option value="">Anyone</option>
            <option value="user">People in Hypotenuse</option>
            <option value="participant">People on a platform</option>
            <option value="system">The system</option>
          </Form.Select>
        </Form.Group>
        {projects && (
          <Form.Group controlId={`${testId}-project`}>
            <Form.Label>Project</Form.Label>
            <Form.Select
              className="audit-filter"
              value={filters.projectId}
              onChange={(e) => set("projectId", e.currentTarget.value)}
            >
              <option value="">Every project</option>
              <option value={ORGANIZATION_ONLY}>Organization only</option>
              {projects.map((p) => (
                <option key={p.id} value={String(p.id)}>
                  {p.name}
                </option>
              ))}
            </Form.Select>
          </Form.Group>
        )}
        <Button
          variant="outline-secondary"
          disabled={!filtered}
          onClick={() => setFilters(NO_FILTERS)}
          data-testid={`${testId}-reset`}
        >
          Reset
        </Button>
      </div>

      {error && (
        <Alert variant="danger" data-testid={`${testId}-error`}>
          {error}
        </Alert>
      )}

      <Table hover responsive size="sm" data-testid={`${testId}-table`}>
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Who</th>
            <th scope="col">Action</th>
            <th scope="col">Target</th>
            {projects && <th scope="col">Project</th>}
            <th scope="col" className="text-end">
              <span className="visually-hidden">Details</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows === null && (
            <SkeletonRows
              columns={columns}
              rows={5}
              testId={`${testId}-skeleton`}
              label="Loading the audit log"
            />
          )}
          {rows?.length === 0 && !error && (
            <tr>
              <td
                colSpan={columns}
                className="text-muted"
                data-testid={`${testId}-empty`}
              >
                {filtered
                  ? "Nothing matches these filters."
                  : "Nothing has been recorded yet."}
              </td>
            </tr>
          )}
          {rows?.map((row) => {
            const expanded = open === row.id;
            return (
              <Fragment key={row.id}>
                <tr data-testid={`${testId}-row-${row.id}`}>
                  <td className="audit-time">
                    <time dateTime={new Date(row.createdAt).toISOString()}>
                      {new Date(row.createdAt).toLocaleString()}
                    </time>
                  </td>
                  <td>
                    <Actor actor={row.actor} />
                  </td>
                  <td className="audit-action">{row.action}</td>
                  <td>
                    {row.targetPath ?? ""}
                    {row.targetType && (
                      <div className="audit-muted">{row.targetType}</div>
                    )}
                  </td>
                  {projects && (
                    <td>
                      {row.projectId === null ? (
                        <span className="audit-muted">Organization</span>
                      ) : (
                        (row.projectName ?? (
                          <span className="audit-muted">
                            Deleted project #{row.projectId}
                          </span>
                        ))
                      )}
                    </td>
                  )}
                  <td className="text-end">
                    <Button
                      size="sm"
                      variant="link"
                      aria-expanded={expanded}
                      aria-controls={`${testId}-details-${row.id}`}
                      onClick={() => setOpen(expanded ? null : row.id)}
                      data-testid={`${testId}-toggle-${row.id}`}
                    >
                      {expanded ? "Hide" : "Details"}
                    </Button>
                  </td>
                </tr>
                {expanded && (
                  <tr
                    className="audit-details"
                    id={`${testId}-details-${row.id}`}
                    data-testid={`${testId}-details-${row.id}`}
                  >
                    <td colSpan={columns}>
                      <div className="audit-snapshots">
                        <JsonBlock label="Before" value={row.before} />
                        <JsonBlock label="After" value={row.after} />
                        <JsonBlock label="Details" value={row.metadata} />
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </Table>

      <div className="audit-footer">
        <span className="audit-muted" data-testid={`${testId}-total`}>
          {total === 1 ? "1 entry" : `${total} entries`}
        </span>
        {pages > 1 && (
          <Pagination size="sm" data-testid={`${testId}-pages`}>
            <Pagination.Prev
              disabled={page <= 1}
              onClick={() => go(page - 1)}
            />
            <Pagination.Item active data-testid={`${testId}-current-page`}>
              {page} of {pages}
            </Pagination.Item>
            <Pagination.Next
              disabled={page >= pages}
              onClick={() => go(page + 1)}
              data-testid={`${testId}-next`}
            />
          </Pagination>
        )}
      </div>
    </div>
  );
}
