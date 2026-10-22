import type { RunnerView } from "@backend/actions/runner/runner-view";
import type { ActionResponse } from "keryx";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { CopyButton } from "../components/CopyButton";
import SkeletonBlocks from "../components/SkeletonBlocks";
import { PageHeader } from "../components/shell/PageHeader";
import { useAuth } from "../context/AuthContext";
import { Alert, Card } from "../ui";
import { apiFetch } from "../utils/client";
import { authInstructions } from "../utils/runnerAuth";

type View = ActionResponse<RunnerView>;

/**
 * `/runners/:runnerId/auth/:provider` — where an `auth` elicitation in Linear
 * links. A runner needs a login that has to happen on its own machine (its
 * coding agent's, GitHub's, a git host's), so the page shows the runner's
 * owner the commands to run there; anyone else is told who to ask. Then the
 * person replies in Linear and the next turn carries on.
 * @returns The page.
 */
export default function RunnerAuthPage() {
  const { runnerId, provider = "agent" } = useParams();
  const { activeProjectId, user } = useAuth();
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!activeProjectId || !runnerId) return;
    let live = true;
    apiFetch<View>(`/runner/${runnerId}?projectId=${activeProjectId}`)
      .then((next) => live && setView(next))
      .catch(
        (err) =>
          live &&
          setError(
            err instanceof Error ? err.message : "Could not load the runner.",
          ),
      );
    return () => {
      live = false;
    };
  }, [activeProjectId, runnerId]);

  if (error) {
    return (
      <div className="page page-narrow" data-testid="runner-auth-page">
        <PageHeader title="Sign in on a runner" />
        <Alert variant="warning" data-testid="runner-auth-error">
          {error} The runner may belong to another project — switch to it and
          open the link again.
        </Alert>
      </div>
    );
  }
  if (!view) {
    return (
      <div className="page page-narrow" data-testid="runner-auth-page">
        <SkeletonBlocks testId="runner-auth-loading" />
      </div>
    );
  }

  const { runner } = view;
  const fix = authInstructions(provider.toLowerCase(), runner.agents);
  const owner = runner.owner?.name ?? runner.owner?.email ?? "its owner";
  const yours = user?.id === runner.userId;
  return (
    <div className="page page-narrow" data-testid="runner-auth-page">
      <PageHeader title={`Sign in to ${fix.title}`} />
      <Card data-testid="runner-auth-card">
        <Card.Body>
          <p className="mb-3">
            Runner <Link to="/runners">{runner.name}</Link>
            {runner.hostname ? ` (${runner.hostname})` : ""} needs{" "}
            <strong>{fix.title}</strong> signed in before it can carry on. It
            has to happen on that machine, as the user the daemon runs as.
          </p>
          {yours ? (
            <>
              <p className="text-meta">On {runner.name}, run:</p>
              <div className="runner-snippet mb-3">
                <pre data-testid="runner-auth-commands">
                  {fix.commands.join("\n")}
                </pre>
                <CopyButton
                  text={fix.commands.join("\n")}
                  label="Copy commands"
                />
              </div>
              {fix.note && <p className="text-muted mb-3">{fix.note}</p>}
              <p className="mb-0">
                Then reply in the Linear session — anything will do — and the
                agent picks up where it stopped.
              </p>
            </>
          ) : (
            <Alert
              variant="info"
              className="mb-0"
              data-testid="runner-auth-ask-owner"
            >
              Only {owner} can sign in on {runner.name}. Ask them to open this
              page; once they have, reply in the Linear session.
            </Alert>
          )}
        </Card.Body>
      </Card>
    </div>
  );
}
