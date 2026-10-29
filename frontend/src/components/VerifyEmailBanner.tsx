import type { EmailVerificationResend } from "@backend/actions/email-verification/email-verification-resend";
import type { ActionResponse } from "keryx";
import { useState } from "react";
import { useAuth } from "../context/AuthContext";
import { Alert, Button } from "../ui";
import { apiFetch } from "../utils/client";

/**
 * The strip above every signed-in page while the person's address is
 * unconfirmed. It says what is waiting on it — invitations — and offers a new
 * link. It renders nothing until `me:view` has answered, so a confirmed person
 * never sees it flash past.
 * @returns The banner, or nothing.
 */
export function VerifyEmailBanner() {
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!user || user.emailVerified) return null;

  /** Ask for a new link, at most one a minute (the server enforces it). */
  async function resend() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<ActionResponse<EmailVerificationResend>>(
        "/email-verification",
        { method: "PUT" },
      );
      setSent(res.sentTo);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send a link.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shell-banner">
      <Alert variant="warning" data-testid="verify-email-banner">
        <span className="shell-banner-row">
          <span>
            Confirm your email address. We sent a link to{" "}
            <strong>{user.email}</strong>; until you follow it you cannot see or
            accept invitations.
            {sent && (
              <span data-testid="verify-email-sent">
                {" "}
                A new link is on its way to {sent}.
              </span>
            )}
            {error && (
              <span className="text-danger" data-testid="verify-email-error">
                {" "}
                {error}
              </span>
            )}
          </span>
          <Button
            size="sm"
            variant="outline-secondary"
            disabled={busy}
            onClick={resend}
            data-testid="verify-email-resend"
          >
            Send a new link
          </Button>
        </span>
      </Alert>
    </div>
  );
}
