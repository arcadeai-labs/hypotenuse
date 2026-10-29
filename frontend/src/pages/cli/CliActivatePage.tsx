import type { CliAuthActivate } from "@backend/actions/cli-auth/cli-auth-activate";
import type { ActionResponse } from "keryx";
import { type FormEvent, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { Alert, Button, CompleteGlyph, Form, Mark } from "../../ui";
import { apiFetch } from "../../utils/client";

/**
 * `/cli/activate` — approve a `hypotenuse login --device` by typing the
 * code it printed. For a terminal with no browser of its own: SSH sessions,
 * build boxes, containers. The CLI is polling, so it finishes by itself once
 * `cli-auth:activate` answers.
 * @returns The page.
 */
export function CliActivatePage() {
  const { user } = useAuth();
  const [params] = useSearchParams();
  const [code, setCode] = useState(params.get("code") ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [device, setDevice] = useState<string | null>(null);

  /**
   * Approve the typed code.
   * @param event - The form's submit event.
   */
  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<ActionResponse<CliAuthActivate>>(
        "/cli-auth/activate",
        { method: "POST", body: JSON.stringify({ userCode: code.trim() }) },
      );
      setDevice(res.device);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not approve.");
    } finally {
      setBusy(false);
    }
  }

  if (device) {
    return (
      <div className="auth-page">
        <div className="auth-card" data-testid="cli-activate-done">
          <CompleteGlyph size={24} />
          <h1>The CLI is signed in</h1>
          <p>
            The hypotenuse CLI on <strong>{device}</strong> is signed in as{" "}
            <strong>{user?.email}</strong>.
          </p>
          <p className="auth-footer">Return to your terminal.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <div className="auth-card" data-testid="cli-activate">
        <Mark size={24} label={null} />
        <h1>Sign in a CLI with a code</h1>
        <p className="auth-footer">
          Enter the code <code>hypotenuse login --device</code> printed. The CLI
          will act as <strong>{user?.email}</strong>; only enter a code you got
          from your own terminal.
        </p>
        <Form noValidate onSubmit={onSubmit}>
          <Form.Group controlId="cli-activate-code">
            <Form.Label>Code</Form.Label>
            <Form.Control
              value={code}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="WDJB-MJHT"
              onChange={(e) => setCode(e.target.value)}
              data-testid="cli-activate-code"
            />
          </Form.Group>
          {error && (
            <Alert variant="danger" data-testid="cli-activate-error">
              {error}
            </Alert>
          )}
          <Button
            type="submit"
            variant="primary"
            className="auth-submit"
            disabled={busy}
            data-testid="cli-activate-submit"
          >
            Approve
          </Button>
        </Form>
      </div>
    </div>
  );
}
