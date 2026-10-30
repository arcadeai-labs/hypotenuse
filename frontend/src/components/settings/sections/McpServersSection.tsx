import { ChevronDown, ChevronRight } from "lucide-react";
import { Fragment, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Alert, Button, Form, Table } from "../../../ui";
import { API_URL, apiFetch } from "../../../utils/client";
import {
  AUTH_MODE_OPTIONS,
  authModeOption,
  credentialSummary,
  type HeaderRow,
  headersFromRows,
  type McpAuthMode,
  oauthLanding,
  toolCountLabel,
} from "../../../utils/mcp";
import { ConfirmDialog } from "../../ConfirmDialog";
import { GatedButton } from "../../GatedButton";
import type { McpServer, McpServerDetail } from "../../mcp/data";
import { McpStatusGlyph } from "../../mcp/McpStatusGlyph";
import { ToolCatalog } from "../../mcp/ToolCatalog";
import { SkeletonRows } from "../../SkeletonRows";
import { SectionCard } from "../../sections/SectionCard";
import { useSectionSave } from "../../sections/useSectionSave";
import { useProjectSettings } from "../context";

/** What `mcp-server:test` and `mcp-server:refresh-tools` answer. */
interface ProbeAnswer {
  mcpServer: McpServer;
  ok: boolean;
  toolCount: number;
  error: string | null;
}

/**
 * Settings → MCP servers: the project's shared MCP servers, which bots are
 * then given one by one on their own pages. Every member reads the list and
 * browses each server's tools; connecting, testing, refreshing, switching
 * off, signing in, and deleting are an admin's, and a member sees them
 * disabled with the reason.
 *
 * Signing in to an OAuth server is a browser hop: the window goes to the
 * server's authorization page and comes back here with `?signedIn=1` or
 * `?oauthError=`, which this section reads once and then clears. A bare
 * `?server=<id>` opens that server's catalog.
 * @returns The section.
 */
export function McpServersSection() {
  const { projectId, reason } = useProjectSettings();
  const [params, setParams] = useSearchParams();
  const [landing, setLanding] = useState(() => oauthLanding(params));
  // Read once, at mount: clearing the query below must not drop the alert.
  const [landed] = useState(landing);
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // `?server=<id>` opens that server's catalog, on its own or after a sign-in.
  const [expanded, setExpanded] = useState<number | null>(
    () => landed?.serverId ?? (Number(params.get("server")) || null),
  );

  const reload = useCallback(async () => {
    try {
      const res = await apiFetch<{ mcpServers: McpServer[] }>(
        `/project/${projectId}/mcp-servers?limit=100`,
      );
      setServers(res.mcpServers);
      setLoadError(null);
    } catch (err) {
      setServers((current) => current ?? []);
      setLoadError(
        err instanceof Error ? err.message : "Could not load the servers.",
      );
    }
  }, [projectId]);

  useEffect(() => {
    reload();
  }, [reload]);

  // The landing is read once; a reload must not announce it again.
  useEffect(() => {
    if (landed) setParams({}, { replace: true });
  }, [landed, setParams]);

  const landedOn = servers?.find((s) => s.id === landing?.serverId);

  return (
    <div data-testid="settings-mcp-servers">
      {landing && (
        <Alert
          variant={landing.signedIn ? "success" : "danger"}
          dismissible
          onClose={() => setLanding(null)}
          data-testid="mcp-oauth-landing"
          data-signed-in={landing.signedIn}
        >
          {landing.signedIn
            ? `Signed in${landedOn ? ` to ${landedOn.name}` : ""}. Its tools are listed below.`
            : `Signing in${landedOn ? ` to ${landedOn.name}` : ""} did not finish: ${landing.error}`}
        </Alert>
      )}
      {loadError && (
        <Alert variant="danger" data-testid="mcp-servers-load-error">
          {loadError}
        </Alert>
      )}
      <ServersCard
        projectId={projectId}
        servers={servers}
        reload={reload}
        reason={reason}
        expanded={expanded}
        setExpanded={setExpanded}
      />
      <ConnectCard
        projectId={projectId}
        reason={reason}
        onConnected={async (server) => {
          await reload();
          setExpanded(server.id);
        }}
      />
    </div>
  );
}

/**
 * The servers' table: status, name, address, credentials, tool count, and an
 * admin's actions; a row opens to its catalog.
 * @param props - The servers and what the section shares with the card.
 * @returns The card.
 */
function ServersCard({
  projectId,
  servers,
  reload,
  reason,
  expanded,
  setExpanded,
}: {
  projectId: number;
  servers: McpServer[] | null;
  reload: () => Promise<void>;
  reason: (actionName: string) => string | undefined;
  expanded: number | null;
  setExpanded: (id: number | null) => void;
}) {
  const { busy, error, notice, setError, setNotice, save } = useSectionSave();
  const [deleting, setDeleting] = useState<McpServer | null>(null);
  const testDenied = reason("mcp-server:test");
  const refreshDenied = reason("mcp-server:refresh-tools");
  const editDenied = reason("mcp-server:edit");
  const deleteDenied = reason("mcp-server:delete");
  const signInDenied = reason("mcp-server:oauth-start");
  // Bumped after a probe, so an open catalog re-reads what it found.
  const [catalogVersion, setCatalogVersion] = useState(0);

  /**
   * Connect and list the tools again — Test and Refresh tools differ only in
   * what they are called and in the audit log.
   * @param server - The server.
   * @param kind - Which probe.
   */
  async function onProbe(server: McpServer, kind: "test" | "refresh") {
    let answer: ProbeAnswer | null = null;
    const ok = await save(async () => {
      answer = await apiFetch<ProbeAnswer>(
        `/project/${projectId}/mcp-server/${server.id}/${kind}`,
        { method: "POST" },
      );
    }, "");
    const result = answer as ProbeAnswer | null;
    if (ok && result) {
      if (result.ok) {
        setNotice(
          kind === "test"
            ? `${server.name} answered and lists ${toolCountLabel(result.toolCount)}.`
            : `Refreshed ${server.name}: ${toolCountLabel(result.toolCount)}.`,
        );
      } else {
        setNotice(null);
        setError(
          `${server.name} did not answer as expected: ${result.error ?? "no reason given"}.`,
        );
      }
    }
    setCatalogVersion((v) => v + 1);
    await reload();
  }

  /**
   * Switch a server on or off for every bot that has it.
   * @param server - The server.
   */
  async function onToggle(server: McpServer) {
    const ok = await save(
      () =>
        apiFetch(`/project/${projectId}/mcp-server/${server.id}`, {
          method: "POST",
          body: JSON.stringify({ enabled: !server.enabled }),
        }),
      server.enabled
        ? `Disabled ${server.name}. No bot sees its tools until it is enabled again.`
        : `Enabled ${server.name}.`,
    );
    if (ok) await reload();
  }

  /** Delete the server being confirmed. */
  async function onDelete() {
    const target = deleting;
    if (!target) return;
    setDeleting(null);
    const ok = await save(
      () =>
        apiFetch(`/project/${projectId}/mcp-server/${target.id}`, {
          method: "DELETE",
        }),
      `Deleted ${target.name}.`,
    );
    if (ok) {
      if (expanded === target.id) setExpanded(null);
      await reload();
    }
  }

  /**
   * Send the window to the server's authorization page. It is a full page
   * navigation, carrying the session cookie, and it comes back to this page.
   * @param server - The OAuth server.
   */
  function onSignIn(server: McpServer) {
    window.location.assign(
      `${API_URL}/api/project/${projectId}/mcp-server/${server.id}/oauth`,
    );
  }

  return (
    <SectionCard
      title="MCP servers"
      testId="mcp-servers"
      idPrefix="settings"
      cardTestId="mcp-servers-card"
      intro={
        <>
          An MCP server gives bots tools: a mailbox, a calendar, an issue
          tracker. A server connected here belongs to the project; each bot is
          then given the servers it may use on its own page, with the calls that
          run without asking. Credentials are encrypted and never shown again.
        </>
      }
      error={error}
      notice={notice}
      onDismissError={() => setError(null)}
      onDismissNotice={() => setNotice(null)}
    >
      <Table
        size="sm"
        responsive
        className="mcp-server-table"
        data-testid="mcp-server-list"
      >
        <thead>
          <tr>
            <th scope="col">
              <span className="visually-hidden">Status</span>
            </th>
            <th scope="col">Server</th>
            <th scope="col">Credentials</th>
            <th scope="col">Tools</th>
            <th scope="col" className="text-end">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {servers === null && (
            <SkeletonRows
              columns={5}
              rows={2}
              testId="mcp-servers-skeleton"
              label="Loading MCP servers"
            />
          )}
          {servers?.length === 0 && (
            <tr>
              <td
                colSpan={5}
                className="text-muted"
                data-testid="no-mcp-servers"
              >
                No MCP servers yet. An admin connects one below with its
                address.
              </td>
            </tr>
          )}
          {servers?.map((s) => {
            const open = expanded === s.id;
            const needsSignIn = s.authMode === "oauth" && !s.signedIn;
            return (
              <Fragment key={s.id}>
                <tr
                  className="mcp-server-row"
                  data-testid={`mcp-server-row-${s.name}`}
                  data-status={s.status}
                  data-enabled={s.enabled}
                >
                  <td>
                    <McpStatusGlyph
                      status={s.status}
                      enabled={s.enabled}
                      testId={`mcp-server-status-${s.name}`}
                    />
                  </td>
                  <td className="mcp-server-name-cell">
                    <button
                      type="button"
                      className="mcp-server-toggle"
                      aria-expanded={open}
                      onClick={() => setExpanded(open ? null : s.id)}
                      data-testid={`mcp-server-expand-${s.name}`}
                    >
                      {open ? (
                        <ChevronDown size={14} aria-hidden="true" />
                      ) : (
                        <ChevronRight size={14} aria-hidden="true" />
                      )}
                      {s.name}
                    </button>
                    <span className="mono mcp-server-url" title={s.url}>
                      {s.url}
                    </span>
                  </td>
                  <td data-testid={`mcp-server-credentials-${s.name}`}>
                    {credentialSummary(s)}
                  </td>
                  <td
                    className="tabular"
                    data-testid={`mcp-server-tools-${s.name}`}
                  >
                    {toolCountLabel(s.toolCount)}
                  </td>
                  <td className="text-end">
                    <div className="d-inline-flex gap-2">
                      {needsSignIn && (
                        <GatedButton
                          size="sm"
                          variant="primary"
                          disabled={busy}
                          deniedReason={signInDenied}
                          onClick={() => onSignIn(s)}
                          data-testid={`mcp-server-sign-in-${s.name}`}
                        >
                          Sign in
                        </GatedButton>
                      )}
                      <GatedButton
                        size="sm"
                        variant="outline-secondary"
                        disabled={busy}
                        deniedReason={testDenied}
                        onClick={() => onProbe(s, "test")}
                        data-testid={`mcp-server-test-${s.name}`}
                      >
                        Test
                      </GatedButton>
                      <GatedButton
                        size="sm"
                        variant="outline-secondary"
                        disabled={busy}
                        deniedReason={refreshDenied}
                        onClick={() => onProbe(s, "refresh")}
                        data-testid={`mcp-server-refresh-${s.name}`}
                      >
                        Refresh tools
                      </GatedButton>
                      <GatedButton
                        size="sm"
                        variant="outline-secondary"
                        disabled={busy}
                        deniedReason={editDenied}
                        onClick={() => onToggle(s)}
                        data-testid={`mcp-server-enable-${s.name}`}
                      >
                        {s.enabled ? "Disable" : "Enable"}
                      </GatedButton>
                      <GatedButton
                        size="sm"
                        variant="outline-danger"
                        disabled={busy}
                        deniedReason={deleteDenied}
                        aria-label={`Delete the ${s.name} MCP server`}
                        onClick={() => setDeleting(s)}
                        data-testid={`mcp-server-delete-${s.name}`}
                      >
                        Delete
                      </GatedButton>
                    </div>
                  </td>
                </tr>
                {s.status !== "ok" && s.lastError && (
                  <tr className="model-connection-error-row">
                    <td />
                    <td
                      colSpan={4}
                      className="text-danger"
                      data-testid={`mcp-server-error-${s.name}`}
                    >
                      {s.lastError}
                    </td>
                  </tr>
                )}
                {open && (
                  <tr className="mcp-server-detail-row">
                    <td />
                    <td colSpan={4}>
                      <ServerCatalog
                        projectId={projectId}
                        server={s}
                        version={catalogVersion}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </Table>

      <ConfirmDialog
        show={deleting !== null}
        title={`Delete ${deleting?.name ?? "this server"}?`}
        confirmLabel="Delete server"
        busy={busy}
        onConfirm={onDelete}
        onCancel={() => setDeleting(null)}
        testId="delete-mcp-server"
      >
        Its credentials are erased, and every bot that has it loses its tools.
        Calls waiting for approval on it can no longer run.
      </ConfirmDialog>
    </SectionCard>
  );
}

/**
 * One server's catalog, read when its row opens.
 * @param props - The project, the server, and a version that forces a re-read.
 * @returns The catalog.
 */
function ServerCatalog({
  projectId,
  server,
  version,
}: {
  projectId: number;
  server: McpServer;
  version: number;
}) {
  const [detail, setDetail] = useState<McpServerDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  // `version` and the server's refresh time are the re-read triggers.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above.
  useEffect(() => {
    let cancelled = false;
    apiFetch<McpServerDetail>(`/project/${projectId}/mcp-server/${server.id}`)
      .then((res) => {
        if (!cancelled) {
          setDetail(res);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "Could not load it.");
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, server.id, version, server.toolsRefreshedAt]);

  return (
    <div
      className="mcp-server-detail"
      data-testid={`mcp-catalog-${server.name}`}
    >
      <p className="text-meta mb-2">
        {server.toolsRefreshedAt
          ? `Tools listed ${new Date(server.toolsRefreshedAt).toLocaleString()}.`
          : server.authMode === "oauth" && !server.signedIn
            ? "Sign in to list its tools."
            : "Its tools have not been listed yet."}
      </p>
      {error && (
        <Alert variant="danger" className="mb-2">
          {error}
        </Alert>
      )}
      {detail ? (
        <ToolCatalog
          tools={detail.tools}
          testId={`mcp-catalog-tools-${server.name}`}
        />
      ) : (
        !error && <p className="text-meta">Loading its tools…</p>
      )}
    </div>
  );
}

/**
 * The connect form: a name, the server's address, and how it authenticates,
 * with the fields that mode needs. A credential goes up once and never comes
 * back.
 * @param props - The project, `reason`, and what to do once connected.
 * @returns The card.
 */
function ConnectCard({
  projectId,
  reason,
  onConnected,
}: {
  projectId: number;
  reason: (actionName: string) => string | undefined;
  onConnected: (server: McpServer) => Promise<void>;
}) {
  const { busy, error, notice, setError, setNotice, save } = useSectionSave();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [authMode, setAuthMode] = useState<McpAuthMode>("none");
  const [bearerToken, setBearerToken] = useState("");
  const [headers, setHeaders] = useState<HeaderRow[]>([
    { name: "", value: "" },
  ]);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const denied = reason("mcp-server:create");
  const locked = busy || denied !== undefined;
  const option = authModeOption(authMode);

  /** Connect the server the form describes. */
  async function onConnect() {
    const body: Record<string, unknown> = {
      name: name.trim(),
      url: url.trim(),
      authMode,
    };
    if (authMode === "bearer") {
      if (!bearerToken.trim()) {
        setError("A bearer server needs its token.");
        return;
      }
      body.bearerToken = bearerToken.trim();
    }
    if (authMode === "headers") {
      const parsed = headersFromRows(headers);
      if ("problem" in parsed) {
        setError(parsed.problem);
        return;
      }
      body.headers = parsed.headers;
    }
    if (authMode === "oauth" && clientId.trim()) {
      body.clientId = clientId.trim();
      if (clientSecret.trim()) body.clientSecret = clientSecret.trim();
    }
    let created: McpServer | null = null;
    const ok = await save(async () => {
      const res = await apiFetch<{ mcpServer: McpServer }>(
        `/project/${projectId}/mcp-server`,
        { method: "PUT", body: JSON.stringify(body) },
      );
      created = res.mcpServer;
    }, "");
    const server = created as McpServer | null;
    if (!ok || !server) return;
    setNotice(
      server.authMode === "oauth"
        ? `Connected ${server.name}. Sign in from its row to list its tools.`
        : server.status === "ok"
          ? `Connected ${server.name}: ${toolCountLabel(server.toolCount)}.`
          : `Saved ${server.name}, but it did not answer: ${server.lastError ?? "no reason given"}.`,
    );
    setName("");
    setUrl("");
    setBearerToken("");
    setHeaders([{ name: "", value: "" }]);
    setClientId("");
    setClientSecret("");
    await onConnected(server);
  }

  /**
   * Change one header row.
   * @param index - The row.
   * @param patch - What changed.
   */
  function setHeader(index: number, patch: Partial<HeaderRow>) {
    setHeaders((rows) =>
      rows.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  }

  return (
    <SectionCard
      title="Connect a server"
      testId="mcp-connect"
      idPrefix="settings"
      cardTestId="mcp-connect-card"
      intro={
        <>
          Hypotenuse speaks MCP over Streamable HTTP. It connects once, lists
          the server's tools, and refreshes the list every hour.
        </>
      }
      error={error}
      notice={notice}
      onDismissError={() => setError(null)}
      onDismissNotice={() => setNotice(null)}
    >
      <Form
        className="mcp-connect-form"
        onSubmit={(e) => {
          e.preventDefault();
          onConnect();
        }}
        data-testid="mcp-connect-form"
      >
        <div className="mcp-connect-fields">
          <Form.Group controlId="mcp-connect-name" className="mb-0">
            <Form.Label>Name</Form.Label>
            <Form.Control
              size="sm"
              placeholder="mail"
              value={name}
              disabled={locked}
              title={denied}
              onChange={(e) => setName(e.target.value)}
              data-testid="mcp-connect-name"
            />
            <Form.Text className="text-meta">
              Bots and allowlists name its tools as name/tool.
            </Form.Text>
          </Form.Group>
          <Form.Group controlId="mcp-connect-url" className="mb-0">
            <Form.Label>Address</Form.Label>
            <Form.Control
              size="sm"
              type="url"
              placeholder="https://mcp.example.com/mcp"
              value={url}
              disabled={locked}
              title={denied}
              onChange={(e) => setUrl(e.target.value)}
              data-testid="mcp-connect-url"
            />
          </Form.Group>
          <Form.Group controlId="mcp-connect-auth" className="mb-0">
            <Form.Label>Authentication</Form.Label>
            <Form.Select
              size="sm"
              value={authMode}
              disabled={locked}
              title={denied}
              onChange={(e) => setAuthMode(e.target.value as McpAuthMode)}
              data-testid="mcp-connect-auth"
            >
              {AUTH_MODE_OPTIONS.map((o) => (
                <option key={o.mode} value={o.mode}>
                  {o.label}
                </option>
              ))}
            </Form.Select>
            <Form.Text className="text-meta">{option.hint}</Form.Text>
          </Form.Group>
        </div>

        {authMode === "bearer" && (
          <Form.Group controlId="mcp-connect-bearer" className="mb-0">
            <Form.Label>Bearer token</Form.Label>
            <Form.Control
              size="sm"
              type="password"
              autoComplete="off"
              className="settings-input"
              value={bearerToken}
              disabled={locked}
              title={denied}
              onChange={(e) => setBearerToken(e.target.value)}
              data-testid="mcp-connect-bearer"
            />
          </Form.Group>
        )}

        {authMode === "headers" && (
          <fieldset className="mcp-headers" data-testid="mcp-connect-headers">
            <legend className="form-label">Headers</legend>
            {headers.map((row, i) => (
              // Rows have no identity beyond their position while typed.
              // biome-ignore lint/suspicious/noArrayIndexKey: see above.
              <div key={i} className="mcp-header-row">
                <Form.Control
                  size="sm"
                  aria-label={`Header ${i + 1} name`}
                  placeholder="X-Api-Key"
                  value={row.name}
                  disabled={locked}
                  onChange={(e) => setHeader(i, { name: e.target.value })}
                  data-testid={`mcp-header-name-${i}`}
                />
                <Form.Control
                  size="sm"
                  type="password"
                  autoComplete="off"
                  aria-label={`Header ${i + 1} value`}
                  placeholder="Value"
                  value={row.value}
                  disabled={locked}
                  onChange={(e) => setHeader(i, { value: e.target.value })}
                  data-testid={`mcp-header-value-${i}`}
                />
                <Button
                  size="sm"
                  variant="outline-secondary"
                  disabled={locked || headers.length === 1}
                  aria-label={`Remove header ${i + 1}`}
                  onClick={() =>
                    setHeaders((rows) => rows.filter((_, j) => j !== i))
                  }
                >
                  Remove
                </Button>
              </div>
            ))}
            <Button
              size="sm"
              variant="outline-secondary"
              disabled={locked}
              onClick={() =>
                setHeaders((rows) => [...rows, { name: "", value: "" }])
              }
              data-testid="mcp-header-add"
            >
              Add header
            </Button>
          </fieldset>
        )}

        {authMode === "oauth" && (
          <div className="mcp-connect-fields">
            <Form.Group controlId="mcp-connect-client-id" className="mb-0">
              <Form.Label>
                Client id <span className="text-meta">optional</span>
              </Form.Label>
              <Form.Control
                size="sm"
                autoComplete="off"
                value={clientId}
                disabled={locked}
                title={denied}
                onChange={(e) => setClientId(e.target.value)}
                data-testid="mcp-connect-client-id"
              />
            </Form.Group>
            <Form.Group controlId="mcp-connect-client-secret" className="mb-0">
              <Form.Label>
                Client secret <span className="text-meta">optional</span>
              </Form.Label>
              <Form.Control
                size="sm"
                type="password"
                autoComplete="off"
                value={clientSecret}
                disabled={locked || !clientId.trim()}
                title={denied}
                onChange={(e) => setClientSecret(e.target.value)}
                data-testid="mcp-connect-client-secret"
              />
            </Form.Group>
          </div>
        )}

        <div>
          <GatedButton
            size="sm"
            type="submit"
            variant="outline-primary"
            disabled={busy || name.trim() === "" || url.trim() === ""}
            deniedReason={denied}
            data-testid="mcp-connect-submit"
          >
            Connect server
          </GatedButton>
        </div>
      </Form>
    </SectionCard>
  );
}
