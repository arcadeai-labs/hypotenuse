import type { BotInstallationList } from "@backend/actions/bot-installation/bot-installation-list";
import type { BotInstallationManifest } from "@backend/actions/bot-installation/bot-installation-manifest";
import type { ActionResponse } from "keryx";
import { useEffect, useState } from "react";
import { Alert, Chip, Form, PlatformChip } from "../../ui";
import {
  CUSTOMER_REPLY_POLICIES,
  type CustomerReplyPolicyChoice,
  type InstallablePlatform,
  installationStatusLabel,
  parseExternalIds,
} from "../../utils/channels";
import { apiFetch } from "../../utils/client";
import { ConfirmDialog } from "../ConfirmDialog";
import { CopyButton } from "../CopyButton";
import { GatedButton } from "../GatedButton";
import { useSectionSave } from "../sections/useSectionSave";
import { type Bot, useRead } from "./data";

/** An installation, as `bot-installation:list` serializes it. */
type Installation =
  ActionResponse<BotInstallationList>["installations"][number];

/** One Trigger the manifest asks a Pylon admin to create. */
interface ManifestTrigger {
  kickoff: string;
  action: string;
  body: string;
}

/** `bot-installation:manifest`'s answer for Pylon, shown once. */
type Manifest = ActionResponse<BotInstallationManifest> & {
  manifest: { triggers?: ManifestTrigger[] };
};

/** What a person types to connect. */
interface Draft {
  region: "us" | "eu";
  selfName: string;
  apiToken: string;
  webhookSecret: string;
}

/** The bot's Pylon settings, as edited. */
interface Settings {
  customerReplyPolicy: CustomerReplyPolicyChoice;
  autoTriage: boolean;
  mention: boolean;
  assignment: boolean;
  tags: string;
  teamIds: string;
  legacySignature: boolean;
}

/**
 * The settings an installation holds, defaults filled in.
 * @param installation - The installation.
 * @returns The settings.
 */
function settingsOf(installation: Installation | undefined): Settings {
  const c = (installation?.config ?? {}) as Record<string, unknown>;
  const triggers = (c.triggers ?? {}) as Record<string, boolean>;
  const listen = (c.listen ?? {}) as { tags?: string[]; teamIds?: string[] };
  const policy = CUSTOMER_REPLY_POLICIES.find(
    (p) => p.value === c.customerReplyPolicy,
  );
  return {
    customerReplyPolicy: policy?.value ?? "never",
    autoTriage: triggers.autoTriage !== false,
    mention: triggers.mention !== false,
    assignment: triggers.assignment !== false,
    tags: (listen.tags ?? []).join(", "),
    teamIds: (listen.teamIds ?? []).join(", "),
    legacySignature: c.legacySignature === true,
  };
}

/**
 * **Pylon, on the bot's Channels section.** Each bot works a support queue
 * as its own Pylon teammate:
 *
 * 1. Set it up in Pylon — Get the setup (the webhook URL, shown once, the
 *    token to create with its own identity, and the four Triggers with the
 *    body each sends).
 * 2. Connect — the region, the token's name, the API token, and the webhook
 *    secret; Hypotenuse asks Pylon who the token is at once.
 * 3. Customer replies — the policy, in plain words; a project admin's choice.
 * 4. Triggers and listen filters.
 * 5. Health — the last delivery received, Test, and Disconnect.
 * @param props.platform - Pylon's entry in the platform list.
 * @param props.installation - The bot's Pylon installation, if any.
 * @param props.projectId - The project.
 * @param props.bot - The bot.
 * @param props.denied - Why the person may not connect it.
 * @param props.settingsDenied - Why the person may not change its settings (admins only).
 * @param props.onChanged - Read the installations again.
 * @returns The block.
 */
export function PylonPlatformBlock({
  platform,
  installation,
  projectId,
  bot,
  denied,
  settingsDenied,
  onChanged,
}: {
  platform: InstallablePlatform;
  installation: Installation | undefined;
  projectId: number;
  bot: Bot;
  denied: string | undefined;
  settingsDenied?: string | undefined;
  onChanged: () => Promise<void>;
}) {
  const { busy, error, notice, setError, setNotice, save } = useSectionSave();
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [draft, setDraft] = useState<Draft>({
    region: "us",
    selfName: bot.name,
    apiToken: "",
    webhookSecret: "",
  });
  const [settings, setSettings] = useState<Settings>(settingsOf(installation));
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const status = installation?.status;
  const connected = status === "active" || status === "error";
  const config = (installation?.config ?? {}) as Record<string, unknown>;
  const off = busy || denied !== undefined;
  const settingsOff = busy || settingsDenied !== undefined;
  const lastEvent = useRead<{
    triggerEvents: { receivedAt: number; outcome: string | null }[];
  }>(
    installation && connected
      ? `/project/${projectId}/trigger-events?botInstallationId=${installation.id}&limit=1`
      : null,
  );

  // Show what is saved whenever the installation is read again.
  useEffect(() => {
    setSettings(settingsOf(installation));
  }, [installation]);

  /** Mint the routing key and show the setup, once. */
  async function getManifest() {
    await save(async () => {
      const answer = await apiFetch<Manifest>(
        `/project/${projectId}/bot/${bot.id}/installation/pylon/manifest`,
        { method: "POST" },
      );
      setManifest(answer);
      await onChanged();
    }, "Setup ready. Do it in Pylon, then connect below.");
  }

  /** Connect the token and the webhook secret. */
  async function connect() {
    await save(async () => {
      const answer = await apiFetch<{
        installation: { status: string; lastError: string | null };
      }>(`/project/${projectId}/bot/${bot.id}/installation`, {
        method: "PUT",
        body: JSON.stringify({
          type: "pylon",
          config: { region: draft.region, selfName: draft.selfName.trim() },
          credentials: {
            apiToken: draft.apiToken.trim(),
            webhookSecret: draft.webhookSecret.trim(),
          },
        }),
      });
      setDraft({ ...draft, apiToken: "", webhookSecret: "" });
      setManifest(null);
      await onChanged();
      if (answer.installation.status === "error") {
        throw new Error(
          answer.installation.lastError ?? "Pylon refused the token.",
        );
      }
    }, `Connected. ${bot.name} writes internal notes on the issues it works.`);
  }

  /** Save the policy, triggers, and filters. */
  async function saveSettings() {
    await save(async () => {
      await apiFetch(`/project/${projectId}/bot/${bot.id}/pylon/settings`, {
        method: "POST",
        body: JSON.stringify({
          customerReplyPolicy: settings.customerReplyPolicy,
          triggers: {
            autoTriage: settings.autoTriage,
            mention: settings.mention,
            assignment: settings.assignment,
          },
          listen: {
            tags: parseExternalIds(settings.tags),
            teamIds: parseExternalIds(settings.teamIds),
          },
          legacySignature: settings.legacySignature,
        }),
      });
      await onChanged();
    }, "Saved.");
  }

  /** Ask Pylon who the token is. */
  async function test() {
    if (!installation) return;
    await save(async () => {
      const answer = await apiFetch<{ ok: boolean; error: string | null }>(
        `/project/${projectId}/bot-installation/${installation.id}/test`,
        { method: "POST" },
      );
      await onChanged();
      if (!answer.ok) throw new Error(answer.error ?? "Pylon did not answer.");
    }, "Pylon answered.");
  }

  /** Disconnect. */
  async function disconnect() {
    if (!installation) return;
    setConfirmDisconnect(false);
    await save(async () => {
      await apiFetch(
        `/project/${projectId}/bot-installation/${installation.id}`,
        { method: "DELETE" },
      );
      await onChanged();
    }, "Disconnected. Delete the token and the webhook in Pylon too.");
  }

  const field = (key: "selfName" | "apiToken" | "webhookSecret") => ({
    value: draft[key],
    disabled: off,
    title: denied,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
      setDraft({ ...draft, [key]: e.target.value }),
  });
  const toggle = (
    key: "autoTriage" | "mention" | "assignment" | "legacySignature",
  ) => ({
    checked: settings[key],
    disabled: settingsOff,
    title: settingsDenied,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
      setSettings({ ...settings, [key]: e.target.checked }),
  });
  const last = lastEvent.data?.triggerEvents[0];

  return (
    <div
      className="channels-platform"
      data-testid="bot-channels-platform-pylon"
      data-status={status ?? "none"}
    >
      <div className="channels-platform-head">
        <PlatformChip platform="pylon" />
        <Chip
          tone={status === "active" ? "accent" : "subtle"}
          data-testid="bot-channels-status-pylon"
        >
          {status ? installationStatusLabel(status) : "Not connected"}
        </Chip>
        <span className="channels-platform-actions">
          <GatedButton
            size="sm"
            variant="secondary"
            disabled={busy || !connected}
            onClick={test}
            data-testid="bot-channels-test-pylon"
          >
            Test
          </GatedButton>
          <GatedButton
            size="sm"
            variant="outline-danger"
            deniedReason={denied}
            disabled={busy || !installation}
            onClick={() => setConfirmDisconnect(true)}
            data-testid="bot-channels-disconnect-pylon"
          >
            Disconnect
          </GatedButton>
        </span>
      </div>
      <p className="text-meta channels-platform-summary">{platform.summary}</p>
      {installation?.lastError && (
        <Alert variant="warning" data-testid="bot-channels-last-error-pylon">
          {installation.lastError}
        </Alert>
      )}
      {connected && (
        <p
          className="channels-platform-line"
          data-testid="bot-channels-pylon-connected"
        >
          Connected to{" "}
          <strong>{String(config.organizationName ?? "Pylon")}</strong> (
          {String(config.region ?? "us").toUpperCase()}) as{" "}
          <strong>{String(config.selfName ?? bot.name)}</strong>.{" "}
          {last
            ? `Last delivery ${new Date(last.receivedAt).toLocaleString()} (${last.outcome ?? "pending"}).`
            : "No delivery received yet: check the webhook and its Triggers in Pylon."}
        </p>
      )}
      {!connected && (
        <div
          className="channels-slack-paths"
          data-testid="bot-channels-create-pylon"
        >
          <section className="channels-slack-path">
            <h4 className="channels-slack-path-title">
              1. Set {bot.name} up in Pylon
            </h4>
            <p className="text-meta mb-0">
              A Pylon admin creates an API token{" "}
              <strong>with its own identity</strong>, named {bot.name} (Settings
              → Integrations &amp; dev → API tokens), a webhook to {bot.name}'s
              URL, and four Triggers that send it.
            </p>
            <div>
              <GatedButton
                size="sm"
                variant="secondary"
                deniedReason={denied}
                disabled={busy}
                onClick={getManifest}
                data-testid="bot-channels-manifest-pylon"
              >
                {status === "pending" ? "Get a new setup" : "Get the setup"}
              </GatedButton>
            </div>
            {manifest && (
              <Alert
                variant="warning"
                className="mb-0"
                data-testid="bot-channels-manifest-pylon-shown"
              >
                <p className="mb-2">
                  The webhook URL is shown once: create the webhook now. Asking
                  again makes a new URL and stops this one.
                </p>
                <div className="bot-callback-secret">
                  <code className="mono">{manifest.urls.events}</code>
                  <CopyButton text={manifest.urls.events} label="Copy URL" />
                </div>
                <p className="mb-2 text-meta">{manifest.instructions}</p>
                <ol
                  className="pylon-triggers"
                  data-testid="bot-channels-pylon-triggers"
                >
                  {(manifest.manifest.triggers ?? []).map((t) => (
                    <li key={t.kickoff}>
                      <strong>{t.kickoff}</strong> → {t.action}
                      <div className="bot-callback-secret">
                        <code className="mono pylon-trigger-body">
                          {t.body}
                        </code>
                        <CopyButton text={t.body} label="Copy body" />
                      </div>
                    </li>
                  ))}
                </ol>
              </Alert>
            )}
          </section>
          <section className="channels-slack-path">
            <h4 className="channels-slack-path-title">
              2. Connect the token and the webhook
            </h4>
            <p className="text-meta mb-0">
              Stored encrypted and never shown again. Hypotenuse asks Pylon who
              the token is when you connect.
            </p>
            <form
              className="channels-connect"
              onSubmit={(e) => {
                e.preventDefault();
                connect();
              }}
              data-testid="bot-channels-connect-pylon"
            >
              <Form.Group controlId="channels-pylon-region" className="mb-0">
                <Form.Label>Region</Form.Label>
                <Form.Select
                  size="sm"
                  className="settings-input"
                  value={draft.region}
                  disabled={off}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      region: e.target.value as "us" | "eu",
                    })
                  }
                  data-testid="bot-channels-region-pylon"
                >
                  <option value="us">US (api.usepylon.com)</option>
                  <option value="eu">EU (api.eu.usepylon.com)</option>
                </Form.Select>
              </Form.Group>
              <Form.Group controlId="channels-pylon-self-name" className="mb-0">
                <Form.Label>The token's name in Pylon</Form.Label>
                <Form.Control
                  size="sm"
                  className="settings-input"
                  {...field("selfName")}
                  data-testid="bot-channels-self-name-pylon"
                />
              </Form.Group>
              <Form.Group controlId="channels-pylon-token" className="mb-0">
                <Form.Label>API token</Form.Label>
                <Form.Control
                  size="sm"
                  className="settings-input"
                  type="password"
                  autoComplete="off"
                  {...field("apiToken")}
                  data-testid="bot-channels-token-pylon"
                />
              </Form.Group>
              <Form.Group controlId="channels-pylon-secret" className="mb-0">
                <Form.Label>Webhook secret</Form.Label>
                <Form.Control
                  size="sm"
                  className="settings-input"
                  type="password"
                  autoComplete="off"
                  {...field("webhookSecret")}
                  data-testid="bot-channels-webhook-secret-pylon"
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
                    !installation ||
                    draft.apiToken.trim().length < 8 ||
                    draft.webhookSecret.trim().length < 8
                  }
                  title={installation ? undefined : "Get the setup first"}
                  data-testid="bot-channels-connect-submit-pylon"
                >
                  Connect
                </GatedButton>
              </div>
            </form>
          </section>
        </div>
      )}
      {installation && (
        <form
          className="pylon-settings"
          onSubmit={(e) => {
            e.preventDefault();
            saveSettings();
          }}
          data-testid="bot-channels-pylon-settings"
        >
          <fieldset className="pylon-settings-group">
            <legend className="channels-slack-path-title">
              Replies to customers
            </legend>
            {CUSTOMER_REPLY_POLICIES.map((p) => (
              <Form.Check
                key={p.value}
                type="radio"
                id={`pylon-policy-${p.value}`}
                name="pylon-policy"
                checked={settings.customerReplyPolicy === p.value}
                disabled={settingsOff}
                title={settingsDenied}
                onChange={() =>
                  setSettings({ ...settings, customerReplyPolicy: p.value })
                }
                label={
                  <>
                    <strong>{p.label}</strong>{" "}
                    <span className="text-meta">{p.consequence}</span>
                  </>
                }
                data-testid={`bot-channels-pylon-policy-${p.value}`}
              />
            ))}
          </fieldset>
          <fieldset className="pylon-settings-group">
            <legend className="channels-slack-path-title">
              What starts work
            </legend>
            <Form.Check
              id="pylon-trigger-auto-triage"
              label="Every new issue (auto-triage)"
              {...toggle("autoTriage")}
            />
            <Form.Check
              id="pylon-trigger-mention"
              label={`An internal note that mentions ${String(config.selfName ?? bot.name)}`}
              {...toggle("mention")}
            />
            <Form.Check
              id="pylon-trigger-assignment"
              label={`An issue assigned to ${String(config.selfName ?? bot.name)}`}
              {...toggle("assignment")}
            />
            <Form.Group controlId="pylon-listen-tags" className="mt-2 mb-0">
              <Form.Label>
                New issues only with these tags (any when empty)
              </Form.Label>
              <Form.Control
                size="sm"
                className="settings-input"
                value={settings.tags}
                disabled={settingsOff}
                title={settingsDenied}
                onChange={(e) =>
                  setSettings({ ...settings, tags: e.target.value })
                }
                data-testid="bot-channels-pylon-tags"
              />
            </Form.Group>
            <Form.Group controlId="pylon-listen-teams" className="mb-0">
              <Form.Label>…and in these team ids (any when empty)</Form.Label>
              <Form.Control
                size="sm"
                className="settings-input"
                value={settings.teamIds}
                disabled={settingsOff}
                title={settingsDenied}
                onChange={(e) =>
                  setSettings({ ...settings, teamIds: e.target.value })
                }
                data-testid="bot-channels-pylon-teams"
              />
            </Form.Group>
            <Form.Check
              className="mt-2"
              id="pylon-legacy-signature"
              label="Also accept the legacy signature (no timestamp; only for an old webhook)"
              {...toggle("legacySignature")}
            />
          </fieldset>
          <div>
            <GatedButton
              type="submit"
              size="sm"
              variant="secondary"
              deniedReason={settingsDenied}
              disabled={busy}
              data-testid="bot-channels-pylon-settings-save"
            >
              Save Pylon settings
            </GatedButton>
          </div>
        </form>
      )}
      {error && (
        <Alert
          variant="danger"
          dismissible
          onClose={() => setError(null)}
          data-testid="bot-channels-error-pylon"
        >
          {error}
        </Alert>
      )}
      {notice && (
        <Alert
          variant="success"
          dismissible
          onClose={() => setNotice(null)}
          data-testid="bot-channels-notice-pylon"
        >
          {notice}
        </Alert>
      )}
      <ConfirmDialog
        show={confirmDisconnect}
        title="Disconnect Pylon?"
        confirmLabel="Disconnect"
        busy={busy}
        onConfirm={disconnect}
        onCancel={() => setConfirmDisconnect(false)}
        testId="bot-channels-disconnect-pylon"
      >
        {bot.name} stops hearing from and writing to Pylon at once. Its
        channels, conversations, and memory stay. Delete its token and webhook
        in Pylon too.
      </ConfirmDialog>
    </div>
  );
}
