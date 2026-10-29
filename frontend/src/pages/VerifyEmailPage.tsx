import type { EmailVerificationConfirm } from "@backend/actions/email-verification/email-verification-confirm";
import type { ActionResponse } from "keryx";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { Alert, Button, Mark } from "../ui";
import { apiFetch } from "../utils/client";

/**
 * `/verify-email?token=…` — where a verification link lands. Public, because
 * the link may be opened on a device with no session; the token is the proof.
 *
 * Confirming is a button, not something the page does on load: mail scanners
 * and link previews fetch every URL in a message, and a link that confirmed
 * itself on load could be spent before its owner ever saw it.
 * @returns The page.
 */
export function VerifyEmailPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const { user, refresh } = useAuth();
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(
    token
      ? null
      : "This link is missing its token. Open the link from the email again.",
  );

  /** Spend the token, then re-read the session if there is one. */
  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<ActionResponse<EmailVerificationConfirm>>(
        "/email-verification/confirm",
        { method: "POST", body: JSON.stringify({ token }) },
      );
      setConfirmed(res.user.email);
      if (user) await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card" data-testid="verify-email-card">
        <Mark size={24} label={null} />
        <h1>Confirm your email</h1>
        {confirmed ? (
          <>
            <Alert variant="success" data-testid="verify-email-confirmed">
              <strong>{confirmed}</strong> is confirmed. Invitations sent to it
              are yours to answer.
            </Alert>
            <Link
              to={user ? "/invites" : "/sign-in"}
              className="ui-button ui-variant-primary auth-submit"
              data-testid="verify-email-continue"
            >
              {user ? "See your invitations" : "Sign in"}
            </Link>
          </>
        ) : (
          <>
            <p>
              Confirm that this address is yours. The link works once, for one
              day.
            </p>
            {error && (
              <Alert variant="danger" data-testid="form-error">
                {error}
              </Alert>
            )}
            <Button
              variant="primary"
              className="auth-submit"
              disabled={busy || !token}
              onClick={confirm}
              data-testid="verify-email-submit"
            >
              Confirm my address
            </Button>
          </>
        )}
        <p className="auth-footer">
          <Link to="/">Back to home</Link>
        </p>
      </div>
    </div>
  );
}
