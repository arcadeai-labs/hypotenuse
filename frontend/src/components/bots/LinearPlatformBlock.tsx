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
type Manifest = ActionResponse<BotInstallationManifest> & { link?: string };

/** The app's credentials, as typed. */
interface Draft {
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
}

const EMPTY_DRAFT: Draft = {
  clientId: "",
  clientSecret: "",
  webhookSecret: "",
};

/**
 * A string setting of an installation's config, if it has one.
 * @param installation - The installation.
 * @param key - The setting.
 * @returns The value, or `null`.
 */
function setting(
  installation: Installation | undefined,
  key: string,
): string | null {
  const v = installation?.config[key];
  return typeof v === "string" && v ? v : null;
}

/**
 * **Linear, on the bot's Channels section.** Each bot is its own Linear app,
 * so it is its own delegate and mention in Linear:
 *
 * 1. Create it — Get the creation link (Linear's new-application form,
 *    pre-filled with the bot's name, webhook, and redirect; the webhook URL
 *    inside is shown once), create the app in Linear, and connect its Client
 *    ID, Client Secret, and webhook signing secret.
 * 2. Install it — Linear's OAuth with `actor=app`, which lands back on this
 *    page with `?installed=linear` or `?installError=…`.
 * 3. Then Test and Disconnect, like any platform.
 *
 * Every step is drawn in every state, disabled where it does not apply yet.
 * @param props.platform - Linear's entry in the platform list.
 * @param props.installation - The bot's Linear installation, if any.
 * @param props.projectId - The project.
 * @param props.bot - The bot.
 * @param props.denied - Why the person may not change it.
 * @param props.onChanged - Read the installations again.
 * @returns The block.
 */
export function LinearPlatformBlock({
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
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const status = installation?.status;
  const created = Boolean(installation?.hasCredentials);
  const installed = status === "active" || status === "error";
  const workspace =
    setting(installation, "organizationName") ??
    installation?.externalWorkspaceId;
  const appUser = setting(installation, "appUserName");
  const teamAccess = installation?.config.teamAccess as
    | { canAccessAllPublicTeams: boolean; teamIds: string[] }
    | undefined;
  const off = busy || denied !== undefined;

  // The install's landing: `?installed=linear` or `?installError=…`.
  useEffect(() => {
    const installedParam = params.get("installed");
    const installError = params.get("installError");
    if (installedParam !== "linear" && !installError) return;
    if (installError) setError(installError);
    else
      setNotice(
        `Installed. Delegate an issue to ${bot.name}, or mention it, in Linear.`,
      );
    const next = new URLSearchParams(params);
    for (const key of ["installed", "installError", "installation"]) {
      next.delete(key);
    }
    setParams(next, { replace: true });
  }, [params, setParams, setError, setNotice, bot.name]);

  /** Mint the routing key and show the creation link, once. */
  async function getManifest() {
    await save(async () => {
      const answer = await apiFetch<Manifest>(
        `/project/${projectId}/bot/${bot.id}/installation/linear/manifest`,
        { method: "POST" },
      );
      setManifest(answer);
      await onChanged();
    }, "Link ready. Create the app in Linear, then connect it below.");
  }

  /** Connect the app created in Linear. */
  async function connect() {
    await save(async () => {
      await apiFetch(`/project/${projectId}/bot/${bot.id}/installation`, {
        method: "PUT",
        body: JSON.stringify({
          type: "linear",
          config: { clientId: draft.clientId.trim() },
          credentials: {
            clientSecret: draft.clientSecret.trim(),
            webhookSecret: draft.webhookSecret.trim(),
          },
        }),
      });
      setDraft(EMPTY_DRAFT);
      setManifest(null);
      await onChanged();
    }, "Connected. Now install it into your workspace.");
  }

  /** Send the browser to Linear's install page. */
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

  /** Ask Linear to answer. */
  async function test() {
    if (!installation) return;
    await save(async () => {
      const answer = await apiFetch<{ ok: boolean; error: string | null }>(
        `/project/${projectId}/bot-installation/${installation.id}/test`,
        { method: "POST" },
      );
      await onChanged();
      if (!answer.ok) throw new Error(answer.error ?? "Linear did not answer.");
    }, "Linear answered.");
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
    }, "Disconnected. Remove the app in Linear too.");
  }

  const field = (key: keyof Draft) => ({
    value: draft[key],
    disabled: off || installed,
    title: denied,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
      setDraft({ ...draft, [key]: e.target.value }),
  });

  return (
    <div
      className="channels-platform"
      data-testid="bot-channels-platform-linear"
      data-status={status ?? "none"}
    >
      <div className="channels-platform-head">
        <PlatformChip platform="linear" />
        <Chip
          tone={status === "active" ? "accent" : "subtle"}
          data-testid="bot-channels-status-linear"
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
            title={created ? undefined : "Connect the app first"}
            onClick={install}
            data-testid="bot-channels-install-linear"
          >
            {installed ? "Reinstall" : "Install to Linear"}
          </GatedButton>
          <GatedButton
            size="sm"
            variant="secondary"
            disabled={busy || !installed}
            onClick={test}
            data-testid="bot-channels-test-linear"
          >
            Test
          </GatedButton>
          <GatedButton
            size="sm"
            variant="outline-danger"
            deniedReason={denied}
            disabled={busy || !installation}
            onClick={() => setConfirmDisconnect(true)}
            data-testid="bot-channels-disconnect-linear"
          >
            Disconnect
          </GatedButton>
        </span>
      </div>
      <p className="text-meta channels-platform-summary">{platform.summary}</p>
      {installation?.lastError && (
        <Alert variant="warning" data-testid="bot-channels-last-error-linear">
          {installation.lastError}
        </Alert>
      )}
      {installed && (
        <p
          className="channels-platform-line"
          data-testid="bot-channels-linear-installed"
        >
          Installed in <strong>{workspace}</strong>
          {appUser && (
            <>
              {" "}
              as <strong>{appUser}</strong>
            </>
          )}
          {teamAccess && (
            <>
              {" "}
              —{" "}
              {teamAccess.canAccessAllPublicTeams
                ? "every public team"
                : `${teamAccess.teamIds.length} team${teamAccess.teamIds.length === 1 ? "" : "s"}`}
            </>
          )}
          . Delegate an issue to it, or mention it, to start a session; each
          Linear project is its own channel.
        </p>
      )}
      {!installed && (
        <div
          className="channels-slack-paths"
          data-testid="bot-channels-create-linear"
        >
          <section className="channels-slack-path">
            <h4 className="channels-slack-path-title">
              1. Create {bot.name}'s app in Linear
            </h4>
            <p className="text-meta mb-0">
              A Linear workspace admin opens the creation link — Linear's new
              application form, filled in with {bot.name}'s name, webhook, and
              redirect — and creates the app. On the app's page, also turn on
              the OAuthApp webhook, so an uninstall reaches Hypotenuse.
            </p>
            <div>
              <GatedButton
                size="sm"
                variant="secondary"
                deniedReason={denied}
                disabled={busy}
                onClick={getManifest}
                data-testid="bot-channels-manifest-linear"
              >
                {status === "pending"
                  ? "Get a new creation link"
                  : "Get the creation link"}
              </GatedButton>
            </div>
            {manifest && (
              <Alert
                variant="warning"
                className="mb-0"
                data-testid="bot-channels-manifest-linear-shown"
              >
                <p className="mb-2">
                  The webhook URL inside is shown once: create the app now.
                  Asking for a new link makes a new URL and stops this one.
                </p>
                {manifest.link && (
                  <p className="mb-2">
                    <a
                      href={manifest.link}
                      target="_blank"
                      rel="noreferrer"
                      data-testid="bot-channels-creation-link-linear"
                    >
                      Open Linear's new application form
                    </a>
                  </p>
                )}
                <div className="bot-callback-secret">
                  <code className="mono">{manifest.urls.events}</code>
                  <CopyButton
                    text={JSON.stringify(manifest.manifest, null, 2)}
                    label="Copy manifest"
                  />
                </div>
                <p className="mb-2 text-meta">{manifest.instructions}</p>
                <JsonBlock value={manifest.manifest} label="Manifest" />
              </Alert>
            )}
          </section>
          <section className="channels-slack-path">
            <h4 className="channels-slack-path-title">
              2. Connect the app's credentials
            </h4>
            <p className="text-meta mb-0">
              From the app's page in Linear (Settings → API → the app). Secrets
              are stored encrypted and never shown again.
            </p>
            <form
              className="channels-connect"
              onSubmit={(e) => {
                e.preventDefault();
                connect();
              }}
              data-testid="bot-channels-connect-linear"
            >
              <Form.Group
                controlId="channels-linear-client-id"
                className="mb-0"
              >
                <Form.Label>Client ID</Form.Label>
                <Form.Control
                  size="sm"
                  className="settings-input"
                  {...field("clientId")}
                  data-testid="bot-channels-client-id-linear"
                />
              </Form.Group>
              <Form.Group
                controlId="channels-linear-client-secret"
                className="mb-0"
              >
                <Form.Label>Client Secret</Form.Label>
                <Form.Control
                  size="sm"
                  className="settings-input"
                  type="password"
                  autoComplete="off"
                  {...field("clientSecret")}
                  data-testid="bot-channels-client-secret-linear"
                />
              </Form.Group>
              <Form.Group
                controlId="channels-linear-webhook-secret"
                className="mb-0"
              >
                <Form.Label>Webhook signing secret</Form.Label>
                <Form.Control
                  size="sm"
                  className="settings-input"
                  type="password"
                  autoComplete="off"
                  {...field("webhookSecret")}
                  data-testid="bot-channels-webhook-secret-linear"
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
                    draft.clientId.trim().length < 8 ||
                    draft.clientSecret.trim().length < 8 ||
                    draft.webhookSecret.trim().length < 8
                  }
                  data-testid="bot-channels-connect-submit-linear"
                >
                  Connect
                </GatedButton>
              </div>
            </form>
            <p className="text-meta mb-0">
              3. Then Install to Linear, as a workspace admin.
            </p>
          </section>
        </div>
      )}
      {error && (
        <Alert
          variant="danger"
          dismissible
          onClose={() => setError(null)}
          data-testid="bot-channels-error-linear"
        >
          {error}
        </Alert>
      )}
      {notice && (
        <Alert
          variant="success"
          dismissible
          onClose={() => setNotice(null)}
          data-testid="bot-channels-notice-linear"
        >
          {notice}
        </Alert>
      )}
      <ConfirmDialog
        show={confirmDisconnect}
        title="Disconnect Linear?"
        confirmLabel="Disconnect"
        busy={busy}
        onConfirm={disconnect}
        onCancel={() => setConfirmDisconnect(false)}
        testId="bot-channels-disconnect-linear"
      >
        {bot.name} stops hearing from and writing to Linear at once. Its
        channels, conversations, and memory stay. Remove the app in Linear too;
        connecting again needs a new creation link.
      </ConfirmDialog>
    </div>
  );
}
