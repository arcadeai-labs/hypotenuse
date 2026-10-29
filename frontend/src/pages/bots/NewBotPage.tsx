import type { BotCreate } from "@backend/actions/bot/bot-create";
import type { ActionResponse } from "keryx";
import { type FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PersonaEditor } from "../../components/bots/PersonaEditor";
import { GatedButton } from "../../components/GatedButton";
import { PageHeader } from "../../components/shell/PageHeader";
import { useAuth } from "../../context/AuthContext";
import { useMay } from "../../hooks/useMay";
import { Alert, Card, Form } from "../../ui";
import { apiFetch } from "../../utils/client";

/**
 * `/bots/new` — make a bot in the active project: a name, what it is for, and
 * its persona. Everything else starts at its default — the `default` and
 * `fast` model names, open to every member, enabled — and is changed on the
 * bot's own page, where this lands.
 * @returns The page.
 */
export function NewBotPage() {
  const { activeProjectId } = useAuth();
  const { reason } = useMay();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [persona, setPersona] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const denied = activeProjectId
    ? reason("bot:create")
    : "Choose a project first.";

  /**
   * Create the bot and open its page.
   * @param event - The form's submit event.
   */
  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!activeProjectId || denied) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<ActionResponse<BotCreate>>(
        `/project/${activeProjectId}/bot`,
        {
          method: "PUT",
          body: JSON.stringify({
            name: name.trim(),
            description: description.trim(),
            persona,
          }),
        },
      );
      navigate(`/bots/${res.bot.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create it.");
      setBusy(false);
    }
  }

  return (
    <div className="page" data-testid="new-bot-page">
      <PageHeader
        title={
          <>
            <Link to="/bots" className="shell-page-crumb">
              Bots
            </Link>
            <span className="shell-page-subtitle"> · New bot</span>
          </>
        }
      />
      <Card className="page-medium">
        <Card.Body>
          {error && (
            <Alert variant="danger" data-testid="new-bot-error">
              {error}
            </Alert>
          )}
          {denied && activeProjectId && (
            <Alert variant="info" data-testid="new-bot-denied">
              {denied}
            </Alert>
          )}
          <Form onSubmit={onSubmit} noValidate>
            <Form.Group controlId="new-bot-name" className="mb-3">
              <Form.Label>Name</Form.Label>
              <Form.Control
                value={name}
                placeholder="Ada"
                maxLength={80}
                disabled={busy || denied !== undefined}
                title={denied}
                onChange={(e) => setName(e.target.value)}
                data-testid="new-bot-name"
              />
            </Form.Group>
            <Form.Group controlId="new-bot-description" className="mb-3">
              <Form.Label>
                Description <span className="text-meta">optional</span>
              </Form.Label>
              <Form.Control
                value={description}
                placeholder="Answers billing questions in #support"
                maxLength={280}
                disabled={busy || denied !== undefined}
                title={denied}
                onChange={(e) => setDescription(e.target.value)}
                data-testid="new-bot-description"
              />
              <Form.Text className="text-muted">
                What it is for, as the bots list shows it.
              </Form.Text>
            </Form.Group>
            <Form.Group className="mb-3">
              <Form.Label htmlFor="new-bot-persona">Persona</Form.Label>
              <PersonaEditor
                id="new-bot-persona"
                value={persona}
                onChange={setPersona}
                disabled={busy || denied !== undefined}
                title={denied}
                testId="new-bot-persona"
              />
              <Form.Text className="text-muted">
                Who the bot is and how it behaves, in markdown. It opens every
                conversation the bot has.
              </Form.Text>
            </Form.Group>
            <GatedButton
              type="submit"
              variant="primary"
              disabled={busy || name.trim() === "" || persona.trim() === ""}
              deniedReason={denied}
              data-testid="new-bot-submit"
            >
              Create bot
            </GatedButton>
          </Form>
        </Card.Body>
      </Card>
    </div>
  );
}
