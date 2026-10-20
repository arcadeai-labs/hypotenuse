import type { UserCreate } from "@backend/actions/user";
import type { ActionResponse } from "keryx";
import { type FormEvent, type ReactNode, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { Alert, Button, Form, Mark } from "../ui";
import { apiFetch } from "../utils/client";
import { type AuthFields, validateAuthFields } from "./authForm";

/**
 * The centred sign-in / sign-up card, wired to `session:create` and
 * `user:create`.
 *
 * Creating an account does not create a session, so sign-up signs in with the
 * same credentials straight after: a new person should land inside the app, in
 * the project the signup bootstrap just made them admin of, not on a login
 * form. A refusal is shown in the server's own words — sign-in deliberately
 * cannot tell an unknown email from a wrong password, and the page does not
 * editorialize about which half was wrong.
 * @param props - Which form, its heading, and the link to the other one.
 * @returns The card.
 */
export function AuthCard({
  mode,
  title,
  footer,
}: {
  mode: "sign-in" | "sign-up";
  title: string;
  footer: ReactNode;
}) {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [fields, setFields] = useState<AuthFields>({
    email: "",
    password: "",
    name: "",
  });
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const errors = validateAuthFields(fields, mode === "sign-up");
  const show = (key: keyof AuthFields) => (submitted ? errors[key] : undefined);

  /**
   * Validate, then create the account (sign-up only), open a session,
   * re-hydrate, and land on the project home.
   * @param event - The form's submit event.
   */
  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    setServerError(null);
    if (Object.keys(errors).length > 0) return;

    const email = fields.email.trim();
    setSubmitting(true);
    try {
      if (mode === "sign-up") {
        await apiFetch<ActionResponse<UserCreate>>("/user", {
          method: "PUT",
          body: JSON.stringify({
            name: fields.name?.trim(),
            email,
            password: fields.password,
          }),
        });
      }
      await apiFetch("/session", {
        method: "PUT",
        body: JSON.stringify({ email, password: fields.password }),
      });
      await refresh();
      navigate("/home");
    } catch (err) {
      setServerError(
        err instanceof Error ? err.message : "Something went wrong.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const field = (
    key: keyof AuthFields,
    label: string,
    type: string,
    autoComplete: string,
  ) => (
    <Form.Group controlId={`${mode}-${key}`}>
      <Form.Label>{label}</Form.Label>
      <Form.Control
        type={type}
        name={key}
        autoComplete={autoComplete}
        value={fields[key] ?? ""}
        isInvalid={Boolean(show(key))}
        aria-describedby={show(key) ? `${mode}-${key}-error` : undefined}
        data-testid={`${mode}-${key}`}
        onChange={(event) =>
          setFields({ ...fields, [key]: event.target.value })
        }
      />
      {show(key) && (
        <Form.Text id={`${mode}-${key}-error`} className="auth-error">
          {show(key)}
        </Form.Text>
      )}
    </Form.Group>
  );

  return (
    <div className="auth-page">
      <div className="auth-card" data-testid={`${mode}-card`}>
        <Mark size={24} label={null} />
        <h1>{title}</h1>
        <Form noValidate onSubmit={onSubmit} data-testid={`${mode}-form`}>
          {mode === "sign-up" && field("name", "Name", "text", "name")}
          {field("email", "Email", "email", "email")}
          {field(
            "password",
            "Password",
            "password",
            mode === "sign-up" ? "new-password" : "current-password",
          )}
          {serverError && (
            <Alert variant="danger" data-testid="form-error">
              {serverError}
            </Alert>
          )}
          <Button
            type="submit"
            variant="primary"
            className="auth-submit"
            disabled={submitting}
            data-testid={`${mode}-submit`}
          >
            {title}
          </Button>
        </Form>
        <p className="auth-footer">{footer}</p>
        <p className="auth-footer">
          <Link to="/">Back to home</Link>
        </p>
      </div>
    </div>
  );
}
