import type { BotRotateCallbackSecret } from "@backend/actions/bot/bot-rotate-callback-secret";
import type { ActionResponse } from "keryx";
import { useState } from "react";
import { Alert, Chip } from "../../ui";
import { apiFetch } from "../../utils/client";
import { ConfirmDialog } from "../ConfirmDialog";
import { CopyButton } from "../CopyButton";
import { GatedButton } from "../GatedButton";
import { SectionCard } from "../sections/SectionCard";
import { useSectionSave } from "../sections/useSectionSave";
import type { BotSectionProps } from "./IdentitySection";

/**
 * The secret a bot signs its API callbacks with. Creating one answers it
 * exactly once, so the card shows it once, with a copy button and a warning;
 * replacing one stops the old secret at once, so that asks first.
 * @param props - See {@link BotSectionProps}; `denied` is the write refusal.
 * @returns The section.
 */
export function CallbackSecretSection({
  projectId,
  bot,
  denied,
  onSaved,
}: BotSectionProps) {
  const { busy, error, setError, save } = useSectionSave();
  const [secret, setSecret] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  /** Create or replace the secret, and hold the answer to show once. */
  async function rotate() {
    setConfirming(false);
    setSecret(null);
    await save(async () => {
      const answer = await apiFetch<ActionResponse<BotRotateCallbackSecret>>(
        `/project/${projectId}/bot/${bot.id}/callback-secret`,
        { method: "POST" },
      );
      setSecret(answer.callbackSecret);
      onSaved({ bot: answer.bot, standing: answer.standing });
    }, "Secret created.");
  }

  return (
    <SectionCard
      title="Callback secret"
      testId="bot-callback"
      idPrefix="bot"
      intro={
        <>
          A conversation started over the API with a callback URL has each of
          the bot's messages POSTed there, signed with this secret. It is shown
          once, when it is made.
        </>
      }
      error={error}
      onDismissError={() => setError(null)}
      busy={busy}
    >
      <div className="bot-callback">
        <div className="bot-callback-row">
          <Chip
            tone={bot.hasCallbackSecret ? "accent" : "subtle"}
            data-testid="bot-callback-status"
          >
            {bot.hasCallbackSecret ? "Secret set" : "No secret yet"}
          </Chip>
          <GatedButton
            size="sm"
            variant="secondary"
            deniedReason={denied}
            disabled={busy}
            onClick={() =>
              bot.hasCallbackSecret ? setConfirming(true) : rotate()
            }
            data-testid="bot-callback-rotate"
          >
            {bot.hasCallbackSecret ? "Replace secret" : "Create secret"}
          </GatedButton>
        </div>
        {secret && (
          <Alert variant="warning" data-testid="bot-callback-secret">
            <p className="mb-2">
              Copy it now: it is never shown again. Store it where your callback
              receiver can read it.
            </p>
            <div className="bot-callback-secret">
              <code className="mono" data-testid="bot-callback-secret-value">
                {secret}
              </code>
              <CopyButton text={secret} label="Copy secret" />
            </div>
          </Alert>
        )}
      </div>
      <ConfirmDialog
        show={confirming}
        title="Replace the callback secret?"
        confirmLabel="Replace secret"
        busy={busy}
        onConfirm={rotate}
        onCancel={() => setConfirming(false)}
        testId="bot-callback-replace"
      >
        Callbacks signed with the old secret stop verifying at once. Update your
        receiver with the new one.
      </ConfirmDialog>
    </SectionCard>
  );
}
