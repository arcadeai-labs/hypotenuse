import type { BotInstallationList } from "@backend/actions/bot-installation/bot-installation-list";
import type { BotInstallationManifest } from "@backend/actions/bot-installation/bot-installation-manifest";
import type { ChannelList } from "@backend/actions/channel/channel-list";
import type { ActionResponse } from "keryx";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Alert, Chip, Form, PlatformChip } from "../../ui";
import {
  APPROVAL_POLICIES,
  BINDING_DELIVERIES,
  BINDING_MODES,
  bindConfirmation,
  INSTALLABLE_PLATFORMS,
  type InstallablePlatform,
  installationStatusLabel,
  parseExternalIds,
  splitChannels,
} from "../../utils/channels";
import { apiFetch } from "../../utils/client";
import { ConfirmDialog } from "../ConfirmDialog";
import { CopyButton } from "../CopyButton";
import { GatedButton } from "../GatedButton";
import { JsonBlock } from "../JsonBlock";
import { SectionCard } from "../sections/SectionCard";
import { useSectionSave } from "../sections/useSectionSave";
import { platformOf } from "../transcript/model";
import { type Bot, useRead } from "./data";
import { SlackPlatformBlock } from "./SlackPlatformBlock";

/** An installation, as `bot-installation:list` serializes it. */
type Installation =
  ActionResponse<BotInstallationList>["installations"][number];

/** `bot-installation:manifest`'s answer, shown once. */
type Manifest = ActionResponse<BotInstallationManifest>;

/** A channel the bot is bound to or has heard from, with its binding or `null`. */
type ChannelRow = ActionResponse<ChannelList>["channels"][number] & {
  binding?: Binding | null;
};

/** A binding, as `channel:list?botId=` carries it. */
interface Binding {
  id: number;
  mode: string;
  defaultDelivery: string;
  approvalPolicy: string;
  approverExternalIds: string[];
  allowPromotion: boolean;
  allowShared: boolean;
  enabled: boolean;
  autoBound: boolean;
}

/** A binding's settings, as typed. */
interface BindingDraft {
  mode: string;
  defaultDelivery: string;
  approvalPolicy: string;
  /** Platform user ids, one per line. */
  approvers: string;
  allowPromotion: boolean;
  enabled: boolean;
}

/** See {@link ChannelsSection}. */
export interface ChannelsSectionProps {
  projectId: number;
  bot: Bot;
  /** Why the person may not change the bot's channels, or `undefined`. */
  denied: string | undefined;
}

/**
 * One platform: its installation for this bot, or the way to make one. Get
 * manifest mints the events URL and shows it once, with the app definition
 * and what to do with it; Connect takes the platform's settings and secret;
 * Test asks the platform to answer; Disconnect uninstalls.
 * @param props.platform - The platform.
 * @param props.installation - The bot's installation on it, if any.
 * @param props.projectId - The project.
 * @param props.bot - The bot.
 * @param props.denied - Why the person may not change it.
 * @param props.onChanged - Read the installations again.
 * @returns The block.
 */
function PlatformBlock({
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
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [deliveryUrl, setDeliveryUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [botUserId, setBotUserId] = useState("");
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const status = installation?.status;
  const connected = status === "active" || status === "error";
  const t = platform.type;

  /** Mint the routing key and show the manifest, once. */
  async function getManifest() {
    await save(async () => {
      const answer = await apiFetch<Manifest>(
        `/project/${projectId}/bot/${bot.id}/installation/${t}/manifest`,
        { method: "POST" },
      );
      setManifest(answer);
      await onChanged();
    }, "Manifest ready. Create the app, then connect it below.");
  }

  /** Connect the installation with its settings and secret. */
  async function connect() {
    await save(async () => {
      await apiFetch(`/project/${projectId}/bot/${bot.id}/installation`, {
        method: "PUT",
        body: JSON.stringify({
          type: t,
          config: { deliveryUrl: deliveryUrl.trim() },
          credentials: { signingSecret: secret },
          ...(botUserId.trim() ? { botUserId: botUserId.trim() } : {}),
        }),
      });
      setSecret("");
      setManifest(null);
      await onChanged();
    }, `Connected. ${bot.name} answers on ${platform.label} now.`);
  }

  /** Ask the platform to answer. */
  async function test() {
    if (!installation) return;
    setNotice(null);
    await save(async () => {
      const answer = await apiFetch<{ ok: boolean; error: string | null }>(
        `/project/${projectId}/bot-installation/${installation.id}/test`,
        { method: "POST" },
      );
      await onChanged();
      if (!answer.ok) throw new Error(answer.error ?? "It did not answer.");
    }, `${platform.label} answered.`);
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
    }, "Disconnected.");
  }

  return (
    <div
      className="channels-platform"
      data-testid={`bot-channels-platform-${t}`}
      data-status={status ?? "none"}
    >
      <div className="channels-platform-head">
        <PlatformChip platform={platformOf(t)} />
        <Chip
          tone={status === "active" ? "accent" : "subtle"}
          data-testid={`bot-channels-status-${t}`}
        >
          {status ? installationStatusLabel(status) : "Not connected"}
        </Chip>
        <span className="channels-platform-actions">
          {connected ? (
            <>
              <GatedButton
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={test}
                data-testid={`bot-channels-test-${t}`}
              >
                Test
              </GatedButton>
              <GatedButton
                size="sm"
                variant="outline-danger"
                deniedReason={denied}
                disabled={busy}
                onClick={() => setConfirmDisconnect(true)}
                data-testid={`bot-channels-disconnect-${t}`}
              >
                Disconnect
              </GatedButton>
            </>
          ) : (
            <GatedButton
              size="sm"
              variant="secondary"
              deniedReason={denied}
              disabled={busy}
              onClick={getManifest}
              data-testid={`bot-channels-manifest-${t}`}
            >
              {status === "pending" ? "Get a new manifest" : "Get manifest"}
            </GatedButton>
          )}
        </span>
      </div>
      <p className="text-meta channels-platform-summary">{platform.summary}</p>
      {installation?.lastError && (
        <Alert variant="warning" data-testid={`bot-channels-last-error-${t}`}>
          {installation.lastError}
        </Alert>
      )}
      {connected && typeof installation?.config.deliveryUrl === "string" && (
        <p className="channels-platform-line">
          Delivers to{" "}
          <span className="mono">{installation.config.deliveryUrl}</span>
          {installation.externalBotUserId && (
            <>
              {" "}
              as <span className="mono">{installation.externalBotUserId}</span>
            </>
          )}
        </p>
      )}
      {manifest && (
        <Alert
          variant="warning"
          data-testid={`bot-channels-manifest-${t}-shown`}
        >
          <p className="mb-2">
            Copy the events URL now: it is shown once. Asking for a new manifest
            makes a new URL and stops this one.
          </p>
          <div className="bot-callback-secret">
            <code className="mono" data-testid={`bot-channels-events-url-${t}`}>
              {manifest.urls.events}
            </code>
            <CopyButton text={manifest.urls.events} label="Copy events URL" />
          </div>
          <p className="mt-2 mb-2">{manifest.instructions}</p>
          <JsonBlock value={manifest.manifest} label="Manifest" />
        </Alert>
      )}
      {status === "pending" && (
        <form
          className="channels-connect"
          onSubmit={(e) => {
            e.preventDefault();
            connect();
          }}
          data-testid={`bot-channels-connect-${t}`}
        >
          <Form.Group controlId={`channels-${t}-delivery`} className="mb-0">
            <Form.Label>Delivery URL</Form.Label>
            <Form.Control
              size="sm"
              className="settings-input"
              type="url"
              placeholder="https://example.com/hypotenuse"
              value={deliveryUrl}
              disabled={busy || denied !== undefined}
              title={denied}
              onChange={(e) => setDeliveryUrl(e.target.value)}
              data-testid={`bot-channels-delivery-${t}`}
            />
            <Form.Text className="text-meta">
              Where {bot.name}'s messages are POSTed, signed.
            </Form.Text>
          </Form.Group>
          <Form.Group controlId={`channels-${t}-secret`} className="mb-0">
            <Form.Label>Signing secret</Form.Label>
            <Form.Control
              size="sm"
              className="settings-input"
              type="password"
              autoComplete="off"
              placeholder="At least 16 characters"
              value={secret}
              disabled={busy || denied !== undefined}
              title={denied}
              onChange={(e) => setSecret(e.target.value)}
              data-testid={`bot-channels-secret-${t}`}
            />
            <Form.Text className="text-meta">
              Both sides sign with it. It is stored encrypted and never shown
              again.
            </Form.Text>
          </Form.Group>
          <Form.Group controlId={`channels-${t}-bot-user`} className="mb-0">
            <Form.Label>
              Bot user id <span className="text-meta">optional</span>
            </Form.Label>
            <Form.Control
              size="sm"
              className="settings-input"
              value={botUserId}
              disabled={busy || denied !== undefined}
              title={denied}
              onChange={(e) => setBotUserId(e.target.value)}
              data-testid={`bot-channels-bot-user-${t}`}
            />
            <Form.Text className="text-meta">
              The sender id the platform gives {bot.name}'s own messages, so it
              never answers itself.
            </Form.Text>
          </Form.Group>
          <div>
            <GatedButton
              type="submit"
              size="sm"
              variant="primary"
              deniedReason={denied}
              disabled={busy || !deliveryUrl.trim() || secret.length < 16}
              data-testid={`bot-channels-connect-submit-${t}`}
            >
              Connect
            </GatedButton>
          </div>
        </form>
      )}
      {error && (
        <Alert
          variant="danger"
          dismissible
          onClose={() => setError(null)}
          data-testid={`bot-channels-error-${t}`}
        >
          {error}
        </Alert>
      )}
      {notice && (
        <Alert
          variant="success"
          dismissible
          onClose={() => setNotice(null)}
          data-testid={`bot-channels-notice-${t}`}
        >
          {notice}
        </Alert>
      )}
      <ConfirmDialog
        show={confirmDisconnect}
        title={`Disconnect ${platform.label}?`}
        confirmLabel="Disconnect"
        busy={busy}
        onConfirm={disconnect}
        onCancel={() => setConfirmDisconnect(false)}
        testId={`bot-channels-disconnect-${t}`}
      >
        {bot.name} stops hearing from and posting to {platform.label} at once.
        Its channels, conversations, and memory stay. Connecting again needs a
        new manifest.
      </ConfirmDialog>
    </div>
  );
}

/**
 * One bound channel's settings, each saved with `channel-binding:edit`.
 * @param props.channel - The channel, with its binding.
 * @param props.projectId - The project.
 * @param props.denied - Why the person may not change it.
 * @param props.onChanged - Read the channels again.
 * @returns The row.
 */
function BindingRow({
  channel,
  projectId,
  denied,
  onChanged,
}: {
  channel: ChannelRow & { binding: Binding };
  projectId: number;
  denied: string | undefined;
  onChanged: () => Promise<void>;
}) {
  const { binding } = channel;
  const { busy, error, notice, setError, setNotice, save } = useSectionSave();
  const [draft, setDraft] = useState<BindingDraft>(() => ({
    mode: binding.mode,
    defaultDelivery: binding.defaultDelivery,
    approvalPolicy: binding.approvalPolicy,
    approvers: binding.approverExternalIds.join("\n"),
    allowPromotion: binding.allowPromotion,
    enabled: binding.enabled,
  }));
  const [confirmUnbind, setConfirmUnbind] = useState(false);
  useEffect(() => {
    setDraft({
      mode: binding.mode,
      defaultDelivery: binding.defaultDelivery,
      approvalPolicy: binding.approvalPolicy,
      approvers: binding.approverExternalIds.join("\n"),
      allowPromotion: binding.allowPromotion,
      enabled: binding.enabled,
    });
  }, [binding]);
  const locked = busy || denied !== undefined;
  const approvers = parseExternalIds(draft.approvers);
  const changed =
    draft.mode !== binding.mode ||
    draft.defaultDelivery !== binding.defaultDelivery ||
    draft.approvalPolicy !== binding.approvalPolicy ||
    approvers.join("\n") !== binding.approverExternalIds.join("\n") ||
    draft.allowPromotion !== binding.allowPromotion ||
    draft.enabled !== binding.enabled;
  const base = `/project/${projectId}/channel-binding/${binding.id}`;
  const testId = `bot-binding-${channel.id}`;

  /**
   * Change one field of the draft.
   * @param patch - The fields.
   */
  function set(patch: Partial<BindingDraft>) {
    setDraft((was) => ({ ...was, ...patch }));
    setNotice(null);
  }

  /** Save what changed. */
  async function onSave() {
    await save(async () => {
      await apiFetch(base, {
        method: "POST",
        body: JSON.stringify({
          mode: draft.mode,
          defaultDelivery: draft.defaultDelivery,
          approvalPolicy: draft.approvalPolicy,
          approverExternalIds: approvers,
          allowPromotion: draft.allowPromotion,
          enabled: draft.enabled,
        }),
      });
      await onChanged();
    }, "Saved.");
  }

  /** Remove the binding. */
  async function onUnbind() {
    setConfirmUnbind(false);
    await save(async () => {
      await apiFetch(base, { method: "DELETE" });
      await onChanged();
    }, "Unbound.");
  }

  return (
    <div className="channels-binding" data-testid={testId}>
      <div className="channels-platform-head">
        <PlatformChip platform={platformOf(channel.type)} />
        <span className="channels-name">{channel.name}</span>
        {channel.isPrivate && <Chip>Private</Chip>}
        {channel.isShared && <Chip>Shared</Chip>}
        {binding.autoBound && (
          <Chip title="It started listening here by itself">Auto-bound</Chip>
        )}
        {!binding.enabled && <Chip>Paused</Chip>}
      </div>
      <div className="channels-binding-fields">
        <Form.Group controlId={`${testId}-mode`} className="mb-0">
          <Form.Label>Listens to</Form.Label>
          <Form.Select
            size="sm"
            value={draft.mode}
            disabled={locked}
            title={denied}
            onChange={(e) => set({ mode: e.target.value })}
            data-testid={`${testId}-mode`}
          >
            {BINDING_MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </Form.Select>
        </Form.Group>
        <Form.Group controlId={`${testId}-delivery`} className="mb-0">
          <Form.Label>A message while it works arrives</Form.Label>
          <Form.Select
            size="sm"
            value={draft.defaultDelivery}
            disabled={locked}
            title={denied}
            onChange={(e) => set({ defaultDelivery: e.target.value })}
            data-testid={`${testId}-delivery`}
          >
            {BINDING_DELIVERIES.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </Form.Select>
        </Form.Group>
        <Form.Group controlId={`${testId}-policy`} className="mb-0">
          <Form.Label>Approvals decided</Form.Label>
          <Form.Select
            size="sm"
            value={draft.approvalPolicy}
            disabled={locked}
            title={denied}
            onChange={(e) => set({ approvalPolicy: e.target.value })}
            data-testid={`${testId}-policy`}
          >
            {APPROVAL_POLICIES.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </Form.Select>
        </Form.Group>
        {draft.approvalPolicy === "listed" && (
          <Form.Group controlId={`${testId}-approvers`} className="mb-0">
            <Form.Label>Who may decide (platform user ids)</Form.Label>
            <Form.Control
              as="textarea"
              rows={2}
              size="sm"
              value={draft.approvers}
              disabled={locked}
              title={denied}
              placeholder="One per line"
              onChange={(e) => set({ approvers: e.target.value })}
              data-testid={`${testId}-approvers`}
            />
          </Form.Group>
        )}
      </div>
      <div className="channels-binding-checks">
        <Form.Check
          id={`${testId}-promotion`}
          label="Its facts may be promoted to project memory"
          checked={draft.allowPromotion}
          disabled={locked}
          onChange={(e) => set({ allowPromotion: e.target.checked })}
          data-testid={`${testId}-promotion`}
        />
        <Form.Check
          id={`${testId}-enabled`}
          label="Listening"
          checked={draft.enabled}
          disabled={locked}
          onChange={(e) => set({ enabled: e.target.checked })}
          data-testid={`${testId}-enabled`}
        />
        <span className="channels-platform-actions">
          <GatedButton
            size="sm"
            variant="primary"
            deniedReason={denied}
            disabled={busy || !changed}
            onClick={onSave}
            data-testid={`${testId}-save`}
          >
            Save
          </GatedButton>
          <GatedButton
            size="sm"
            variant="outline-danger"
            deniedReason={denied}
            disabled={busy}
            onClick={() => setConfirmUnbind(true)}
            data-testid={`${testId}-unbind`}
          >
            Unbind
          </GatedButton>
        </span>
      </div>
      {error && (
        <Alert variant="danger" dismissible onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {notice && (
        <Alert variant="success" dismissible onClose={() => setNotice(null)}>
          {notice}
        </Alert>
      )}
      <ConfirmDialog
        show={confirmUnbind}
        title={`Unbind ${channel.name}?`}
        confirmLabel="Unbind"
        busy={busy}
        onConfirm={onUnbind}
        onCancel={() => setConfirmUnbind(false)}
        testId={`${testId}-unbind`}
      >
        It stops listening there. Its conversations and the channel's memory
        stay, and binding it again picks them up.
      </ConfirmDialog>
    </div>
  );
}

/**
 * The bot page's **Channels**: where the bot listens. Its installations per
 * platform, with the manifest, connection, Test, and Disconnect; the channels
 * it is bound to, each with how it listens, when a message reaches it, who
 * may decide approvals from the channel, and whether its facts may be
 * promoted; and the channels that have messaged it without a binding, each
 * with Bind. Binding a private channel asks first, naming its new audience
 * in so many words, and sends `confirmAudience: true`; a shared channel names
 * the other organization and sends `allowShared: true`.
 * @param props - See {@link ChannelsSectionProps}.
 * @returns The section.
 */
export function ChannelsSection({
  projectId,
  bot,
  denied,
}: ChannelsSectionProps) {
  const installations = useRead<{ installations: Installation[] }>(
    `/project/${projectId}/bot/${bot.id}/installations?limit=100`,
  );
  const channels = useRead<{ channels: ChannelRow[] }>(
    `/project/${projectId}/channels?botId=${bot.id}&limit=100`,
  );
  const { busy, error, notice, setError, setNotice, save } = useSectionSave();
  const [binding, setBinding] = useState<ChannelRow | null>(null);
  const rows = channels.data?.channels ?? [];
  const { bound, unbound } = splitChannels(
    rows.map((c) => ({ ...c, binding: c.binding ?? null })),
  );

  /** Read everything again. */
  async function reload() {
    await Promise.all([installations.reload(), channels.reload()]);
  }

  /**
   * Bind a channel, with what was confirmed.
   * @param channel - The channel.
   */
  async function bind(channel: ChannelRow) {
    setBinding(null);
    await save(async () => {
      await apiFetch(`/project/${projectId}/channel-binding`, {
        method: "PUT",
        body: JSON.stringify({
          botId: bot.id,
          channelId: channel.id,
          ...bindConfirmation(channel).flags,
        }),
      });
      await channels.reload();
    }, `${bot.name} listens in ${channel.name} now.`);
  }

  const confirming = binding ? bindConfirmation(binding) : null;

  return (
    <SectionCard
      title="Channels"
      testId="bot-channels"
      idPrefix="bot"
      intro={
        <>
          Where {bot.name} listens. Anyone who can write in a bound channel may
          talk to it there; everyone who may read {bot.name} here may read those
          conversations. Every platform delivery is in the project's{" "}
          <Link to="/events">events</Link>. You can also{" "}
          <Link to={`/bots/${bot.id}/chat`}>chat with it here</Link>.
        </>
      }
      error={error ?? installations.error ?? channels.error}
      notice={notice}
      onDismissError={() => setError(null)}
      onDismissNotice={() => setNotice(null)}
      busy={busy}
      loading={installations.data === null && !installations.error}
    >
      <div className="channels-section">
        <h3 className="channels-heading">Platforms</h3>
        {INSTALLABLE_PLATFORMS.map((platform) => {
          const Block =
            platform.type === "slack" ? SlackPlatformBlock : PlatformBlock;
          return (
            <Block
              key={platform.type}
              platform={platform}
              installation={
                installations.data?.installations.find(
                  (i) => i.type === platform.type && i.status !== "uninstalled",
                ) ??
                // An uninstalled Slack app keeps its credentials: offer to install it again.
                (platform.type === "slack"
                  ? installations.data?.installations.find(
                      (i) => i.type === "slack",
                    )
                  : undefined)
              }
              projectId={projectId}
              bot={bot}
              denied={denied}
              onChanged={reload}
            />
          );
        })}
        <h3 className="channels-heading">Bound channels</h3>
        {bound.length === 0 ? (
          <p className="text-meta" data-testid="bot-channels-none-bound">
            Not bound anywhere yet.
          </p>
        ) : (
          bound.map((c) => (
            <BindingRow
              key={c.id}
              channel={c as ChannelRow & { binding: Binding }}
              projectId={projectId}
              denied={denied}
              onChanged={reload}
            />
          ))
        )}
        {unbound.length > 0 && (
          <>
            <h3 className="channels-heading">Heard from, not bound</h3>
            <p className="text-meta">
              These channels messaged {bot.name}, which did not answer: it
              listens only where it is bound.
            </p>
            {unbound.map((c) => (
              <div
                key={c.id}
                className="channels-unbound"
                data-testid={`bot-unbound-${c.id}`}
              >
                <PlatformChip platform={platformOf(c.type)} />
                <span className="channels-name">{c.name}</span>
                {c.isPrivate && <Chip>Private</Chip>}
                {c.isShared && <Chip>Shared</Chip>}
                <span className="channels-platform-actions">
                  <GatedButton
                    size="sm"
                    variant="secondary"
                    deniedReason={denied}
                    disabled={busy}
                    onClick={() =>
                      bindConfirmation(c).sentences.length > 0
                        ? setBinding(c)
                        : bind(c)
                    }
                    data-testid={`bot-unbound-${c.id}-bind`}
                  >
                    Bind
                  </GatedButton>
                </span>
              </div>
            ))}
          </>
        )}
      </div>
      <ConfirmDialog
        show={binding !== null}
        title={`Bind ${binding?.name ?? "this channel"}?`}
        confirmLabel="Bind"
        busy={busy}
        onConfirm={() => binding && bind(binding)}
        onCancel={() => setBinding(null)}
        testId="bot-bind-confirm"
      >
        {confirming?.sentences.map((s) => (
          <p key={s} data-testid="bot-bind-confirm-sentence">
            {s}
          </p>
        ))}
      </ConfirmDialog>
    </SectionCard>
  );
}
