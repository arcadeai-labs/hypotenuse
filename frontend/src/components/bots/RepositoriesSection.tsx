import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Chip, Form } from "../../ui";
import {
  type BotRepository,
  GITHUB_WAKE_EVENTS,
  type GithubWakeEvent,
  orderWakeEvents,
  repositoryUrl,
  sameWakeEvents,
} from "../../utils/repositories";
import { SectionCard } from "../sections/SectionCard";
import { useSectionSave } from "../sections/useSectionSave";
import { useRead } from "./data";
import { type BotSectionProps, editBot } from "./IdentitySection";

/**
 * Repositories: the GitHub repositories this bot can read, or also write
 * (push a branch and open a pull request), from the project's grants — set on
 * the Repositories page — and which events on a pull request its sandbox job
 * opened wake the conversation that asked for it, saved through `bot:edit`.
 * @param props - See {@link BotSectionProps}.
 * @returns The section.
 */
export function RepositoriesSection({
  projectId,
  bot,
  denied,
  onSaved,
}: BotSectionProps) {
  const { busy, error, notice, setNotice, setError, save } = useSectionSave();
  const read = useRead<{ repositories: BotRepository[] }>(
    `/project/${projectId}/bot/${bot.id}/repositories`,
  );
  const [events, setEvents] = useState<GithubWakeEvent[]>(bot.githubWakeEvents);
  const locked = denied !== undefined;

  useEffect(() => {
    setEvents(bot.githubWakeEvents);
  }, [bot]);

  const changed = !sameWakeEvents(events, bot.githubWakeEvents);
  const repositories = read.data?.repositories ?? null;

  /**
   * Turn one event on or off.
   * @param event - The event.
   * @param on - Whether it should wake the bot.
   */
  function toggle(event: GithubWakeEvent, on: boolean) {
    setEvents((current) =>
      orderWakeEvents(
        on ? [...current, event] : current.filter((e) => e !== event),
      ),
    );
    setNotice(null);
  }

  /** Save the wake events. */
  async function onSave() {
    await save(async () => {
      onSaved(
        await editBot(projectId, bot.id, {
          githubWakeEvents: orderWakeEvents(events),
        }),
      );
    }, "Saved.");
  }

  return (
    <SectionCard
      title="Repositories"
      testId="bot-repositories"
      idPrefix="bot"
      intro={
        <>
          The GitHub repositories {bot.name} can reach, from the project's{" "}
          <Link to="/repositories" data-testid="bot-repositories-link">
            repository grants
          </Link>
          . It reads them with its GitHub tools and in{" "}
          <Link to="/docs/sandboxes">sandbox</Link> jobs; where it may write, a
          job pushes a branch and opens a pull request.
        </>
      }
      error={error ?? read.error}
      notice={notice}
      onDismissError={() => setError(null)}
      onDismissNotice={() => setNotice(null)}
      onSave={onSave}
      canSave={changed}
      saveDeniedReason={denied}
      busy={busy}
      loading={read.data === null && !read.error}
      loadingBlocks={2}
    >
      {repositories?.length === 0 ? (
        <p className="text-meta" data-testid="bot-no-repositories">
          No repository is granted to {bot.name}. A project admin grants one on
          the <Link to="/repositories">Repositories</Link> page.
        </p>
      ) : (
        <ul className="bot-repositories" data-testid="bot-repository-list">
          {repositories?.map((r) => (
            <li key={r.grantId} data-testid={`bot-repository-${r.grantId}`}>
              <a
                href={repositoryUrl(r.fullName, r.host)}
                target="_blank"
                rel="noreferrer"
                className="mono"
              >
                {r.fullName}
              </a>
              <Chip
                tone={r.access === "write" ? "accent" : "subtle"}
                data-testid={`bot-repository-access-${r.grantId}`}
              >
                {r.access === "write" ? "Read and push" : "Read"}
              </Chip>
              {r.access === "write" && (
                <span className="text-meta">
                  pushes under{" "}
                  <span className="mono">
                    {r.branchPrefix ?? `hypotenuse/${bot.slug}/`}
                  </span>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <Form.Group controlId="bot-wake-events" className="mb-0">
        <Form.Label>
          Wake it, on a pull request its job opened, when…
        </Form.Label>
        <div className="bot-wake-events" data-testid="bot-wake-events">
          {GITHUB_WAKE_EVENTS.map((e) => (
            <Form.Check
              key={e.value}
              id={`bot-wake-${e.value}`}
              label={e.label}
              checked={events.includes(e.value)}
              disabled={busy || locked}
              title={denied}
              onChange={(ev) => toggle(e.value, ev.target.checked)}
              data-testid={`bot-wake-${e.value}`}
            />
          ))}
        </div>
        <Form.Text className="text-muted">
          The rest are recorded and wait for its next turn. A conversation
          someone stopped stays silent.
        </Form.Text>
      </Form.Group>
    </SectionCard>
  );
}
