import { useEffect, useRef, useState } from "react";
import { Avatar, Button, Form } from "../../ui";
import { AVATAR_ACCEPT, botAvatarSrc, readAvatar } from "../../utils/avatar";
import { API_URL, apiFetch } from "../../utils/client";
import { SectionCard } from "../sections/SectionCard";
import { useSectionSave } from "../sections/useSectionSave";
import type { Bot, BotStanding } from "./data";
import { PersonaEditor } from "./PersonaEditor";

/** What every section of the bot page is handed. */
export interface BotSectionProps {
  projectId: number;
  bot: Bot;
  /** Why the person may not change this bot, or `undefined` when they may. */
  denied: string | undefined;
  /** Take the server's answer to an edit as the page's new truth. */
  onSaved: (answer: { bot: Bot; standing: BotStanding }) => void;
}

/**
 * Send one `bot:edit`, carrying only the fields given.
 * @param projectId - The project.
 * @param botId - The bot.
 * @param fields - The fields to change.
 * @returns The bot and the caller's standing on it, as the server now has them.
 */
export function editBot(
  projectId: number,
  botId: number,
  fields: Record<string, unknown>,
): Promise<{ bot: Bot; standing: BotStanding }> {
  return apiFetch(`/project/${projectId}/bot/${botId}`, {
    method: "POST",
    body: JSON.stringify(fields),
  });
}

/** The identity fields, as typed. */
interface IdentityDraft {
  name: string;
  displayName: string;
  slug: string;
  description: string;
  persona: string;
  enabled: boolean;
}

/**
 * The fields of a bot this section edits.
 * @param bot - The bot.
 * @returns Its identity, as a draft.
 */
function identityOf(bot: Bot): IdentityDraft {
  return {
    name: bot.name,
    displayName: bot.displayName,
    slug: bot.slug,
    description: bot.description,
    persona: bot.persona,
    enabled: bot.enabled,
  };
}

/**
 * Who the bot is: its avatar (always drawn with the bot badge), its name and
 * the name platforms show, its slug, what it is for, whether it takes new
 * conversations, and its persona, with a preview.
 *
 * The avatar goes up the moment a file is chosen, as its own edit, so a
 * picture is never lost behind an unsaved form; the other fields save
 * together.
 * @param props - See {@link BotSectionProps}.
 * @returns The section.
 */
export function IdentitySection({
  projectId,
  bot,
  denied,
  onSaved,
}: BotSectionProps) {
  const { busy, error, notice, setError, setNotice, save } = useSectionSave();
  const [draft, setDraft] = useState<IdentityDraft>(() => identityOf(bot));
  const fileInput = useRef<HTMLInputElement>(null);
  const locked = denied !== undefined;

  // A save answers with the bot as stored; the form follows it.
  useEffect(() => {
    setDraft(identityOf(bot));
  }, [bot]);

  const saved = identityOf(bot);
  const changed = (Object.keys(saved) as (keyof IdentityDraft)[]).some(
    (key) => draft[key] !== saved[key],
  );
  const valid =
    draft.name.trim() !== "" &&
    draft.displayName.trim() !== "" &&
    draft.slug.trim() !== "" &&
    draft.persona.trim() !== "";

  /** Save the changed identity fields. */
  async function onSave() {
    const fields: Record<string, unknown> = {};
    for (const key of Object.keys(saved) as (keyof IdentityDraft)[]) {
      if (draft[key] !== saved[key]) fields[key] = draft[key];
    }
    await save(async () => {
      onSaved(await editBot(projectId, bot.id, fields));
    }, "Saved.");
  }

  /**
   * Upload the chosen file as the avatar.
   * @param file - The file from the input.
   */
  async function onAvatar(file: File) {
    await save(async () => {
      const avatar = await readAvatar(file);
      onSaved(await editBot(projectId, bot.id, { avatar }));
    }, "Avatar updated.");
    if (fileInput.current) fileInput.current.value = "";
  }

  /** Remove the avatar, back to the monogram. */
  async function onRemoveAvatar() {
    await save(async () => {
      onSaved(await editBot(projectId, bot.id, { avatar: null }));
    }, "Avatar removed.");
  }

  /**
   * Change one field of the draft.
   * @param key - The field.
   * @param value - Its new value.
   */
  function set<K extends keyof IdentityDraft>(key: K, value: IdentityDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setNotice(null);
  }

  return (
    <SectionCard
      title="Identity"
      testId="bot-identity"
      idPrefix="bot"
      error={error}
      notice={notice}
      onDismissError={() => setError(null)}
      onDismissNotice={() => setNotice(null)}
      onSave={onSave}
      canSave={changed && valid}
      saveDeniedReason={denied}
      busy={busy}
    >
      <div className="bot-avatar-field">
        <Avatar
          name={bot.name}
          src={botAvatarSrc(API_URL, bot.avatarUrl)}
          bot
          size={48}
          data-testid="bot-avatar"
        />
        <div className="bot-avatar-controls">
          <div className="d-flex gap-2 flex-wrap">
            <Form.Label visuallyHidden htmlFor="bot-avatar-file">
              Avatar image
            </Form.Label>
            <input
              ref={fileInput}
              id="bot-avatar-file"
              type="file"
              accept={AVATAR_ACCEPT}
              className="visually-hidden"
              disabled={busy || locked}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onAvatar(file);
              }}
              data-testid="bot-avatar-file"
            />
            <Button
              size="sm"
              variant="outline-secondary"
              disabled={busy || locked}
              title={denied}
              onClick={() => fileInput.current?.click()}
              data-testid="bot-avatar-upload"
            >
              {bot.avatarUrl ? "Replace avatar" : "Upload avatar"}
            </Button>
            {bot.avatarUrl && (
              <Button
                size="sm"
                variant="outline-danger"
                disabled={busy || locked}
                title={denied}
                onClick={onRemoveAvatar}
                data-testid="bot-avatar-remove"
              >
                Remove
              </Button>
            )}
          </div>
          <Form.Text className="text-meta">
            A square PNG or JPEG, at most 512 KB. It always carries the bot
            badge.
          </Form.Text>
        </div>
      </div>

      <div className="bot-identity-fields">
        <Form.Group controlId="bot-name" className="mb-0">
          <Form.Label>Name</Form.Label>
          <Form.Control
            size="sm"
            value={draft.name}
            maxLength={80}
            disabled={busy || locked}
            title={denied}
            onChange={(e) => set("name", e.target.value)}
            data-testid="bot-name"
          />
        </Form.Group>
        <Form.Group controlId="bot-display-name" className="mb-0">
          <Form.Label>Display name</Form.Label>
          <Form.Control
            size="sm"
            value={draft.displayName}
            maxLength={80}
            disabled={busy || locked}
            title={denied}
            onChange={(e) => set("displayName", e.target.value)}
            data-testid="bot-display-name"
          />
          <Form.Text className="text-meta">
            The name Slack, Linear, and Pylon show.
          </Form.Text>
        </Form.Group>
        <Form.Group controlId="bot-slug" className="mb-0">
          <Form.Label>Slug</Form.Label>
          <Form.Control
            size="sm"
            className="mono"
            value={draft.slug}
            maxLength={64}
            disabled={busy || locked}
            title={denied}
            onChange={(e) => set("slug", e.target.value)}
            data-testid="bot-slug"
          />
        </Form.Group>
        <Form.Group controlId="bot-description" className="mb-0">
          <Form.Label>Description</Form.Label>
          <Form.Control
            size="sm"
            value={draft.description}
            maxLength={280}
            disabled={busy || locked}
            title={denied}
            onChange={(e) => set("description", e.target.value)}
            data-testid="bot-description"
          />
        </Form.Group>
      </div>

      <Form.Check
        type="switch"
        className="mt-3"
        label="Enabled — takes new conversations"
        checked={draft.enabled}
        disabled={busy || locked}
        onChange={(e) => set("enabled", e.target.checked)}
        data-testid="bot-enabled"
      />

      <Form.Group className="mt-3">
        <Form.Label htmlFor="bot-persona">Persona</Form.Label>
        <PersonaEditor
          id="bot-persona"
          value={draft.persona}
          onChange={(persona) => set("persona", persona)}
          disabled={busy || locked}
          title={denied}
          testId="bot-persona"
        />
        <Form.Text className="text-meta">
          Who the bot is and how it behaves, in markdown. It opens every
          conversation the bot has.
        </Form.Text>
      </Form.Group>
    </SectionCard>
  );
}
