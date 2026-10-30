import { useEffect, useState } from "react";
import { Chip, Form, ProgressBar } from "../../ui";
import { apiFetch } from "../../utils/client";
import { budgetUsage } from "../../utils/prompts";
import { CopyButton } from "../CopyButton";
import type { PromptPreviewResult } from "./data";

/** The preview's state. */
type Preview =
  | { state: "loading" }
  | { state: "loaded"; prompt: PromptPreviewResult }
  | { state: "failed"; message: string };

/** How long typing must pause before the preview is asked again. */
const DEBOUNCE_MS = 300;

/**
 * The system prompt the bot would be sent, assembled by the server exactly as
 * a step assembles it (`prompt:preview`): its estimated size against the
 * bot's budget, its hash, the sections included and the contextual ones the
 * budget dropped, the words contextual sections were matched on, and the
 * text itself. A sample message decides which contextual sections come in,
 * as the latest message of a conversation would.
 * @param props.projectId - The project.
 * @param props.botId - The bot.
 * @param props.version - Bumped by the page after a save, so the preview is asked again.
 * @returns The pane.
 */
export function PromptPreviewPane({
  projectId,
  botId,
  version,
}: {
  projectId: number;
  botId: number;
  version: number;
}) {
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<Preview>({ state: "loading" });

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(
      () => {
        const query = message.trim()
          ? `?${new URLSearchParams({ message })}`
          : "";
        apiFetch<{ prompt: PromptPreviewResult }>(
          `/project/${projectId}/bot/${botId}/prompt-preview${query}`,
        )
          .then((res) => {
            if (!cancelled) setPreview({ state: "loaded", prompt: res.prompt });
          })
          .catch((err) => {
            if (!cancelled)
              setPreview({
                state: "failed",
                message:
                  err instanceof Error
                    ? err.message
                    : "Could not preview the prompt.",
              });
          });
      },
      // The first read, and a re-read after a save, go at once.
      message ? DEBOUNCE_MS : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `version` is in the list so a save asks again.
  }, [projectId, botId, message, version]);

  const prompt = preview.state === "loaded" ? preview.prompt : null;
  const usage = prompt
    ? budgetUsage(prompt.estimatedTokens, prompt.budgetTokens)
    : null;

  return (
    <section
      className="prompt-preview"
      aria-label="Preview"
      data-testid="prompt-preview"
    >
      <h2 className="prompt-preview-title">Preview</h2>
      <Form.Group controlId="prompt-preview-message" className="mb-0">
        <Form.Label>A message to it</Form.Label>
        <Form.Control
          as="textarea"
          rows={2}
          size="sm"
          value={message}
          placeholder="Can you draft the release notes for 2.4?"
          onChange={(e) => setMessage(e.target.value)}
          data-testid="prompt-preview-message"
        />
        <Form.Text className="text-meta">
          Contextual sections come in when one of their keywords is in the
          latest message, the conversation's title, or the channel's name.
        </Form.Text>
      </Form.Group>

      {preview.state === "failed" && (
        <p className="text-danger mb-0" data-testid="prompt-preview-error">
          {preview.message}
        </p>
      )}
      {preview.state === "loading" && (
        <p className="text-meta mb-0">Assembling its prompt…</p>
      )}
      {prompt && usage && (
        <>
          <div className="prompt-preview-budget">
            <div className="prompt-preview-budget-head">
              <span>Size</span>
              <span
                className="text-meta tabular"
                data-testid="prompt-preview-tokens"
                data-over={usage.over}
              >
                about {prompt.estimatedTokens.toLocaleString()} of{" "}
                {prompt.budgetTokens.toLocaleString()} tokens
              </span>
            </div>
            <ProgressBar
              now={usage.percent}
              variant={usage.over ? "danger" : "primary"}
              aria-label="Prompt size against its budget"
            />
            {prompt.overBudget && (
              <p
                className="text-danger mb-0"
                data-testid="prompt-preview-over-budget"
              >
                The parts that are always included are over the budget. Make a
                section contextual, shorten one, or raise the bot's prompt
                budget.
              </p>
            )}
          </div>

          <div className="prompt-preview-hash">
            <span className="text-meta">Hash</span>
            <code
              className="prompt-preview-hash-value"
              title={prompt.hash}
              data-testid="prompt-preview-hash"
            >
              {prompt.hash.slice(0, 12)}
            </code>
            <CopyButton text={prompt.hash} label="Copy the hash" />
          </div>

          {prompt.contextTerms.length > 0 && (
            <div
              className="prompt-preview-terms"
              data-testid="prompt-preview-terms"
            >
              <span className="text-meta">Matched on</span>
              {prompt.contextTerms.map((term) => (
                <Chip key={term}>{term}</Chip>
              ))}
            </div>
          )}

          <div>
            <h3 className="prompt-preview-subtitle">Included</h3>
            <ul
              className="prompt-preview-sections"
              data-testid="prompt-preview-included"
            >
              {prompt.sections.map((s) => (
                <li
                  key={s.id}
                  data-key={s.key}
                  data-testid={`prompt-preview-included-${s.key}`}
                >
                  <span className="prompt-preview-section-title">
                    {s.title}
                  </span>
                  {s.scope === "project" && <Chip>Every bot</Chip>}
                  {s.loading === "contextual" && (
                    <Chip tone="accent">Contextual</Chip>
                  )}
                  <span className="text-meta tabular">
                    v{s.version} · ~{s.estimatedTokens}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          {prompt.dropped.length > 0 && (
            <div>
              <h3 className="prompt-preview-subtitle">
                Matched, but dropped to fit the budget
              </h3>
              <ul
                className="prompt-preview-sections is-dropped"
                data-testid="prompt-preview-dropped"
              >
                {prompt.dropped.map((s) => (
                  <li key={s.id} data-key={s.key}>
                    <span className="prompt-preview-section-title">
                      {s.title}
                    </span>
                    <span className="text-meta tabular">
                      v{s.version} · ~{s.estimatedTokens}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <details className="prompt-preview-text" open>
            <summary>The text it is sent</summary>
            <pre data-testid="prompt-preview-system">{prompt.system}</pre>
          </details>
        </>
      )}
    </section>
  );
}
