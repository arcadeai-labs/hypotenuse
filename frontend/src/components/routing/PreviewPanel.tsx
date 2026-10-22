import type { RoutingRulePreview } from "@backend/actions/routing-rule/routing-rule-preview";
import type { ActionResponse } from "keryx";
import { useState } from "react";
import {
  Alert,
  Button,
  Card,
  Chip,
  Form,
  PresenceDot,
  RoleChip,
  Table,
} from "../../ui";
import { apiFetch } from "../../utils/client";
import { waitingLabel } from "../../utils/sessions";

type Preview = ActionResponse<RoutingRulePreview>["preview"];

/**
 * The routing preview: "what would happen if this issue were delegated
 * now?". Reads the issue from Linear and runs the project's real rules and
 * runner eligibility over it, writing nothing; each runner it rules out says
 * why, in the same codes a waiting turn shows on its session page. Ranking
 * repositories costs Linear budget, so it is a checkbox.
 * @param props - The project.
 * @returns The panel.
 */
export function PreviewPanel({ projectId }: { projectId: number }) {
  const [issue, setIssue] = useState("");
  const [prompt, setPrompt] = useState("");
  const [withRepository, setWithRepository] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** Ask the server for the preview. */
  async function run() {
    if (!issue.trim()) return setError("Name an issue, e.g. ENG-123.");
    setBusy(true);
    setError(null);
    const query = new URLSearchParams({
      projectId: String(projectId),
      issue: issue.trim(),
    });
    if (prompt.trim()) query.set("prompt", prompt.trim());
    if (withRepository) query.set("withRepository", "true");
    try {
      const res = await apiFetch<ActionResponse<RoutingRulePreview>>(
        `/routing-rule/preview?${query}`,
      );
      setPreview(res.preview);
    } catch (err) {
      setPreview(null);
      setError(err instanceof Error ? err.message : "Could not preview.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card data-testid="routing-preview">
      <Card.Header as="h2">Preview</Card.Header>
      <Card.Body>
        <p className="text-muted">
          What would happen if this issue were delegated now: the rule that
          matches, the role it picks, and which runners could take it — and why
          the others cannot. Nothing is written.
        </p>
        <Form
          className="routing-preview-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          <Form.Group controlId="preview-issue">
            <Form.Label className="text-meta">Issue</Form.Label>
            <Form.Control
              value={issue}
              placeholder="ENG-123"
              onChange={(e) => setIssue(e.target.value)}
              data-testid="preview-issue"
            />
          </Form.Group>
          <Form.Group controlId="preview-prompt">
            <Form.Label className="text-meta">
              As a mention (optional)
            </Form.Label>
            <Form.Control
              value={prompt}
              placeholder="/manage plan the launch"
              onChange={(e) => setPrompt(e.target.value)}
              data-testid="preview-prompt"
            />
          </Form.Group>
          <Form.Check
            id="preview-repository"
            label="Ask Linear to rank repositories (spends API budget)"
            checked={withRepository}
            onChange={(e) => setWithRepository(e.target.checked)}
            data-testid="preview-with-repository"
          />
          <Button
            type="submit"
            size="sm"
            variant="primary"
            disabled={busy}
            data-testid="preview-run"
          >
            Preview
          </Button>
        </Form>
        {error && (
          <Alert variant="danger" className="mt-3" data-testid="preview-error">
            {error}
          </Alert>
        )}
        {preview && <PreviewResult preview={preview} />}
      </Card.Body>
    </Card>
  );
}

/**
 * What the preview found.
 * @param props - The preview.
 * @returns The result.
 */
function PreviewResult({ preview }: { preview: Preview }) {
  const repo = preview.repository;
  return (
    <div className="routing-preview-result" data-testid="preview-result">
      <p>
        <strong>{preview.issue.identifier ?? preview.issue.id}</strong>{" "}
        {preview.issue.title} → <RoleChip role={preview.role} showLabel />{" "}
        <span data-testid="preview-rule">
          {preview.matchedRuleName
            ? `by the ${preview.matchedRuleName} rule`
            : "no rule matched (worker by default)"}
        </span>
      </p>
      <p className="text-meta" data-testid="preview-repository">
        Repository:{" "}
        {repo.repository
          ? `${repo.repository}${repo.pinnedByRule ? " (pinned by the rule)" : ""}`
          : repo.waitsForRepository
            ? "none checked out on an eligible runner — it would wait"
            : repo.wouldElicit === true
              ? `Linear is unsure; it would ask which of ${repo.candidates.length}`
              : repo.wouldElicit === null
                ? `one of ${repo.candidates.join(", ")} (rank with Linear to know which)`
                : "none needed"}
        {repo.suggestion &&
          ` · Linear suggests ${repo.suggestion.repository} (${Math.round(repo.suggestion.confidence * 100)}%)`}
      </p>
      {preview.waitingCode && (
        <Alert variant="warning" data-testid="preview-waiting">
          No runner could take it now: {waitingLabel(preview.waitingCode)}.
        </Alert>
      )}
      <Table size="sm" responsive data-testid="preview-candidates">
        <thead>
          <tr>
            <th scope="col">Runner</th>
            <th scope="col">Owner</th>
            <th scope="col">Could take it</th>
          </tr>
        </thead>
        <tbody>
          {preview.candidates.length === 0 && (
            <tr>
              <td colSpan={3} className="text-muted">
                This project has no runners.
              </td>
            </tr>
          )}
          {preview.candidates.map((c) => (
            <tr key={c.runnerId} data-testid={`preview-runner-${c.runnerId}`}>
              <td>
                <PresenceDot
                  presence={
                    c.reasons.some((r) => r.code === "offline")
                      ? "offline"
                      : c.reasons.some((r) => r.code === "draining")
                        ? "draining"
                        : "online"
                  }
                />{" "}
                {c.name}
              </td>
              <td>{c.owner?.name ?? "—"}</td>
              <td>
                {c.eligible ? (
                  <Chip tone="accent">Eligible</Chip>
                ) : (
                  c.reasons.map((r) => (
                    <Chip
                      key={r.code}
                      title={r.message}
                      data-testid={`preview-reason-${c.runnerId}-${r.code}`}
                    >
                      {r.code}
                    </Chip>
                  ))
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
