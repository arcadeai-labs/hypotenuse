import type { CliAuthApprove } from "@backend/actions/cli-auth/cli-auth-approve";
import type { ActionResponse } from "keryx";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { Alert, Button, CompleteGlyph, ErrorGlyph, Mark } from "../../ui";
import { apiFetch } from "../../utils/client";
import {
  type CliAuthorizeOutcome,
  callbackUrl,
  parseAuthorizeRequest,
  parseOutcome,
} from "./cliLink";

const OUTCOME_COPY: Record<
  CliAuthorizeOutcome,
  { title: string; body: string; ok: boolean }
> = {
  done: {
    title: "The CLI is signed in",
    body: "You can close this tab and return to your terminal.",
    ok: true,
  },
  cancelled: {
    title: "Sign-in cancelled",
    body: "Nothing was signed in. Run hypotenuse login again whenever you are ready.",
    ok: false,
  },
  error: {
    title: "That sign-in did not match",
    body: "The terminal was not expecting this answer. Run hypotenuse login again.",
    ok: false,
  },
};

/**
 * `/cli/authorize` — approve a `hypotenuse login` from this browser.
 *
 * The CLI opens this page with its loopback port, PKCE challenge, state, and
 * device name. Approve asks `cli-auth:approve` for a one-time code bound to the
 * signed-in person and the challenge, then sends the browser to the CLI's
 * `127.0.0.1` listener with it. The listener redirects back here with
 * `?status=`, which is the second visit this page renders.
 * @returns The page.
 */
export function CliAuthorizePage() {
  const { user } = useAuth();
  const [params] = useSearchParams();
  const outcome = parseOutcome(params);
  const request = parseAuthorizeRequest(params);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** Approve, then hand the code to the CLI's listener. */
  async function approve() {
    if (!request) return;
    setBusy(true);
    setError(null);
    try {
      const { code } = await apiFetch<ActionResponse<CliAuthApprove>>(
        "/cli-auth/approve",
        {
          method: "PUT",
          body: JSON.stringify({
            codeChallenge: request.codeChallenge,
            device: request.device,
          }),
        },
      );
      window.location.assign(callbackUrl(request, { code }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not approve.");
      setBusy(false);
    }
  }

  /** Tell the CLI the person said no. */
  function cancel() {
    if (request) window.location.assign(callbackUrl(request, { denied: true }));
  }

  if (outcome) {
    const copy = OUTCOME_COPY[outcome];
    return (
      <div className="auth-page">
        <div className="auth-card" data-testid={`cli-authorize-${outcome}`}>
          {copy.ok ? <CompleteGlyph size={24} /> : <ErrorGlyph size={24} />}
          <h1>{copy.title}</h1>
          <p className="auth-footer">{copy.body}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <div className="auth-card" data-testid="cli-authorize">
        <Mark size={24} label={null} />
        <h1>Sign in the hypotenuse CLI</h1>
        {request ? (
          <>
            <p>
              Sign in the CLI on <strong>{request.device}</strong> as{" "}
              <strong>{user?.email}</strong>?
            </p>
            <p className="auth-footer">
              Approve only if you just ran <code>hypotenuse login</code> on that
              machine. It will act as you in every project you belong to, until
              you sign it out on your Account page.
            </p>
            {error && (
              <Alert variant="danger" data-testid="cli-authorize-error">
                {error}
              </Alert>
            )}
            <Button
              variant="primary"
              className="auth-submit"
              disabled={busy}
              onClick={approve}
              data-testid="cli-authorize-approve"
            >
              Approve
            </Button>
            <Button
              variant="outline-secondary"
              className="auth-submit"
              disabled={busy}
              onClick={cancel}
              data-testid="cli-authorize-cancel"
            >
              Cancel
            </Button>
          </>
        ) : (
          <Alert variant="warning" data-testid="cli-authorize-invalid">
            This sign-in link is incomplete. Run <code>hypotenuse login</code>{" "}
            again.
          </Alert>
        )}
      </div>
    </div>
  );
}
