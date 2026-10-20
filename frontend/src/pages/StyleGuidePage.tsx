import { ChevronRight } from "lucide-react";
import { MarkdownBlock } from "../components/MarkdownBlock";
import {
  AGENT_SESSION_STATUSES,
  AgentBadge,
  Alert,
  Avatar,
  Badge,
  Button,
  CapacityBar,
  Card,
  Chip,
  Form,
  Kbd,
  ListGroup,
  ListRow,
  Mark,
  PresenceDot,
  Property,
  PropertiesPanel,
  RoleChip,
  STATUS_LABELS,
  StatusGlyph,
  Table,
  UI_VARIANT_TONES,
} from "../ui";
import {
  FIXTURE_RUNNERS,
  FIXTURE_SESSION_GROUPS,
  FIXTURE_TRANSCRIPT,
  type FixtureRunner,
  type FixtureTranscriptEntry,
} from "./styleGuideFixtures";

const TONES = [...UI_VARIANT_TONES];

/**
 * One labelled block of the style guide.
 * @param props - Title and content.
 * @returns The section.
 */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="sg-section">
      <h2 className="sg-section-title">{title}</h2>
      {children}
    </section>
  );
}

/**
 * One transcript entry, rendered as a line of the log.
 * @param props - The entry.
 * @returns The line.
 */
function TranscriptLine({ entry }: { entry: FixtureTranscriptEntry }) {
  switch (entry.kind) {
    case "turn":
      return (
        <div className="tx-turn">
          <span>Turn {entry.turn}</span>
          <span>{entry.runner}</span>
          <AgentBadge kind={entry.agent} />
          <RoleChip role={entry.role} />
          <span className="tabular">{entry.duration}</span>
          <span>{entry.outcome}</span>
        </div>
      );
    case "prompt":
      return (
        <div className="tx-prompt">
          <Avatar name={entry.author} size={20} />
          <span className="tx-author">{entry.author.split(" ")[0]}</span>
          <span>{entry.body}</span>
        </div>
      );
    case "thought":
      return (
        <div className="tx-thought">
          <span aria-hidden>···</span> thinking: {entry.body}
        </div>
      );
    case "action":
      return (
        <div className={entry.ephemeral ? "tx-action tx-ephemeral" : "tx-action"}>
          {entry.ephemeral ? <StatusGlyph status="active" /> : <ChevronRight size={14} aria-hidden />}
          <span className="tx-verb">{entry.verb}</span>
          <code className="tx-parameter">{entry.parameter}</code>
          {entry.added !== undefined && (
            <span className="tx-diff tabular">
              <span className="tx-diff-add">+{entry.added}</span> <span className="tx-diff-remove">−{entry.removed}</span>
            </span>
          )}
          {entry.duration && <span className="tx-duration tabular">{entry.duration}</span>}
        </div>
      );
    case "plan":
      return (
        <div className="tx-card tx-plan">
          <div className="tx-card-title">Plan</div>
          {entry.steps.map((step) => (
            <div key={step.title} className="tx-plan-step">
              <StatusGlyph status={step.status} />
              <span>{step.title}</span>
            </div>
          ))}
        </div>
      );
    case "elicitation":
      return (
        <div className="tx-card tx-elicitation">
          <div className="tx-card-title">Needs your answer</div>
          <MarkdownBlock>{entry.body}</MarkdownBlock>
          <div className="tx-options">
            {entry.options.map((option) => (
              <Button key={option} size="sm" variant="secondary">
                {option}
              </Button>
            ))}
          </div>
        </div>
      );
    case "response":
      return (
        <div className="tx-response">
          <Mark size={14} label={null} />
          <MarkdownBlock>{entry.body}</MarkdownBlock>
        </div>
      );
    case "error":
      return (
        <div className="tx-error" role="note">
          <StatusGlyph status="error" />
          <span>{entry.body}</span>
        </div>
      );
  }
}

/**
 * A runner card for the fleet view.
 * @param props - The runner.
 * @returns The card.
 */
function RunnerCard({ runner }: { runner: FixtureRunner }) {
  return (
    <Card className="sg-runner-card">
      <Card.Body>
        <div className="sg-runner-head">
          <PresenceDot presence={runner.presence} />
          <strong>{runner.name}</strong>
          <Avatar name={runner.owner} size={18} />
          <span className="text-meta">v{runner.version}</span>
          {runner.updateAvailable && <Chip tone="accent">Update available</Chip>}
        </div>
        <CapacityBar
          segments={runner.slots}
          label={`${runner.slots.filter((s) => s.state === "busy").length} of ${runner.slots.length} slots`}
        />
        <div className="sg-chips">
          {runner.agents.map((agent) => (
            <AgentBadge key={agent} kind={agent} />
          ))}
          {runner.roles.map((role) => (
            <RoleChip key={role} role={role} />
          ))}
          {runner.repositories.map((repo) => (
            <Chip key={repo}>{repo}</Chip>
          ))}
        </div>
        <div className="text-meta tabular">Last heartbeat {runner.heartbeat}</div>
      </Card.Body>
    </Card>
  );
}

/**
 * Everything the style guide shows, once. Rendered inside each theme container.
 * @returns The content.
 */
function StyleGuideContent() {
  return (
    <>
      <Section title="Buttons">
        <div className="sg-row">
          {TONES.map((tone) => (
            <Button key={tone} variant={tone}>
              {tone}
            </Button>
          ))}
        </div>
        <div className="sg-row">
          {TONES.filter((t) => t !== "link").map((tone) => (
            <Button key={tone} variant={`outline-${tone}`} size="sm">
              {tone}
            </Button>
          ))}
          <Button disabled>Disabled</Button>
        </div>
      </Section>

      <Section title="Badges and chips">
        <div className="sg-row">
          {TONES.filter((t) => t !== "link").map((tone) => (
            <Badge key={tone} bg={tone}>
              {tone}
            </Badge>
          ))}
        </div>
        <div className="sg-row">
          <Chip>acme/web</Chip>
          <Chip tone="accent">Update available</Chip>
          <RoleChip role="manager" />
          <RoleChip role="worker" />
          <RoleChip role="manager" showLabel />
          <AgentBadge kind="claude" />
          <AgentBadge kind="codex" />
        </div>
      </Section>

      <Section title="Avatars, presence, keys">
        <div className="sg-row">
          <Avatar name="Evan Tahler" />
          <Avatar name="codex" agent="codex" />
          <PresenceDot presence="online" />
          <PresenceDot presence="draining" />
          <PresenceDot presence="offline" />
          <Kbd keys="mod+k" />
          <Kbd keys="g s" />
          <Kbd keys="?" />
        </div>
      </Section>

      <Section title="Status glyphs">
        <div className="sg-row">
          {AGENT_SESSION_STATUSES.map((status) => (
            <span key={status} className="sg-glyph">
              <StatusGlyph status={status} /> {STATUS_LABELS[status]}
            </span>
          ))}
        </div>
      </Section>

      <Section title="Alerts">
        {["info", "success", "warning", "danger"].map((tone) => (
          <Alert key={tone} variant={tone}>
            A {tone} alert says what happened and what to do next.
          </Alert>
        ))}
      </Section>

      <Section title="Form controls">
        <Form className="sg-form">
          <Form.Group controlId="sg-name">
            <Form.Label>Runner name</Form.Label>
            <Form.Control placeholder="my-laptop" />
          </Form.Group>
          <Form.Group controlId="sg-invalid">
            <Form.Label>Max parallel jobs</Form.Label>
            <Form.Control isInvalid defaultValue="0" />
            <Form.Text>Use at least 1.</Form.Text>
          </Form.Group>
          <Form.Group controlId="sg-agent">
            <Form.Label>Agent</Form.Label>
            <Form.Select defaultValue="claude">
              <option value="claude">claude</option>
              <option value="codex">codex</option>
            </Form.Select>
          </Form.Group>
          <Form.Check id="sg-check" label="Accept manager work" defaultChecked />
        </Form>
      </Section>

      <Section title="Session list">
        {FIXTURE_SESSION_GROUPS.map((group) => (
          <ListGroup key={group.title} title={group.title} count={group.sessions.length}>
            {group.sessions.map((session) => (
              <ListRow
                key={session.identifier}
                glyph={<StatusGlyph status={session.status} />}
                identifier={session.identifier}
                title={session.title}
                trailing={
                  <>
                    <RoleChip role={session.role} />
                    <AgentBadge kind={session.agent} />
                    <span className="text-meta">{session.runner}</span>
                  </>
                }
              />
            ))}
          </ListGroup>
        ))}
      </Section>

      <Section title="Transcript">
        <div className="tx-log">
          {FIXTURE_TRANSCRIPT.map((entry, i) => (
            // Fixture order is fixed, so the index is a stable key here.
            // biome-ignore lint/suspicious/noArrayIndexKey: static fixture
            <TranscriptLine key={i} entry={entry} />
          ))}
        </div>
      </Section>

      <Section title="Properties">
        <PropertiesPanel>
          <Property label="Status">
            <StatusGlyph status="active" /> Active
          </Property>
          <Property label="Role">
            <RoleChip role="worker" showLabel />
          </Property>
          <Property label="Runner">evan-mbp · codex</Property>
          <Property label="Repository">acme/web</Property>
          <Property label="Branch">
            <code>hypotenuse/eng-142-add-retry</code>
          </Property>
          <Property label="Linear">
            <a href="#session">Session ↗</a>
          </Property>
        </PropertiesPanel>
      </Section>

      <Section title="Runners">
        <div className="sg-runner-grid">
          {FIXTURE_RUNNERS.map((runner) => (
            <RunnerCard key={runner.name} runner={runner} />
          ))}
        </div>
        <Table size="sm" hover>
          <thead>
            <tr>
              <th>Runner</th>
              <th>Owner</th>
              <th>Version</th>
              <th className="sg-numeric">Slots</th>
              <th>Heartbeat</th>
            </tr>
          </thead>
          <tbody>
            {FIXTURE_RUNNERS.map((runner) => (
              <tr key={runner.name}>
                <td>
                  <PresenceDot presence={runner.presence} /> {runner.name}
                </td>
                <td>{runner.owner}</td>
                <td>{runner.version}</td>
                <td className="sg-numeric tabular">
                  {runner.slots.filter((s) => s.state === "busy").length}/{runner.slots.length}
                </td>
                <td className="tabular">{runner.heartbeat}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Section>
    </>
  );
}

/**
 * Every primitive and fixture surface, in both themes side by side, so a
 * reviewer compares light and dark at once. Lives outside both shells.
 * @returns The page.
 */
export function StyleGuidePage() {
  return (
    <div className="sg-page" data-testid="style-guide">
      {(["light", "dark"] as const).map((theme) => (
        <div key={theme} className="sg-theme" data-theme={theme} data-testid={`style-guide-${theme}`}>
          <h1 className="sg-title">
            <Mark size={18} label={null} /> Style guide · {theme}
          </h1>
          <StyleGuideContent />
        </div>
      ))}
    </div>
  );
}
