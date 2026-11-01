import type { BotInstallationList } from "@backend/actions/bot-installation/bot-installation-list";
import type { BotInstallationManifest } from "@backend/actions/bot-installation/bot-installation-manifest";
import type { ActionResponse } from "keryx";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Alert, Chip, Form, PlatformChip } from "../../ui";
import {
  type InstallablePlatform,
  installationStatusLabel,
} from "../../utils/channels";
import { apiFetch } from "../../utils/client";
import { ConfirmDialog } from "../ConfirmDialog";
import { CopyButton } from "../CopyButton";
import { GatedButton } from "../GatedButton";
import { JsonBlock } from "../JsonBlock";
import { useSectionSave } from "../sections/useSectionSave";
import type { Bot } from "./data";

/** An installation, as `bot-installation:list` serializes it. */
type Installation =
  ActionResponse<BotInstallationList>["installations"][number];

/** `bot-installation:manifest`'s answer, shown once. */
type Manifest = ActionResponse<BotInstallationManifest>;

/** The manual path's fields, as typed. */
interface ManualDraft {
  clientId: string;
  appId: string;
  clientSecret: string;
  signingSecret: string;
  botToken: string;
}

const EMPTY_DRAFT: ManualDraft = {
  clientId: "",
  appId: "",
  clientSecret: "",
  signingSecret: "",
  botToken: "",
};

/**
 * **Slack, on the bot's Channels section.** Each bot is its own Slack app:
 *
 * 1. Create it — with an app configuration token (Hypotenuse calls
 *    `apps.manifest.create`; the token is used once), or from the manifest by
 *    hand, connecting the app's credentials afterwards.
 * 2. Install it — the platform's OAuth, which lands back on this page with
 *    `?installed=slack` or `?installError=…`.
 * 3. Then Test and Disconnect, like any platform.
 *
 * Every step is drawn in every state, disabled where it does not apply yet.
 * @param props.platform - Slack's entry in the platform list.
 * @param props.installation - The bot's Slack installation, if any.
 * @param props.projectId - The project.
 * @param props.bot - The bot.
 * @param props.denied - Why the person may not change it.
 * @param props.onChanged - Read the installations again.
 * @returns The block.
 */
export function SlackPlatformBlock({
  platform,
  installation,
  projectId,
  bot,
  denied,
  onChanged,
}: {
  platform: InstallablePlatform;
  installation: Installation | undefined;
  projectId: number;
  bot: Bot;
  denied: string | undefined;
  onChanged: () => Promise<void>;
}) {
  const { busy, error, notice, setError, setNotice, save } = useSectionSave();
  const [params, setParams] = useSearchParams();
  const [configToken, setConfigToken] = useState("");
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [draft, setDraft] = useState<ManualDraft>(EMPTY_DRAFT);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const status = installation?.status;
  const created = Boolean(installation?.hasCredentials);
  const installed = status === "active" || status === "error";
  const teamName =
    typeof installation?.config.teamName === "string"
      ? installation.config.teamName
      : null;
  const off = busy || denied !== undefined;

  // The install's landing: `?installed=slack` or `?installError=…`.
  useEffect(() => {
    const installedParam = params.get("installed");
    const installError = params.get("installError");
    if (installedParam !== "slack" && !installError) return;
    if (installError) setError(installError);
    else setNotice(`Installed. Invite ${bot.name} to a channel with /invite.`);
    const next = new URLSearchParams(params);
    for (const key of ["installed", "installError", "installation"]) {
      next.delete(key);
    }
    setParams(next, { replace: true });
  }, [params, setParams, setError, setNotice, bot.name]);

  /** Let Hypotenuse create the app with a configuration token. */
  async function createApp() {
    await save(async () => {
      await apiFetch(`/project/${projectId}/bot/${bot.id}/slack/app`, {
        method: "PUT",
        body: JSON.stringify({ configToken: configToken.trim() }),
      });
      setConfigToken("");
      await onChanged();
    }, "Created. Now install it into your workspace.");
  }

  /** Mint the routing key and show the manifest, once. */
  async function getManifest() {
    await save(async () => {
      const answer = await apiFetch<Manifest>(
        `/project/${projectId}/bot/${bot.id}/installation/slack/manifest`,
        { method: "POST" },
      );
      setManifest(answer);
      await onChanged();
    }, "Manifest ready. Create the app in Slack, then connect it below.");
  }

  /** Connect the app created by hand. */
  async function connect() {
    await save(async () => {
      await apiFetch(`/project/${projectId}/bot/${bot.id}/installation`, {
        method: "PUT",
        body: JSON.stringify({
          type: "slack",
          config: {
            clientId: draft.clientId.trim(),
            ...(draft.appId.trim() ? { appId: draft.appId.trim() } : {}),
          },
          credentials: {
            clientSecret: draft.clientSecret.trim(),
            signingSecret: draft.signingSecret.trim(),
            ...(draft.botToken.trim()
              ? { botToken: draft.botToken.trim() }
              : {}),
          },
        }),
      });
      setDraft(EMPTY_DRAFT);
      setManifest(null);
      await onChanged();
    }, "Connected.");
  }

  /** Send the browser to Slack's install page. */
  async function install() {
    if (!installation) return;
    setNotice(null);
    setError(null);
    try {
      const { url } = await apiFetch<{ url: string }>(
        `/project/${projectId}/bot-installation/${installation.id}/oauth?format=json`,
      );
      window.location.assign(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The install could not start.");
    }
  }

  /** Ask Slack to answer. */
  async function test() {
    if (!installation) return;
    await save(async () => {
      const answer = await apiFetch<{ ok: boolean; error: string | null }>(
        `/project/${projectId}/bot-installation/${installation.id}/test`,
        { method: "POST" },
      );
      await onChanged();
      if (!answer.ok) throw new Error(answer.error ?? "Slack did not answer.");
    }, "Slack answered.");
  }

  /** Uninstall. */
  async function disconnect() {
    if (!installation) return;
    setConfirmDisconnect(false);
    await save(async () => {
      await apiFetch(
        `/project/${projectId}/bot-installation/${installation.id}`,
        { method: "DELETE" },
      );
      await onChanged();
    }, "Disconnected. Remove the app in Slack too.");
  }

  const field = (key: keyof ManualDraft) => ({
    value: draft[key],
    disabled: off || installed,
    title: denied,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
      setDraft({ ...draft, [key]: e.target.value }),
  });

  return (
    <div
      className="channels-platform"
      data-testid="bot-channels-platform-slack"
      data-status={status ?? "none"}
    >
      <div className="channels-platform-head">
        <PlatformChip platform="slack" />
        <Chip
          tone={status === "active" ? "accent" : "subtle"}
          data-testid="bot-channels-status-slack"
        >
          {status === "pending" && created
            ? "Created, not installed"
            : status
              ? installationStatusLabel(status)
              : "Not connected"}
        </Chip>
        <span className="channels-platform-actions">
          <GatedButton
            size="sm"
            variant={installed ? "secondary" : "primary"}
            deniedReason={denied}
            disabled={busy || !created}
            title={created ? undefined : "Create the app first"}
            onClick={install}
            data-testid="bot-channels-install-slack"
          >
            {installed ? "Reinstall" : "Install to Slack"}
          </GatedButton>
          <GatedButton
            size="sm"
            variant="secondary"
            disabled={busy || !installed}
            onClick={test}
            data-testid="bot-channels-test-slack"
          >
            Test
          </GatedButton>
          <GatedButton
            size="sm"
            variant="outline-danger"
            deniedReason={denied}
            disabled={busy || !installation}
            onClick={() => setConfirmDisconnect(true)}
            data-testid="bot-channels-disconnect-slack"
          >
            Disconnect
          </GatedButton>
        </span>
      </div>
      <p className="text-meta channels-platform-summary">{platform.summary}</p>
      {installation?.lastError && (
        <Alert variant="warning" data-testid="bot-channels-last-error-slack">
          {installation.lastError}
        </Alert>
      )}
      {installed && (
        <p
          className="channels-platform-line"
          data-testid="bot-channels-slack-installed"
        >
          Installed in{" "}
          <strong>{teamName ?? installation?.externalWorkspaceId}</strong>
          {installation?.externalBotUserId && (
            <>
              {" "}
              as <span className="mono">{installation.externalBotUserId}</span>
            </>
          )}
          . Invite it to a channel with{" "}
          <span className="mono">/invite @{bot.slug}</span>.
        </p>
      )}
      {!installed && (
        <div
          className="channels-slack-paths"
          data-testid="bot-channels-create-slack"
        >
          <section className="channels-slack-path">
            <h4 className="channels-slack-path-title">
              Create the app with a configuration token
            </h4>
            <p className="text-meta mb-0">
              From api.slack.com/apps → Your App Configuration Tokens. It is
              used once to create {bot.name}'s app, and never stored.
            </p>
            <form
              className="channels-connect"
              onSubmit={(e) => {
                e.preventDefault();
                createApp();
              }}
            >
              <Form.Group
                controlId="channels-slack-config-token"
                className="mb-0"
              >
                <Form.Label>Configuration token</Form.Label>
                <Form.Control
                  size="sm"
                  className="settings-input"
                  type="password"
                  autoComplete="off"
                  placeholder="xoxe.xoxp-…"
                  value={configToken}
                  disabled={off}
                  title={denied}
                  onChange={(e) => setConfigToken(e.target.value)}
                  data-testid="bot-channels-config-token-slack"
                />
              </Form.Group>
              <div>
                <GatedButton
                  type="submit"
                  size="sm"
                  variant="primary"
                  deniedReason={denied}
                  disabled={busy || !configToken.trim().startsWith("xoxe")}
                  data-testid="bot-channels-create-submit-slack"
                >
                  Create the app
                </GatedButton>
              </div>
            </form>
          </section>
          <section className="channels-slack-path">
            <h4 className="channels-slack-path-title">
              Or create it yourself from the manifest
            </h4>
            <p className="text-meta mb-0">
              Paste the manifest into api.slack.com/apps → Create New App → From
              a manifest, then connect the app's credentials from its Basic
              Information page.
            </p>
            <div>
              <GatedButton
                size="sm"
                variant="secondary"
                deniedReason={denied}
                disabled={busy}
                onClick={getManifest}
                data-testid="bot-channels-manifest-slack"
              >
                {status === "pending" ? "Get a new manifest" : "Get manifest"}
              </GatedButton>
            </div>
            {manifest && (
              <Alert
                variant="warning"
                className="mb-0"
                data-testid="bot-channels-manifest-slack-shown"
              >
                <p className="mb-2">
                  The events URL inside is shown once: copy the manifest now.
                  Asking for a new one makes a new URL and stops this one.
                </p>
                <div className="bot-callback-secret">
                  <code className="mono">{manifest.urls.events}</code>
                  <CopyButton
                    text={JSON.stringify(manifest.manifest, null, 2)}
                    label="Copy manifest"
                  />
                </div>
                <JsonBlock value={manifest.manifest} label="Manifest" />
              </Alert>
            )}
            <form
              className="channels-connect"
              onSubmit={(e) => {
                e.preventDefault();
                connect();
              }}
              data-testid="bot-channels-connect-slack"
            >
              <Form.Group controlId="channels-slack-client-id" className="mb-0">
                <Form.Label>Client ID</Form.Label>
                <Form.Control
                  size="sm"
                  className="settings-input"
                  placeholder="1234.5678"
                  {...field("clientId")}
                  data-testid="bot-channels-client-id-slack"
                />
              </Form.Group>
              <Form.Group controlId="channels-slack-app-id" className="mb-0">
                <Form.Label>
                  App ID <span className="text-meta">optional</span>
                </Form.Label>
                <Form.Control
                  size="sm"
                  className="settings-input"
                  placeholder="A0…"
                  {...field("appId")}
                />
              </Form.Group>
              <Form.Group
                controlId="channels-slack-client-secret"
                className="mb-0"
              >
                <Form.Label>Client Secret</Form.Label>
                <Form.Control
                  size="sm"
                  className="settings-input"
                  type="password"
                  autoComplete="off"
                  {...field("clientSecret")}
                  data-testid="bot-channels-client-secret-slack"
                />
              </Form.Group>
              <Form.Group
                controlId="channels-slack-signing-secret"
                className="mb-0"
              >
                <Form.Label>Signing Secret</Form.Label>
                <Form.Control
                  size="sm"
                  className="settings-input"
                  type="password"
                  autoComplete="off"
                  {...field("signingSecret")}
                  data-testid="bot-channels-signing-secret-slack"
                />
              </Form.Group>
              <Form.Group controlId="channels-slack-bot-token" className="mb-0">
                <Form.Label>
                  Bot token <span className="text-meta">optional</span>
                </Form.Label>
                <Form.Control
                  size="sm"
                  className="settings-input"
                  type="password"
                  autoComplete="off"
                  placeholder="xoxb-…"
                  {...field("botToken")}
                />
              </Form.Group>
              <div>
                <GatedButton
                  type="submit"
                  size="sm"
                  variant="secondary"
                  deniedReason={denied}
                  disabled={
                    busy ||
                    !draft.clientId.trim() ||
                    draft.clientSecret.trim().length < 8 ||
                    draft.signingSecret.trim().length < 8
                  }
                  data-testid="bot-channels-connect-submit-slack"
                >
                  Connect
                </GatedButton>
              </div>
            </form>
            <p className="text-meta mb-0">
              The bot token is only for an app you installed from Slack's own
              settings; otherwise use Install to Slack. Secrets are stored
              encrypted and never shown again.
            </p>
          </section>
        </div>
      )}
      {error && (
        <Alert
          variant="danger"
          dismissible
          onClose={() => setError(null)}
          data-testid="bot-channels-error-slack"
        >
          {error}
        </Alert>
      )}
      {notice && (
        <Alert
          variant="success"
          dismissible
          onClose={() => setNotice(null)}
          data-testid="bot-channels-notice-slack"
        >
          {notice}
        </Alert>
      )}
      <ConfirmDialog
        show={confirmDisconnect}
        title="Disconnect Slack?"
        confirmLabel="Disconnect"
        busy={busy}
        onConfirm={disconnect}
        onCancel={() => setConfirmDisconnect(false)}
        testId="bot-channels-disconnect-slack"
      >
        {bot.name} stops hearing from and posting to Slack at once. Its
        channels, conversations, and memory stay. Remove the app in Slack too;
        connecting again needs a new app or manifest.
      </ConfirmDialog>
    </div>
  );
}
