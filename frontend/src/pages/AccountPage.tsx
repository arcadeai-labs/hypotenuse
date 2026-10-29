import type { UserEdit } from "@backend/actions/user-edit";
import type { ActionResponse } from "keryx";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { CliSignInsCard } from "../components/account/CliSignInsCard";
import { LoadingLabel } from "../components/LoadingLabel";
import { PageHeader } from "../components/shell/PageHeader";
import { useAuth } from "../context/AuthContext";
import { Alert, Button, Card, Form } from "../ui";
import { MIN_PASSWORD_LENGTH } from "../utils/authForm";
import { apiFetch } from "../utils/client";

/**
 * `/account` — edit your own name, email, or password through `user:edit`,
 * and sign out the `hypotenuse` CLIs signed in as you.
 * Only the fields that changed are sent, so an untouched form never re-hashes
 * a password or trips the email-uniqueness check against yourself.
 *
 * The fields are seeded from the session once, and again only after a save:
 * a re-hydration that lands between two keystrokes must not revert them.
 * @returns The page.
 */
export function AccountPage() {
  const { user, refresh } = useAuth();
  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const seededFor = useRef<number | null>(user?.id ?? null);

  useEffect(() => {
    if (!user || seededFor.current === user.id) return;
    seededFor.current = user.id;
    setName(user.name);
    setEmail(user.email);
  }, [user]);

  /**
   * Submit the changed fields, then re-hydrate so the sidebar agrees.
   * @param event - The form's submit event.
   */
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user) return;
    setError(null);
    setSaved(false);

    const body: { name?: string; email?: string; password?: string } = {};
    if (name.trim() !== user.name) body.name = name.trim();
    if (email.trim().toLowerCase() !== user.email) body.email = email.trim();
    if (password) body.password = password;

    if (Object.keys(body).length === 0) {
      setError("Nothing to update: change a field first.");
      return;
    }
    if (
      body.password !== undefined &&
      body.password.length < MIN_PASSWORD_LENGTH
    ) {
      setError(`Passwords are at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }

    setBusy(true);
    try {
      const res = await apiFetch<ActionResponse<UserEdit>>("/user", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setPassword("");
      setName(res.user.name);
      setEmail(res.user.email);
      setSaved(true);
      await refresh();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not update your account.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (!user) {
    return (
      <div className="page">
        <PageHeader title="Account" />
        <LoadingLabel testId="account-loading" />
      </div>
    );
  }

  return (
    <div className="page" data-testid="account-page">
      <PageHeader title="Account" />
      <Card className="page-narrow" data-testid="account-card">
        <Card.Header as="h2">Profile</Card.Header>
        <Card.Body>
          {error && (
            <Alert variant="danger" data-testid="form-error">
              {error}
            </Alert>
          )}
          {saved && (
            <Alert variant="success" data-testid="form-saved">
              Your account has been updated.
            </Alert>
          )}
          <Form onSubmit={onSubmit} noValidate>
            <Form.Group className="mb-3" controlId="account-name">
              <Form.Label>Name</Form.Label>
              <Form.Control
                value={name}
                autoComplete="name"
                onChange={(e) => setName(e.target.value)}
                data-testid="account-name-input"
              />
            </Form.Group>
            <Form.Group className="mb-3" controlId="account-email">
              <Form.Label>Email</Form.Label>
              <Form.Control
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                data-testid="account-email"
              />
              <Form.Text className="text-muted">
                Invitations are addressed to this email.
              </Form.Text>
            </Form.Group>
            <Form.Group className="mb-3" controlId="account-password">
              <Form.Label>New password</Form.Label>
              <Form.Control
                type="password"
                autoComplete="new-password"
                placeholder="Leave blank to keep your current password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                data-testid="account-password"
              />
              <Form.Text className="text-muted">
                At least {MIN_PASSWORD_LENGTH} characters.
              </Form.Text>
            </Form.Group>
            <Button
              type="submit"
              variant="primary"
              disabled={busy}
              data-testid="account-submit"
            >
              Save changes
            </Button>
          </Form>
        </Card.Body>
      </Card>
      <CliSignInsCard />
    </div>
  );
}
