import type { IntegrationConnect } from "@backend/actions/integration/integration-connect";
import type { IntegrationView } from "@backend/actions/integration/integration-view";
import type { LinearCallbackError } from "@backend/ops/LinearOAuthOps";
import type { ActionResponse } from "keryx";
import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../../../context/AuthContext";
import { useFirstLoad } from "../../../hooks/useFirstLoad";
import {
  Alert,
  Badge,
  Button,
  ErrorGlyph,
  Modal,
  OfflineGlyph,
  OnlineGlyph,
  Property,
  Table,
} from "../../../ui";
import { apiFetch } from "../../../utils/client";
import { outcomeView } from "../../../utils/deliveryOutcomes";
import SectionCard from "../../sections/SectionCard";
import { useSectionSave } from "../../sections/useSectionSave";
import { useProjectSettings } from "../context";

/** What `integration:view` answers for `type=linear`. */
type IntegrationResponse = ActionResponse<IntegrationView>;

/** The Linear integration as the server serializes it. */
type Integration = NonNullable<IntegrationResponse["integration"]>;

/**
 * What each `linear:callback` refusal means to the person who just came back
 * from Linear. Keyed by the backend's own code type, so a code added there
 * without a sentence here fails `tsc`; an unknown code (an older or newer
 * server) falls back to a generic sentence rather than nothing.
 */
export const CALLBACK_ERROR_MESSAGES: Record<LinearCallbackError, string> = {
  state_expired:
    "That Linear sign-in link expired or was already used. Start again with Connect Linear.",
  state_mismatch:
    "The Linear approval finished in a browser signed in as somebody else. Connect again while signed in as the admin who started it.",
  denied: "The Linear admin declined the install, so nothing was connected.",
  exchange_failed:
    "Linear did not complete the install. Try again; if it keeps failing, check the deployment's Linear app settings.",
  forbidden:
    "Only a project admin can connect Linear, and you no longer hold the admin tag here.",
  workspace_taken:
    "This Linear workspace is already connected to another Hypotenuse project. Disconnect it there first.",
  workspace_changed:
    "This project is connected to a different Linear workspace. Disconnect it before connecting another.",
};

/**
 * The sentence for a callback refusal code.
 * @param code - The `error` query parameter.
 * @returns What to tell the person.
 */
export function callbackErrorMessage(code: string): string {
  return (
    (CALLBACK_ERROR_MESSAGES as Record<string, string>)[code] ??
    "Linear could not be connected. Try again."
  );
}

/**
 * Format an epoch-ms instant for a property row.
 * @param ms - The instant, or null.
 * @returns A local date and time, or an em dash.
 */
function when(ms: number | null): string {
  return ms === null ? "—" : new Date(ms).toLocaleString();
}

/**
 * The connection's health as a glyph and a word: shape carries the state, so
 * colour is never the only cue.
 * @param props.status - The integration's status, or null when never connected.
 * @returns The status mark.
 */
function ConnectionStatus({
  status,
}: {
  status: Integration["status"] | null;
}) {
  if (status === "active") {
    return (
      <span className="d-inline-flex align-items-center gap-1">
        <OnlineGlyph label={null} /> Connected
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="d-inline-flex align-items-center gap-1">
        <ErrorGlyph label={null} /> Needs reconnecting
      </span>
    );
  }
  return (
    <span className="d-inline-flex align-items-center gap-1">
      <OfflineGlyph label={null} /> Not connected
    </span>
  );
}

/**
 * The project's Linear integration: which workspace, as which app user, how
 * healthy the tokens are, and the Connect / Disconnect controls. One card in
 * Settings → Integrations.
 *
 * Every member may read it (`integration:view` is member-level); connecting
 * and disconnecting are gated per control through `may()`. Connect sends the
 * browser to Linear's consent screen, and Linear sends it back to this page with
 * `?type=linear&connected=1` or `?type=linear&error=<code>`, which is read once
 * on mount and then stripped from the URL so a reload does not repeat the
 * message. A verdict for another type is left for that type's card.
 * @returns The rendered card.
 */
export default function LinearIntegrationCard() {
  const { projectId, may } = useProjectSettings();
  const { projects, setActiveProject } = useAuth();
  const { busy, error, notice, setError, setNotice, save } = useSectionSave();
  const [data, setData] = useState<IntegrationResponse | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const { loading, begin, done } = useFirstLoad();
  const [searchParams, setSearchParams] = useSearchParams();
  const mayConnect = may("integration:connect");
  const mayDisconnect = may("integration:disconnect");

  const load = useCallback(async () => {
    begin();
    try {
      setData(
        await apiFetch<IntegrationResponse>(
          `/integration?projectId=${projectId}&type=linear`,
        ),
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not load the connection.",
      );
    } finally {
      done();
    }
  }, [projectId, setError, begin, done]);

  useEffect(() => {
    load();
  }, [load]);

  // The callback's verdict, once. Stripped with `replace` so Back does not
  // return to a URL that repeats it. A success names the project it connected:
  // when that is not the one on screen (the person switched while Linear's
  // consent screen was open), switch to it first and let this section remount
  // there with the parameters still on the URL.
  useEffect(() => {
    const connected = searchParams.get("connected");
    const failure = searchParams.get("error");
    if (!connected && !failure) return;
    if (searchParams.get("type") !== "linear") return;
    const named = Number(searchParams.get("projectId"));
    if (named && named !== projectId && projects.some((p) => p.id === named)) {
      setActiveProject(named);
      return;
    }
    if (connected) setNotice("Linear is connected.");
    if (failure) setError(callbackErrorMessage(failure));
    const next = new URLSearchParams(searchParams);
    next.delete("connected");
    next.delete("error");
    next.delete("projectId");
    next.delete("type");
    setSearchParams(next, { replace: true });
  }, [
    searchParams,
    setSearchParams,
    setNotice,
    setError,
    projectId,
    projects,
    setActiveProject,
  ]);

  /** Ask for the consent-screen URL and send the browser there. */
  async function onConnect() {
    setConnecting(true);
    setError(null);
    try {
      const { authorizeUrl } = await apiFetch<
        ActionResponse<IntegrationConnect>
      >(`/integration/connect?projectId=${projectId}&type=linear`);
      window.location.assign(authorizeUrl);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not start connecting.",
      );
      setConnecting(false);
    }
  }

  /** Disconnect after the confirmation, then re-read. */
  async function onDisconnect() {
    setConfirming(false);
    const ok = await save(
      () =>
        apiFetch("/integration", {
          method: "DELETE",
          body: JSON.stringify({ projectId, type: "linear" }),
        }),
      "Disconnected. @hypotenuse was removed from the Linear workspace.",
    );
    if (ok) await load();
  }

  const integration =
    data?.integration && data.integration.status !== "revoked"
      ? data.integration
      : null;
  const configured = data?.configured ?? true;

  /** The Connect (or Reconnect) control, or why there is none. */
  const connectControl = !mayConnect ? (
    <p className="text-muted mb-0" data-testid="linear-admin-only">
      A project admin connects Linear, and a Linear workspace admin approves it.
    </p>
  ) : (
    <div className="d-flex gap-2 align-items-center flex-wrap">
      <Button
        variant="primary"
        disabled={!configured || connecting || busy}
        onClick={onConnect}
        data-testid="linear-connect"
      >
        {integration ? "Reconnect Linear" : "Connect Linear"}
      </Button>
      {!configured && (
        <span className="text-muted" data-testid="linear-not-configured">
          This deployment has no Linear app configured yet.
        </span>
      )}
    </div>
  );

  return (
    <SectionCard
      title="Linear"
      testId="linear"
      idPrefix="settings"
      cardTestId="linear-card"
      loading={loading}
      error={error}
      notice={notice}
      onDismissError={() => setError(null)}
      onDismissNotice={() => setNotice(null)}
      intro={
        <>
          Connect one Linear workspace. Hypotenuse joins it as the{" "}
          <code>@hypotenuse</code> app user, so people can delegate issues to it
          or mention it.
        </>
      }
    >
      {!integration ? (
        <div
          className="d-flex flex-column gap-3"
          data-testid="linear-disconnected"
        >
          <ConnectionStatus status={null} />
          {connectControl}
        </div>
      ) : (
        <div
          className="d-flex flex-column gap-3"
          data-testid="linear-connected"
        >
          {integration.status === "error" && (
            <Alert
              variant="danger"
              className="mb-0"
              data-testid="linear-refresh-error"
            >
              {integration.refreshError ??
                "Linear stopped accepting this connection."}{" "}
              {mayConnect
                ? "Reconnect to bring @hypotenuse back."
                : "A project admin must reconnect it."}
            </Alert>
          )}
          {integration.status === "active" && integration.refreshError && (
            <Alert
              variant="warning"
              className="mb-0"
              data-testid="linear-refresh-warning"
            >
              {integration.refreshError}
            </Alert>
          )}

          <dl className="ui-properties-list" data-testid="linear-properties">
            <Property label="Status">
              <ConnectionStatus status={integration.status} />
            </Property>
            <Property label="Workspace">
              <a
                href={`https://linear.app/${integration.workspaceUrlKey}`}
                target="_blank"
                rel="noreferrer"
                data-testid="linear-workspace"
              >
                {integration.workspaceName}
              </a>
              <span className="text-muted">
                linear.app/{integration.workspaceUrlKey}
              </span>
            </Property>
            <Property label="App user">
              <span data-testid="linear-app-user">
                @{integration.appUserName}
              </span>
            </Property>
            <Property label="Scopes">
              {integration.scopes.map((scope) => (
                <Badge key={scope} bg="secondary">
                  {scope}
                </Badge>
              ))}
            </Property>
            <Property label="Teams">
              <span data-testid="linear-teams">
                {integration.details.teamIds.length === 1
                  ? "1 team"
                  : `${integration.details.teamIds.length} teams`}
                {integration.details.canAccessAllPublicTeams &&
                  ", every public team"}
              </span>
            </Property>
            <Property label="Token expires">
              {when(integration.accessTokenExpiresAt)}
            </Property>
            <Property label="Last refreshed">
              {when(integration.lastRefreshedAt)}
            </Property>
            {integration.rateLimit && (
              <Property label="Rate limit">
                <span data-testid="linear-rate-limit">
                  {integration.rateLimit.requestsRemaining !== null
                    ? `${integration.rateLimit.requestsRemaining.toLocaleString()}${
                        integration.rateLimit.requestsLimit !== null
                          ? ` of ${integration.rateLimit.requestsLimit.toLocaleString()}`
                          : ""
                      } requests left`
                    : "—"}
                  {integration.rateLimit.complexityRemaining !== null &&
                    ` · ${integration.rateLimit.complexityRemaining.toLocaleString()} complexity`}
                  {` · seen ${when(integration.rateLimit.observedAt)}`}
                </span>
              </Property>
            )}
            <Property label="Last webhook">
              <span data-testid="linear-last-webhook">
                {when(data?.deliveries?.lastReceivedAt ?? null)}
              </span>
            </Property>
          </dl>

          <RecentDeliveries deliveries={data?.deliveries ?? null} />

          <div className="d-flex gap-2 flex-wrap">
            {integration.status === "error" && mayConnect && connectControl}
            {mayDisconnect && (
              <Button
                variant="outline-danger"
                disabled={busy}
                onClick={() => setConfirming(true)}
                data-testid="linear-disconnect"
              >
                Disconnect
              </Button>
            )}
          </div>
        </div>
      )}

      <Modal
        show={confirming}
        onHide={() => setConfirming(false)}
        data-testid="linear-disconnect-modal"
      >
        <Modal.Header closeButton>
          <Modal.Title>Disconnect Linear?</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          This revokes Hypotenuse's access to{" "}
          <strong>{integration?.workspaceName}</strong> at once:{" "}
          <code>@hypotenuse</code> is removed from the workspace and stops
          answering there. Connecting again needs a Linear workspace admin.
        </Modal.Body>
        <Modal.Footer>
          <Button
            variant="outline-secondary"
            onClick={() => setConfirming(false)}
            data-testid="linear-disconnect-cancel"
          >
            Keep connected
          </Button>
          <Button
            variant="danger"
            onClick={onDisconnect}
            data-testid="linear-disconnect-confirm"
          >
            Disconnect
          </Button>
        </Modal.Footer>
      </Modal>
    </SectionCard>
  );
}

/**
 * The webhook's recent deliveries and what processing made of each — the
 * first place to look when Linear says it delegated and nothing happened.
 * The full log, with routing, is `/events`.
 * @param props - `integration:view`'s `deliveries`.
 * @returns The table, or a line saying none arrived.
 */
function RecentDeliveries({
  deliveries,
}: {
  deliveries: IntegrationResponse["deliveries"];
}) {
  if (!deliveries || deliveries.recent.length === 0) {
    return (
      <p className="text-muted mb-0" data-testid="linear-deliveries-empty">
        No webhook deliveries yet.
      </p>
    );
  }
  return (
    <>
      <Table size="sm" responsive data-testid="linear-deliveries">
        <thead>
          <tr>
            <th scope="col">Received</th>
            <th scope="col">Event</th>
            <th scope="col">Outcome</th>
          </tr>
        </thead>
        <tbody>
          {deliveries.recent.map((d) => {
            const view = outcomeView(d.outcome);
            return (
              <tr key={d.id} data-testid={`linear-delivery-${d.id}`}>
                <td className="tabular">{when(d.receivedAt)}</td>
                <td>
                  {d.eventType} · {d.action}
                </td>
                <td>
                  <Badge bg={view.tone}>{d.outcome}</Badge>
                  {d.error && <span className="text-muted"> {d.error}</span>}
                  {view.hint && (
                    <span className="text-muted"> {view.hint}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </Table>
      <Link to="/events" data-testid="linear-deliveries-all">
        Every event and how it was routed →
      </Link>
    </>
  );
}
