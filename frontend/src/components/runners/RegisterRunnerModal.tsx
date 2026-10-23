import type { RunnerRegister } from "@backend/actions/runner/runner-register";
import type { ActionResponse } from "keryx";
import { useState } from "react";
import { Alert, Button, Form, Modal } from "../../ui";
import { API_URL, apiFetch } from "../../utils/client";
import { INSTALL_COMMANDS } from "../../utils/install";
import { CopyButton } from "../CopyButton";

type Registered = ActionResponse<RunnerRegister>;

/**
 * The commands that set up a runner from a terminal — the usual path, which
 * mints and saves the token itself.
 * @param name - The runner's name.
 * @returns The shell lines.
 */
export function registerCommands(name: string): string {
  return [
    `hypotenuse login --url ${API_URL}`,
    `hypotenuse runner register --name ${name || "my-laptop"}`,
    "hypotenuse config init",
    "hypotenuse daemon start",
  ].join("\n");
}

/**
 * The `credentials.json` entry that puts a dashboard-minted token on a
 * machine, under its server's origin.
 * @param registered - What `runner:register` answered.
 * @param projectId - The project.
 * @returns The JSON.
 */
export function credentialsSnippet(
  registered: Pick<Registered, "token" | "runner">,
  projectId: number,
): string {
  return JSON.stringify(
    {
      servers: {
        [new URL(API_URL).origin]: {
          runner: {
            runnerId: registered.runner.id,
            projectId,
            name: registered.runner.name,
            token: registered.token,
          },
        },
      },
    },
    null,
    2,
  );
}

/**
 * Register a runner from the browser. Shows the token **once**, with copy
 * buttons and the exact commands; closing the modal forgets it, and nothing
 * can show it again — a lost token means registering again with `replace`.
 * @param props - Whether it is open, the project, and the close handler.
 * @returns The modal.
 */
export function RegisterRunnerModal({
  show,
  projectId,
  onHide,
  onRegistered,
}: {
  show: boolean;
  projectId: number;
  onHide: () => void;
  onRegistered: () => void;
}) {
  const [name, setName] = useState("");
  const [replace, setReplace] = useState(false);
  const [registered, setRegistered] = useState<Registered | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** Close, and forget the token. */
  function close() {
    setRegistered(null);
    setName("");
    setReplace(false);
    setError(null);
    onHide();
  }

  /** Register the runner. */
  async function register() {
    if (!name.trim()) return setError("Give the runner a name.");
    setBusy(true);
    try {
      const res = await apiFetch<Registered>("/runner", {
        method: "PUT",
        body: JSON.stringify({ projectId, name: name.trim(), replace }),
      });
      setRegistered(res);
      setError(null);
      onRegistered();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not register.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal show={show} onHide={close} data-testid="register-runner-modal">
      <Modal.Header closeButton>
        <Modal.Title>Register a runner</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        {error && (
          <Alert variant="danger" data-testid="register-runner-error">
            {error}
          </Alert>
        )}
        {registered ? (
          <div data-testid="register-runner-done">
            <p>
              Registered <strong>{registered.runner.name}</strong>. This token
              is shown <strong>once</strong>; copy it now.
            </p>
            <div className="runner-token">
              <code data-testid="register-runner-token">
                {registered.token}
              </code>
              <CopyButton text={registered.token} label="Copy token" />
            </div>
            <p className="text-meta">
              On the runner's machine, add this to{" "}
              <code>~/.config/hypotenuse/credentials.json</code> (mode 0600),
              then run <code>hypotenuse config init</code> and{" "}
              <code>hypotenuse daemon start</code>:
            </p>
            <div className="runner-snippet">
              <pre data-testid="register-runner-credentials">
                {credentialsSnippet(registered, projectId)}
              </pre>
              <CopyButton
                text={credentialsSnippet(registered, projectId)}
                label="Copy credentials"
              />
            </div>
          </div>
        ) : (
          <Form
            onSubmit={(e) => {
              e.preventDefault();
              void register();
            }}
          >
            <p className="text-muted">
              No <code>hypotenuse</code> on the machine yet? Install it first:
            </p>
            <div
              className="runner-installs"
              data-testid="register-runner-install"
            >
              {INSTALL_COMMANDS.map((install) => (
                <div key={install.label}>
                  <span className="text-meta">{install.label}</span>
                  <div className="runner-snippet">
                    <code>{install.command}</code>
                    <CopyButton
                      text={install.command}
                      label={`Copy ${install.label} install command`}
                    />
                  </div>
                </div>
              ))}
            </div>
            <p className="text-muted">
              Then register from the machine itself, which saves the token for
              you:
            </p>
            <div className="runner-snippet">
              <pre data-testid="register-runner-commands">
                {registerCommands(name.trim())}
              </pre>
              <CopyButton
                text={registerCommands(name.trim())}
                label="Copy commands"
              />
            </div>
            <p className="text-muted">Or mint a token here:</p>
            <Form.Group controlId="register-runner-name">
              <Form.Label className="text-meta">Name</Form.Label>
              <Form.Control
                value={name}
                placeholder="evan-mbp"
                onChange={(e) => setName(e.target.value)}
                data-testid="register-runner-name"
              />
            </Form.Group>
            <Form.Check
              id="register-runner-replace"
              className="mt-2"
              label="Replace a runner with this name (revokes its token)"
              checked={replace}
              onChange={(e) => setReplace(e.target.checked)}
              data-testid="register-runner-replace"
            />
          </Form>
        )}
      </Modal.Body>
      <Modal.Footer>
        {registered ? (
          <Button
            variant="primary"
            onClick={close}
            data-testid="register-runner-close"
          >
            I've copied it
          </Button>
        ) : (
          <>
            <Button variant="outline-secondary" onClick={close}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={register}
              data-testid="register-runner-submit"
            >
              Register
            </Button>
          </>
        )}
      </Modal.Footer>
    </Modal>
  );
}
