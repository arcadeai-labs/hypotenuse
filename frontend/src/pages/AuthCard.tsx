import { type FormEvent, type ReactNode, useState } from "react";
import { Link } from "react-router-dom";
import { Alert, Button, Form, Mark } from "../ui";
import { type AuthFields, validateAuthFields } from "./authForm";

/**
 * The centred sign-in / sign-up card. It validates on the client and posts
 * nowhere: accounts do not exist yet, so submitting says so instead.
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
  const [fields, setFields] = useState<AuthFields>({
    email: "",
    password: "",
    name: "",
  });
  const [submitted, setSubmitted] = useState(false);
  const errors = validateAuthFields(fields, mode === "sign-up");
  const show = (key: keyof AuthFields) => (submitted ? errors[key] : undefined);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
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

  const valid = Object.keys(errors).length === 0;
  return (
    <div className="auth-page">
      <div className="auth-card">
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
          {submitted && valid && (
            <Alert variant="info" data-testid={`${mode}-unavailable`}>
              Accounts are not open yet. This form will sign you in once they
              are.
            </Alert>
          )}
          <Button type="submit" variant="primary" className="auth-submit">
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
