import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Form } from "../../ui";
import { SectionCard } from "../sections/SectionCard";
import { useSectionSave } from "../sections/useSectionSave";
import type { ModelAliasesResponse } from "./data";
import { type BotSectionProps, editBot } from "./IdentitySection";

/**
 * The model names a select offers: every name the project defines, plus the
 * bot's current one when the project does not define it yet (a new bot
 * names `default` and `fast` before an admin has set them).
 * @param aliases - `model-alias:list`'s answer, or `null` before it.
 * @param current - The name the bot uses now.
 * @returns The options, each with what it points at.
 */
function aliasOptions(
  aliases: ModelAliasesResponse | null,
  current: string,
): { name: string; detail: string }[] {
  const defined = (aliases?.modelAliases ?? []).map((a) => ({
    name: a.name,
    detail: `${a.modelId}${a.connectionName ? ` via ${a.connectionName}` : ""}`,
  }));
  if (!defined.some((a) => a.name === current)) {
    defined.unshift({ name: current, detail: "not set yet" });
  }
  return defined;
}

/**
 * Which model names the bot uses: its main one, for thinking, and its fast
 * one, for quick, cheap calls. A bot names a model name rather than a model,
 * so an admin re-pointing `default` moves every bot that uses it at once.
 * @param props - See {@link BotSectionProps}, plus the project's model names.
 * @returns The section.
 */
export function ModelSection({
  projectId,
  bot,
  denied,
  onSaved,
  aliases,
}: BotSectionProps & { aliases: ModelAliasesResponse | null }) {
  const { busy, error, notice, setError, setNotice, save } = useSectionSave();
  const [modelAlias, setModelAlias] = useState(bot.modelAlias);
  const [fastModelAlias, setFastModelAlias] = useState(bot.fastModelAlias);
  const locked = denied !== undefined;

  useEffect(() => {
    setModelAlias(bot.modelAlias);
    setFastModelAlias(bot.fastModelAlias);
  }, [bot]);

  const changed =
    modelAlias !== bot.modelAlias || fastModelAlias !== bot.fastModelAlias;

  /** Save the two names. */
  async function onSave() {
    await save(async () => {
      onSaved(
        await editBot(projectId, bot.id, {
          ...(modelAlias !== bot.modelAlias ? { modelAlias } : {}),
          ...(fastModelAlias !== bot.fastModelAlias ? { fastModelAlias } : {}),
        }),
      );
    }, "Saved.");
  }

  return (
    <SectionCard
      title="Model"
      testId="bot-model"
      idPrefix="bot"
      intro={
        <>
          The bot names a model by one of the project's{" "}
          <Link to="/settings/models">model names</Link>, so changing what a
          name points at changes every bot that uses it.
        </>
      }
      error={error}
      notice={notice}
      onDismissError={() => setError(null)}
      onDismissNotice={() => setNotice(null)}
      onSave={onSave}
      canSave={changed}
      saveDeniedReason={denied}
      busy={busy}
    >
      <div className="bot-model-fields">
        <Form.Group controlId="bot-model-alias" className="mb-0">
          <Form.Label>Main model</Form.Label>
          <Form.Select
            size="sm"
            value={modelAlias}
            disabled={busy || locked}
            title={denied}
            onChange={(e) => {
              setModelAlias(e.target.value);
              setNotice(null);
            }}
            data-testid="bot-model-alias"
          >
            {aliasOptions(aliases, bot.modelAlias).map((a) => (
              <option key={a.name} value={a.name}>
                {a.name} — {a.detail}
              </option>
            ))}
          </Form.Select>
          <Form.Text className="text-meta">What it thinks with.</Form.Text>
        </Form.Group>
        <Form.Group controlId="bot-fast-model-alias" className="mb-0">
          <Form.Label>Fast model</Form.Label>
          <Form.Select
            size="sm"
            value={fastModelAlias}
            disabled={busy || locked}
            title={denied}
            onChange={(e) => {
              setFastModelAlias(e.target.value);
              setNotice(null);
            }}
            data-testid="bot-fast-model-alias"
          >
            {aliasOptions(aliases, bot.fastModelAlias).map((a) => (
              <option key={a.name} value={a.name}>
                {a.name} — {a.detail}
              </option>
            ))}
          </Form.Select>
          <Form.Text className="text-meta">
            For quick, cheap calls: summaries, titles, routing.
          </Form.Text>
        </Form.Group>
      </div>
    </SectionCard>
  );
}
